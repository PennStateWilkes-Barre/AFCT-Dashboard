import { prisma } from '@/lib/prisma';
import { canManageCourse } from '@/lib/permissions';
import type { PermissionUser } from '@/lib/permissions';
import type { ViewerFileKind } from '@/lib/viewer-link';
import { discloseSubmissionFeedback, feedbackVisibilityMap } from '@/lib/feedback-visibility';

/**
 * Where a file in the viewer came from: its course, what it belongs to, and when it arrived.
 *
 * Server-only. It reads the database and resolves permissions, and the standalone viewer page
 * loads it during render and passes the result down as plain data, so none of this reaches the
 * browser.
 *
 * Carries what the evaluator said about this attempt: which attempt it was, when it was
 * graded, whether it was judged correct and, for course staff, the feedback text. Somebody
 * reviewing a submission here was reading that a moment ago on the assignment page and should
 * not have to go back for it.
 *
 * Still **nothing about the recorded grade**: not the mark, not the points, not whether it was
 * released. The evaluator's verdict on one attempt and a student's grade for a problem are two
 * different facts, and the second is the gradebook's to state.
 *
 * The feedback text is staff only, and that is a disclosure rule rather than a tidiness one.
 * A course can turn evaluator feedback off for a problem (see `feedback-visibility`), and a
 * student reading it is recorded for the study (see `logStudentFeedbackViewed`). The student's
 * own way to it is the assignment page, where both of those already apply; a second, silent
 * one here would risk showing what a course withheld and would leave a hole in the record of
 * what students do with feedback. Routed through the shared resolver all the same, so if this
 * is ever opened to students the rule is already the same rule.
 */
export type ViewerProperties = {
  /** Rows in display order. Kept as a list so the panel renders without knowing the shape. */
  rows: { label: string; value: string }[];
};

/**
 * What the evaluator made of the attempt, in one phrase.
 *
 * The verdict, not the grade: a correct attempt is not necessarily a full mark, and a problem
 * can be marked by hand afterwards. An attempt that never reached a verdict says where it got
 * to instead, because "not correct" and "not graded yet" are opposite things to read.
 */
function resultOf(status: string, correct: boolean | null): string {
  if (status === 'PENDING') return 'Waiting to be graded';
  if (status === 'PROCESSING') return 'Being graded';
  if (status === 'FAILED') return 'Grading failed';
  if (correct === null) return 'Not graded';
  return correct ? 'Correct' : 'Incorrect';
}

/** A date an operator can read, in the machine's own timezone-free form. */
function stamp(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/**
 * Look up what a viewer file belongs to, or null.
 *
 * Null covers both "no such file" and "not yours to see", on purpose: telling the two apart
 * would let somebody probe for which files exist by watching the panel change.
 *
 * Authorisation mirrors the file routes exactly rather than inventing a second rule. A
 * submission is visible to the student who submitted it and to course staff; a problem or
 * solution file is staff only.
 */
export async function loadViewerProperties(
  kind: ViewerFileKind,
  file: string,
  user: PermissionUser,
): Promise<ViewerProperties | null> {
  if (kind === 'submissions') {
    const submission = await prisma.submission.findFirst({
      where: { fileName: file },
      select: {
        id: true,
        originalFileName: true,
        createdAt: true,
        submittedAt: true,
        evaluatedAt: true,
        status: true,
        correct: true,
        feedback: true,
        assignmentId: true,
        problemId: true,
        studentId: true,
        courseId: true,
        student: { select: { firstName: true, lastName: true, email: true } },
        studentGroup: { select: { name: true } },
        course: { select: { name: true, code: true } },
        assignmentProblem: {
          select: {
            showFeedback: true,
            assignment: { select: { title: true } },
            problem: { select: { title: true, type: true } },
          },
        },
      },
    });
    if (!submission) return null;

    const isStaff = await canManageCourse(user, submission.courseId);
    const allowed = (!!user?.id && submission.studentId === user.id) || isStaff;
    if (!allowed) return null;

    /**
     * Which attempt at this problem this was: its place in the student's own run of them,
     * oldest first. Counted rather than stored, the same way the similarity page and the
     * submissions table both work it out, because there is no attempt column to read: what a
     * student has sent is the list of their submissions.
     */
    const attempt = await prisma.submission.count({
      where: {
        assignmentId: submission.assignmentId,
        problemId: submission.problemId,
        studentId: submission.studentId,
        submittedAt: { lte: submission.submittedAt },
      },
    });

    const disclosure = discloseSubmissionFeedback(
      { problemId: submission.problemId, status: submission.status, feedback: submission.feedback },
      feedbackVisibilityMap([
        {
          problemId: submission.problemId,
          showFeedback: submission.assignmentProblem?.showFeedback ?? true,
        },
      ]),
      { isStaff },
    );

    // The person is always named, group or not: on group work the grade counts for the whole
    // group, but somebody still uploaded this file and that is worth being able to see.
    const person =
      [submission.student?.firstName, submission.student?.lastName].filter(Boolean).join(' ') ||
      submission.student?.email ||
      'Unknown';
    const group = submission.studentGroup?.name ?? null;

    return {
      rows: [
        { label: 'File', value: submission.originalFileName ?? file },
        // Said outright, because a solution and a student's attempt look identical on the
        // canvas and mistaking one for the other is the expensive confusion here.
        {
          label: 'Kind',
          value: group ? 'Student submission (group work)' : 'Student submission',
        },
        {
          label: 'Course',
          value: submission.course?.code
            ? `${submission.course.code} ${submission.course.name}`
            : (submission.course?.name ?? 'Unknown'),
        },
        {
          label: 'Assignment',
          value: submission.assignmentProblem?.assignment?.title ?? 'Unknown',
        },
        { label: 'Problem', value: submission.assignmentProblem?.problem?.title ?? 'Unknown' },
        { label: 'Type', value: submission.assignmentProblem?.problem?.type ?? 'Unknown' },
        ...(group ? [{ label: 'Group', value: group }] : []),
        { label: group ? 'Uploaded by' : 'Student', value: person },
        { label: 'Attempt', value: String(attempt) },
        // `submittedAt`, not `createdAt`: they are usually the same instant, and the first is
        // the one that means "when the student sent this" and the one attempts are numbered by.
        { label: 'Submitted', value: stamp(submission.submittedAt) },
        // Only once there is one. An attempt still in the queue has no result to date.
        // "Evaluated", not "Graded": this is when the evaluator finished with the attempt, and
        // the recorded grade is a separate fact this panel deliberately does not carry.
        ...(submission.evaluatedAt
          ? [{ label: 'Evaluated', value: stamp(submission.evaluatedAt) }]
          : []),
        { label: 'Result', value: resultOf(submission.status, submission.correct) },
        // Staff only; see the note at the top of this file for why.
        ...(isStaff && disclosure.feedback
          ? [{ label: 'Feedback', value: disclosure.feedback }]
          : []),
      ],
    };
  }

  // A problem's own file, or the solution posted with it. Both hang off Problem and are staff
  // only, which is the rule their file routes apply.
  const problem = await prisma.problem.findFirst({
    where: { fileName: file },
    select: {
      title: true,
      type: true,
      originalFileName: true,
      createdAt: true,
      updatedAt: true,
      courseId: true,
      course: { select: { name: true, code: true } },
    },
  });
  if (!problem) return null;
  if (!(await canManageCourse(user, problem.courseId))) return null;

  return {
    rows: [
      { label: 'File', value: problem.originalFileName ?? file },
      {
        label: 'Kind',
        value: kind === 'solutions' ? "Instructor's solution" : 'Problem file',
      },
      {
        label: 'Course',
        value: problem.course?.code
          ? `${problem.course.code} ${problem.course.name}`
          : (problem.course?.name ?? 'Unknown'),
      },
      { label: 'Problem', value: problem.title },
      { label: 'Type', value: problem.type ?? 'Unknown' },
      { label: 'Added', value: stamp(problem.createdAt) },
      { label: 'Last changed', value: stamp(problem.updatedAt) },
    ],
  };
}
