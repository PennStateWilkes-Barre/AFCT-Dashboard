'use client';

import React, { useId } from 'react';
import {
  Controller,
  useController,
  useFieldArray,
  useWatch,
  type Control,
  type FieldErrors,
} from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import SwitchField from '@/components/ui/SwitchField';
import { AudienceSelect, type AudienceItem } from '@/components/assignments/AudienceSelect';
import { CourseDateTimeField } from '@/components/dialogs/CourseDateTimeField';
import {
  useRosterStudentOptions,
  getStudentName,
} from '@/components/dialogs/useRosterStudentOptions';
import { apiClient } from '@/lib/api/fetch-client';
import { apiPaths } from '@/lib/api-paths';
import type { GroupSetDetailDTO } from '@/lib/group-set-service';
import type { AssignmentWizardFormSchema } from '@/schemas/assignment';
import { memberCountLabel } from '@/components/assignments/labels';
import { queryKeys } from '@/lib/query-keys';

type FormValues = z.input<typeof AssignmentWizardFormSchema>;
type FormOverride = NonNullable<FormValues['overrides']>[number];

/**
 * The create wizard's "Assign To" step: a single stacked column of the assign-to selector
 * (students or groups) and the default schedule (available from, due, late policy).
 *
 * Audience membership is stored as override ROWS with no dates: "assigned to everyone" is
 * the implicit default (no rows), and picking a subset materializes one dateless row per
 * member. Per-student/group date overrides are intentionally NOT set here to keep create
 * simple; they are added on the assignment's page after it exists (AssignmentSettingsCard).
 *
 * A PURE react-hook-form component: it drives the enclosing form (assignedToEveryone,
 * unlockAt, dueDate, allowLateSubmissions, lateCutoff, groupSetId, overrides) and does no
 * API save of its own. `active` gates the roster and group-set fetches.
 */
export function AssignToFields({
  control,
  errors,
  courseId,
  active,
  hideOverridesHint = false,
  labelled = true,
}: {
  control: Control<FormValues>;
  errors: FieldErrors<FormValues>;
  courseId: string;
  active: boolean;
  /** Hide the "add date overrides on the assignment's page" hint (it's shown in the create
   * wizard, but is self-referential on the assignment page itself). */
  hideOverridesHint?: boolean;
  /**
   * Whether these fields name themselves.
   *
   * True in the create wizard, where nothing else does: the step is a bare column of fields
   * and the sr-only heading is the only thing telling a screen reader what they are. False
   * on the Assign To tab, where the panel around them is already a titled region and this
   * would nest a second, near-identically named one inside it.
   */
  labelled?: boolean;
}) {
  const { fields, replace } = useFieldArray({ control, name: 'overrides' });
  const { field: assignedToEveryoneField } = useController({ control, name: 'assignedToEveryone' });
  const sectionIdPrefix = useId();
  const regionHeadingId = `${sectionIdPrefix}-assign-to`;

  const baseAllowLate = useWatch({ control, name: 'allowLateSubmissions' });
  const baseDue = useWatch({ control, name: 'dueDate' });
  const assignedToEveryone = useWatch({ control, name: 'assignedToEveryone' });
  // Individual vs group assignment (chosen in the wizard's Type step). Drives whether the
  // audience selector lists students or groups.
  const isGroup = !!useWatch({ control, name: 'isGroup' });

  // The selected group set lives in the form so the wizard can pin it after creation.
  const { field: groupSetField } = useController({ control, name: 'groupSetId' });
  const groupSetId = groupSetField.value ?? '';

  const students = useRosterStudentOptions(courseId, active);

  // The chosen group set (from the Type step) and the groups within it.
  const groupSetDetailQuery = useQuery({
    queryKey: queryKeys.course.groupSet(courseId, groupSetId),
    queryFn: () => apiClient.get<GroupSetDetailDTO>(apiPaths.courseGroupSet(courseId, groupSetId)),
    enabled: active && !!groupSetId,
    staleTime: 30_000,
  });
  const groups = groupSetDetailQuery.data?.groups ?? [];

  // The audience is a list of students (individual) or groups (group). "Everyone" is the
  // implicit default (no rows); a subset materializes one dateless row per member.
  const allMembers: AudienceItem[] = isGroup
    ? groups.map((g) => ({ id: g.id, label: `${g.name} (${memberCountLabel(g.members.length)})` }))
    : students.map((s) => ({ id: s.id, label: getStudentName(s) }));

  const selectedAudienceIds = assignedToEveryone
    ? allMembers.map((m) => m.id)
    : isGroup
      ? fields.filter((f) => !!f.groupId).map((f) => f.groupId as string)
      : fields.filter((f) => !!f.userId).map((f) => f.userId as string);

  const makeAudienceRow = (memberId: string): FormOverride => {
    if (isGroup) {
      const g = groups.find((x) => x.id === memberId);
      return {
        groupId: memberId,
        groupName: g?.name ?? 'Group',
        groupMemberCount: g?.members.length,
        unlockAt: undefined,
        dueDate: undefined,
        allowLateSubmissions: undefined,
        lateCutoff: undefined,
      };
    }
    const s = students.find((x) => x.id === memberId);
    return {
      userId: memberId,
      studentName: s ? getStudentName(s) : 'Student',
      unlockAt: undefined,
      dueDate: undefined,
      allowLateSubmissions: undefined,
      lateCutoff: undefined,
    };
  };

  // Collapse to the "assigned to everyone" shortcut when every member is selected; otherwise
  // store one explicit row per selected member (no dates: they follow the default schedule).
  const setSelectedAudience = (nextIds: string[]) => {
    const selected = new Set(nextIds);
    const everyoneSelected = allMembers.length > 0 && allMembers.every((m) => selected.has(m.id));
    if (everyoneSelected) {
      assignedToEveryoneField.onChange(true);
      replace([]);
      return;
    }
    assignedToEveryoneField.onChange(false);
    replace(nextIds.map((id) => makeAudienceRow(id)));
  };

  const audienceEmpty = !assignedToEveryone && fields.length === 0;

  return (
    <div
      className="space-y-4"
      role={labelled ? 'region' : undefined}
      aria-labelledby={labelled ? regionHeadingId : undefined}
    >
      {labelled ? (
        <h3 id={regionHeadingId} className="sr-only">
          Assign to and due dates
        </h3>
      ) : null}

      <AudienceSelect
        id={`${sectionIdPrefix}-audience-select`}
        label="Assign to:"
        items={allMembers}
        value={selectedAudienceIds}
        onChange={setSelectedAudience}
        allLabel={isGroup ? 'All groups' : 'All students'}
        allSelected={assignedToEveryone}
        addLabel={isGroup ? 'Edit groups' : 'Edit students'}
        searchPlaceholder={isGroup ? 'Search groups…' : 'Search students…'}
        emptyStateText={isGroup ? 'No groups in this set.' : 'No students in this course.'}
        emptySelectionText={isGroup ? 'No groups selected' : 'No students selected'}
        error={
          audienceEmpty
            ? isGroup
              ? 'Select at least one group.'
              : 'Select at least one student.'
            : undefined
        }
      />

      <CourseDateTimeField
        control={control}
        name="unlockAt"
        label="Available from (optional)"
        error={errors.unlockAt?.message}
      />
      <CourseDateTimeField
        control={control}
        name="dueDate"
        label="Due"
        error={errors.dueDate?.message}
        requiredMark
      />

      <Controller
        control={control}
        name="allowLateSubmissions"
        render={({ field }) => (
          <SwitchField
            label="Allow late submissions"
            name="allowLateSubmissions"
            checked={!!field.value}
            onCheckedChange={(checked) => field.onChange(!!checked)}
            description="Accept work after the due date."
            descriptionPlacement="inline"
          />
        )}
      />

      <Controller
        control={control}
        name="missingWorkIsZero"
        render={({ field }) => (
          <SwitchField
            label="Count missing work as zero"
            name="missingWorkIsZero"
            checked={field.value !== false}
            onCheckedChange={(checked) => field.onChange(!!checked)}
            description="After the due date, work nobody submitted is scored zero. Nothing is written to the gradebook: a late submission or an extension replaces it, and work still waiting to be marked is never counted."
            descriptionPlacement="inline"
          />
        )}
      />

      {baseAllowLate ? (
        <div className="space-y-1">
          <CourseDateTimeField
            control={control}
            name="lateCutoff"
            label="Accept until (optional)"
            error={errors.lateCutoff?.message}
            min={baseDue || undefined}
          />
          <p className="text-muted-foreground text-xs">
            Leave “Accept until” blank to allow late work without a cutoff.
          </p>
        </div>
      ) : (
        <div className="bg-muted rounded-lg px-3 py-2 text-sm">
          <span className="font-medium">Closes at the due date</span>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Students cannot submit after it passes.
          </p>
        </div>
      )}

      {hideOverridesHint ? null : (
        <p className="text-muted-foreground border-t pt-3 text-xs">
          Need different due dates for specific {isGroup ? 'groups' : 'students'}? Add date
          overrides on the assignment&apos;s page after you create it.
        </p>
      )}
    </div>
  );
}
