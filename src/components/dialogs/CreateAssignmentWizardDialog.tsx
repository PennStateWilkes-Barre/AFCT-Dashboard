'use client';

import React, { useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Stepper } from '@/components/ui/stepper';
import InputGroup from '@/components/ui/InputGroup';
import SelectField from '@/components/ui/SelectField';
import { RichDescriptionField } from '@/components/rich-description/RichDescriptionField';
import type { RichDescriptionEnvelope } from '@/lib/rich-description';
import { AssignToFields } from '@/components/assignments/AssignToFields';
import { showToast } from '@/lib/toast';

import { useForm, Controller, type FieldPath } from 'react-hook-form';
import { useDiscardGuard } from '@/components/unsaved-changes/useDiscardGuard';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import { AssignmentWizardFormSchema } from '@/schemas/assignment';
import { apiPaths } from '@/lib/api-paths';
import { apiClient, ApiError } from '@/lib/api/fetch-client';
import type { GroupSetSummaryDTO } from '@/lib/group-set-service';
import type { Assignment } from '@prisma/client';
import { shouldEnterAdvanceStep } from '@/lib/wizard-keyboard';
import { formatDateTimeLocal } from '@/lib/date-convert';
import { queryKeys } from '@/lib/query-keys';

type FormValues = z.input<typeof AssignmentWizardFormSchema>;

const STEPS: ReadonlyArray<{ title: string; fields: FieldPath<FormValues>[] }> = [
  { title: 'Details', fields: ['title', 'descriptionJson'] },
  { title: 'Type', fields: ['isGroup', 'groupSetId'] },
  {
    title: 'Assign To',
    fields: [
      'assignedToEveryone',
      'unlockAt',
      'dueDate',
      'allowLateSubmissions',
      'lateCutoff',
      'overrides',
    ],
  },
  { title: 'Review', fields: [] },
];
const LAST_STEP = STEPS.length - 1;

type Props = {
  open: boolean;
  setOpen: (open: boolean) => void;
  courseId: string;
  courseIsArchived: boolean;
  timeZone: string;
  onCreate?: (assignment: Assignment) => void;
};

/** "today at 23:59" in the course timezone, the default base due date. */
function defaultDueLocalString(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const l = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${l.year ?? '0000'}-${l.month ?? '01'}-${l.day ?? '01'}T23:59`;
}

/**
 * A full, human-readable window ("Available … · Due … · Late until …" / "· No late") from
 * already-resolved (effective) datetime-local strings. Used in Review so a target that
 * only changes the late policy still reads clearly.
 */
function formatWindow(w: {
  unlockAt?: string;
  dueDate?: string;
  allowLate?: boolean;
  lateCutoff?: string;
}): string {
  const parts: string[] = [];
  if (w.unlockAt) parts.push(`Available ${formatDateTimeLocal(w.unlockAt)}`);
  parts.push(`Due ${w.dueDate ? formatDateTimeLocal(w.dueDate) : 'not set'}`);
  if (w.allowLate) {
    parts.push(w.lateCutoff ? `Late until ${formatDateTimeLocal(w.lateCutoff)}` : 'Late accepted');
  } else {
    parts.push('No late');
  }
  return parts.join(' · ');
}

export function CreateAssignmentWizardDialog({
  open,
  setOpen,
  courseId,
  courseIsArchived,
  timeZone,
  onCreate,
}: Props) {
  const [step, setStep] = useState(0);

  const defaults: FormValues = useMemo(
    () => ({
      title: '',
      description: '',
      descriptionJson: null,
      unlockAt: undefined,
      dueDate: defaultDueLocalString(timeZone),
      assignedToEveryone: true,
      allowLateSubmissions: false,
      lateCutoff: undefined,
      // Created unpublished; staff publish from the assignment's own controls.
      isPublished: false,
      isGroup: false,
      courseId,
      overrides: [],
    }),
    [courseId, timeZone],
  );

  const {
    control,
    handleSubmit,
    reset,
    watch,
    trigger,
    getValues,
    setValue,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(AssignmentWizardFormSchema),
    defaultValues: defaults,
    mode: 'onChange',
    reValidateMode: 'onChange',
  });

  // The Assign-To fields (base dates + per-student overrides) live in AssignToFields; the
  // Review step still reads these two to summarize what was chosen.
  const assignedToEveryone = watch('assignedToEveryone');
  const overrides = watch('overrides') ?? [];
  const isGroup = watch('isGroup');

  // Group sets for the course, so the Type step can offer one to pin group work to. Shares
  // the ['course', id, 'group-sets'] cache with AssignToFields (step 3), so they dedupe.
  const groupSetsQuery = useQuery({
    queryKey: queryKeys.course.groupSets(courseId),
    queryFn: () => apiClient.get<GroupSetSummaryDTO[]>(apiPaths.courseGroupSets(courseId)),
    enabled: open && !!courseId,
    staleTime: 30_000,
  });
  const groupSets = groupSetsQuery.data ?? [];

  const resetForm = () => {
    setStep(0);
    reset(defaults, { keepValues: false, keepErrors: false, keepDirty: false, keepTouched: false });
  };

  const next = async () => {
    const ok = await trigger(STEPS[step]?.fields ?? []);
    if (ok) setStep((s) => Math.min(s + 1, LAST_STEP));
  };
  const back = () => setStep((s) => Math.max(s - 1, 0));

  const onSubmit = async (raw: FormValues) => {
    // Audience (WHO): only when not "everyone". Each row targets one student or one group;
    // the create route validates them and writes the AssignmentAssignee rows.
    const assignees = raw.assignedToEveryone
      ? undefined
      : (raw.overrides ?? []).map((o) =>
          o.groupId ? { groupId: o.groupId } : { userId: o.userId },
        );

    const basePayload = {
      title: raw.title,
      // The rich document is authoritative when the author wrote one: the server derives the
      // plain-text description from it. An untouched editor sends neither field, so the new
      // assignment stays PLAIN_TEXT with an empty description, exactly as before.
      ...(raw.descriptionJson
        ? { descriptionJson: raw.descriptionJson }
        : { description: raw.description || undefined }),
      dueDate: raw.dueDate,
      unlockAt: raw.unlockAt || undefined,
      assignedToEveryone: raw.assignedToEveryone,
      allowLateSubmissions: raw.allowLateSubmissions,
      lateCutoff: raw.allowLateSubmissions ? raw.lateCutoff : null,
      // A group assignment is pinned to the set chosen in the Type step; individual is null.
      groupSetId: raw.isGroup ? (raw.groupSetId ?? undefined) : undefined,
      assignees,
      // Always unpublished: the wizard has no publish step.
      isPublished: false,
    };

    let created: Assignment;
    try {
      created = await apiClient.post<Assignment>(apiPaths.courseAssignments(courseId), basePayload);
    } catch (err) {
      showToast.error(
        err instanceof ApiError
          ? err.message
          : 'Could not create the assignment. Check your connection and try again.',
      );
      return; // stay open so the user can retry without duplicating anything
    }

    // This dialog performed the write, so it reports the outcome: `onCreate` updates the caller's
    // state and nothing more. Toasting in both places is what produced two messages for one
    // assignment. Date overrides are added later on the assignment's page.
    showToast.created('Assignment', { name: created.title });
    onCreate?.(created);
    resetForm();
    setOpen(false);
  };

  const review = step === LAST_STEP ? getValues() : null;
  const reviewGroupSetName = groupSets.find((s) => s.id === review?.groupSetId)?.name;
  // Everyone assigned shows "All students"/"All groups"; a restricted audience lists the
  // chosen members (each follows the schedule below; per-target dates are set later).
  const assignToSummary = assignedToEveryone
    ? isGroup
      ? 'All groups'
      : 'All students'
    : overrides
        .map((o) => (o.groupId ? o.groupName : o.studentName))
        .filter(Boolean)
        .join(', ') || (isGroup ? 'No groups selected' : 'No students selected');

  // Every wizard field lives on the form, so isDirty covers all four steps. Escape or the X
  // on a dirty wizard asks before discarding; a successful create closes via setOpen(false)
  // directly and is never asked.
  const { requestClose, discardConfirm } = useDiscardGuard({
    dirty: open && isDirty,
    onDiscard: () => {
      setOpen(false);
      resetForm();
    },
  });

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(val) => {
          if (!val) {
            requestClose();
            return;
          }
          setOpen(val);
        }}
      >
        <DialogContent className="sm:max-w-2xl" onInteractOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>Create Assignment</DialogTitle>
            <DialogDescription className="sr-only">
              Create an assignment in four steps: details, individual or group type, who it is
              assigned to and when it is due, then review.
            </DialogDescription>
          </DialogHeader>

          <Stepper
            steps={STEPS.map((s) => s.title)}
            current={step}
            onStepClick={(index) => setStep(index)}
            className="mb-2"
          />

          {/* Announce step changes to screen readers (the Stepper is visual). */}
          <div className="sr-only" role="status" aria-live="polite">
            {`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]?.title ?? ''}`}
          </div>

          {/* The form owns an onKeyDown that scopes Enter to single-line text inputs so it
            advances the wizard instead of submitting early. That is deliberate keyboard
            management on the form element, not an interactive-role gap. */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
          <form
            onSubmit={step === LAST_STEP ? handleSubmit(onSubmit) : (e) => e.preventDefault()}
            className="space-y-4"
            onKeyDown={(e) => {
              // Enter advances only from a single-line text input; every other control
              // (select, file, radio, combobox, textarea) keeps its native Enter behavior.
              if (e.key !== 'Enter' || step >= LAST_STEP) return;
              if (!shouldEnterAdvanceStep(e.target)) return;
              e.preventDefault();
              void next();
            }}
          >
            <div className="min-h-[320px] space-y-4">
              {step === 0 && (
                <>
                  <Controller
                    control={control}
                    name="title"
                    render={({ field }) => (
                      <InputGroup
                        label="Title"
                        requiredMark
                        name="title"
                        fieldProps={field}
                        error={errors.title?.message}
                        showStatus
                        isValid={!errors.title && !!field.value}
                      />
                    )}
                  />
                  <Controller
                    control={control}
                    name="descriptionJson"
                    render={({ field }) => (
                      <RichDescriptionField
                        // The schema's input type is structurally looser than the envelope type
                        // (Zod widens the recursive node), so narrow it at this boundary.
                        value={(field.value as RichDescriptionEnvelope | null | undefined) ?? null}
                        onChange={field.onChange}
                        error={errors.descriptionJson?.message}
                        placeholder="Enter assignment description"
                        minHeightClassName="min-h-32"
                      />
                    )}
                  />
                </>
              )}

              {step === 1 && (
                <div className="space-y-5">
                  <Controller
                    control={control}
                    name="isGroup"
                    render={({ field }) => (
                      <fieldset className="space-y-3">
                        <legend className="text-sm font-medium">Assignment type</legend>
                        <p className="text-muted-foreground text-sm">
                          Choose whether students complete this assignment on their own or together
                          as a group.
                        </p>
                        <div className="grid gap-3 sm:grid-cols-2">
                          {(
                            [
                              {
                                value: false,
                                label: 'Individual',
                                desc: 'Each student submits and is graded on their own.',
                              },
                              {
                                value: true,
                                label: 'Group',
                                desc: 'Students submit and are graded together as a group. A faculty member or TA can override an individual member’s grade.',
                              },
                            ] as const
                          ).map((opt) => {
                            const selected = !!field.value === opt.value;
                            return (
                              <label
                                key={opt.label}
                                className={`flex cursor-pointer gap-3 rounded-lg border p-4 transition ${
                                  selected
                                    ? 'border-primary bg-primary/5 ring-primary/30 ring-1'
                                    : 'hover:bg-muted'
                                }`}
                              >
                                <input
                                  type="radio"
                                  name="isGroup"
                                  className="accent-primary mt-1"
                                  checked={selected}
                                  onChange={() => {
                                    field.onChange(opt.value);
                                    // The audience is type-specific (students vs groups), so reset
                                    // it to "everyone" on any type switch to avoid carrying
                                    // cross-type rows into the create payload.
                                    setValue('assignedToEveryone', true, { shouldValidate: true });
                                    setValue('overrides', [], { shouldValidate: true });
                                    // Switching back to Individual drops any chosen group set.
                                    if (!opt.value)
                                      setValue('groupSetId', null, { shouldValidate: true });
                                  }}
                                />
                                <span>
                                  <span className="block text-sm font-medium">{opt.label}</span>
                                  <span className="text-muted-foreground block text-xs">
                                    {opt.desc}
                                  </span>
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      </fieldset>
                    )}
                  />

                  {/* Group assignments pick which group set they run in. Not stored on the
                  assignment itself; the Assign-To step (3) uses this selection. */}
                  {isGroup && (
                    <Controller
                      control={control}
                      name="groupSetId"
                      render={({ field }) => (
                        <div className="space-y-1">
                          {groupSetsQuery.isPending ? (
                            <p className="text-muted-foreground text-sm">Loading group sets…</p>
                          ) : groupSets.length === 0 ? (
                            <p className="text-muted-foreground text-sm">
                              This course has no group sets yet. Create one on the course&apos;s
                              Groups tab first.
                            </p>
                          ) : (
                            <SelectField
                              label="Group set"
                              name="groupSetId"
                              placeholder="Choose a group set"
                              description="Students submit and are graded as their group in the chosen set."
                              value={field.value ?? undefined}
                              onValueChange={(v) => field.onChange(v)}
                              options={groupSets.map((gs) => ({
                                value: gs.id,
                                label: `${gs.name} (${gs.groupCount} ${gs.groupCount === 1 ? 'group' : 'groups'})`,
                              }))}
                            />
                          )}
                          {errors.groupSetId && (
                            <p className="text-destructive text-xs" role="alert">
                              {errors.groupSetId.message}
                            </p>
                          )}
                        </div>
                      )}
                    />
                  )}
                </div>
              )}

              {step === 2 && (
                <AssignToFields
                  control={control}
                  errors={errors}
                  courseId={courseId}
                  active={open}
                />
              )}

              {step === LAST_STEP && review && (
                <div className="space-y-3">
                  <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm [&>dt]:break-words [&>dd]:min-w-0 [&>dd]:break-words">
                    <dt className="text-muted-foreground">Title</dt>
                    <dd className="font-medium">{review.title}</dd>
                    <dt className="text-muted-foreground">Type</dt>
                    <dd>
                      {review.isGroup
                        ? `Group${reviewGroupSetName ? ` · ${reviewGroupSetName}` : ''}`
                        : 'Individual'}
                    </dd>
                    <dt className="text-muted-foreground">Assign to</dt>
                    <dd>{assignToSummary}</dd>
                    <dt className="text-muted-foreground">Schedule</dt>
                    <dd>
                      {formatWindow({
                        unlockAt: review.unlockAt,
                        dueDate: review.dueDate,
                        allowLate: review.allowLateSubmissions,
                        lateCutoff: review.lateCutoff,
                      })}
                    </dd>
                  </dl>
                  <p className="text-muted-foreground text-xs">
                    Created unpublished. Add problems and publish it after creating it.
                  </p>
                </div>
              )}
            </div>

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="ghost" onClick={resetForm}>
                  Cancel
                </Button>
              </DialogClose>

              {step > 0 && (
                <Button type="button" variant="secondary" onClick={back}>
                  Back
                </Button>
              )}

              {step < LAST_STEP ? (
                <Button key="wizard-next" type="button" onClick={() => void next()}>
                  Next
                </Button>
              ) : (
                <Button
                  key="wizard-create"
                  type="submit"
                  disabled={isSubmitting || courseIsArchived}
                >
                  {isSubmitting ? 'Creating…' : 'Create Assignment'}
                </Button>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {discardConfirm}
    </>
  );
}
