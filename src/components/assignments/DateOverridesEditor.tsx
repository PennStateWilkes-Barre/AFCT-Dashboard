'use client';

import React, { useEffect, useId, useState } from 'react';
import { Controller, useController, useFieldArray, useWatch, type Control } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { CourseDateTimeField } from '@/components/dialogs/CourseDateTimeField';
import {
  useRosterStudentOptions,
  getStudentName,
} from '@/components/dialogs/useRosterStudentOptions';
import { apiClient } from '@/lib/api/fetch-client';
import { apiPaths } from '@/lib/api-paths';
import type { GroupSetDetailDTO } from '@/lib/group-set-service';
import { CalendarRange, ChevronDown, X } from 'lucide-react';
import {
  DueDateSection,
  OverrideLatePolicyField,
} from '@/components/assignments/DueDateFormPrimitives';
import type { AssignmentWizardFormSchema } from '@/schemas/assignment';
import { formatDateTimeLocal } from '@/lib/date-convert';
import { memberCountLabel } from '@/components/assignments/labels';
import { queryKeys } from '@/lib/query-keys';

type FormValues = z.input<typeof AssignmentWizardFormSchema>;
type FormOverride = NonNullable<FormValues['dateOverrides']>[number];

/**
 * The assignment-page editor for per-student / per-group DATE overrides. Operates on the
 * form's `dateOverrides` field (distinct from `overrides`, which is the audience). Each row
 * is a date exception on top of the assignment's default schedule; blank fields inherit.
 * Candidates for a new override are the assigned targets (everyone, or the audience list)
 * that don't already have one. The parent diffs `dateOverrides` against the loaded rows to
 * create / patch / delete via the overrides API.
 */
export function DateOverridesEditor({
  control,
  courseId,
  active,
  className,
}: {
  control: Control<FormValues>;
  courseId: string;
  active: boolean;
  /** Passed to the panel, so a caller can match the shape of the panels around it. */
  className?: string;
}) {
  const { fields, append, remove } = useFieldArray({ control, name: 'dateOverrides' });
  const sectionId = useId();
  const addOverrideId = `${sectionId}-add-override`;
  const overrideTriggerId = (key: string) =>
    `${sectionId}-override-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [focusTargetId, setFocusTargetId] = useState<string | null>(null);
  const [liveMessage, setLiveMessage] = useState('');

  useEffect(() => {
    if (!focusTargetId) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(focusTargetId)?.focus();
      setFocusTargetId(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [fields, focusTargetId]);

  const baseAllowLate = useWatch({ control, name: 'allowLateSubmissions' });
  const assignedToEveryone = useWatch({ control, name: 'assignedToEveryone' });
  const isGroup = !!useWatch({ control, name: 'isGroup' });
  const { field: groupSetField } = useController({ control, name: 'groupSetId' });
  const groupSetId = groupSetField.value ?? '';
  const audience = (useWatch({ control, name: 'overrides' }) ?? []) as FormOverride[];
  const rows = (useWatch({ control, name: 'dateOverrides' }) ?? []) as FormOverride[];

  const students = useRosterStudentOptions(courseId, active);
  const groupSetDetailQuery = useQuery({
    queryKey: queryKeys.course.groupSet(courseId, groupSetId),
    queryFn: () => apiClient.get<GroupSetDetailDTO>(apiPaths.courseGroupSet(courseId, groupSetId)),
    enabled: active && !!groupSetId,
    staleTime: 30_000,
  });
  const groups = groupSetDetailQuery.data?.groups ?? [];

  const toggleExpanded = (key: string, open: boolean) =>
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });

  // Targets already carrying a date-override row (so they drop out of the Add picker).
  const usedIds = new Set(
    fields.map((f) => (isGroup ? f.groupId : f.userId)).filter((v): v is string => !!v),
  );

  // The assigned targets: everyone (all students / all groups in the set) or the audience.
  const assignedIds = assignedToEveryone
    ? isGroup
      ? groups.map((g) => g.id)
      : students.map((s) => s.id)
    : isGroup
      ? audience.map((a) => a.groupId).filter((v): v is string => !!v)
      : audience.map((a) => a.userId).filter((v): v is string => !!v);

  const candidates = assignedIds
    .filter((id) => !usedIds.has(id))
    .map((id) => {
      if (isGroup) {
        const g = groups.find((x) => x.id === id);
        return {
          id: `g:${id}`,
          label: `${g?.name ?? 'Group'} (${memberCountLabel(g?.members.length ?? 0)})`,
        };
      }
      const s = students.find((x) => x.id === id);
      // The email under the name, for the same reason the faculty pickers carry one: two
      // students called the same thing is ordinary, and this list decides whose deadline moves.
      return {
        id: `s:${id}`,
        label: s ? getStudentName(s) : 'Student',
        description: s?.email,
      };
    });

  const addDateOverride = (rawId: string) => {
    const targetIsGroup = rawId.startsWith('g:');
    const id = rawId.slice(2);
    let displayName = 'Student';
    if (targetIsGroup) {
      const g = groups.find((x) => x.id === id);
      displayName = g?.name ?? 'Group';
      append({
        groupId: id,
        groupName: g?.name ?? 'Group',
        groupMemberCount: g?.members.length,
        unlockAt: undefined,
        dueDate: undefined,
        allowLateSubmissions: undefined,
        lateCutoff: undefined,
      });
    } else {
      const s = students.find((x) => x.id === id);
      displayName = s ? getStudentName(s) : 'Student';
      append({
        userId: id,
        studentName: s ? getStudentName(s) : 'Student',
        unlockAt: undefined,
        dueDate: undefined,
        allowLateSubmissions: undefined,
        lateCutoff: undefined,
      });
    }
    const key = `${targetIsGroup ? 'g' : 's'}:${id}`;
    setExpandedKeys((prev) => new Set(prev).add(key));
    setLiveMessage(`Date override added for ${displayName}.`);
    setFocusTargetId(overrideTriggerId(key));
  };

  const removeDateOverride = (index: number, displayName: string) => {
    remove(index);
    setLiveMessage(`Date override removed for ${displayName}.`);
    setFocusTargetId(addOverrideId);
  };

  return (
    <DueDateSection
      className={className}
      id={sectionId}
      icon={<CalendarRange className="h-4 w-4" />}
      title={`Date overrides (${fields.length})`}
      description="Give an assigned student or group different dates. Blank fields use the default schedule."
      action={
        <SearchableSelect
          id={addOverrideId}
          label="Add override"
          items={candidates}
          onSelect={addDateOverride}
          placeholder={isGroup ? 'Select a group' : 'Select a student'}
          searchPlaceholder={isGroup ? 'Search groups...' : 'Search students...'}
          emptyStateText={
            isGroup
              ? 'Every assigned group already has an override.'
              : 'Every assigned student already has an override.'
          }
          restoreFocusAfterSelect={false}
        />
      }
      contentClassName="p-0"
    >
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {liveMessage}
      </p>
      {fields.length === 0 ? (
        <div className="m-4 rounded-lg border border-dashed px-4 py-6 text-center">
          <p className="text-sm font-medium">No date overrides</p>
          <p className="text-muted-foreground mt-1 text-xs">
            Everyone assigned follows the default schedule.
          </p>
        </div>
      ) : (
        <ul className="divide-y">
          {fields.map((f, index) => {
            const o = rows[index];
            const rowIsGroup = !!f.groupId;
            const key = f.groupId ? `g:${f.groupId}` : f.userId ? `s:${f.userId}` : f.id;
            const displayName = rowIsGroup
              ? (f.groupName ?? 'Group')
              : (f.studentName ?? 'Student');
            const targetLabel = rowIsGroup ? `group ${displayName}` : displayName;
            const isOpen = expandedKeys.has(key);
            const overrideAllowLate = o?.allowLateSubmissions;

            let lateText: string;
            if (overrideAllowLate === undefined || overrideAllowLate === null) {
              lateText = baseAllowLate ? 'Default: allowed' : 'Default: closes at due';
            } else if (overrideAllowLate) {
              lateText = o?.lateCutoff
                ? `Until ${formatDateTimeLocal(o.lateCutoff)}`
                : 'Allowed, no cutoff';
            } else {
              lateText = 'Closes at due';
            }

            return (
              <li key={f.id}>
                <Collapsible open={isOpen} onOpenChange={(open) => toggleExpanded(key, open)}>
                  <div className="hover:bg-muted flex items-stretch gap-1 px-2 sm:px-3">
                    <CollapsibleTrigger
                      id={overrideTriggerId(key)}
                      className="focus-visible:ring-ring grid min-w-0 flex-1 gap-2 rounded-md px-2 py-3 text-left focus-visible:ring-2 focus-visible:outline-none md:grid-cols-[minmax(11rem,1.2fr)_minmax(9rem,1fr)_minmax(9rem,1fr)_minmax(9rem,1fr)] md:items-center md:gap-3"
                      aria-label={`Edit date override for ${targetLabel}`}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <ChevronDown
                          className={`text-muted-foreground h-4 w-4 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                          aria-hidden="true"
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{displayName}</span>
                          {rowIsGroup ? (
                            <span className="text-muted-foreground block text-xs">
                              {memberCountLabel(f.groupMemberCount)}
                            </span>
                          ) : null}
                        </span>
                      </span>
                      <span className="text-muted-foreground pl-6 text-xs md:pl-0">
                        <span className="font-medium md:sr-only">Available: </span>
                        {o?.unlockAt ? (
                          formatDateTimeLocal(o.unlockAt)
                        ) : (
                          <Badge variant="neutral">Default</Badge>
                        )}
                      </span>
                      <span className="text-muted-foreground pl-6 text-xs md:pl-0">
                        <span className="font-medium md:sr-only">Due: </span>
                        {o?.dueDate ? (
                          formatDateTimeLocal(o.dueDate)
                        ) : (
                          <Badge variant="neutral">Default</Badge>
                        )}
                      </span>
                      <span className="text-muted-foreground pl-6 text-xs md:pl-0">
                        <span className="font-medium md:sr-only">Late work: </span>
                        {lateText}
                      </span>
                    </CollapsibleTrigger>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="my-2 h-9 w-9 shrink-0"
                      onClick={() => removeDateOverride(index, displayName)}
                      aria-label={`Remove date override for ${targetLabel}`}
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                  <CollapsibleContent className="bg-muted border-t px-4 py-4">
                    <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-4">
                      <CourseDateTimeField
                        control={control}
                        name={`dateOverrides.${index}.unlockAt`}
                        label="Available from"
                      />
                      <CourseDateTimeField
                        control={control}
                        name={`dateOverrides.${index}.dueDate`}
                        label="Due"
                        defaultTime="23:59"
                      />
                      <Controller
                        control={control}
                        name={`dateOverrides.${index}.allowLateSubmissions`}
                        render={({ field }) => (
                          <OverrideLatePolicyField
                            id={`${overrideTriggerId(key)}-late-policy`}
                            value={field.value}
                            onChange={field.onChange}
                            defaultAllowsLate={!!baseAllowLate}
                          />
                        )}
                      />
                      {overrideAllowLate ? (
                        <CourseDateTimeField
                          control={control}
                          name={`dateOverrides.${index}.lateCutoff`}
                          label="Accept until (optional)"
                          defaultTime="23:59"
                        />
                      ) : (
                        <div className="text-muted-foreground flex min-h-11 items-center text-xs xl:mt-6">
                          {overrideAllowLate === false
                            ? 'This override closes at its due date.'
                            : 'Late-work behavior follows the assignment default.'}
                        </div>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </li>
            );
          })}
        </ul>
      )}
    </DueDateSection>
  );
}
