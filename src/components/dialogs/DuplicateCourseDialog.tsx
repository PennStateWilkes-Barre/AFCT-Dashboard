'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Stepper } from '@/components/ui/stepper';
import InputGroup from '@/components/ui/InputGroup';
import { Checkbox } from '@/components/ui/checkbox';
import { SearchableMultiSelect } from '@/components/ui/SearchableMultiSelect';
import type { User } from '@prisma/client';
import { useForm, Controller, type FieldPath } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { DuplicateFormSchema } from '@/schemas/course';
import type { Course } from '@prisma/client';
import { showToast } from '@/lib/toast';
import { apiPaths } from '@/lib/api-paths';
import { apiClient, ApiError } from '@/lib/api/fetch-client';
import { useFacultyTaOptions, getUserName, namesForReview } from './useFacultyTaOptions';
import { CourseDateTimeField } from './CourseDateTimeField';
import { shouldEnterAdvanceStep } from '@/lib/wizard-keyboard';
import { formatDateTimeLocal, toDateTimeLocalInTimeZone } from '@/lib/date-convert';
import { queryKeys } from '@/lib/query-keys';

type FormValues = z.input<typeof DuplicateFormSchema>;

// Same wizard shape as CreateCourseDialog: one concern per step, each step
// validating its own fields before advancing.
const STEPS: ReadonlyArray<{ title: string; fields: FieldPath<FormValues>[] }> = [
  { title: 'Details', fields: ['name', 'code', 'semester', 'credits'] },
  {
    title: 'Schedule',
    fields: ['startDate', 'endDate', 'registrationOpenAt', 'registrationCloseAt'],
  },
  { title: 'Content', fields: ['copyMode'] },
  { title: 'Roster', fields: ['instructorIds', 'taIds'] },
  { title: 'Review', fields: [] },
];
const LAST_STEP = STEPS.length - 1;

const COPY_MODE_LABELS: Record<string, string> = {
  assignments: 'Assignments only',
  assignments_with_problems: 'Assignments and their problems',
  problems: 'Problems only',
};

interface Props {
  open: boolean;
  setOpen: (v: boolean) => void;
  // Only base course fields are read (name, code, dates, etc.), so any Course row works.
  course: Course | null;
  timeZone: string;
  onSuccess?: (newId: string) => void;
}

export default function DuplicateCourseDialog({
  open,
  setOpen,
  course,
  timeZone,
  onSuccess,
}: Props) {
  const router = useRouter();
  // Render (and later re-interpret) the copied dates in the SOURCE course's timezone so
  // the duplicate's schedule matches the original. Falls back to the passed-in display
  // zone if the course row doesn't carry a timezone.
  const zone = course?.timezone || timeZone;

  const defaults: FormValues = {
    name: course?.name ?? '',
    code: course?.code ?? '',
    semester: course?.semester ?? '',
    credits: String(course?.credits ?? 3),
    startDate: course ? toDateTimeLocalInTimeZone(course.startDate, zone) : '',
    endDate: course ? toDateTimeLocalInTimeZone(course.endDate, zone) : '',
    registrationOpenAt: course?.registrationOpenAt
      ? toDateTimeLocalInTimeZone(course.registrationOpenAt, zone)
      : '',
    registrationCloseAt: course?.registrationCloseAt
      ? toDateTimeLocalInTimeZone(course.registrationCloseAt, zone)
      : '',
    emptyStringNotation:
      (course as { emptyStringNotation?: FormValues['emptyStringNotation'] })
        ?.emptyStringNotation ?? 'EPSILON',
    copyMode: 'assignments_with_problems',
    instructorIds: [],
    taIds: [],
  };

  const {
    control,
    handleSubmit,
    reset,
    trigger,
    watch,
    getValues,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(DuplicateFormSchema),
    defaultValues: defaults,
    mode: 'onChange',
    reValidateMode: 'onChange',
  });

  const [step, setStep] = useState(0);
  const [confirmChecked, setConfirmChecked] = useState(false);

  // Faculty/TA option lists for the "add faculty/TA" dropdowns (shared with CreateCourseDialog).
  const { facultyList, taList } = useFacultyTaOptions(open);

  type CourseRosterRow = { role: string; user: User };

  const courseRosterQuery = useQuery<CourseRosterRow[]>({
    /*
     * Its own key. This used to be ['course', id, 'roster'], byte-identical to the key
     * `useCourseData` stores a whole FullCourse object under, so opening this dialog on a
     * course whose Roster tab had been visited handed it the wrong shape entirely.
     *
     * Only faculty and TAs are wanted here (the wizard copies course staff), which is
     * exactly what the course payload now carries.
     */
    queryKey: queryKeys.course.duplicateStaff(course?.id ?? ''),
    queryFn: async () => {
      if (!course?.id) return [];
      const res = await fetch(apiPaths.course(course.id, { view: 'roster' }));
      if (!res.ok) throw new Error('Failed to load current course roster');
      const data = await res.json();
      const staff = Array.isArray(data?.staff) ? data.staff : [];
      return staff.map((row: Record<string, unknown>) => ({
        role: String(row.courseRole ?? row.role ?? ''),
        user: {
          id: String(row.id),
          firstName: row.firstName as string | undefined,
          lastName: row.lastName as string | undefined,
          email: String(row.email ?? ''),
          avatar: row.avatar as string | null | undefined,
        },
      }));
    },
    enabled: open && !!course?.id,
    staleTime: 30_000,
  });
  const currentRoster = courseRosterQuery.data ?? [];
  useEffect(() => {
    if (courseRosterQuery.isError)
      showToast.error(
        'Could not load the course roster. Close and reopen this dialog to try again.',
      );
  }, [courseRosterQuery.isError]);

  // Keep min (end) in sync with start
  const startDateStr = watch('startDate');
  const registrationOpenAtStr = watch('registrationOpenAt');

  useEffect(() => {
    if (!open) return;
    // reset with current course values when opening (use live course to avoid stale defaults)
    const vals: FormValues = {
      name: course?.name ?? '',
      code: course?.code ?? '',
      semester: course?.semester ?? '',
      credits: String(course?.credits ?? 3),
      startDate: course ? toDateTimeLocalInTimeZone(course.startDate, zone) : '',
      endDate: course ? toDateTimeLocalInTimeZone(course.endDate, zone) : '',
      registrationOpenAt: course?.registrationOpenAt
        ? toDateTimeLocalInTimeZone(course.registrationOpenAt, zone)
        : '',
      registrationCloseAt: course?.registrationCloseAt
        ? toDateTimeLocalInTimeZone(course.registrationCloseAt, zone)
        : '',
      emptyStringNotation:
        (course as { emptyStringNotation?: FormValues['emptyStringNotation'] })
          ?.emptyStringNotation ?? 'EPSILON',
      copyMode: 'assignments_with_problems',
      instructorIds: [],
      taIds: [],
    };
    reset(vals);
    setStep(0);
    setConfirmChecked(false);
    // Runs when the dialog opens or its subject changes, not when the form does. `reset` and
    // the setters are deliberately absent: including them would re-seed the form mid-edit and
    // throw away what has been typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, course, timeZone]);

  const resetAll = () => {
    setStep(0);
    setConfirmChecked(false);
    reset(defaults, { keepErrors: false });
  };

  // Both selectors toast their outcome (sonner toasts are aria-live), so screen
  // reader users hear what happened - including the nothing-to-add cases, which
  // would otherwise be silent no-ops.
  const selectCurrentFaculty = async () => {
    const currentFacultyIds = currentRoster
      .filter((row) => row.role === 'FACULTY')
      .map((row) => row.user.id);
    if (currentFacultyIds.length === 0) {
      showToast.info('This course has no current faculty members to add.');
      return;
    }
    const existingIds = new Set(getValues('instructorIds') ?? []);
    const before = existingIds.size;
    currentFacultyIds.forEach((id) => existingIds.add(id));
    const added = existingIds.size - before;
    setValue('instructorIds', Array.from(existingIds), {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: true,
    });
    showToast.success(
      added === 0
        ? 'All current faculty were already selected.'
        : `Added ${added} current faculty member${added === 1 ? '' : 's'}.`,
    );
  };

  const selectCurrentTAs = async () => {
    const currentTAIds = currentRoster.filter((row) => row.role === 'TA').map((row) => row.user.id);
    if (currentTAIds.length === 0) {
      showToast.info('This course has no current TAs to add.');
      return;
    }
    const existingIds = new Set(getValues('taIds') ?? []);
    const before = existingIds.size;
    currentTAIds.forEach((id) => existingIds.add(id));
    const added = existingIds.size - before;
    setValue('taIds', Array.from(existingIds), {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: true,
    });
    showToast.success(
      added === 0
        ? 'All current TAs were already selected.'
        : `Added ${added} current TA${added === 1 ? '' : 's'}.`,
    );
  };

  // Advance only when the current step's own fields validate; errors render in
  // place and the step holds. (The whole schema still gates the final submit.)
  const next = async () => {
    const ok = await trigger(STEPS[step]?.fields ?? []);
    if (ok) {
      setConfirmChecked(false);
      setStep((s) => Math.min(s + 1, LAST_STEP));
    }
  };
  const back = () => setStep((s) => Math.max(s - 1, 0));

  const onSubmit = async (raw: FormValues) => {
    const courseId = course?.id;
    if (!courseId) {
      showToast.error('Could not duplicate the course. Refresh the page to try again.');
      return;
    }

    // Build payload
    const mode = raw.copyMode ?? 'assignments_with_problems';
    const payload = {
      title: raw.name,
      code: raw.code,
      semester: raw.semester,
      startDate: raw.startDate,
      endDate: raw.endDate,
      registrationOpenAt: raw.registrationOpenAt,
      registrationCloseAt: raw.registrationCloseAt,
      credits: Number(raw.credits),
      copyAssignments: mode === 'assignments' || mode === 'assignments_with_problems',
      copyProblems: mode === 'problems' || mode === 'assignments_with_problems',
      instructorIds: raw.instructorIds ?? [],
      taIds: raw.taIds ?? [],
    };

    try {
      const data = await apiClient.post<{ id: string }>(
        apiPaths.courseDuplicate(courseId),
        payload,
      );
      setOpen(false);
      if (onSuccess) {
        onSuccess(data.id);
      } else {
        router.push(`/dashboard/courses/${data.id}`);
      }
    } catch (e) {
      showToast.error(e instanceof ApiError ? e.message : 'Failed to duplicate course');
    }
  };

  // The review step reads straight from the form state.
  const review = step === LAST_STEP ? getValues() : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) resetAll();
      }}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Copy className="text-muted-foreground size-4" />
            <DialogTitle>Duplicate Course</DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            Copy this course into a new one in five steps: details, schedule, what to copy, roster,
            then review.
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

        {/* The onKeyDown below scopes Enter to single-line text inputs so it advances
            the wizard instead of submitting early: deliberate keyboard management on the
            form element, not an interactive-role gap. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
        <form
          // Only the Review step may submit; earlier steps swallow any submit that
          // slips through (backstop for the button-swap hazard handled below).
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
          {/* A stable min-height keeps the dialog from resizing between steps. */}
          <div className="min-h-[320px] space-y-4">
            {step === 0 && (
              <>
                <Controller
                  control={control}
                  name="name"
                  render={({ field }) => (
                    <InputGroup
                      label="Course Name"
                      name="name"
                      isValid={!!field.value}
                      fieldProps={field}
                      error={errors.name?.message as string | undefined}
                    />
                  )}
                />

                <Controller
                  control={control}
                  name="code"
                  render={({ field }) => (
                    <InputGroup
                      label="Course Code"
                      name="code"
                      isValid={!!field.value}
                      fieldProps={field}
                      error={errors.code?.message as string | undefined}
                    />
                  )}
                />

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Controller
                    control={control}
                    name="semester"
                    render={({ field }) => (
                      <InputGroup
                        label="Semester"
                        name="semester"
                        isValid={!!field.value}
                        fieldProps={field}
                        placeholder={`Fall ${new Date().getFullYear()}`}
                        error={errors.semester?.message as string | undefined}
                      />
                    )}
                  />

                  <Controller
                    control={control}
                    name="credits"
                    render={({ field }) => (
                      <InputGroup
                        label="Credits"
                        name="credits"
                        type="number"
                        isValid={!!field.value}
                        fieldProps={field}
                        min={1}
                        max={6}
                        error={errors.credits?.message as string | undefined}
                      />
                    )}
                  />
                </div>
              </>
            )}

            {step === 1 && (
              <>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <CourseDateTimeField
                    control={control}
                    name="startDate"
                    label="Start Date & Time"
                    error={errors.startDate?.message as string | undefined}
                  />
                  <CourseDateTimeField
                    control={control}
                    name="endDate"
                    label="End Date & Time"
                    error={errors.endDate?.message as string | undefined}
                    min={startDateStr || undefined}
                    defaultTime="23:59"
                  />
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <CourseDateTimeField
                    control={control}
                    name="registrationOpenAt"
                    label="Self Registration Opens"
                    error={errors.registrationOpenAt?.message as string | undefined}
                  />
                  <CourseDateTimeField
                    control={control}
                    name="registrationCloseAt"
                    label="Self Registration Closes"
                    error={errors.registrationCloseAt?.message as string | undefined}
                    min={registrationOpenAtStr || undefined}
                    defaultTime="23:59"
                  />
                </div>
              </>
            )}

            {step === 2 && (
              <div className="space-y-2">
                <div id="copy-mode-label" className="text-sm font-medium">
                  What would you like to copy?
                </div>
                <Controller
                  control={control}
                  name="copyMode"
                  render={({ field }) => (
                    <div className="space-y-1" role="radiogroup" aria-labelledby="copy-mode-label">
                      <label className="flex items-start gap-2">
                        <input
                          type="radio"
                          name="copyMode"
                          value="assignments"
                          checked={field.value === 'assignments'}
                          onChange={() => field.onChange('assignments')}
                        />
                        <div>
                          <div className="font-medium">Assignments only</div>
                          <div className="text-muted-foreground text-sm">
                            Copy assignments only; assignments will not reference problems.
                          </div>
                        </div>
                      </label>

                      <label className="flex items-start gap-2">
                        <input
                          type="radio"
                          name="copyMode"
                          value="assignments_with_problems"
                          checked={field.value === 'assignments_with_problems'}
                          onChange={() => field.onChange('assignments_with_problems')}
                        />
                        <div>
                          <div className="font-medium">Assignments and their problems</div>
                          <div className="text-muted-foreground text-sm">
                            Copy assignments and duplicate the problems attached to each assignment;
                            new assignments will reference copied problems only.
                          </div>
                        </div>
                      </label>

                      <label className="flex items-start gap-2">
                        <input
                          type="radio"
                          name="copyMode"
                          value="problems"
                          checked={field.value === 'problems'}
                          onChange={() => field.onChange('problems')}
                        />
                        <div>
                          <div className="font-medium">Problems only</div>
                          <div className="text-muted-foreground text-sm">
                            Copy problems only; no assignments will be created.
                          </div>
                        </div>
                      </label>
                    </div>
                  )}
                />
              </div>
            )}

            {step === 3 && (
              <div className="space-y-3">
                <div className="space-y-3">
                  <div className="text-sm font-medium">Load current roster members</div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={selectCurrentFaculty}
                      aria-describedby="duplicate-roster-status"
                      disabled={
                        !course?.id || courseRosterQuery.isLoading || courseRosterQuery.isError
                      }
                    >
                      Select current faculty
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={selectCurrentTAs}
                      aria-describedby="duplicate-roster-status"
                      disabled={
                        !course?.id || courseRosterQuery.isLoading || courseRosterQuery.isError
                      }
                    >
                      Select current TAs
                    </Button>
                  </div>
                  {/* Persistent explanation for why the buttons are disabled (the
                      error toast is transient); described-by from both buttons. */}
                  {(courseRosterQuery.isLoading || courseRosterQuery.isError) && (
                    <p
                      id="duplicate-roster-status"
                      role="status"
                      className="text-muted-foreground text-xs"
                    >
                      {courseRosterQuery.isLoading
                        ? 'Loading the current roster…'
                        : 'The current roster could not be loaded. Close and reopen this dialog to retry, or add members below.'}
                    </p>
                  )}
                </div>

                <Controller
                  control={control}
                  name="instructorIds"
                  render={({ field }) => (
                    <SearchableMultiSelect
                      label="Add faculty"
                      items={facultyList.map((faculty) => ({
                        id: faculty.id,
                        label: getUserName(faculty),
                        description: faculty.email,
                      }))}
                      value={field.value ?? []}
                      onChange={(value) => field.onChange(value)}
                      placeholder="Select faculty"
                      searchPlaceholder="Search faculty..."
                      emptyStateText="No faculty found."
                      error={errors.instructorIds?.message as string | undefined}
                    />
                  )}
                />

                <Controller
                  control={control}
                  name="taIds"
                  render={({ field }) => (
                    <SearchableMultiSelect
                      label="Add TAs"
                      items={taList.map((ta) => ({
                        id: ta.id,
                        label: getUserName(ta),
                        description: ta.email,
                      }))}
                      value={field.value ?? []}
                      onChange={(value) => field.onChange(value)}
                      placeholder="Select TAs"
                      searchPlaceholder="Search TAs..."
                      emptyStateText="No TAs found."
                      error={errors.taIds?.message as string | undefined}
                    />
                  )}
                />

                <div className="text-muted-foreground text-xs">
                  The copy needs at least one faculty member: use Select current faculty or add
                  faculty above. Students are never copied.
                </div>
              </div>
            )}

            {step === LAST_STEP && review && (
              <div className="space-y-3">
                {/* min-w-0 + break-words keep long names from overflowing on phones. */}
                <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm [&>dt]:break-words [&>dd]:min-w-0 [&>dd]:break-words">
                  <dt className="text-muted-foreground">Name</dt>
                  <dd className="font-medium">{review.name}</dd>
                  <dt className="text-muted-foreground">Code</dt>
                  <dd className="font-medium">{review.code}</dd>
                  <dt className="text-muted-foreground">Semester</dt>
                  <dd>{review.semester}</dd>
                  <dt className="text-muted-foreground">Credits</dt>
                  <dd>{review.credits}</dd>
                  <dt className="text-muted-foreground">Runs</dt>
                  <dd>
                    {formatDateTimeLocal(review.startDate)} to {formatDateTimeLocal(review.endDate)}
                  </dd>
                  <dt className="text-muted-foreground">Self registration</dt>
                  <dd>
                    {formatDateTimeLocal(review.registrationOpenAt)} to{' '}
                    {formatDateTimeLocal(review.registrationCloseAt)}
                  </dd>
                  <dt className="text-muted-foreground">Copy</dt>
                  <dd>{COPY_MODE_LABELS[review.copyMode ?? ''] ?? review.copyMode}</dd>
                  {(review.instructorIds ?? []).length > 0 && (
                    <>
                      <dt className="text-muted-foreground">Added faculty</dt>
                      <dd>{namesForReview(review.instructorIds ?? [], facultyList)}</dd>
                    </>
                  )}
                  {(review.taIds ?? []).length > 0 && (
                    <>
                      <dt className="text-muted-foreground">Added TAs</dt>
                      <dd>{namesForReview(review.taIds ?? [], taList)}</dd>
                    </>
                  )}
                </dl>

                <p className="text-muted-foreground text-xs">
                  The duplicated course is created unpublished, and submissions are never copied.
                </p>

                <label className="mt-2 flex items-center gap-2">
                  <Checkbox
                    checked={confirmChecked}
                    disabled={isSubmitting}
                    onCheckedChange={(val) => setConfirmChecked(!!val)}
                  />
                  <span className="text-sm">
                    I confirm I want to duplicate this course with the options above
                  </span>
                </label>
              </div>
            )}
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={isSubmitting} onClick={resetAll}>
                Cancel
              </Button>
            </DialogClose>

            {step > 0 && (
              <Button type="button" variant="secondary" disabled={isSubmitting} onClick={back}>
                Back
              </Button>
            )}

            {/* Distinct keys force a fresh button node when Next becomes Duplicate,
                so the pending click's default action can't submit the form (same
                hazard as CreateCourseDialog). */}
            {step < LAST_STEP ? (
              <Button
                key="wizard-next"
                type="button"
                disabled={isSubmitting}
                onClick={() => void next()}
              >
                Next
              </Button>
            ) : (
              <Button key="wizard-submit" type="submit" disabled={isSubmitting || !confirmChecked}>
                {isSubmitting ? 'Copying…' : 'Duplicate Course'}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
