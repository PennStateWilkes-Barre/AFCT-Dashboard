import { prisma } from '@/lib/prisma';
import type { CourseRole } from '@prisma/client';
import { courseHasStarted } from '@/lib/course-status';

/**
 * Authorization primitives for the user + admin-flag + per-course-role model.
 *
 * Global authority is a single flag (`isAdmin`); everything else is decided by the
 * caller's role IN a specific course (their `Roster.role`). Route handlers use these
 * helpers instead of inspecting a global role, so the rules live in one tested place.
 */

// The slice of the session user these checks need.
export type PermissionUser = { id?: string | null; isAdmin?: boolean | null } | null | undefined;

// Course roles at the faculty tier (top of a course; TAs excluded).
export const COURSE_FACULTY_ROLES: CourseRole[] = ['FACULTY'];

// Course roles that count as "staff" (may manage a course). Admins bypass this.
export const COURSE_STAFF_ROLES: CourseRole[] = ['FACULTY', 'TA'];

/** Global system administrator: full access everywhere. */
export function isAdmin(user: PermissionUser): boolean {
  return Boolean(user?.isAdmin);
}

/**
 * The caller's role in a specific course, or null if they're not an active member.
 * A DROPPED student is treated as a non-member (returns null) so the surfaces that key
 * off "do they have a role here" (staff-vs-student page routing) exclude them, the same
 * as if they were never enrolled. FACULTY/TA are unaffected (status applies to students).
 */
export async function getCourseRole(
  userId: string | null | undefined,
  courseId: string | null | undefined,
): Promise<CourseRole | null> {
  if (!userId || !courseId) return null;
  const entry = await prisma.roster.findFirst({
    where: { courseId, userId },
    select: { role: true, status: true },
  });
  if (!entry) return null;
  // A student is an active member unless explicitly DROPPED (the column is NOT NULL
  // DEFAULT ENROLLED, so "not dropped" is the same as ENROLLED for real rows).
  if (entry.role === 'STUDENT' && entry.status === 'DROPPED') return null;
  return entry.role;
}

/**
 * May the caller see this course at all? A system admin always may. Otherwise they
 * must be on the roster, AND, for a student, the course must be published and started;
 * course staff (FACULTY/TA) may access their course even while it is unpublished or before
 * it opens. This is the single gate for course-scoped reads, so the "students only see
 * published courses that have started" rule lives here rather than being re-checked in
 * every route.
 *
 * One query (role + the course's published flag); admins short-circuit before it.
 */
export async function canAccessCourse(user: PermissionUser, courseId: string): Promise<boolean> {
  if (isAdmin(user)) {
    // A soft-deleted course is inaccessible to everyone, even a system admin.
    // Best-effort: if the lookup errors, fall through and allow, so a transient DB
    // fault surfaces from the handler rather than masking as a denial.
    try {
      if (await isCourseDeleted(courseId)) return false;
    } catch {
      /* fall through */
    }
    return true;
  }
  if (!user?.id) return false;
  const entry = await prisma.roster.findFirst({
    where: { courseId, userId: user.id },
    select: {
      role: true,
      status: true,
      course: { select: { isPublished: true, deletedAt: true, startDate: true } },
    },
  });
  if (!entry) return false;
  // A soft-deleted course is inaccessible to non-admins (retained only for recovery).
  if (entry.course?.deletedAt) return false;
  if (entry.role === 'FACULTY' || entry.role === 'TA') return true;
  // Students only once the course is published, has STARTED, and while not DROPPED. A
  // DROPPED student keeps their roster row and all their work, but is denied access here (the
  // single gate), which cascades to every course-scoped route and the native client. (The
  // status column is NOT NULL DEFAULT ENROLLED, so "not dropped" means enrolled.)
  //
  // The start date is a gate on entering, not on seeing: a course still appears under
  // Upcoming Courses, because those lists are built from their own queries rather than
  // through here, and the course page turns this denial into "opens on <date>" rather than a
  // 404. Staff returned above, so building a course before it opens is unaffected.
  return (
    entry.course.isPublished &&
    entry.status !== 'DROPPED' &&
    courseHasStarted(entry.course.startDate)
  );
}

/**
 * May the caller perform a staff action in this course? Admins always; otherwise
 * their course role must be one of `roles` (default: FACULTY or TA). Pass a
 * narrower set (e.g. `['FACULTY']`) for actions TAs shouldn't do.
 */
export async function canManageCourse(
  user: PermissionUser,
  courseId: string,
  roles: CourseRole[] = COURSE_STAFF_ROLES,
): Promise<boolean> {
  if (isAdmin(user)) {
    // A soft-deleted course can't be managed by anyone, even a system admin.
    try {
      if (await isCourseDeleted(courseId)) return false;
    } catch {
      /* fall through */
    }
    return true;
  }
  if (!user?.id) return false;
  const entry = await prisma.roster.findFirst({
    where: { courseId, userId: user.id },
    select: { role: true, course: { select: { deletedAt: true } } },
  });
  if (!entry) return false;
  // A soft-deleted course can't be managed by non-admins (retained only for recovery).
  if (entry.course?.deletedAt) return false;
  return roles.includes(entry.role);
}

/** Is this course archived? A `null`/missing course reads as not archived. */
export async function isCourseArchived(courseId: string): Promise<boolean> {
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: { isArchived: true },
  });
  return Boolean(course?.isArchived);
}

/**
 * Is this course soft-deleted? Used to keep deleted courses inaccessible to everyone
 * (admins included). A `null`/missing course reads as not deleted, so the handler
 * still runs and returns its own 404.
 */
export async function isCourseDeleted(courseId: string): Promise<boolean> {
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: { deletedAt: true },
  });
  return Boolean(course?.deletedAt);
}

/**
 * Does the caller have scoped account authority over `targetUserId`? True when the
 * caller is a system admin, or is **course staff (FACULTY/TA) of any course in which
 * the target is enrolled as a STUDENT**. This is the gate for a faculty/TA acting on
 * a student's account (e.g. resetting their password): being a STUDENT in one of the
 * caller's courses is sufficient; the target's roles in *other* courses don't matter.
 */
export async function staffManagesStudent(
  caller: PermissionUser,
  targetUserId: string,
): Promise<boolean> {
  if (isAdmin(caller)) return true;
  if (!caller?.id || !targetUserId) return false;
  // A student-roster row for the target whose course also rosters the caller as staff.
  const rel = await prisma.roster.findFirst({
    where: {
      userId: targetUserId,
      role: 'STUDENT',
      course: {
        roster: { some: { userId: caller.id, role: { in: COURSE_STAFF_ROLES } } },
      },
    },
    select: { id: true },
  });
  return rel !== null;
}

/**
 * Is the caller course staff (FACULTY/TA) somewhere, or a system admin?
 *
 * For the few surfaces that are staff tools without belonging to any one course, the
 * evaluator trial page being the first: the work has no course, so there is no course
 * id to gate on, but it still must not be reachable by students. Soft-deleted courses
 * do not count, matching every course-scoped check.
 */
export async function isCourseStaffAnywhere(user: PermissionUser): Promise<boolean> {
  if (isAdmin(user)) return true;
  if (!user?.id) return false;
  const staffRow = await prisma.roster.findFirst({
    where: {
      userId: user.id,
      role: { in: COURSE_STAFF_ROLES },
      course: { deletedAt: null },
    },
    select: { id: true },
  });
  return staffRow !== null;
}

/** Is `userId` a member of this specific student group? */
export async function isMemberOfGroup(
  groupId: string | null | undefined,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!groupId || !userId) return false;
  const membership = await prisma.groupMembership.findFirst({
    where: { groupId, userId },
    select: { id: true },
  });
  return membership !== null;
}

/**
 * May the caller view `targetStudentId`'s course-scoped data (submissions, grades,
 * review data, files)? Admins and course staff may view anyone's; a student may view
 * **their own**. For a **group submission**, pass `opts.studentGroupId` (the group that
 * owns the work): a student may also view it if they belong to **that exact group**.
 * Never crosses into another student/group.
 *
 * IMPORTANT: the group check is scoped to the owning group id, NOT "shares any group in
 * the course". A course can hold several group sets, so two students who are groupmates
 * in one set but not in the set this submission belongs to must NOT see each other's work.
 *
 * Course membership itself is assumed already gated (e.g. by `withCourseAuth`); this
 * decides *whose* data within the course the caller may see.
 */
export async function canViewStudentData(
  user: PermissionUser,
  courseId: string,
  targetStudentId: string,
  opts?: { studentGroupId?: string | null },
): Promise<boolean> {
  if (isAdmin(user)) return true;
  if (!user?.id) return false;
  if (user.id === targetStudentId) return true;
  if (await canManageCourse(user, courseId)) return true;
  if (opts?.studentGroupId) {
    return isMemberOfGroup(opts.studentGroupId, user.id);
  }
  return false;
}
