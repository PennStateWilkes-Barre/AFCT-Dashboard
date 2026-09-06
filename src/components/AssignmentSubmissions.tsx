'use client';

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import type { Submission, User } from '@prisma/client';
import { showToast } from '@/lib/toast';
import { isTextEntryTarget } from '@/lib/keyboard';
import { apiPaths } from '@/lib/api-paths';
import { rerunSubmission } from '@/app/utils/rerunSubmission';
import type { Comment as DiscussionComment } from './DiscussionPanel';
import ProblemWorkspace from '@/components/assignments/ProblemWorkspace';
import type { ProblemSubmission } from '@/lib/problem-submission';
import { ReviewStrip } from '@/components/assignments/ReviewStrip';
import { ReviewShortcutsDialog } from '@/components/assignments/ReviewShortcutsDialog';
import { GRADE_INPUT_ID } from '@/components/ProblemGradeForm';
import { useEffectiveTimezone } from '@/hooks/use-effective-timezone';
import { queryKeys } from '@/lib/query-keys';
import { fetchJson } from '@/lib/query-fetch';
import { useEmptyStringSymbol } from '@/hooks/use-empty-string-symbol';
import { SubmissionViewerDialog } from '@/components/dialogs/SubmissionViewerDialog';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog';
// The same loading indicator the tables use. It lives under data-table-status because that
// is where it started, but it is the app's status renderer rather than a table-only one.
import { DataTableLoading } from '@/components/ui/data-table-status';
import dynamic from 'next/dynamic';

// On demand: the grant dialog carries the form stack and was the last thing putting zod on the
// assignment route. Staff open it rarely, and never on arrival.
const GrantExtraSubmissionsDialog = dynamic(
  () =>
    import('@/components/dialogs/GrantExtraSubmissionsDialog').then(
      (m) => m.GrantExtraSubmissionsDialog,
    ),
  { ssr: false },
);
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { MoreVertical } from 'lucide-react';
import { useReviewData } from './useReviewData';
import { useComments } from './useComments';
import { useProblemGrades } from './useProblemGrades';
import { useReviewSelection } from './useReviewSelection';

type Person = Pick<User, 'firstName' | 'lastName' | 'id'> & { enrollmentStatus?: string | null };

type Problem = {
  id: string;
  title: string;
  description?: string;
  type?: string;
  maxPoints?: number;
  maxStates?: number;
  isDeterministic?: boolean;
  fileName?: string;
  originalFileName?: string;
  maxSubmissions?: number;
  autograderEnabled?: boolean;
};

type SubmissionData = Submission[] | { submissions: Submission[] };

type Props = {
  courseIsArchived: boolean;
  courseId: string;
  assignmentId: string;
  maxAssignmentGrade: number;
  assignmentDueDate?: string | Date | null;
  problems?: Problem[];
};

// Helpers
const hasSubmissions = (obj: unknown): obj is { submissions: Submission[] } => {
  return (
    !!obj &&
    typeof obj === 'object' &&
    Array.isArray((obj as { submissions?: unknown }).submissions)
  );
};

/**
 * True when the key event originates from a text field, so the shortcuts stay dormant.
 *
 * These are bare letters and digits, so any modifier means the keystroke was meant for something
 * else and this is not it. That extra rule is why this is not `isTextEntryTarget` alone.
 */
const isTypingTarget = (e: KeyboardEvent): boolean =>
  e.altKey || e.ctrlKey || e.metaKey || isTextEntryTarget(e);

const extractSubs = (raw?: SubmissionData): Submission[] => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;

  // TypeScript now automatically knows 'raw' has the submissions array
  if (hasSubmissions(raw)) {
    return raw.submissions;
  }

  return [];
};

export default function AssignmentSubmissions({
  courseIsArchived,
  courseId,
  assignmentId,
  assignmentDueDate,
  problems,
}: Props) {
  const epsSymbol = useEmptyStringSymbol(courseId);
  const [rerunning, setRerunning] = useState<Record<string, boolean>>({});
  /** The review panel. The single-key shortcuts fire only while focus is inside it. */
  const rootRef = useRef<HTMLDivElement>(null);
  const [grantDialogOpen, setGrantDialogOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Set on first open and never cleared, so the dynamic import above stays deferred.
  const [grantMounted, setGrantMounted] = useState(false);
  useEffect(() => {
    if (grantDialogOpen) setGrantMounted(true);
  }, [grantDialogOpen]);

  const [showStudentDataLoading, setShowStudentDataLoading] = useState(false);
  const [openDialog, setOpenDialog] = useState<{
    open: boolean;
    submission: Submission | ProblemSubmission | null;
  }>({ open: false, submission: null });

  // Students for review: includes DROPPED students (labeled), since staff still review
  // their submitted work. Its own query key ('students', 'all') so it doesn't collide
  // with the active-only list GroupsCard/audience pickers share.
  const { timezone, hour12 } = useEffectiveTimezone();
  const assignmentShellQuery = useQuery<{
    dueDate?: string | Date;
    allowLateSubmissions?: boolean;
    lateCutoff?: string | Date | null;
  }>({
    queryKey: queryKeys.assignment.shell(courseId, assignmentId),
    queryFn: () => fetchJson(apiPaths.assignment(courseId, assignmentId, { view: 'problems' })),
    enabled: !!assignmentId,
    staleTime: 30_000,
  });
  const assignmentShell = assignmentShellQuery.isError ? null : (assignmentShellQuery.data ?? null);

  const studentsQuery = useQuery({
    queryKey: queryKeys.course.studentsAll(courseId),
    queryFn: async () => {
      const res = await fetch(apiPaths.courseStudents(courseId, { includeDropped: true }));
      if (!res.ok)
        throw new Error(
          (await res.json())?.error ||
            'Could not load the student list. Refresh the page to try again.',
        );
      return (await res.json()) as Person[];
    },
    staleTime: 30_000,
  });

  // Derived, sorted students list (replaces the old `students` useState). Sort
  // alphabetically by last name, then first name (case-insensitive).
  const students = useMemo<Person[]>(() => {
    return [...(studentsQuery.data ?? [])].sort((a, b) => {
      const aLast = (a.lastName ?? '').toLowerCase();
      const bLast = (b.lastName ?? '').toLowerCase();
      if (aLast < bLast) return -1;
      if (aLast > bLast) return 1;
      const aFirst = (a.firstName ?? '').toLowerCase();
      const bFirst = (b.firstName ?? '').toLowerCase();
      if (aFirst < bFirst) return -1;
      if (aFirst > bFirst) return 1;
      return 0;
    });
  }, [studentsQuery.data]);

  // Surface a load failure the same way the imperative catch did.
  const studentsQueryIsError = studentsQuery.isError;
  useEffect(() => {
    if (studentsQueryIsError) {
      console.error('Fetch students error:', studentsQuery.error);
      showToast.error('Could not load the student list. Refresh the page to try again.');
    }
  }, [studentsQueryIsError, studentsQuery.error]);

  // Build the assignment-specific problem list from assignment payload.
  const assignmentProblems = useMemo(() => {
    return problems ?? [];
  }, [problems]);

  // All assignment problems are visible.
  const visibleProblems = assignmentProblems;

  const {
    selectedIndex,
    setSelectedIndex,
    selectedStudent,
    selectedStudentId,
    selectedProblemId,
    handleSelectProblem,
    handleSelectChange,
  } = useReviewSelection({ students, visibleProblems });

  // Number keys 1-9 jump to that problem (matching the numbers in the list), unless
  // the user is typing in a field (comment box, grade input, student search, etc.).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      /**
       * Only while focus is inside the review panel.
       *
       * WCAG 2.1.4 allows a single-character shortcut when it is active only on focus, and
       * these are letters and digits bound to the window. The typing guard below is not the
       * same thing: it covers a text field, not somebody dictating with speech input or
       * reading the page in a screen reader's browse mode, where a stray "g" or "3" silently
       * changed which problem was being graded.
       */
      const root = rootRef.current;
      if (!root || !(document.activeElement && root.contains(document.activeElement))) return;
      if (isTypingTarget(e)) return;
      // Grading is the reason to be here, so it gets a key of its own rather than a reach
      // for the mouse after every problem change.
      if (e.key === 'g' || e.key === 'G') {
        const field = document.getElementById(GRADE_INPUT_ID);
        if (field) {
          e.preventDefault();
          field.focus();
        }
        return;
      }
      if (e.key >= '1' && e.key <= '9') {
        const problem = visibleProblems[Number(e.key) - 1];
        if (problem) {
          e.preventDefault();
          handleSelectProblem(problem.id);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visibleProblems, handleSelectProblem]);

  // Review data (submissions + comments + problem grades) for the selected student:
  // the TanStack Query fetch, its cold-load flag, and refresher live in a hook.
  const { reviewData, reviewQueryIsError, reviewError, reviewFetching, refreshReview } =
    useReviewData(courseId, assignmentId, selectedStudentId);

  const {
    commentTexts,
    setCommentText,
    savingComments,
    deletingComments,
    commentTarget,
    setCommentTarget,
    saveComment,
    deleteComment,
  } = useComments({
    courseId,
    assignmentId,
    selectedStudentId,
    group: reviewData?.group,
    groupMembers: reviewData?.groupMembers,
  });

  const {
    problemGrades,
    gradeInputs,
    problemGradeErrors,
    savingProblemGrades,
    studentGradeStatuses,
    studentEarned,
    handleGradeInputChange,
    saveProblemGrade,
    setManualHold,
    gradeTarget,
    setGradeTarget,
    pendingGroupGrade,
    confirmGroupGrade,
    cancelGroupGrade,
  } = useProblemGrades({
    courseId,
    assignmentId,
    courseIsArchived,
    students,
    selectedStudent,
    assignmentProblems,
    reviewData,
    reviewQueryIsError,
    reviewError,
    group: reviewData?.group,
    groupMembers: reviewData?.groupMembers,
  });

  // All three loading flags previously flipped together; they track the cold load.
  const loadingSubmissions = reviewFetching;
  const loadingComments = reviewFetching;
  const loadingProblemGrades = reviewFetching;

  // Group assignment for the selected student => the workspace shows a "Submitted by"
  // column so staff can see which member made each attempt.
  const reviewIsGroup = !!reviewData?.isGroup;

  // Read-only review data derived straight from the query cache instead of being
  // mirrored into state by an effect. Empty for no selected student or a failed load
  // (the query data is then undefined).
  const submissions = useMemo<Record<string, SubmissionData>>(
    () => (selectedStudentId ? (reviewData?.submissions ?? {}) : {}),
    [selectedStudentId, reviewData],
  );

  // Comments grouped by problem id (every visible problem gets an entry, even if
  // empty). Optimistic add/delete update the review-data cache (see saveComment /
  // deleteComment), so this memo stays the single source of truth.
  const comments = useMemo<Record<string, DiscussionComment[]>>(() => {
    const grouped = Object.fromEntries(
      assignmentProblems.map((problem) => [problem.id, [] as DiscussionComment[]]),
    ) as Record<string, DiscussionComment[]>;
    if (!selectedStudentId || !reviewData) return grouped;
    for (const comment of reviewData.comments ?? []) {
      const problemId = comment.problemId;
      if (problemId && grouped[problemId]) grouped[problemId].push(comment);
    }
    return grouped;
  }, [assignmentProblems, reviewData, selectedStudentId]);

  // The whole assignment at a glance, for the strip. Both come from the grades already
  // loaded for this student, so neither needs a request of its own.
  const assignmentTotals = useMemo(() => {
    const totalPoints = assignmentProblems.reduce((sum, p) => sum + (p.maxPoints ?? 0), 0);
    const earned = assignmentProblems.reduce((sum, p) => sum + (problemGrades[p.id] ?? 0), 0);
    const graded = assignmentProblems.filter((p) => typeof problemGrades[p.id] === 'number').length;
    return { totalPoints, earned, graded, count: assignmentProblems.length };
  }, [assignmentProblems, problemGrades]);

  // The problem whose submissions are on screen; also the target of a grant action.
  const selectedProblem = useMemo(
    () =>
      selectedProblemId
        ? (visibleProblems.find((p) => p.id === selectedProblemId) ?? null)
        : (visibleProblems[0] ?? null),
    [selectedProblemId, visibleProblems],
  );

  const handleRerunSubmission = useCallback(
    async (submission: Submission) => {
      await rerunSubmission({ submission, setRerunning, fetchReviewData: refreshReview });
    },
    [refreshReview],
  );

  const goPrev = () =>
    setSelectedIndex((prev) =>
      students.length === 0 ? -1 : prev <= 0 ? students.length - 1 : prev - 1,
    );
  const goNext = () =>
    setSelectedIndex((prev) =>
      students.length === 0 ? -1 : prev >= students.length - 1 ? 0 : prev + 1,
    );

  // Left/Right arrows page to the previous/next student (wrapping), unless the user is
  // typing in a field (so arrow keys still move the cursor there).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return;
      const count = students.length;
      if (count === 0) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev <= 0 ? count - 1 : prev - 1));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev >= count - 1 ? 0 : prev + 1));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // setSelectedIndex is a useState setter from useReviewSelection, so it is stable; the
    // linter cannot see that through the hook boundary.
  }, [students.length, setSelectedIndex]);

  const isStudentDataLoading = loadingSubmissions || loadingComments || loadingProblemGrades;

  useEffect(() => {
    if (isStudentDataLoading) {
      const timeoutId = setTimeout(() => {
        setShowStudentDataLoading(true);
      }, 150);

      return () => clearTimeout(timeoutId);
    }

    setShowStudentDataLoading(false);
    return undefined;
  }, [isStudentDataLoading]);

  // The panel is built around a selected student, so everything before there is one needs
  // saying out loud. It used to render an empty div: a course with nobody enrolled looked
  // identical to a page that had failed, and every cold load flashed blank first.
  const heading = (
    <h2 className="flex items-center gap-2 text-xl font-semibold">
      <FileText className="h-6 w-6" /> Submissions
    </h2>
  );

  if (studentsQuery.isPending) {
    return (
      <div className="space-y-4">
        {heading}
        <DataTableLoading message="Loading students, please wait..." className="min-h-[320px]" />
      </div>
    );
  }

  if (studentsQueryIsError) {
    return (
      <div className="space-y-4">
        {heading}
        <div className="text-muted-foreground rounded-md border border-dashed p-6 text-center text-sm">
          Could not load the student list. Refresh the page to try again.
        </div>
      </div>
    );
  }

  if (students.length === 0) {
    return (
      <div className="space-y-4">
        {heading}
        <div className="text-muted-foreground rounded-md border border-dashed p-6 text-center text-sm">
          Nobody is enrolled in this course yet. Add students on the Roster tab, and their
          submissions will appear here.
        </div>
      </div>
    );
  }

  return (
    // Focus inside this element is what arms the single-key shortcuts; see the handler above.
    <div ref={rootRef}>
      {selectedStudent && (
        <div className="space-y-4">
          <div>
            <h2 className="flex items-center gap-2 text-xl font-semibold">
              <FileText className="h-6 w-6" /> Submissions
            </h2>

            <ReviewStrip
              className="mt-4"
              hour12={hour12}
              students={students}
              selectedIndex={selectedIndex}
              onSelectStudent={handleSelectChange}
              onPrevStudent={goPrev}
              onNextStudent={goNext}
              gradeStatuses={studentGradeStatuses}
              earnedByStudent={studentEarned}
              groupInfo={
                reviewData
                  ? {
                      isGroupAssignment: reviewData.isGroupAssignment,
                      isGroup: !!reviewData.isGroup,
                      group: reviewData.group ?? null,
                      members: reviewData.groupMembers ?? [],
                      effective: reviewData.effective,
                    }
                  : null
              }
              problems={visibleProblems}
              selectedProblemId={selectedProblem?.id ?? null}
              onSelectProblem={handleSelectProblem}
              problemGrades={problemGrades}
              assignment={assignmentShell}
              effective={reviewData?.effective ?? null}
              timezone={timezone}
              totals={assignmentTotals}
            />
          </div>

          <div role="region" aria-labelledby="review-student-heading">
            {/* Names the panel with the selected student so the region is meaningful
                to screen readers; StudentNavigator's live region announces changes. */}
            <h3 id="review-student-heading" className="sr-only">
              Reviewing{' '}
              {`${selectedStudent.firstName ?? ''} ${selectedStudent.lastName ?? ''}`.trim() ||
                'this student'}
            </h3>
            {assignmentProblems.length === 0 ? (
              <div className="text-muted-foreground rounded-md border border-dashed p-6 text-center text-sm">
                No problems have been added to this assignment yet.
              </div>
            ) : showStudentDataLoading ? (
              <DataTableLoading
                message="Loading submissions, please wait..."
                className="min-h-[320px]"
              />
            ) : (
              (() => {
                const selectedSubs = selectedProblem
                  ? extractSubs(submissions[selectedProblem.id])
                  : [];
                const selectedComments = selectedProblem ? comments[selectedProblem.id] || [] : [];

                // Staff can hand the selected student (or their group) extra attempts on the
                // selected problem, on top of the shared cap. It sits in the Submissions
                // panel header because that is what it acts on; floating above the layout it
                // competed for attention with the grade box and pointed at nothing.
                // Granting extra attempts only means something when there is a cap to add to.
                // `max: null` from the limit resolver is "unlimited", which a problem gets by
                // having a base of zero or less, so the button would promise nothing.
                const problemLimit = selectedProblem
                  ? reviewData?.problemLimits?.[selectedProblem.id]
                  : undefined;
                const hasSubmissionCap = problemLimit
                  ? problemLimit.max !== null
                  : (selectedProblem?.maxSubmissions ?? 0) > 0;

                // The menu itself always shows: it carries the keyboard shortcuts, which are
                // useful whatever the problem's submission cap is. Only the grant item depends
                // on there being a cap to add to.
                const grantAction = selectedProblem ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label="Problem actions">
                        <MoreVertical className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {hasSubmissionCap ? (
                        <DropdownMenuItem
                          disabled={courseIsArchived}
                          onClick={() => setGrantDialogOpen(true)}
                        >
                          Grant extra submissions
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem onClick={() => setShortcutsOpen(true)}>
                        Keyboard shortcuts
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null;

                const workspace = (
                  <ProblemWorkspace
                    assignmentId={assignmentId}
                    // Who the LMS panel below the grade reports on, and sends for.
                    studentId={selectedStudentId}
                    // The header shows the cap the SELECTED student is working against
                    // (base plus any grants), not just the shared base value.
                    problem={
                      selectedProblem
                        ? {
                            ...selectedProblem,
                            maxSubmissions:
                              reviewData?.problemLimits?.[selectedProblem.id]?.max ??
                              selectedProblem.maxSubmissions,
                          }
                        : null
                    }
                    submissions={selectedSubs}
                    assignmentDueDate={assignmentDueDate}
                    submissionsAction={grantAction}
                    group={reviewData?.group ?? null}
                    groupMembers={reviewData?.groupMembers}
                    gradedManually={
                      selectedProblem
                        ? (reviewData?.problemGrades?.[selectedProblem.id]?.gradedManually ?? false)
                        : false
                    }
                    gradeSource={
                      selectedProblem
                        ? (reviewData?.problemGrades?.[selectedProblem.id]?.gradeSource ??
                          'AUTOGRADER')
                        : 'AUTOGRADER'
                    }
                    onManualHoldChange={(held) =>
                      selectedProblem && void setManualHold(selectedProblem.id, held)
                    }
                    showSubmitter={reviewIsGroup}
                    subjectName={
                      `${selectedStudent.firstName ?? ''} ${selectedStudent.lastName ?? ''}`.trim() ||
                      'this student'
                    }
                    commentAudience={
                      reviewData?.group
                        ? {
                            group: reviewData.group,
                            studentName:
                              `${selectedStudent.firstName ?? ''} ${selectedStudent.lastName ?? ''}`.trim() ||
                              'this student',
                            target: commentTarget,
                            onTargetChange: setCommentTarget,
                          }
                        : null
                    }
                    comments={selectedComments}
                    commentText={selectedProblem ? commentTexts[selectedProblem.id] || '' : ''}
                    onCommentTextChange={(text: string) =>
                      selectedProblem && setCommentText(selectedProblem.id, text)
                    }
                    onSaveComment={() => selectedProblem && saveComment(selectedProblem.id)}
                    onDeleteComment={(commentId: string) =>
                      selectedProblem && deleteComment(commentId)
                    }
                    isSaving={selectedProblem ? savingComments[selectedProblem.id] : false}
                    deletingComments={deletingComments}
                    onViewSubmission={(submission: ProblemSubmission) =>
                      setOpenDialog({ open: true, submission })
                    }
                    onRerunSubmission={(submission) =>
                      handleRerunSubmission(submission as unknown as Submission)
                    }
                    rerunning={rerunning}
                    courseIsArchived={courseIsArchived}
                    gradeInput={selectedProblem ? gradeInputs[selectedProblem.id] || '' : ''}
                    currentGrade={
                      selectedProblem ? (problemGrades[selectedProblem.id] ?? null) : null
                    }
                    gradeError={
                      selectedProblem ? problemGradeErrors[selectedProblem.id] || null : null
                    }
                    onGradeInputChange={(value) =>
                      selectedProblem && handleGradeInputChange(selectedProblem.id, value)
                    }
                    onSaveGrade={() => selectedProblem && saveProblemGrade(selectedProblem.id)}
                    isSavingGrade={
                      selectedProblem ? Boolean(savingProblemGrades[selectedProblem.id]) : false
                    }
                    isLoadingGrade={loadingProblemGrades}
                    groupGradeValue={
                      selectedProblem
                        ? (reviewData?.problemGrades?.[selectedProblem.id]?.groupGradeValue ?? null)
                        : null
                    }
                    gradeAudience={
                      reviewData?.group
                        ? {
                            group: reviewData.group,
                            studentName:
                              `${selectedStudent.firstName ?? ''} ${selectedStudent.lastName ?? ''}`.trim() ||
                              'this student',
                            target: gradeTarget,
                            onTargetChange: setGradeTarget,
                          }
                        : null
                    }
                    isPrivilegedUser={true}
                  />
                );

                // Stack on small screens; a fixed two-column layout on desktop.
                return <div className="min-w-0">{workspace}</div>;
              })()
            )}
          </div>
        </div>
      )}

      {selectedStudent && selectedProblem && grantMounted && (
        <GrantExtraSubmissionsDialog
          open={grantDialogOpen}
          setOpen={setGrantDialogOpen}
          courseId={courseId}
          assignmentId={assignmentId}
          problemId={selectedProblem.id}
          problemTitle={selectedProblem.title ?? null}
          student={{
            id: selectedStudent.id,
            name:
              `${selectedStudent.firstName ?? ''} ${selectedStudent.lastName ?? ''}`.trim() ||
              'this student',
          }}
          groupId={reviewData?.groupId ?? null}
          onGranted={refreshReview}
        />
      )}

      {/* Applying a group grade over members who already differ. Naming them and their
          current grades makes overwriting somebody's deliberate adjustment a decision rather
          than a side effect of a routine save. */}
      <ConfirmDialog
        open={!!pendingGroupGrade}
        title={`Overwrite ${pendingGroupGrade?.conflicts.length === 1 ? 'a grade' : 'grades'} in ${pendingGroupGrade?.groupName ?? 'this group'}?`}
        description={
          pendingGroupGrade ? (
            <>
              <span className="block">
                Giving {pendingGroupGrade.groupName} {pendingGroupGrade.grade} will replace what
                these members already have:
              </span>
              <ul className="mt-2 list-disc pl-5">
                {pendingGroupGrade.conflicts.map((c) => (
                  <li key={c.studentId}>
                    {c.name} currently has {c.grade}
                  </li>
                ))}
              </ul>
            </>
          ) : null
        }
        confirmText="Overwrite and apply"
        onConfirm={confirmGroupGrade}
        onCancel={cancelGroupGrade}
      />

      <ReviewShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />

      {openDialog.submission && (
        <SubmissionViewerDialog
          open={openDialog.open}
          onOpenChange={(open) => setOpenDialog({ open, submission: null })}
          problemType={visibleProblems.find((p) => p.id === selectedProblemId)?.type}
          src={apiPaths.files.submission(encodeURIComponent(openDialog.submission.fileName ?? ''))}
          title={`${openDialog.submission.originalFileName || openDialog.submission.fileName} - Submission`}
          fileName={
            openDialog.submission.originalFileName || openDialog.submission.fileName || undefined
          }
          epsSymbol={epsSymbol}
          width="70vw"
          height="70vh"
        />
      )}
    </div>
  );
}
