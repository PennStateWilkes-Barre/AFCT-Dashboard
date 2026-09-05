import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { canManageCourse } from '@/lib/permissions';
import { resolveStudentContentGate } from '@/lib/assignment-student-gate';
import { effectiveMaxSubmissions } from '@/lib/submission-limits';
import { discloseSubmissionFeedback, feedbackVisibilityMap } from '@/lib/feedback-visibility';
import { isMissingZero, submittedKey } from '@/lib/missing-work';
import { withCourseAuth } from '@/lib/api/with-auth';

/**
 * Everything the caller needs to see their own work on an assignment, grouped by
 * problem: their submissions, the comments addressed to them, and their per-problem
 * and overall grades. Requires enrollment in the course; students can't see it
 * until the assignment is published. Scoped entirely to the caller's own data.
 * @openapi
 * summary: Get my context for an assignment
 * parameters:
 *   - { name: id, in: path, required: true, description: Course id, schema: { type: string } }
 *   - { name: aid, in: path, required: true, description: Assignment id, schema: { type: string } }
 * responses:
 *   200:
 *     description: The caller's submissions, comments, and grades for the assignment.
 *     content:
 *       application/json:
 *         schema:
 *           type: object
 *           properties:
 *             assignmentGrade: { type: number, nullable: true }
 *             problemGrades: { type: object }
 *             submissionCount: { type: integer }
 *             submissionsByProblem:
 *               type: object
 *               description: "Attempts per problem. Each carries feedbackVisible: false where the problem withholds the evaluator's feedback, so a null feedback can be told from one that is simply empty."
 *             commentsByProblem: { type: object }
 *             problemLimits:
 *               type: object
 *               description: Per-problem effective submission cap for the caller (base plus any grants); max null means unlimited.
 *   401: { description: Not signed in. }
 *   403: { description: Caller is not enrolled in the course. }
 *   404: { description: "Assignment not found in this course, or unpublished (for students)." }
 *   500: { description: Server error. }
 */
/**
 * "First Last" for a submission's author, matching the staff review route's wording so the
 * two web views name the same person the same way. Falls back to "Unknown" rather than an
 * empty cell, which would read as "nobody submitted this".
 */
function submitterName(
  u: { firstName: string | null; lastName: string | null } | null | undefined,
): string {
  return `${u?.firstName ?? ''} ${u?.lastName ?? ''}`.trim() || 'Unknown';
}

export const GET = withCourseAuth(
  async (_req, ctx, { user, courseId }) => {
    const { aid: assignmentId } = await ctx.params;
    const userId = user.id;

    try {
      const assignment = await prisma.assignment.findFirst({
        where: { id: assignmentId, courseId },
        select: {
          id: true,
          isPublished: true,
          groupSetId: true,
          // What `lib/missing-work` needs to say whether unsubmitted work is a zero here.
          missingWorkIsZero: true,
          dueDate: true,
          unlockAt: true,
          lateCutoff: true,
          allowLateSubmissions: true,
          assignedToEveryone: true,
          course: { select: { isArchived: true } },
          overrides: {
            select: {
              targetType: true,
              userId: true,
              groupId: true,
              unlockAt: true,
              dueDate: true,
              lateCutoff: true,
              allowLateSubmissions: true,
            },
          },
          problems: {
            select: {
              problemId: true,
              maxSubmissions: true,
              showFeedback: true,
              maxPoints: true,
              createdAt: true,
            },
          },
        },
      });

      if (!assignment) {
        return NextResponse.json({ error: 'Assignment not found' }, { status: 404 });
      }

      const isStaff = await canManageCourse(user, courseId);

      if (!assignment.isPublished && !isStaff) {
        return NextResponse.json({ error: 'Assignment not found' }, { status: 404 });
      }

      // Published is not enough. Course membership got the caller this far, but a
      // student must also be in the assignment's audience and past their unlock time -
      // the same two gates the assignment, review-data and submission routes apply.
      // Without them, any enrolled student who guesses a published assignment id learns
      // it exists and gets its problem ids back, which are then useful keys for probing
      // elsewhere.
      if (!isStaff) {
        const gate = await resolveStudentContentGate(assignment.id, userId);

        // Not in the audience: mask exactly as if it did not exist.
        if (!gate.assigned) {
          return NextResponse.json({ error: 'Assignment not found' }, { status: 404 });
        }

        // Assigned but not open yet: the assignment legitimately exists for them, so
        // answer with an empty context rather than an error the client has to special
        // case. Nothing here is theirs yet anyway.
        if (gate.locked) {
          return NextResponse.json({
            assignmentGrade: null,
            problemGrades: {},
            submissionCount: 0,
            submissionsByProblem: {},
            commentsByProblem: {},
            problemLimits: {},
            locked: true,
          });
        }
      }

      const problemIds = assignment.problems.map((problem) => problem.problemId);

      // On a group assignment the submission set is shared, so attempts (and the cap
      // they count against) are group-wide, matching submit enforcement.
      const myGroup = assignment.groupSetId
        ? await prisma.groupMembership.findFirst({
            where: { userId, groupSetId: assignment.groupSetId },
            select: { groupId: true },
          })
        : null;
      const myGroupId = myGroup?.groupId ?? null;
      const isGroupAssignment = assignment.groupSetId != null;

      // The group's name and the caller's groupmates, for the assignment page's group card.
      // Their own group only, and only names: on a group assignment they already share every
      // submission with these people, so who is in it is not a disclosure. Shaped exactly like
      // the staff review-data route's, so ProblemWorkspace takes one prop shape from both.
      const myGroupDetail = myGroupId
        ? await prisma.studentGroup.findUnique({
            where: { id: myGroupId },
            select: {
              id: true,
              name: true,
              memberships: {
                select: {
                  roster: {
                    select: { user: { select: { id: true, firstName: true, lastName: true } } },
                  },
                },
              },
            },
          })
        : null;
      // Everyone but the caller: the card names them separately as the person looking.
      const myGroupMembers = (myGroupDetail?.memberships ?? [])
        .map((m) => m.roster.user)
        .filter((u) => u.id !== userId);

      const [submissions, comments, grades, grants] = await Promise.all([
        prisma.submission.findMany({
          where: {
            assignmentId,
            problemId: { in: problemIds },
            OR: [{ studentId: userId }, ...(myGroupId ? [{ studentGroupId: myGroupId }] : [])],
          },
          orderBy: { submittedAt: 'desc' },
          select: {
            id: true,
            submittedAt: true,
            feedback: true,
            correct: true,
            fileName: true,
            originalFileName: true,
            problemId: true,
            status: true,
            // Who made the attempt. Only disclosed on a group assignment (see below), where
            // the caller is already looking at their groupmates' submissions and cannot
            // otherwise tell whose is whose.
            student: { select: { firstName: true, lastName: true } },
          },
        }),
        prisma.comment.findMany({
          where: {
            assignmentId,
            problemId: { in: problemIds },
            OR: [
              { aboutStudentId: userId },
              { authorId: userId },
              // Feedback written to their GROUP. The schema notes that on group work staff
              // usually address the group rather than each member, so the shared submission
              // gets one thread, and the staff review route has always read it that way. This
              // side did not, so an instructor's feedback on group work reached nobody it was
              // written for. Scoped to the caller's own group, which is the same id the cap
              // and the submissions above are scoped to.
              ...(myGroupId ? [{ aboutGroupId: myGroupId }] : []),
            ],
          },
          include: {
            author: { select: { id: true, firstName: true, lastName: true } },
            roster: { select: { role: true } }, // course role for the badge, may be null
          },
          orderBy: { createdAt: 'asc' },
        }),
        prisma.assignmentProblemGrade.findMany({
          where: {
            assignmentId,
            studentId: userId,
            problemId: { in: problemIds },
          },
          select: {
            problemId: true,
            grade: true,
          },
        }),
        prisma.submissionGrant.findMany({
          where: {
            assignmentId,
            problemId: { in: problemIds },
            OR: [{ userId }, ...(myGroupId ? [{ groupId: myGroupId }] : [])],
          },
          select: {
            problemId: true,
            targetType: true,
            userId: true,
            groupId: true,
            extraSubmissions: true,
          },
        }),
      ]);

      // The cap that applies to THIS caller per problem (base plus grants); max null
      // means unlimited. The client pairs this with the attempt lists below.
      const problemLimits = Object.fromEntries(
        assignment.problems.map((p) => {
          const limit = effectiveMaxSubmissions(
            p.maxSubmissions,
            grants.filter((g) => g.problemId === p.problemId),
            userId,
            myGroupId ? [myGroupId] : [],
          );
          return [p.problemId, limit];
        }),
      );

      const submissionsByProblem: Record<
        string,
        ((typeof submissions)[number] & { feedbackVisible: boolean })[]
      > = {};
      for (const problemId of problemIds) {
        submissionsByProblem[problemId] = [];
      }

      // Feedback the caller is allowed. Staff reading a student's page keep everything; a
      // student gets the evaluator's text only where the problem shows it, and a flag either
      // way so the screen can tell "nothing to say" from "not shown to you".
      const visibility = feedbackVisibilityMap(assignment.problems);
      for (const submission of submissions) {
        (submissionsByProblem[submission.problemId] ??= []).push({
          ...submission,
          ...discloseSubmissionFeedback(submission, visibility, { isStaff }),
        });
      }

      const commentsByProblem: Record<string, (typeof comments)[number][]> = {};
      for (const problemId of problemIds) {
        commentsByProblem[problemId] = [];
      }

      for (const comment of comments) {
        (commentsByProblem[comment.problemId] ??= []).push(comment);
      }

      const gradeMap = new Map(grades.map((grade) => [grade.problemId, grade.grade]));

      /**
       * Work nobody handed in, scored zero, when the assignment says so.
       *
       * The same rule the gradebook applies, from the same resolver, because the number a student
       * reads here and the number their professor reads there have to be the same one. Reaching
       * this code means the caller is assigned the work and past any unlock, both already checked
       * above, so the audience and activity questions are settled by the time we get here.
       */
      const submittedIndex = {
        byStudent: new Set(
          submissions
            .filter((s) => s.problemId)
            .map((s) => submittedKey(userId, s.problemId as string)),
        ),
        byGroup: new Set(
          myGroupId
            ? submissions
                .filter((s) => s.problemId)
                .map((s) => submittedKey(myGroupId, s.problemId as string))
            : [],
        ),
      };
      const missingProblems = new Set(
        assignment.dueDate
          ? assignment.problems
              .filter(
                (p) =>
                  !gradeMap.has(p.problemId) &&
                  isMissingZero(
                    {
                      missingWorkIsZero: assignment.missingWorkIsZero,
                      isPublished: assignment.isPublished,
                      groupSetId: assignment.groupSetId,
                      courseIsArchived: assignment.course?.isArchived ?? false,
                      dueDate: assignment.dueDate,
                      unlockAt: assignment.unlockAt,
                      lateCutoff: assignment.lateCutoff,
                      allowLateSubmissions: assignment.allowLateSubmissions,
                    },
                    {
                      problemId: p.problemId,
                      maxPoints: Number(p.maxPoints ?? 0),
                      createdAt: p.createdAt,
                    },
                    {
                      studentId: userId,
                      isAssigned: true,
                      isActive: true,
                      groupIds: myGroupId ? [myGroupId] : [],
                    },
                    assignment.overrides,
                    submittedIndex,
                    false,
                  ).missing,
              )
              .map((p) => p.problemId)
          : [],
      );

      const problemGrades = Object.fromEntries(
        problemIds.map((problemId) => [
          problemId,
          gradeMap.get(problemId) ?? (missingProblems.has(problemId) ? 0 : null),
        ]),
      );
      const gradesList = Object.values(problemGrades);
      const hasAnyGrade = gradesList.some((grade) => grade !== null);
      const assignmentGrade = hasAnyGrade
        ? gradesList.reduce((sum: number, grade) => sum + (grade ?? 0), 0)
        : null;

      return NextResponse.json({
        assignmentGrade,
        problemGrades,
        // Which of those zeros are for work never handed in, so the page can say so rather than
        // showing a bare zero that reads like a mark.
        missingProblems: [...missingProblems],
        problemLimits,
        submissionCount: submissions.length,
        submissionsByProblem: Object.fromEntries(
          Object.entries(submissionsByProblem).map(([problemId, problemSubmissions]) => [
            problemId,
            problemSubmissions.map((submission) => ({
              id: submission.id,
              submittedAt: submission.submittedAt.toISOString(),
              grade: gradeMap.get(submission.problemId) ?? null,
              feedback: submission.feedback,
              // Group work only. On an individual assignment every attempt is the caller's
              // own, so naming the submitter would add a column that says the same thing on
              // every row; the field is simply absent and the table's column stays off.
              ...(isGroupAssignment ? { submittedBy: submitterName(submission.student) } : {}),
              // Null feedback has two meanings and the screen has to tell them apart: the
              // evaluator had nothing to say, or this problem does not show what it said.
              feedbackVisible: submission.feedbackVisible,
              correct: submission.correct,
              fileName: submission.fileName,
              originalFileName: submission.originalFileName,
              problemId: submission.problemId,
              status: submission.status,
            })),
          ]),
        ),
        group: myGroupDetail ? { id: myGroupDetail.id, name: myGroupDetail.name } : null,
        groupMembers: myGroupMembers.map((u) => ({
          id: u.id,
          firstName: u.firstName,
          lastName: u.lastName,
        })),
        commentsByProblem: Object.fromEntries(
          Object.entries(commentsByProblem).map(([problemId, problemComments]) => [
            problemId,
            problemComments.map((comment) => ({
              id: comment.id,
              content: comment.content,
              createdAt: comment.createdAt.toISOString(),
              authorId: comment.author.id,
              authorName:
                [comment.author.firstName, comment.author.lastName].filter(Boolean).join(' ') ||
                'Unknown',
              // Role badge from the author's roster row; null when they aren't rostered
              // (e.g. a system admin), rather than mislabeling them as a student.
              authorRole: comment.roster?.role ?? null,
              problemId: comment.problemId,
            })),
          ]),
        ),
      });
    } catch (error) {
      console.error('GET student-context error:', error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  },
  { access: 'read', deniedAction: 'ASSIGNMENT_STUDENT_CONTEXT_DENIED' },
);
