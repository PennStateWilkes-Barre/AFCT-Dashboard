'use client';

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { showToast } from '@/lib/toast';
import { ArrowLeft, ClipboardList, Lock } from 'lucide-react';
import { useEmptyStringSymbol } from '@/hooks/use-empty-string-symbol';
import {
  IdentityPanel,
  IdentityPanelIcon,
  IDENTITY_BADGE,
  IDENTITY_LINK,
} from '@/components/IdentityPanel';
import { ProblemListCard } from '@/components/assignments/ProblemListCard';
import ProblemWorkspace from '@/components/assignments/ProblemWorkspace';
import { SubmissionViewerDialog } from '@/components/dialogs/SubmissionViewerDialog';
import { useEffectiveTimezone } from '@/hooks/use-effective-timezone';
import { formatDeadlineDual } from '@/lib/date-format';
import { apiPaths } from '@/lib/api-paths';
import { queryKeys } from '@/lib/query-keys';
import { fetchJson, HttpError } from '@/lib/query-fetch';
import { RichDescription } from '@/components/rich-description/RichDescription';
import type {
  AssignmentWithDetails,
  StudentAssignmentContext,
  StudentProblemComment,
  StudentProblemSubmission,
} from '@/lib/assignment-details';
import { cn } from '@/lib/utils';

type StudentAssignmentViewProps = {
  initialAssignment?: AssignmentWithDetails | null;
};

// Stable empty defaults so the values derived from the context query keep a
// constant identity between renders (keeps the memoized problem list stable).
const EMPTY_SUBMISSIONS: Record<string, StudentProblemSubmission[]> = {};
const EMPTY_COMMENTS: Record<string, StudentProblemComment[]> = {};
const EMPTY_GRADES: Record<string, number | null> = {};
/** Stable identity, so the memo below is not invalidated on every render. */
const EMPTY_MISSING: string[] = [];
const EMPTY_GROUP_MEMBERS: Array<{
  id: string;
  firstName: string | null;
  lastName: string | null;
}> = [];

export default function StudentAssignmentPage({
  initialAssignment = null,
}: StudentAssignmentViewProps) {
  const params = useParams<{ id: string; aid: string }>();
  const assignmentId = params?.aid;

  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const { timezone, hour12 } = useEffectiveTimezone();
  const userId = session?.user?.id ?? null;
  // No per-course role is available here; a non-admin viewer is treated as a
  // student for the purpose of hiding unpublished assignments.
  const isStudent = !session?.user?.isAdmin;

  const queryClient = useQueryClient();

  // Assignment shell: cached; the SSR-provided assignment seeds it so there's no
  // refetch on mount when the server already sent it, and back-navigation is warm.
  const assignmentQuery = useQuery({
    queryKey: queryKeys.assignment.shell(params.id, assignmentId),
    queryFn: () =>
      fetchJson<AssignmentWithDetails>(
        apiPaths.assignment(params.id, assignmentId, { view: 'problems' }),
      ),
    initialData: initialAssignment ?? undefined,
    enabled: !!assignmentId && !!session,
    retry: false,
    staleTime: 30_000,
  });
  const assignment = assignmentQuery.data ?? null;
  const loading = assignmentQuery.isPending;
  const epsSymbol = useEmptyStringSymbol(assignment?.courseId);

  // Per-student submissions, comments, and grades: cached, and re-pulled (via
  // invalidation) after the student adds or deletes a comment.
  const contextQuery = useQuery({
    queryKey: queryKeys.assignment.studentContext(params.id, assignmentId),
    queryFn: () =>
      fetchJson<StudentAssignmentContext>(
        apiPaths.assignmentStudentContext(params.id, assignmentId),
      ),
    enabled: !!assignmentId && !!userId,
    staleTime: 30_000,
  });
  const submissions = contextQuery.data?.submissionsByProblem ?? EMPTY_SUBMISSIONS;
  const comments = contextQuery.data?.commentsByProblem ?? EMPTY_COMMENTS;
  const problemGrades = contextQuery.data?.problemGrades ?? EMPTY_GRADES;
  // Which of those zeros are for work never handed in, so the list can say so.
  const missingProblems: string[] = contextQuery.data?.missingProblems ?? EMPTY_MISSING;
  const assignmentGrade = contextQuery.data?.assignmentGrade ?? null;
  // Only ever set on a group assignment, and only ever the caller's own group.
  const myGroup = contextQuery.data?.group ?? null;
  const myGroupMembers = contextQuery.data?.groupMembers ?? EMPTY_GROUP_MEMBERS;
  const problemLimits = contextQuery.data?.problemLimits;
  // The cap that applies to THIS student (base plus any extra-submission grants). An
  // unlimited effective cap keeps the base sentinel so the existing "<= 0 or null means
  // unlimited" rendering stays the single convention.
  const effectiveMax = useCallback(
    (problemId: string, base: number | null | undefined) => {
      const limit = problemLimits?.[problemId];
      return limit && limit.max != null ? limit.max : (base ?? null);
    },
    [problemLimits],
  );
  // Cold-load only: after the student adds/deletes a comment the context query is
  // invalidated and refetches; isFetching would blank the submissions/comments
  // panels on every such refetch. isPending is true only before the first load.
  const submissionsLoading = contextQuery.isPending;
  const commentsLoading = contextQuery.isPending;

  const [newComment, setNewComment] = useState<Record<string, string>>({});
  const [submittingComment, setSubmittingComment] = useState<Record<string, boolean>>({});
  const [selectedProblemId, setSelectedProblemId] = useState<string | null>(null);
  const [openDialog, setOpenDialog] = useState<{
    open: boolean;
    submission: StudentProblemSubmission | null;
  }>({ open: false, submission: null });
  const limitText = (value: string, max = 120) =>
    value.length > max ? `${value.slice(0, max - 1)}…` : value;

  // Re-pull the student context after a mutation (comment add/delete); the query
  // refetches because it's active.
  const refreshContext = useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.assignment.studentContext(params.id, assignmentId),
      }),
    [queryClient, params.id, assignmentId],
  );

  const handleSubmitComment = useCallback(
    async (problemId: string) => {
      const text = newComment[problemId]?.trim();
      if (!text) return;

      setSubmittingComment((prev) => ({ ...prev, [problemId]: true }));

      try {
        const response = await fetch(apiPaths.comments(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text, assignmentId, problemId }),
        });

        if (!response.ok) {
          throw new Error('Could not post your comment. Check your connection and try again.');
        }

        setNewComment((prev) => ({ ...prev, [problemId]: '' }));
        await refreshContext();
        showToast.created('Comment');
      } catch (error) {
        console.error('Error submitting comment:', error);
        showToast.error('Could not post your comment. Check your connection and try again.');
      } finally {
        setSubmittingComment((prev) => ({ ...prev, [problemId]: false }));
      }
    },
    [refreshContext, newComment, assignmentId],
  );

  const handleDeleteComment = useCallback(
    async (commentId: string) => {
      try {
        const response = await fetch(apiPaths.comments({ commentId }), {
          method: 'DELETE',
        });
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(
            error?.error || 'Could not delete the comment. Check your connection and try again.',
          );
        }
        await refreshContext();
        showToast.deleted('Comment');
      } catch (error) {
        console.error('Error deleting comment:', error);
        showToast.error('Could not delete the comment. Check your connection and try again.');
      }
    },
    [refreshContext],
  );

  /**
   * Say what actually happened, and only offer a refresh when one might help.
   *
   * A 404 is gone-or-forbidden and a 403 is a door that is shut for a reason the server can
   * name (an unpublished course, most often, which is what every student sees who follows an
   * LMS link before their instructor publishes). Both leave nothing on this page worth
   * standing on, so they go back to the dashboard with the reason. Telling somebody to refresh
   * a page that will never load was the old behaviour and it wasted their time.
   */
  /**
   * Reported once, however many of the page's reads fail.
   *
   * The assignment and its context are fetched separately and fail together, so a student who
   * followed a link to something they cannot open was told twice and pushed to the dashboard
   * twice. One cause, one message, whatever the cause was.
   */
  /**
   * What this page load has already said, ranked.
   *
   * Two reads fail together, so one cause used to be reported twice. A plain "reported
   * already" flag fixes that and creates a worse fault: whichever read failed first decides
   * everything, so a 500 arriving before a 403 swallows the 403 *and the redirect it owes*,
   * leaving somebody sitting on a page they have no access to.
   *
   * Ranking keeps both properties. A generic failure speaks only if nothing has; a terminal
   * one (gone, or refused) always gets its say once, because it is the answer and it carries
   * the navigation. Worst case is two messages, and only when the two reads genuinely
   * disagree about what went wrong.
   */
  const reported = useRef<'none' | 'generic' | 'terminal'>('none');

  const reportLoadFailure = useCallback(
    (error: unknown, context: string) => {
      const status = error instanceof HttpError ? error.status : undefined;
      const terminal = status === 404 || status === 403;

      // A terminal answer speaks once, whatever came before it; a generic one only when the
      // page has said nothing at all.
      if (terminal ? reported.current === 'terminal' : reported.current !== 'none') return;
      reported.current = terminal ? 'terminal' : 'generic';

      if (status === 404) {
        showToast.error(
          'This assignment is not available. It may have been removed, or you may not have access to it.',
        );
        router.push('/dashboard');
        return;
      }
      if (status === 403) {
        showToast.error(
          error instanceof HttpError && error.message && error.message !== 'Forbidden'
            ? error.message
            : 'You do not have access to this assignment.',
        );
        router.push('/dashboard');
        return;
      }
      console.error(context, error);
      showToast.error('Could not load the assignment. Refresh the page to try again.');
    },
    [router],
  );

  /**
   * A load that works clears the slate, so a failure in a later cycle is still reported. The
   * page refetches in place (see `refreshContext`), and without this the first failure would
   * silence every later one for as long as the page stayed open.
   */
  useEffect(() => {
    if (assignmentQuery.isSuccess && contextQuery.isSuccess) reported.current = 'none';
  }, [assignmentQuery.isSuccess, contextQuery.isSuccess]);

  useEffect(() => {
    if (assignmentQuery.error)
      reportLoadFailure(assignmentQuery.error, 'Error fetching assignment:');
  }, [assignmentQuery.error, reportLoadFailure]);

  useEffect(() => {
    if (contextQuery.isError) {
      reportLoadFailure(contextQuery.error, 'Error fetching assignment context:');
    }
  }, [contextQuery.isError, contextQuery.error, reportLoadFailure]);

  useEffect(() => {
    if (!assignment || assignment.problems.length === 0) {
      setSelectedProblemId(null);
      return;
    }

    const preferredProblemId = searchParams.get('problem');
    if (
      preferredProblemId &&
      assignment.problems.some((ap) => ap.problem.id === preferredProblemId)
    ) {
      setSelectedProblemId(preferredProblemId);
      return;
    }

    setSelectedProblemId((prev) => {
      if (prev && assignment.problems.some((ap) => ap.problem.id === prev)) {
        return prev;
      }
      return assignment.problems[0]?.problem.id ?? null;
    });
  }, [assignment, searchParams]);

  const problemListItems = useMemo(() => {
    if (!assignment) return [];
    return assignment.problems.map((assignmentProblem, index) => ({
      id: assignmentProblem.problem.id,
      title: assignmentProblem.problem.title
        ? limitText(assignmentProblem.problem.title, 25)
        : `Problem ${index + 1}`,
      grade: problemGrades[assignmentProblem.problem.id] ?? null,
      missing: missingProblems.includes(assignmentProblem.problem.id),
      maxGrade: assignmentProblem.maxPoints ?? null,
      submissionsCount: submissions[assignmentProblem.problem.id]?.length ?? 0,
      maxSubmissions: effectiveMax(assignmentProblem.problem.id, assignmentProblem.maxSubmissions),
    }));
  }, [assignment, submissions, problemGrades, missingProblems, effectiveMax]);

  // Both announce. On a first paint plain text would do, but this same branch renders when
  // moving between assignments client-side, where the change is otherwise silent.
  if (loading) {
    return (
      <div className="p-6" role="status" aria-live="polite">
        Loading assignment...
      </div>
    );
  }

  if (!assignment) {
    return (
      <div className="p-6" role="alert">
        Assignment not found.
      </div>
    );
  }

  if (isStudent && !assignment.isPublished) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground">This assignment is not yet available.</p>
            <Button
              variant="outline"
              onClick={() => router.push(`/dashboard/courses/${assignment.courseId}`)}
              className="mt-4"
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Course
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const allowLateSubmissions = assignment.allowLateSubmissions ?? false;
  const lateCutoffDate = assignment.lateCutoff ? new Date(assignment.lateCutoff) : null;
  // Show deadlines in the student's local zone AND the course zone (when they differ),
  // so a student in a different timezone can't misread the cutoff.
  const courseZone = assignment.course?.timezone ?? null;
  const dueDisplay = formatDeadlineDual(assignment.dueDate, timezone, courseZone, hour12);
  const lateCutoffDisplay = allowLateSubmissions
    ? lateCutoffDate
      ? formatDeadlineDual(lateCutoffDate, timezone, courseZone, hour12)
      : 'Never'
    : 'Not allowed';
  const latePolicyDisplay = !allowLateSubmissions
    ? 'Not accepted'
    : lateCutoffDate
      ? `Accepted until ${lateCutoffDisplay}`
      : 'Accepted anytime';
  const gradeDisplay = assignmentGrade !== null ? `${assignmentGrade}` : '-';
  // Individual vs group, derived from the group set link; there is no stored flag. It matters
  // to a student before they start: a group assignment shares one set of submissions.
  const typeDisplay = assignment?.groupSetId ? 'Group' : 'Individual';
  // When it opens, in the student's own timezone plus the course's where they differ, the
  // same way the deadline beside it is written.
  const unlockDisplay = assignment?.unlockAt
    ? formatDeadlineDual(assignment.unlockAt, timezone, assignment.course?.timezone ?? null, hour12)
    : null;
  // Either form counts: a rich-only assignment still has something to show.
  const hasDescription = Boolean(assignment?.description || assignment?.descriptionJson);
  /**
   * The description, rendered in whichever of its two homes applies. `headingTag` and
   * `baseLevel` travel together: the content's own headings must start one level below the
   * "Description" label above them, and that label sits at a different depth in each home.
   */
  const descriptionSection = (headingTag: 'h2' | 'h3', baseLevel: 3 | 4) => {
    const Heading = headingTag;
    return (
      <div className={headingTag === 'h3' ? 'mt-4' : undefined}>
        {/* "Assignment Description", not "Description": the problem selected below carries one
            too, and on a page showing both at once the bare word did not say whose. */}
        <Heading className="mb-2 font-semibold">Assignment Description</Heading>
        {/* Plain text on the card, not a bordered box that scrolls and drags to resize. The
            box existed to bound a long description, and the cost was a frame, a scrollbar and
            a tab stop around three sentences. The focusable-region markup went with it: a
            container only needs to be reachable by keyboard while it is the thing that
            scrolls (WCAG 2.1.1), and this one no longer does.

            A div, not a p: a rich description can contain headings, lists and rules, which
            are invalid inside a paragraph. */}
        <div className="text-muted-foreground">
          <RichDescription
            headingBaseLevel={baseLevel}
            description={assignment?.description}
            descriptionJson={assignment?.descriptionJson}
          />
        </div>
      </div>
    );
  };
  const courseIsArchived = assignment.course?.isArchived ?? false;
  // The course, written the way the course page's own title writes it, so a student sees the
  // same name in the banner they just came from. The code is not always present, so the name
  // has to stand alone.
  const courseCode = assignment.course?.code ?? assignment.courseCode ?? '';
  const courseName = assignment.course?.name ?? assignment.courseName ?? assignment.courseId;
  const courseLabel = courseCode ? `${courseCode}: ${courseName}` : courseName;

  const selectedProblem = selectedProblemId
    ? assignment.problems.find((ap) => ap.problem.id === selectedProblemId) || null
    : null;
  const selectedProblemSubmissions = selectedProblemId ? submissions[selectedProblemId] || [] : [];
  const selectedProblemComments = selectedProblemId ? comments[selectedProblemId] || [] : [];
  const selectedProblemGrade = selectedProblem
    ? (problemGrades[selectedProblem.problem.id] ?? selectedProblemSubmissions[0]?.grade ?? null)
    : null;
  const selectedProblemDetails = selectedProblem
    ? {
        ...selectedProblem.problem,
        // Points / submission cap / autograding are per-assignment (on the link). The
        // cap shown is the one that applies to THIS student, grants included.
        maxPoints: selectedProblem.maxPoints,
        maxSubmissions: effectiveMax(selectedProblem.problem.id, selectedProblem.maxSubmissions),
        autograderEnabled: selectedProblem.autograderEnabled,
      }
    : null;

  return (
    // No padding of its own. `dashboard/layout.tsx` puts `px-4 py-6 lg:px-6` on <main> and
    // WorkspaceSurface restores it inside its negative margins, so a `p-6` here was a second
    // gutter on top of the first: this page sat further in than the course page it is one
    // click from, and it did not narrow with the layout's own `px-4` on a phone. The staff
    // assignment view and the course page both rely on the layout's gutter alone.
    <div className="space-y-6">
      {/*
        The same branded banner the course page and the staff assignment page lead with, in its
        quieter tone. A student who opens a course gets the navy banner and then landed on a plain
        white card one click later, which read as two different applications.

        Staff-only controls are absent rather than disabled: no publish switch, no assignment
        picker, no LMS state. That is a matter of not rendering them here at all, not of hiding
        them, so nothing staff-only travels into the student bundle through the shared shell. The
        shell owns the surface; each page owns what goes in it.

        No "Assignment:" prefix on the title any more. It was doing the work the icon and the
        course line under it now do, and it pushed the assignment's own name to second place in
        its own heading.
      */}
      <IdentityPanel labelledBy="assignment-page-title" tone="operational">
        {/* basis-full below sm so the title claims its own row and the grade drops beneath it,
            rather than the chip taking the line and squeezing a long assignment name into a
            column of single letters. The course banner solves the same problem the same way. */}
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-1 basis-full items-start gap-3 sm:basis-0 sm:gap-4">
            <IdentityPanelIcon icon={ClipboardList} />
            <div className="flex min-w-0 flex-col gap-1">
              <h1
                id="assignment-page-title"
                className="min-w-0 text-2xl leading-tight font-semibold tracking-tight break-words"
              >
                {assignment.title}
              </h1>
            </div>
          </div>

          {/* The one number a student came for, promoted out of the row of facts below the
              title and into the banner beside it. IDENTITY_BADGE rather than a badge variant:
              the banner is navy in every theme, and the semantic fills are page tokens that
              vanish on it in dark mode. See the note on IdentityPanel. */}
          <div
            className={cn(
              IDENTITY_BADGE,
              'inline-flex min-h-10 shrink-0 items-center gap-2 rounded-full border px-4 py-2',
            )}
          >
            <span className="text-xs font-semibold tracking-widest uppercase">Grade</span>
            <span className="text-sm leading-none font-semibold tabular-nums">
              {gradeDisplay} / {assignment.maxPoints}
            </span>
          </div>
        </div>

        {/* The terms the work is done under, written the way the course banner writes its
            faculty line: label/value pairs on one wrapping row rather than chips. A late
            policy reads "Accepted until 09/25/26 11:59 PM EDT", which is a sentence, and four
            chips of that length wrap into a block that competes with the title.

            Indented to the title's text rather than the banner edge on wide screens, so the
            identity block reads as one column: the sm icon is 56px and the gap beside it 16.
            No indent below sm, where the rows are stacked full width anyway. */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm sm:pl-[4.5rem]">
          {/* The way back, first on the line rather than tucked under the title. It is the
              one item here that goes somewhere, so it leads the row the way a breadcrumb
              would; the rest of the row states the terms of the work. */}
          {assignment.course || assignment.courseName ? (
            <span className="max-w-full">
              <span className="text-course-banner-muted-foreground">Course: </span>
              <Link
                href={`/dashboard/courses/${assignment.course?.id || assignment.courseId}`}
                className={cn(IDENTITY_LINK, 'font-medium break-words')}
              >
                {courseLabel}
              </Link>
            </span>
          ) : null}
          <span>
            <span className="text-course-banner-muted-foreground">Due: </span>
            <span className="font-medium">{dueDisplay}</span>
          </span>
          <span>
            <span className="text-course-banner-muted-foreground">Late policy: </span>
            <span className="font-medium">{latePolicyDisplay}</span>
          </span>
          <span>
            <span className="text-course-banner-muted-foreground">Type: </span>
            <span className="font-medium">{typeDisplay}</span>
          </span>
        </div>
      </IdentityPanel>

      {/* When the assignment has no problems there is no card below to put the description
          in, so it keeps a card of its own. Same content either way; only the heading level
          differs, because nested under the problems card it sits below that card's own h2. */}
      {hasDescription && assignment.problems.length === 0 ? (
        <Card>
          <CardContent className="pt-6">{descriptionSection('h2', 3)}</CardContent>
        </Card>
      ) : null}

      {/* Not open yet.
          The release time withholds the description and the problems, so without this the
          page rendered its banner and then nothing at all: no prompt, no problem list, and no
          reason given. The assignment's existence is not the secret (it is listed on the
          course page with its opening date), so the honest thing is to say when it opens. */}
      {assignment.locked ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <Lock className="text-muted-foreground size-6" aria-hidden="true" />
            <h2 className="text-lg font-semibold">This assignment has not opened yet</h2>
            <p className="text-muted-foreground max-w-prose text-sm">
              {unlockDisplay
                ? `Its problems and instructions become available on ${unlockDisplay}.`
                : 'Its problems and instructions are not available yet.'}
            </p>
          </CardContent>
        </Card>
      ) : null}

      {!assignment.locked && assignment.problems.length > 0 ? (
        <Card>
          <CardHeader className="pb-3">
            {/* The assignment's name is the banner's h1 two inches above; repeating it as the
                card's title said the same word twice and pushed the first thing a student
                actually needs to read further down.

                No row of fact chips here either. Due, the late policy and the type are in the
                banner, where they are terms of the assignment rather than a property of its
                problem list; the points total is the denominator of the grade beside it there,
                and the problem count is the list immediately below. */}
            {hasDescription ? descriptionSection('h2', 3) : null}
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(240px,280px)_1fr]">
              <ProblemListCard
                problems={problemListItems}
                selectedProblemId={selectedProblemId}
                onSelect={(problemId) => setSelectedProblemId(problemId)}
                className="h-full"
                scrollAreaClassName="max-h-[520px]"
                description="Select a problem to review submissions and discussion."
                // A picker, not a scoreboard. The score and the attempts for the problem being
                // read are in the workspace beside it, and repeating every problem's numbers
                // here gave each row three figures to get past before its title.
                showGrade={false}
                showSubmissionUsage={false}
              />

              <ProblemWorkspace
                problem={selectedProblemDetails}
                submissions={selectedProblemSubmissions}
                assignmentDueDate={assignment.dueDate}
                // Null on an individual assignment, so the card renders only when there is a
                // group to name. "You" rather than a name: this is the student's own page.
                isGroupWork={typeDisplay === 'Group'}
                group={myGroup}
                groupMembers={myGroupMembers}
                subjectName="You"
                // On group work the attempts table is the group's, not this student's, so it
                // gains the "Submitted by" column the staff review view already uses. On an
                // individual assignment every row would name the reader.
                showSubmitter={typeDisplay === 'Group'}
                comments={selectedProblemComments}
                commentText={selectedProblem ? newComment[selectedProblem.problem.id] || '' : ''}
                onCommentTextChange={(text: string) =>
                  selectedProblem &&
                  setNewComment((prev) => ({
                    ...prev,
                    [selectedProblem.problem.id]: text,
                  }))
                }
                onSaveComment={() =>
                  selectedProblem && handleSubmitComment(selectedProblem.problem.id)
                }
                onDeleteComment={(commentId: string) => handleDeleteComment(commentId)}
                isSaving={selectedProblem ? submittingComment[selectedProblem.problem.id] : false}
                deletingComments={{}}
                onViewSubmission={(submission) =>
                  setOpenDialog({
                    open: true,
                    submission: submission as unknown as StudentProblemSubmission,
                  })
                }
                courseIsArchived={courseIsArchived}
                currentGrade={selectedProblemGrade}
                isPrivilegedUser={false}
                submissionsLoading={submissionsLoading}
                commentsLoading={commentsLoading}
              />
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground text-center">
              No problems have been added to this assignment yet.
            </p>
          </CardContent>
        </Card>
      )}
      {/* Viewer dialog for the selected submission, keyed off the problem type. */}
      {openDialog.submission && (
        <SubmissionViewerDialog
          open={openDialog.open}
          onOpenChange={(open) => setOpenDialog({ open, submission: null })}
          // Preview only. The standalone viewer window is a staff tool: it exists for
          // comparing and arranging several machines while marking, and a student looking at
          // one attempt of their own has nothing to do with it.
          allowOpenInWindow={false}
          problemType={
            assignment.problems.find((u) => u.problem.id === openDialog?.submission?.problemId)
              ?.problem?.type
          }
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
