import { NextResponse } from 'next/server';
import { withCourseAuth } from '@/lib/api/with-auth';
import { getStudentCourseAssignments } from '@/lib/student-assignments';

/**
 * Returns the signed-in student's own grade breakdown for a course: published
 * assignments, their problems, and per-problem grade, latest submission status,
 * and attempt count. Available to enrolled members (viewing their own data) and
 * to staff.
 * @openapi
 * summary: Get my grades for a course
 * parameters:
 *   - { name: id, in: path, required: true, schema: { type: string } }
 * responses:
 *   200:
 *     description: The caller's per-assignment, per-problem grade breakdown.
 *     content:
 *       application/json:
 *         schema: { type: object, properties: { assignments: { type: array, items: { type: object } } } }
 *   400: { description: Missing course id. }
 *   401: { description: Not signed in. }
 *   403: { description: Not enrolled and not staff. }
 *   500: { description: Server error. }
 */
export const GET = withCourseAuth(
  async (_req, _ctx, { user, courseId }) => {
    try {
      const assignments = await getStudentCourseAssignments(user.id, courseId);

      const payload = assignments.map((assignment) => {
        // The assignment's own total, not a sum over the problem list: that list is empty
        // while the assignment is still locked, and summing it reported the assignment as
        // being worth 0 points on the student's own grades page.
        const maxPoints = assignment.maxPoints;
        const assignmentGrade = assignment.problems.reduce((sum, p) => sum + (p.grade ?? 0), 0);
        const hasGrade = assignment.problems.some((p) => p.grade !== null);

        return {
          id: assignment.id,
          title: assignment.title,
          description: assignment.description,
          // Not open yet, so it has no problems to show and no score to explain.
          locked: assignment.locked,
          // Individual vs group, derived from the group set link the same way the course
          // route derives it. There is no stored flag, and the gradebook labels the row
          // with it so a student can tell a shared grade from their own.
          isGroup: assignment.groupSetId != null,
          dueDate: assignment.dueDate?.toISOString() ?? null,
          maxPoints,
          grade: hasGrade ? assignmentGrade : null,
          problems: assignment.problems.map((p) => ({
            id: p.id,
            title: p.title,
            autograderEnabled: p.autograderEnabled,
            maxPoints: p.maxPoints,
            maxSubmissions: p.maxSubmissions,
            status: p.status,
            submissionCount: p.submissionCount,
            grade: p.grade,
            // Whether that grade is a zero for work never handed in rather than one somebody
            // marked. Both are the number 0, and the page has to tell them apart: the
            // assignment page next door already says "Not submitted" beside it.
            missing: p.missing ?? false,
          })),
        };
      });

      return NextResponse.json({ assignments: payload });
    } catch (error) {
      console.error('GET /api/courses/[id]/student-grades error:', error);
      const detail = error instanceof Error ? error.message : String(error);
      return NextResponse.json(
        {
          error: 'Failed to fetch student grades',
          detail: process.env.NODE_ENV === 'development' ? detail : undefined,
        },
        { status: 500 },
      );
    }
  },
  { access: 'read', deniedAction: 'COURSE_STUDENT_GRADES_ACCESS_DENIED', deniedCategory: 'GRADE' },
);
