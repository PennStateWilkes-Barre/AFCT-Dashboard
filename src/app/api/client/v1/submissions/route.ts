import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withClientAuth } from '@/lib/api/with-client-auth';
import { apiError } from '@/lib/api/http';
import { logStudentFeedbackViewed, logError } from '@/lib/api/activity';
import { readFormData } from '@/lib/api/request';
import { SubmissionCreateApiSchema } from '@/schemas/submission';
import { createSubmission } from '@/lib/create-submission';
import { canAccessCourse, canManageCourse } from '@/lib/permissions';
import { resolveStudentSubmissionGroupId } from '@/lib/assignment-groups';
import { discloseSubmissionFeedback, feedbackVisibilityMap } from '@/lib/feedback-visibility';

/**
 * The caller's own submission history for one problem (attempt list), newest first,
 * so the client can show past attempts and drill into any one's result via
 * `GET /submissions/{id}`. Scoped to the token's user, so it never exposes anyone
 * else's work.
 * @openapi
 * summary: List my submissions for a problem (client)
 * parameters:
 *   - { name: assignmentId, in: query, required: true, schema: { type: string } }
 *   - { name: problemId, in: query, required: true, schema: { type: string } }
 * responses:
 *   200:
 *     description: The caller's attempts for the problem, newest first.
 *     content:
 *       application/json:
 *         schema:
 *           type: object
 *           properties:
 *             submissions:
 *               type: array
 *               description: "Each attempt carries feedbackVisible: false where the problem withholds the evaluator's feedback, so a null feedback can be told from one the evaluator left empty."
 *               items: { type: object }
 *   400: { description: Missing assignmentId or problemId. }
 *   401: { description: Missing or invalid token. }
 *   403: { description: Not enrolled in the course. }
 *   404: { description: "Assignment not found, unpublished, or the problem is not linked to it." }
 *   500: { description: Server error. }
 */
export const GET = withClientAuth(async (req, _ctx, { user }) => {
  const { searchParams } = new URL(req.url);
  const assignmentId = searchParams.get('assignmentId');
  const problemId = searchParams.get('problemId');
  if (!assignmentId || !problemId) {
    return apiError(400, 'assignmentId and problemId are required');
  }

  try {
    // Same visibility gate as the web (and this route's POST): the caller must
    // still have course access, the assignment must be published for students,
    // and the problem must still be linked. Otherwise a student removed from a
    // course could keep reading their history here that the browser hides.
    const assignment = await prisma.assignment.findUnique({
      where: { id: assignmentId },
      select: { courseId: true, isPublished: true },
    });
    if (!assignment) return apiError(404, 'Assignment not found');
    if (!(await canAccessCourse(user, assignment.courseId))) {
      return apiError(403, 'Forbidden');
    }
    if (!assignment.isPublished && !(await canManageCourse(user, assignment.courseId))) {
      return apiError(404, 'Assignment not found');
    }
    const link = await prisma.assignmentProblem.findUnique({
      where: { assignmentId_problemId: { assignmentId, problemId } },
      select: { assignmentId: true, showFeedback: true },
    });
    if (!link) return apiError(404, 'Assignment not found');

    // Group-aware read: a group-assigned caller sees the group's shared attempts for
    // this problem plus any of their own individual rows.
    const groupId = await resolveStudentSubmissionGroupId(assignmentId, user.id);
    const submissions = await prisma.submission.findMany({
      where: groupId
        ? { assignmentId, problemId, OR: [{ studentId: user.id }, { studentGroupId: groupId }] }
        : { assignmentId, problemId, studentId: user.id },
      orderBy: { submittedAt: 'desc' },
      select: {
        id: true,
        status: true,
        correct: true,
        submittedAt: true,
        originalFileName: true,
        feedback: true,
        // The member who actually submitted. For a group problem this can be any
        // groupmate; for an individual problem it is always the caller.
        student: { select: { firstName: true, lastName: true } },
      },
    });

    // This route answers only for the caller's own work, so there is no staff branch: a
    // member of staff reading a student's attempts does it through the web routes.
    const visibility = feedbackVisibilityMap([{ problemId, showFeedback: link.showFeedback }]);

    const disclosed = submissions.map((s) => ({
      id: s.id,
      status: s.status,
      correct: s.correct,
      submittedAt: s.submittedAt.toISOString(),
      // The name of the file the student uploaded, and the evaluator's witness /
      // counterexample string once evaluation has finished (null while queued).
      fileName: s.originalFileName,
      ...discloseSubmissionFeedback({ ...s, problemId }, visibility, { isStaff: false }),
      submittedBy:
        [s.student?.firstName, s.student?.lastName].filter(Boolean).join(' ').trim() || null,
    }));

    // The client is where most students read their feedback, and it never calls the web
    // routes, so without this the study would only ever see the browser. Counted after
    // disclosure, so a problem with feedback turned off records nothing.
    const withFeedback = disclosed.filter((s) => s.feedbackVisible && s.feedback).length;
    if (withFeedback > 0) {
      await logStudentFeedbackViewed(req, {
        userId: user.id,
        courseId: assignment.courseId,
        assignmentId,
        surface: 'client',
        withFeedback,
        problemId,
      });
    }

    return NextResponse.json({
      submissions: disclosed,
    });
  } catch (error) {
    await logError(req, {
      userId: user.id,
      action: 'CLIENT_SUBMISSIONS_LIST_ERROR',
      category: 'SUBMISSION',
      error,
    });
    return apiError(500, 'Server error');
  }
});


/**
 * Submit a solution file (client). Same multipart body, validation, caps, cooldown,
 * late policy, storage, and queueing as the web `/api/submissions` (it runs the same
 * `createSubmission` service) but authenticated by a bearer token. Returns 202 with
 * the new submission's id + status.
 * @openapi
 * summary: Submit a solution (client)
 * requestBody:
 *   required: true
 *   content:
 *     multipart/form-data:
 *       schema:
 *         type: object
 *         required: [assignmentId, problemId]
 *         properties:
 *           assignmentId: { type: string }
 *           problemId: { type: string }
 *           file: { type: string, format: binary, description: The solution file (XML) }
 * responses:
 *   202: { description: Submission accepted and queued (status PENDING). }
 *   400: { description: "Missing fields, unlinked problem, or invalid file structure." }
 *   401: { description: Missing or invalid token. }
 *   403: { description: "Not enrolled, or the late policy rejected it." }
 *   404: { description: Assignment not found. }
 *   409: { description: Per-problem submission limit reached. }
 *   413: { description: File exceeds the system upload limit. }
 *   429: { description: Resubmit cooldown in effect (see Retry-After). }
 *   500: { description: Server error. }
 */
export const POST = withClientAuth(async (req, _ctx, { user }) => {
  const parsed = await readFormData(req, SubmissionCreateApiSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const result = await createSubmission({
      source: 'client',
      user,
      courseId: parsed.data.courseId,
      assignmentId: parsed.data.assignmentId,
      problemId: parsed.data.problemId,
      file: parsed.form.get('file') as File | null,
      req,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status, headers: result.headers },
      );
    }
    return NextResponse.json(
      { submissionId: result.submission.id, status: result.submission.status },
      { status: 202 },
    );
  } catch (error) {
    await logError(req, {
      userId: user.id,
      action: 'CLIENT_SUBMISSION_CREATE_ERROR',
      category: 'SUBMISSION',
      error,
    });
    return apiError(500, 'Server error');
  }
});
