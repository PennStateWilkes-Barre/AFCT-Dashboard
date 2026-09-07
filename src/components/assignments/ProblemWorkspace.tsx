'use client';

import { useState } from 'react';
import { ChevronUp, ClipboardCheck, FileText, MessageSquare, Users } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import ProblemHeader from '@/components/ProblemHeader';
import ProblemGradeForm from '@/components/ProblemGradeForm';
import { GradeHoldControl } from '@/components/GradeHoldControl';
import { DataTableLoading } from '@/components/ui/data-table-status';
import ProblemDiscussionPanel from '@/components/ProblemDiscussionPanel';
import type { GradeAudience } from '@/components/ProblemGradeForm';
import type { Comment as DiscussionComment, CommentAudience } from '@/components/DiscussionPanel';
import type { StudentProblemComment } from '@/lib/assignment-details';
import type { ProblemSubmission } from '@/lib/problem-submission';
import { buildSubmissionColumns } from '@/components/assignments/submission-columns';
import { apiPaths } from '@/lib/api-paths';
import { getReviewStatusChip } from '@/lib/submission-status';
import { useEffectiveTimezone } from '@/hooks/use-effective-timezone';
import { GradeSyncCard } from '@/components/assignments/GradeSyncCard';
import { FEEDBACK_WITHHELD_MESSAGE } from '@/lib/feedback-visibility';

type Problem = {
  id: string;
  title: string;
  description?: string | null;
  type?: string | null;
  maxPoints?: number | null;
  maxStates?: number | null;
  isDeterministic?: boolean | null;
  maxSubmissions?: number | null;
  autograderEnabled?: boolean | null;
  fileName?: string | null;
  originalFileName?: string | null;
  problemId?: string | null;
};

type ProblemWorkspaceComment = DiscussionComment | StudentProblemComment;

export type ProblemWorkspaceProps = {
  problem: Problem | null;
  submissions: ProblemSubmission[];
  assignmentDueDate?: string | Date | null;
  /** Group assignment: show a "Submitted by" column naming the member who submitted. */
  showSubmitter?: boolean;
  comments: ProblemWorkspaceComment[];
  commentText: string;
  onCommentTextChange: (text: string) => void;
  onSaveComment: () => void;
  /** Group assignments only: who a new comment reaches. */
  commentAudience?: CommentAudience | null;
  subjectName?: string;
  onDeleteComment?: (id: string) => void;
  isSaving?: boolean;
  deletingComments?: Record<string, boolean>;
  onViewSubmission: (submission: ProblemSubmission) => void;
  onRerunSubmission?: (submission: ProblemSubmission) => void;
  rerunning?: Record<string, boolean>;
  courseIsArchived: boolean;
  gradeInput?: string;
  currentGrade?: number | null;
  gradeError?: string | null;
  onGradeInputChange?: (value: string) => void;
  onSaveGrade?: () => void;
  /** Control shown in the Submissions panel header, e.g. granting extra attempts. */
  submissionsAction?: React.ReactNode;
  /** Whether this grade is held, so the autograder will leave it alone. */
  gradedManually?: boolean;
  /** Who produced the grade. Not derivable from the hold above; see `lib/grade-hold`. */
  gradeSource?: 'AUTOGRADER' | 'MANUAL';
  /** Hold the grade against the autograder, or hand it back. */
  onManualHoldChange?: (held: boolean) => void;
  /** The group whose work this is, on a group assignment. */
  /**
   * Whether the assignment is group work at all, which is a different question from whether
   * this student has a group. Without it a student in no group saw the card simply missing
   * from a page that says "Type: Group" two inches above, and nothing told them why they
   * cannot submit.
   */
  isGroupWork?: boolean;
  group?: { id: string; name: string } | null;
  /** The other members of that group. */
  groupMembers?: { id: string; firstName: string | null; lastName: string | null }[];
  /** Group assignments only: who a saved grade applies to. */
  gradeAudience?: GradeAudience | null;
  /** The value this student's group was given, when the grade came from one. */
  groupGradeValue?: number | null;
  isSavingGrade?: boolean;
  isLoadingGrade?: boolean;
  isPrivilegedUser: boolean;
  /** Set by the staff view only. Enables the LMS grade entry below the grade form. */
  assignmentId?: string;
  /** Whose work is open, so the LMS panel reports and sends this student's grade alone. */
  studentId?: string | null;
  submissionsLoading?: boolean;
  commentsLoading?: boolean;
};

const normalizeComments = (comments: ProblemWorkspaceComment[]): DiscussionComment[] =>
  comments.map((comment) => {
    if ('author' in comment) {
      return comment;
    }

    const [firstName, ...rest] = (comment.authorName ?? '').split(' ');
    return {
      id: comment.id,
      content: comment.content,
      createdAt: comment.createdAt,
      author: {
        id: comment.authorId ?? undefined,
        firstName: firstName || null,
        lastName: rest.length > 0 ? rest.join(' ') : null,
        role: comment.authorRole ?? null,
        avatar: null,
        avatarUrl: null,
      },
    };
  });

export default function ProblemWorkspace({
  problem,
  submissions,
  assignmentDueDate,
  showSubmitter = false,
  comments,
  commentText,
  onCommentTextChange,
  onSaveComment,
  commentAudience,
  subjectName,
  onDeleteComment,
  isSaving = false,
  deletingComments = {},
  onViewSubmission,
  onRerunSubmission,
  courseIsArchived,
  gradeInput = '',
  currentGrade = null,
  gradeError = null,
  onGradeInputChange,
  onSaveGrade,
  submissionsAction,
  gradedManually = false,
  gradeSource = 'AUTOGRADER',
  onManualHoldChange,
  group = null,
  isGroupWork = false,
  groupMembers,
  gradeAudience,
  groupGradeValue,
  isSavingGrade = false,
  isLoadingGrade = false,
  isPrivilegedUser,
  assignmentId,
  studentId,
  submissionsLoading = false,
  commentsLoading = false,
}: ProblemWorkspaceProps) {
  const [discussionOpen, setDiscussionOpen] = useState(true);
  const [membersOpen, setMembersOpen] = useState(false);
  // Render each submission's date/time in the course/effective timezone (not the
  // reviewer's browser locale), so the time shown is the one that student submitted at.
  const { timezone, hour12 } = useEffectiveTimezone();

  if (!problem) {
    return (
      <Card>
        <CardContent className="text-muted-foreground p-6 text-sm">
          Select a problem to view submissions.
        </CardContent>
      </Card>
    );
  }

  const normalizedComments = normalizeComments(comments);
  const handleDeleteComment = onDeleteComment ?? (() => {});
  const dueDate = assignmentDueDate ? new Date(assignmentDueDate) : null;
  const hasValidDueDate = !!dueDate && !Number.isNaN(dueDate.getTime());

  const attemptNumbers = new Map<string, number>();
  [...submissions]
    .sort((a, b) => new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime())
    .forEach((s, i) => attemptNumbers.set(s.id, i + 1));

  const sortedSubmissions = [...submissions].sort(
    (a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime(),
  );

  /**
   * What the latest attempt currently says, as one sentence.
   *
   * The verdict and the evaluator's feedback live in table cells, and a cell changing in place
   * announces nothing: a submission went from Pending to Incorrect, and a counterexample
   * appeared in a row the reader had already passed, in silence. This is the one place that
   * says so out loud.
   *
   * Scoped to the newest attempt on purpose. Putting `aria-live` on the table would re-announce
   * the whole thing on every sort, filter and page change, which is how a live region becomes
   * something people turn off.
   */
  const latest = sortedSubmissions[0];
  const latestStatus = latest
    ? `Attempt ${attemptNumbers.get(latest.id) ?? sortedSubmissions.length}: ${
        getReviewStatusChip(latest).label
      }.${
        latest.feedbackVisible === false
          ? ` ${FEEDBACK_WITHHELD_MESSAGE}`
          : latest.feedback
            ? ` ${String(latest.feedback)}`
            : ''
      }`
    : '';

  const handleDownload = (submission: ProblemSubmission) => {
    if (!submission.fileName) return;

    const url = apiPaths.files.submission(encodeURIComponent(submission.fileName), {
      download: true,
    });
    const link = document.createElement('a');
    link.href = url;
    link.download = submission.originalFileName || 'Download';
    link.click();
  };

  // The attempts table's columns, in their own file: 196 lines of column definitions were the
  // bulk of this one, and every other table here keeps them in a `*-columns.tsx` beside it.
  // Rebuilt each render on purpose, so an action cell never holds a stale handler.
  const submissionColumns = buildSubmissionColumns({
    timeZone: timezone,
    hour12,
    dueDate,
    hasValidDueDate,
    attemptNumbers,
    isPrivilegedUser,
    showSubmitter,
    onViewSubmission,
    onDownload: handleDownload,
    onRerunSubmission,
  });

  // Named because two places ask it: whether the grade card exists at all, and whether its
  // first section needs a rule under it.
  const showGradeControls = isPrivilegedUser && !!onGradeInputChange && !!onSaveGrade;

  return (
    /*
     * Two columns only once there is room for both, measured on this workspace rather than
     * on the window: how wide it is depends on the sidebar as much as on the screen, so a
     * viewport breakpoint put the grade panel at 218px on a 1063px window with the sidebar
     * open. At 56rem of workspace the 30% column is about 270px, which the grade row, the
     * hold control and a comment bubble fit in without stacking on themselves. Raise the
     * threshold if it still reads as cramped; lowering it is what produced the 218px.
     */
    <div className="@container/workspace">
      <div className="grid items-start gap-4 @[56rem]/workspace:grid-cols-[minmax(0,70fr)_minmax(0,30fr)] @[56rem]/workspace:items-stretch print:block print:space-y-2">
        {/* Two matching cards: what the problem is and the work submitted for it, beside what
          you are doing about it. */}
        <div className="bg-card flex min-w-0 flex-col gap-4 rounded-md border p-4 @[56rem]/workspace:h-full">
          <div className="flex items-center gap-2">
            <FileText className="text-muted-foreground h-4 w-4" aria-hidden="true" />
            <h3 className="text-sm font-medium">Problem Attempts</h3>
            {/* Across from the heading, matching the menu opposite in Problem Grade. */}
            {isPrivilegedUser ? <div className="ml-auto">{submissionsAction}</div> : null}
          </div>
          <ProblemHeader
            className="min-w-0"
            // No grade here any more. It used to hang off this heading as a badge, which put
            // the one number a student came for inside the card about their attempts. It has
            // its own card in the right column now, where the grader's version of it lives.
            title={problem.title}
            description={problem.description ?? undefined}
            descriptionJson={(problem as { descriptionJson?: unknown }).descriptionJson}
            type={problem.type ?? undefined}
            maxStates={problem.maxStates ?? undefined}
            isDeterministic={problem.isDeterministic ?? undefined}
            maxSubmissions={problem.maxSubmissions ?? undefined}
            autograderEnabled={problem.autograderEnabled ?? undefined}
          />

          {/*
          Always mounted, empty when there is nothing to say. A live region inserted together
          with its first message is not reliably announced, so it has to be here before the
          answer is.
        */}
          <div role="status" aria-live="polite" className="sr-only">
            {latestStatus}
          </div>

          {/* No panel around the table: it carries its own toolbar, column headers and pager,
              so a band above it repeating "Submissions" on the Submissions tab added a frame
              and a word without adding information. `tableLabel` still names it for assistive
              tech, and the grant action sits with the table's other controls. */}
          {submissionsLoading ? (
            <DataTableLoading
              message="Loading submissions, please wait..."
              className="min-h-[320px]"
            />
          ) : sortedSubmissions.length > 0 ? (
            <DataTable
              columns={submissionColumns}
              data={sortedSubmissions}
              storageKey="problem-submissions"
              tableLabel="Problem attempts"
              // A handful of attempts for one student on one problem: search, filters and a
              // column picker are more chrome than the data underneath them.
              showToolbar={false}
              showExportButton={false}
              defaultSorting={[{ id: 'submitted', desc: true }]}
              emptyTitle="No attempts match the filters"
              emptyDescription="Adjust the filters to see more."
              emptyIcon={FileText}
            />
          ) : (
            <div className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
              No attempts yet.
            </div>
          )}
        </div>

        {/* Right column, in the order the questions get asked: what the grade is, who it is
            shared with, and what anyone has said about it. One card each. They used to be a
            single box holding the grade and the group under a rule, which made a group look
            like part of the marking controls rather than a fact about the work. Each renders
            only when it has something to hold, so an absent one leaves no empty frame. */}
        <div className="flex min-w-0 flex-col gap-4">
          {showGradeControls ? (
            <div className="bg-card flex min-w-0 flex-col gap-4 rounded-md border p-4">
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <ClipboardCheck className="text-muted-foreground h-4 w-4" aria-hidden="true" />
                  <h3 className="text-sm font-medium">Problem Grade</h3>
                </div>
                <ProblemGradeForm
                  value={gradeInput}
                  currentGrade={currentGrade}
                  maxPoints={problem.maxPoints}
                  disabled={courseIsArchived}
                  isSaving={isSavingGrade}
                  isLoading={isLoadingGrade}
                  error={gradeError}
                  onChange={onGradeInputChange}
                  onSubmit={onSaveGrade}
                  audience={gradeAudience}
                  groupGradeValue={groupGradeValue}
                />
                {/* Renders nothing unless the course is linked to an LMS. */}
                {assignmentId ? (
                  <GradeSyncCard
                    assignmentId={assignmentId}
                    variant="inline"
                    studentId={studentId}
                  />
                ) : null}
                {/* Under the grade rather than beside the heading: it needs a sentence to
                    mean anything, and the sentence is the part the old switch was missing. */}
                {onManualHoldChange ? (
                  <GradeHoldControl
                    autograderEnabled={!!problem.autograderEnabled}
                    gradeSource={gradeSource}
                    gradedManually={gradedManually}
                    hasGrade={currentGrade !== null && currentGrade !== undefined}
                    onChange={onManualHoldChange}
                    disabled={courseIsArchived}
                    className="mt-1"
                  />
                ) : null}
              </div>
            </div>
          ) : null}

          {/* The student's own grade, in the slot the grader's Problem Grade card occupies.
              The two never appear together (`showGradeControls` is privileged-only), so the
              heading and icon are shared deliberately: one name for one thing, whoever is
              looking. It renders ungraded as well as graded, because "not yet" is an answer
              to the question a student opened this page to ask. */}
          {!isPrivilegedUser ? (
            <div className="bg-card flex min-w-0 flex-col gap-2 rounded-md border p-4">
              <div className="flex items-center gap-2">
                <ClipboardCheck className="text-muted-foreground h-4 w-4" aria-hidden="true" />
                <h3 className="text-sm font-medium">Problem Grade</h3>
              </div>
              <p className="text-2xl leading-none font-semibold tabular-nums">
                {currentGrade !== null ? currentGrade : '—'}
                <span className="text-muted-foreground text-base font-normal">
                  {' / '}
                  {problem.maxPoints}
                </span>
              </p>
              {currentGrade === null ? (
                <p className="text-muted-foreground text-xs">Not graded yet.</p>
              ) : null}
            </div>
          ) : null}

          {isGroupWork && !group ? (
            <div className="bg-card flex min-w-0 flex-col gap-2 rounded-md border p-4">
              <div className="flex items-center gap-2">
                <Users className="text-muted-foreground h-4 w-4" aria-hidden="true" />
                <h3 className="text-sm font-medium">Group</h3>
              </div>
              {/* States the fact and its consequence, rather than leaving a gap where a card
                  should be on a page whose banner says "Type: Group".

                  Not an error, and deliberately not "ask to be added": submitting without a
                  group is allowed. `create-submission` writes the attempt with no
                  studentGroupId and counts it against this student alone, which is a
                  reasonable thing for an instructor to have intended. What changes is that
                  the work is theirs rather than a group's, and that is the part worth saying
                  before they submit. */}
              <p className="text-muted-foreground text-sm">
                {subjectName && subjectName !== 'You'
                  ? `${subjectName} is not in a group for this assignment, but can still submit on their own.`
                  : 'You are not in a group for this assignment, but you can still submit on your own. If you feel like this is an error, contact your instructor.'}
              </p>
            </div>
          ) : null}

          {group ? (
            <div className="bg-card flex min-w-0 flex-col gap-4 rounded-md border p-4">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <Users className="text-muted-foreground h-4 w-4" aria-hidden="true" />
                  <h3 className="text-sm font-medium">
                    {group.name} · {(groupMembers?.length ?? 0) + 1}{' '}
                    {(groupMembers?.length ?? 0) + 1 === 1 ? 'member' : 'members'}
                  </h3>
                  {/* Collapsed by default: the count in the heading answers the usual
                      question, and the names are only needed when something looks wrong. */}
                  <button
                    type="button"
                    onClick={() => setMembersOpen((open) => !open)}
                    aria-expanded={membersOpen}
                    aria-controls="group-members"
                    className="text-muted-foreground hover:text-foreground ml-auto rounded p-1"
                  >
                    <ChevronUp
                      className={`h-4 w-4 transition-transform ${membersOpen ? '' : 'rotate-180'}`}
                      aria-hidden="true"
                    />
                    <span className="sr-only">
                      {membersOpen ? 'Collapse members' : 'Expand members'}
                    </span>
                  </button>
                </div>
                {/* The whole group, the student under review included: a list that omitted
                    them would read as "everyone else", which is not who the grade and the
                    thread apply to. */}
                <p
                  id="group-members"
                  hidden={!membersOpen}
                  className="text-muted-foreground text-xs"
                >
                  {[
                    subjectName ?? 'This student',
                    ...(groupMembers ?? []).map(
                      (m) => `${m.firstName ?? ''} ${m.lastName ?? ''}`.trim() || 'Student',
                    ),
                  ].join(', ')}
                </p>
              </div>
            </div>
          ) : null}

          <div className="bg-card flex min-w-0 flex-col gap-4 rounded-md border p-4">
            <div className="flex items-center gap-2">
              <MessageSquare className="text-muted-foreground h-4 w-4" aria-hidden="true" />
              <h3 className="text-sm font-medium">
                Problem Discussion ({normalizedComments.length})
              </h3>
              {/* Collapsing gets the composer out of the way when a grader is reading rather
                  than replying. aria-expanded and aria-controls carry the state, so it is not
                  a chevron whose meaning only a sighted user can infer. */}
              <button
                type="button"
                onClick={() => setDiscussionOpen((open) => !open)}
                aria-expanded={discussionOpen}
                aria-controls="problem-discussion"
                className="text-muted-foreground hover:text-foreground ml-auto rounded p-1"
              >
                <ChevronUp
                  className={`h-4 w-4 transition-transform ${discussionOpen ? '' : 'rotate-180'}`}
                  aria-hidden="true"
                />
                <span className="sr-only">
                  {discussionOpen ? 'Collapse discussion' : 'Expand discussion'}
                </span>
              </button>
            </div>
            <div id="problem-discussion" hidden={!discussionOpen}>
              {/* Kept across both branches. It used to be mounted with "Loading discussion..." and
              then replaced wholesale by the panel, so neither the wait nor its end announced. */}
              <span role="status" aria-live="polite" className="sr-only">
                {commentsLoading ? 'Loading the discussion.' : 'Discussion loaded.'}
              </span>
              {commentsLoading ? (
                <div className="text-muted-foreground text-sm" aria-hidden="true">
                  Loading discussion...
                </div>
              ) : (
                <ProblemDiscussionPanel
                  courseIsArchived={courseIsArchived}
                  audience={commentAudience}
                  subjectName={subjectName}
                  comments={normalizedComments}
                  commentText={commentText}
                  onCommentTextChange={onCommentTextChange}
                  onSaveComment={onSaveComment}
                  onDeleteComment={handleDeleteComment}
                  isSaving={isSaving}
                  deletingComments={deletingComments}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
