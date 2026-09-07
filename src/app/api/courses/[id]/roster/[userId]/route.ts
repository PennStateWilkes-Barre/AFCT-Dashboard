import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { canManageCourse, isAdmin } from '@/lib/permissions';
import { createEnhancedActivityLog } from '@/lib/activity-log-utils';
import { withCourseAuth } from '@/lib/api/with-auth';
import { readJson } from '@/lib/api/request';
import { logDenial, logError } from '@/lib/api/activity';
import { CourseRoleChangeSchema } from '@/schemas/user';

/** Thrown inside a roster transaction when the change would leave 0 faculty. */
class LastFacultyError extends Error {}

/** Thrown inside the removal transaction when the target has submissions in the course. */
class RosterHasSubmissionsError extends Error {}

/**
 * Removes a user from a course roster. Permission is tiered: the shared wrapper
 * admits global admins and course faculty only (TAs and students are rejected up
 * front); the remaining rule (a faculty member may not remove another faculty
 * member) is enforced here (a global admin may). Two safety rules block the removal
 * outright: the user must have no submissions in the course, and a course can't lose
 * its last faculty member.
 * @openapi
 * summary: Remove a user from a course
 * parameters:
 *   - { name: id, in: path, required: true, schema: { type: string } }
 *   - { name: userId, in: path, required: true, schema: { type: string } }
 * responses:
 *   200:
 *     description: Removed; returns how many roster rows were deleted.
 *     content:
 *       application/json:
 *         schema: { type: object, properties: { success: { type: boolean }, removed: { type: integer } } }
 *   400: { description: "User has submissions, or is the only faculty member." }
 *   401: { description: Not signed in. }
 *   403: { description: Caller's role may not remove this user. }
 *   500: { description: Server error. }
 */
export const DELETE = withCourseAuth(
  async (req, ctx, { user, courseId }) => {
    const { userId } = await ctx.params;

    try {
      // The wrapper admitted only global admins and course FACULTY. The one remaining
      // rule: a (non-admin) faculty member may not remove another faculty member.
      const targetRoster = await prisma.roster.findFirst({
        where: { courseId, userId },
        select: { role: true },
      });

      if (!isAdmin(user) && targetRoster?.role === 'FACULTY') {
        return logDenial(req, {
          userId: user.id,
          action: 'ROSTER_REMOVE_DENIED',
          category: 'COURSE',
          courseId,
          metadata: { targetUserId: userId },
        });
      }

      // Both safety checks and the delete run inside one serializable transaction so
      // they're atomic. The submission check in particular must be here, not before
      // the transaction: a submission landing between a pre-check and the delete would
      // otherwise let a user with work be removed. Submissions are created under
      // Serializable too, so a racing insert conflicts with this read and Postgres
      // aborts one transaction (P2034 -> 409 retry below). The faculty-count check is
      // likewise re-read here so concurrent removals can't both leave zero faculty.
      let deleted: { count: number };
      try {
        deleted = await prisma.$transaction(
          async (tx) => {
            if (targetRoster?.role === 'FACULTY') {
              const facultyCount = await tx.roster.count({
                where: { courseId, role: 'FACULTY' },
              });
              if (facultyCount <= 1) {
                throw new LastFacultyError();
              }
            }

            // A user with any submission in the course can't be removed (their work
            // must stay attributable to an enrolled member).
            const assignments = await tx.assignment.findMany({
              where: { courseId },
              select: { id: true },
            });
            const assignmentIdList = assignments.map((a) => a.id);
            if (assignmentIdList.length > 0) {
              const existingSubmission = await tx.submission.findFirst({
                where: { studentId: userId, assignmentId: { in: assignmentIdList } },
                select: { id: true },
              });
              if (existingSubmission) {
                throw new RosterHasSubmissionsError();
              }

              // Drop this user's per-assignment audience rows, due-date overrides and
              // extra-attempt grants in the course so they don't orphan (or silently
              // reactivate if the user is re-enrolled later).
              //
              // The grants were missed when this was written, and they reactivate the same
              // way: a student granted extra attempts, removed before using them and later
              // re-added, came back holding a raised cap nobody had decided to give them.
              // `SubmissionGrant.user` cascades on deleting the USER, which is a different
              // event from leaving one course.
              await tx.assignmentAssignee.deleteMany({
                where: { userId, assignmentId: { in: assignmentIdList } },
              });
              await tx.assignmentOverride.deleteMany({
                where: { userId, assignmentId: { in: assignmentIdList } },
              });
              await tx.submissionGrant.deleteMany({
                where: { userId, assignmentId: { in: assignmentIdList } },
              });
            }

            return tx.roster.deleteMany({ where: { courseId, userId } });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (err) {
        if (err instanceof LastFacultyError) {
          return NextResponse.json(
            { error: 'Cannot remove the only faculty member from the course' },
            { status: 400 },
          );
        }
        if (err instanceof RosterHasSubmissionsError) {
          return NextResponse.json(
            { error: 'User has submissions for this course and cannot be removed' },
            { status: 400 },
          );
        }
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
          return NextResponse.json(
            { error: 'A concurrent roster change conflicted; please retry.' },
            { status: 409 },
          );
        }
        throw err;
      }

      // Log activity
      await createEnhancedActivityLog(prisma, req, {
        userId: user.id,
        action: 'REMOVE_FROM_COURSE',
        severity: 'INFO',
        category: 'COURSE',
        courseId,
        metadata: {
          targetUserId: userId,
          count: deleted.count,
        },
      });

      return NextResponse.json({ success: true, removed: deleted.count });
    } catch (err) {
      console.error('DELETE /api/courses/[id]/roster/[userId] error:', err);
      await logError(req, {
        userId: user.id,
        action: 'ROSTER_REMOVE_ERROR',
        category: 'COURSE',
        error: err,
        courseId,
      });
      return NextResponse.json({ error: 'Server error' }, { status: 500 });
    }
  },
  {
    access: 'manage',
    roles: ['FACULTY'],
    blockWhenArchived: true,
    deniedAction: 'ROSTER_REMOVE_DENIED',
  },
);

/**
 * Returns one roster entry (with the user's profile) plus the viewer's own course
 * role and an `viewerIsAdmin` flag, so the UI can decide which actions to offer.
 * Access is tiered: the caller must be a member of the course (the wrapper enforces
 * this), and a non-staff member may only read their OWN entry; course staff
 * (faculty/TA) and admins may read anyone's. `userId` may be the literal "me" to
 * target the caller.
 * @openapi
 * summary: Get a roster entry
 * parameters:
 *   - { name: id, in: path, required: true, schema: { type: string } }
 *   - { name: userId, in: path, required: true, description: 'A user id, or "me" for the caller', schema: { type: string } }
 * responses:
 *   200:
 *     description: The roster entry, the viewer's course role, and viewerIsAdmin.
 *   401: { description: Not signed in. }
 *   403: { description: "Not a course member, or a non-staff member reading someone else's entry." }
 *   404: { description: No roster entry for that user in this course. }
 *   500: { description: Server error. }
 */
export const GET = withCourseAuth(
  async (req, ctx, { user, courseId }) => {
    const { userId } = await ctx.params;

    try {
      const targetUserId = userId === 'me' ? user.id : userId;

      // Course membership was enforced by the wrapper. A non-staff member may only
      // read their own entry; staff (faculty/TA) and admins may read anyone's.
      if (targetUserId !== user.id && !(await canManageCourse(user, courseId))) {
        return logDenial(req, {
          userId: user.id,
          action: 'ROSTER_VIEW_DENIED',
          category: 'COURSE',
          courseId,
          metadata: { targetUserId },
        });
      }

      // Fetch roster entry and include the user profile info for display in the dialog
      const rosterEntry = await prisma.roster.findFirst({
        where: { courseId, userId: targetUserId },
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              avatar: true,
            },
          },
        },
      });
      if (!rosterEntry) return NextResponse.json({ error: 'Not found' }, { status: 404 });

      // Also return the viewer's admin flag and course role so the UI can decide which actions to show
      const viewerRoster = await prisma.roster.findFirst({
        where: { courseId, userId: user.id },
        select: { role: true },
      });
      const viewerCourseRole = viewerRoster?.role ?? null;
      const viewerIsAdmin = isAdmin(user);

      return NextResponse.json({
        success: true,
        roster: rosterEntry,
        viewerCourseRole,
        viewerIsAdmin,
      });
    } catch (err) {
      console.error('GET /api/courses/[id]/roster/[userId] error:', err);
      return NextResponse.json({ error: 'Server error' }, { status: 500 });
    }
  },
  { access: 'read', deniedAction: 'ROSTER_VIEW_DENIED' },
);

/**
 * Changes a user's course role. Only a global admin or a course faculty member may
 * do this. The last faculty member can't be demoted, keeping every course with
 * someone in charge.
 * @openapi
 * summary: Change a user's course role
 * parameters:
 *   - { name: id, in: path, required: true, schema: { type: string } }
 *   - { name: userId, in: path, required: true, schema: { type: string } }
 * requestBody:
 *   required: true
 *   content:
 *     application/json:
 *       schema:
 *         type: object
 *         required: [role]
 *         properties:
 *           role: { type: string, enum: [FACULTY, TA, STUDENT] }
 * responses:
 *   200:
 *     description: Role updated.
 *   400: { description: "Invalid role, or demoting the only faculty member." }
 *   401: { description: Not signed in. }
 *   403: { description: Caller is not a system admin or a course faculty member. }
 *   404: { description: Roster entry not found. }
 *   500: { description: Server error. }
 */
export const PATCH = withCourseAuth(
  async (req, ctx, { user, courseId }) => {
    const { userId } = await ctx.params;

    try {
      const parsed = await readJson(req, CourseRoleChangeSchema);
      if (!parsed.ok) return parsed.response;
      const newRole = parsed.data.role;

      // Ensure roster entry exists
      const target = await prisma.roster.findFirst({
        where: { courseId, userId },
        select: { id: true, role: true },
      });
      if (!target) return NextResponse.json({ error: 'Roster entry not found' }, { status: 404 });

      // Apply the role change. When demoting a faculty member, re-check the faculty
      // count inside a serializable transaction so concurrent demotions can't leave
      // the course with zero faculty (Postgres aborts one of the racing transactions).
      let updated;
      try {
        updated = await prisma.$transaction(
          async (tx) => {
            if (target.role === 'FACULTY' && newRole !== 'FACULTY') {
              const facultyCount = await tx.roster.count({
                where: { courseId, role: 'FACULTY' },
              });
              if (facultyCount <= 1) {
                throw new LastFacultyError();
              }
            }
            return tx.roster.update({ where: { id: target.id }, data: { role: newRole } });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (err) {
        if (err instanceof LastFacultyError) {
          return NextResponse.json(
            { error: 'Cannot demote the only course faculty member' },
            { status: 400 },
          );
        }
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
          return NextResponse.json(
            { error: 'A concurrent roster change conflicted; please retry.' },
            { status: 409 },
          );
        }
        throw err;
      }

      await createEnhancedActivityLog(prisma, req, {
        userId: user.id,
        action: 'CHANGE_COURSE_ROLE',
        severity: 'INFO',
        category: 'COURSE',
        courseId,
        metadata: {
          targetUserId: userId,
          // The standard shape every change is recorded in. The named fields below it are kept
          // so entries written before this keep reading the same way.
          changes: { role: { from: target.role, to: newRole } },
          previousRole: target.role,
          newRole,
        },
      });

      return NextResponse.json({ success: true, roster: updated });
    } catch (err) {
      console.error('PATCH /api/courses/[id]/roster/[userId] error:', err);
      await logError(req, {
        userId: user.id,
        action: 'ROSTER_UPDATE_ERROR',
        category: 'COURSE',
        error: err,
        courseId,
      });
      return NextResponse.json({ error: 'Server error' }, { status: 500 });
    }
  },
  {
    access: 'manage',
    roles: ['FACULTY'],
    blockWhenArchived: true,
    deniedAction: 'ROSTER_UPDATE_DENIED',
  },
);
