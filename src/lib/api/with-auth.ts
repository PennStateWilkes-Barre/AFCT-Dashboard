import type { NextResponse } from 'next/server';
import type { Session } from 'next-auth';
import type { CourseRole } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logThrottledView } from './activity';
import { auth } from '@/lib/auth';
import { courseHasStarted } from '@/lib/course-status';
import {
  isAdmin,
  canManageCourse,
  canAccessCourse,
  isCourseArchived,
  isCourseDeleted,
  isCourseStaffAnywhere,
} from '@/lib/permissions';
import { createEnhancedActivityLog, type ActivityCategory } from '@/lib/activity-log-utils';
import { withServerTiming } from '@/lib/perf-debug';
import { apiError } from './http';

/** The session user shape handlers receive once auth has passed. */
export type SessionUser = Session['user'];

export type AdminAuthContext = {
  session: Session;
  user: SessionUser;
};

/**
 * Wraps a system-admin route handler with the shared gate, following the app-wide
 * auth-response standard:
 *   - no signed-in session            -> 401 `{ error: 'Unauthorized' }` (not logged;
 *                                        unauthenticated hits are unattributable noise)
 *   - signed in but not an admin      -> 403 `{ error: 'Forbidden' }` + a SECURITY
 *                                        `deniedAction` audit event (a known user
 *                                        exceeding their permissions is worth a trail)
 * The handler runs only for a confirmed admin and receives the resolved session/user
 * so it needn't call `auth()` again.
 *
 * This is the authoritative check; `src/proxy.ts` is only a coarse edge-level
 * backstop over `/api/admin/*`.
 */
export function withAdminAuth<Ctx = unknown, R extends Response = Response>(
  handler: (req: Request, ctx: Ctx, auth: AdminAuthContext) => Promise<R> | R,
  opts: {
    deniedAction: string;
    deniedCategory?: ActivityCategory;
    /**
     * Record the successful read too, throttled: status, settings and backups are sensitive
     * reads (policy §4) and only a refused look was recorded before.
     *
     * One action per surface, not per backing route. The status page fetches eight endpoints
     * every fifteen seconds, so a per-route key would write ~50 rows an hour per admin.
     *
     * Fires before the handler, so it records the read as attempted; a 500 afterwards does not
     * un-look at the page.
     */
    viewAction?: string;
    viewCategory?: ActivityCategory;
  },
): (req: Request, ctx: Ctx) => Promise<R | NextResponse> {
  return async (req: Request, ctx: Ctx) => {
    const session = await auth();
    // Reject a missing session or a disabled/deleted account (the session callback
    // marks the user inactive when the DB row is gone or disabled) before any
    // privilege check; a stale JWT must not keep granting admin access.
    if (!session?.user || session.user.inactive) {
      return apiError(401, 'Unauthorized');
    }
    if (!isAdmin(session.user)) {
      await createEnhancedActivityLog(prisma, req, {
        userId: session.user.id,
        action: opts.deniedAction,
        severity: 'SECURITY',
        // Admin-gate denials are system-level unless the caller says otherwise.
        category: opts.deniedCategory ?? 'SYSTEM',
        metadata: { reason: 'not an administrator', required: 'admin' },
      });
      return apiError(403, 'Forbidden');
    }
    if (opts.viewAction) {
      await logThrottledView(req, {
        userId: session.user.id,
        action: opts.viewAction,
        category: opts.viewCategory ?? 'SYSTEM',
      });
    }
    return withServerTiming(req, () => handler(req, ctx, { session, user: session.user }));
  };
}

/**
 * Wraps a handler that any course staff member may reach, following the same standard
 * as {@link withAdminAuth}: 401 unsigned, 403 + SECURITY log for a signed-in caller who
 * is neither an admin nor FACULTY/TA anywhere.
 *
 * For staff tools that belong to no particular course (the evaluator trial page), where
 * there is no course id to gate on but students must still be kept out. Anything that
 * touches a course's data belongs behind {@link withCourseAuth} instead.
 */
export function withStaffAuth<Ctx = unknown, R extends Response = Response>(
  handler: (req: Request, ctx: Ctx, auth: AdminAuthContext) => Promise<R> | R,
  opts: { deniedAction: string; deniedCategory?: ActivityCategory },
): (req: Request, ctx: Ctx) => Promise<R | NextResponse> {
  return async (req: Request, ctx: Ctx) => {
    const session = await auth();
    if (!session?.user || session.user.inactive) {
      return apiError(401, 'Unauthorized');
    }
    if (!(await isCourseStaffAnywhere(session.user))) {
      await createEnhancedActivityLog(prisma, req, {
        userId: session.user.id,
        action: opts.deniedAction,
        severity: 'SECURITY',
        category: opts.deniedCategory ?? 'SYSTEM',
        metadata: { reason: 'not course staff', required: 'faculty, TA or admin' },
      });
      return apiError(403, 'Forbidden');
    }
    return withServerTiming(req, () => handler(req, ctx, { session, user: session.user }));
  };
}

export type CourseAuthContext = {
  session: Session;
  user: SessionUser;
  /** The course the request is scoped to (resolved before the handler runs). */
  courseId: string;
};

type CourseParams = { params: Promise<Record<string, string>> };

/**
 * Wraps a course-scoped route handler with the shared gate, following the same
 * app-wide standard as {@link withAdminAuth}:
 *   - no signed-in session       -> 401 `{ error: 'Unauthorized' }` (not logged)
 *   - insufficient course role    -> 403 `{ error: 'Forbidden' }` + a SECURITY
 *                                    `deniedAction` audit event (scoped to the course)
 *
 * `access: 'manage'` requires course staff (FACULTY/TA by default; pass `roles` to
 * narrow, e.g. `['FACULTY']`); `access: 'read'` requires any enrolled member. Admins
 * pass both. The course id is read from the route param named `param` (default `id`).
 * The handler receives the resolved `{ session, user, courseId }`; it can still await
 * `ctx.params` for other params (e.g. `aid`).
 *
 * `blockWhenArchived: true` rejects the action with **409** when the course is
 * archived, **for everyone, admins included** (the archive freeze is not bypassed by
 * the admin short-circuit). Set it on every mutating course route *except* un-archive.
 */
export function withCourseAuth<Ctx extends CourseParams, R extends Response = Response>(
  handler: (req: Request, ctx: Ctx, auth: CourseAuthContext) => Promise<R> | R,
  opts: {
    access: 'manage' | 'read';
    deniedAction: string;
    deniedCategory?: ActivityCategory;
    roles?: CourseRole[];
    param?: string;
    blockWhenArchived?: boolean;
  },
): (req: Request, ctx: Ctx) => Promise<R | NextResponse> {
  return async (req: Request, ctx: Ctx) => {
    const session = await auth();
    // Reject a missing session or a disabled/deleted account before any course
    // check (see withAdminAuth); a stale JWT must not keep granting access.
    if (!session?.user || session.user.inactive) {
      return apiError(401, 'Unauthorized');
    }

    const params = await ctx.params;
    const courseId = params?.[opts.param ?? 'id'];
    if (!courseId) {
      return apiError(400, 'Missing course id');
    }

    // A soft-deleted course is inaccessible to everyone (admins included) since it's
    // retained only for out-of-band recovery. Mask it as 404 before the role gate so
    // its existence and data are never served through any course-scoped route (this
    // is the choke point the admin short-circuit in canAccessCourse would otherwise
    // slip past). Best-effort: if the lookup itself errors, fall through and let the
    // handler surface that error rather than masking a real fault as a 404.
    try {
      if (await isCourseDeleted(courseId)) {
        return apiError(404, 'Not found');
      }
    } catch {
      // Ignore; proceed to the normal flow; the handler will hit (and report) any
      // real DB fault.
    }

    const allowed =
      opts.access === 'manage'
        ? await canManageCourse(session.user, courseId, opts.roles)
        : await canAccessCourse(session.user, courseId);

    if (!allowed) {
      // Read the caller's standing now, not when somebody reads the log: roles and enrolment
      // change. One extra query, on the denial path only.
      let membership: {
        role?: CourseRole | null;
        status?: string | null;
        course?: { isPublished: boolean; startDate: Date | null } | null;
      } | null = null;
      try {
        membership = await prisma.roster.findFirst({
          where: { courseId, userId: session.user.id },
          // The course's own state comes too: a student enrolled in an unpublished course is
          // refused for a reason that has nothing to do with their enrolment, and reporting it
          // as "needs enrolled" sends whoever reads the log looking in the wrong place.
          select: {
            role: true,
            status: true,
            course: { select: { isPublished: true, startDate: true } },
          },
        });
      } catch {
        // A failed lookup must not turn the 403 into a 500; log the refusal without the role.
      }
      const required =
        opts.access === 'manage' ? (opts.roles ?? ['FACULTY', 'TA']).join(' or ') : 'enrolled';
      // Defensive: this path is already failing, so an unexpected shape must not throw.
      const role = membership?.role ?? null;
      const status = membership?.status ?? null;
      /**
       * Enrolled, not dropped, and still refused: the course is not open to students yet.
       *
       * Worth separating because it is the only denial here that the person can do nothing
       * about and their instructor can fix in one click, and because it is common. A course
       * starts unpublished, so every student who follows an LMS link before the instructor
       * publishes lands on this.
       */
      const unpublished =
        opts.access === 'read' &&
        role === 'STUDENT' &&
        status === 'ENROLLED' &&
        membership?.course?.isPublished === false;
      /**
       * Enrolled in a published course and still refused: it has not reached its start date.
       *
       * The same shape as `unpublished` above and separated for the same reasons. Without it
       * the refusal is logged as "student, needs enrolled", which is not true and sends
       * whoever reads the log looking at the roster for a fault that is a date.
       */
      const notStarted =
        opts.access === 'read' &&
        role === 'STUDENT' &&
        status === 'ENROLLED' &&
        membership?.course?.isPublished === true &&
        !courseHasStarted(membership?.course?.startDate);
      const reason = unpublished
        ? 'course not published'
        : notStarted
          ? 'course not started'
          : !membership
            ? 'not enrolled in this course'
            : status && status !== 'ENROLLED'
              ? `${status.toLowerCase()} from this course`
              : role
                ? `${role.toLowerCase()}, needs ${required.toLowerCase()}`
                : `needs ${required.toLowerCase()}`;

      await createEnhancedActivityLog(prisma, req, {
        userId: session.user.id,
        action: opts.deniedAction,
        severity: 'SECURITY',
        // Course-gate denials are course-level unless the caller says otherwise.
        category: opts.deniedCategory ?? 'COURSE',
        courseId,
        metadata: { reason, required, role, status },
      });
      // The only denial that says more than "Forbidden". Nothing is disclosed by it: they are
      // enrolled, so they already know the course exists, and the screen is otherwise left
      // telling them to refresh a page that will never load.
      if (unpublished) {
        return apiError(
          403,
          'This course has not been published yet, so it is not open to students.',
        );
      }
      // Same reasoning as the unpublished message: they are enrolled, so the course's
      // existence is not news, and "Forbidden" would leave them refreshing a page that will
      // not load until a date they were never told.
      if (notStarted) {
        return apiError(403, 'This course has not started yet, so it is not open to students.');
      }
      return apiError(403, 'Forbidden');
    }

    // Archive freeze: an archived course is read-only for everyone (admins too). This
    // runs *after* the role gate, unconditionally, so the admin short-circuit above
    // cannot slip a write past it.
    if (opts.blockWhenArchived && (await isCourseArchived(courseId))) {
      return apiError(409, 'Course is archived and cannot be modified');
    }

    return withServerTiming(req, () =>
      handler(req, ctx, { session, user: session.user, courseId }),
    );
  };
}

/** The assignment slice resolved and handed to a {@link withAssignmentAuth} handler. */
export type ResolvedAssignment = {
  id: string;
  courseId: string;
  isPublished: boolean;
};

export type AssignmentAuthContext = CourseAuthContext & { assignment: ResolvedAssignment };

/**
 * Course-scoped wrapper that also resolves an **assignment** and enforces the
 * assignment-level rules in one place:
 *   - the assignment must exist **and belong to the resolved course** (else 404);
 *   - for `access: 'read'`, a non-staff caller may only reach a **published**
 *     assignment: an unpublished one is masked as **404** (hide existence), matching
 *     the course publish gate for students.
 *
 * Builds on {@link withCourseAuth} (same 401 / 403+SECURITY / archive behavior). The
 * course id comes from `courseParam` (default `id`), the assignment id from
 * `assignmentParam` (default `aid`). The handler receives `{ …, assignment }`.
 */
export function withAssignmentAuth<Ctx extends CourseParams, R extends Response = Response>(
  handler: (req: Request, ctx: Ctx, auth: AssignmentAuthContext) => Promise<R> | R,
  opts: {
    access: 'manage' | 'read';
    deniedAction: string;
    roles?: CourseRole[];
    courseParam?: string;
    assignmentParam?: string;
    blockWhenArchived?: boolean;
  },
): (req: Request, ctx: Ctx) => Promise<R | NextResponse> {
  return withCourseAuth<Ctx, R | NextResponse>(
    async (req, ctx, courseAuth) => {
      const params = await ctx.params;
      const assignmentId = params?.[opts.assignmentParam ?? 'aid'];
      if (!assignmentId) {
        return apiError(400, 'Missing assignment id');
      }

      const assignment = await prisma.assignment.findFirst({
        where: { id: assignmentId, courseId: courseAuth.courseId },
        select: { id: true, courseId: true, isPublished: true },
      });

      // Not found, or not in this course → 404 (never leak that it exists elsewhere).
      if (!assignment) {
        return apiError(404, 'Not found');
      }

      // Student publish gate: a non-staff reader may only see a published assignment;
      // otherwise mask as 404. (Staff/admin, canManageCourse, see drafts.)
      if (opts.access === 'read' && !assignment.isPublished) {
        const isStaff = await canManageCourse(courseAuth.user, courseAuth.courseId, opts.roles);
        if (!isStaff) {
          return apiError(404, 'Not found');
        }
      }

      return handler(req, ctx, { ...courseAuth, assignment });
    },
    {
      access: opts.access,
      deniedAction: opts.deniedAction,
      roles: opts.roles,
      param: opts.courseParam,
      blockWhenArchived: opts.blockWhenArchived,
    },
  ) as (req: Request, ctx: Ctx) => Promise<R | NextResponse>;
}
