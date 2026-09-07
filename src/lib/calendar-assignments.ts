import { prisma } from '@/lib/prisma';
import { ACTIVE_STUDENT_ROSTER } from '@/lib/roster-status';
import { effectiveDeadline } from '@/lib/effective-deadline';
import {
  assignedToStudentWhere,
  groupIdsFromOverrides,
  overridesForStudentWhere,
} from '@/lib/assignment-visibility';
import type { CalendarAssignment } from '@/lib/calendar-shared';
export { getDateKeyInTimeZone, getMonthRangeIso } from '@/lib/calendar-shared';
// Re-exported so existing importers keep working; the implementation now lives in
// one place (`@/lib/user-timezone`).
export { resolveUserTimezone } from '@/lib/user-timezone';

/**
 * Every assignment that should appear on one person's calendar between two dates.
 *
 * Audience-aware: a student sees only what is assigned to them (directly, or through a group
 * set), with per-student and per-group date overrides already applied, so the date returned is
 * the one that binds them. Course staff see the whole course's assignments on their base dates.
 */
export async function getAssignmentsForUserRange(params: {
  userId: string;
  startDate: Date;
  endDate: Date;
}): Promise<CalendarAssignment[]> {
  const { userId, startDate, endDate } = params;

  const [rosterEntries, viewer] = await Promise.all([
    prisma.roster.findMany({
      // A course the viewer was dropped from (as a student) leaves their calendar; their
      // staff courses and active enrollments stay.
      where: { userId, NOT: { role: 'STUDENT', status: 'DROPPED' } },
      select: { courseId: true, role: true },
    }),
    prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } }),
  ]);
  const courseIds = rosterEntries.map((r) => r.courseId);
  if (courseIds.length === 0) return [];

  // The viewer may be staff in one course and a student in another, so decide the
  // calendar treatment per course from their roster role rather than a global one.
  // Admins get the staff treatment everywhere: the global flag outranks a STUDENT
  // roster row, matching the dashboard and the permission model.
  const isAdmin = Boolean(viewer?.isAdmin);
  const staffCourseIds = new Set(
    isAdmin
      ? courseIds
      : rosterEntries.filter((r) => r.role === 'FACULTY' || r.role === 'TA').map((r) => r.courseId),
  );
  const staffCourseIdsArr = courseIds.filter((id) => staffCourseIds.has(id));
  const studentCourseIdsArr = courseIds.filter((id) => !staffCourseIds.has(id));

  const assignments = await prisma.assignment.findMany({
    where: {
      // The calendar never includes archived or soft-deleted courses, for anyone.
      course: { isArchived: false, deletedAt: null },
      // In courses where the viewer is staff, show every assignment whose base due is in
      // range. Where they are a student, show only published assignments from published
      // courses, and match on the base due OR this student's own override due so an
      // extension that moves the date into (or out of) the range is handled below.
      OR: [
        { courseId: { in: staffCourseIdsArr }, dueDate: { gte: startDate, lte: endDate } },
        {
          courseId: { in: studentCourseIdsArr },
          isPublished: true,
          // Published AND started. `canAccessCourse` refuses a student the contents of a
          // course before its start date, so listing its work here would put deadlines on
          // their calendar that they cannot open.
          course: { isPublished: true, startDate: { lte: new Date() } },
          AND: [
            // Base due OR an override that applies to this student falls in the range. Their
            // group's counts: an extension granted to a group is the group members' deadline,
            // and matching only their own row left them looking at an empty week.
            {
              OR: [
                { dueDate: { gte: startDate, lte: endDate } },
                {
                  overrides: {
                    some: {
                      AND: [
                        overridesForStudentWhere(userId),
                        { dueDate: { gte: startDate, lte: endDate } },
                      ],
                    },
                  },
                },
              ],
            },
            // And the assignment is actually assigned to this student. Membership is the
            // assignee table, not the overrides: an override says when, never who, so asking
            // the override rows hid work that was assigned to them and carried no exception.
            assignedToStudentWhere(userId),
          ],
        },
      ],
    },
    select: {
      id: true,
      title: true,
      courseId: true,
      unlockAt: true,
      dueDate: true,
      allowLateSubmissions: true,
      lateCutoff: true,
      // Carried through so staff can see (and the UI can mark) unpublished/draft
      // assignments. Students only ever receive published ones (see the OR above).
      isPublished: true,
      // The overrides that bind this viewer: their own STUDENT row and the GROUP row for any
      // group they are in. It used to select `{ userId }` alone, which meant a group extension
      // was invisible here while the filter above had already widened on it: the assignment
      // was fetched because the group's date fell in the month, then resolved back to its base
      // date and dropped as out of range. The student lost it from the month it was due in.
      overrides: {
        where: overridesForStudentWhere(userId),
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
      course: {
        select: { id: true, code: true, name: true },
      },
    },
    orderBy: { dueDate: 'asc' },
  });

  const assignmentIds = assignments.map((a) => a.id);
  if (assignmentIds.length === 0) return [];

  // Student-view data (for courses where the viewer is a student): their own
  // submissions and grades. Independent reads, so fetch them concurrently.
  const [studentSubmissions, studentGrades] = await Promise.all([
    prisma.submission.findMany({
      where: { studentId: userId, assignmentId: { in: assignmentIds } },
      select: { assignmentId: true },
    }),
    prisma.assignmentProblemGrade.findMany({
      where: { studentId: userId, assignmentId: { in: assignmentIds } },
      select: { assignmentId: true },
    }),
  ]);
  const submissionSet = new Set(studentSubmissions.map((s) => s.assignmentId));
  const gradeSet = new Set(studentGrades.map((g) => g.assignmentId));

  // Staff-view data (for courses where the viewer is faculty/TA): class-wide
  // graded progress.
  const staffCourseIdList = Array.from(
    new Set(assignments.map((a) => a.courseId).filter((id) => staffCourseIds.has(id))),
  );

  const studentCountByCourse: Record<string, number> = {};
  const gradedCountByAssignment: Record<string, number> = {};
  if (staffCourseIdList.length > 0) {
    const staffAssignmentIds = assignments
      .filter((a) => staffCourseIds.has(a.courseId))
      .map((a) => a.id);

    const studentCounts = await prisma.roster.groupBy({
      by: ['courseId'],
      // Count active students only (a dropped student is not part of the active class).
      where: { courseId: { in: staffCourseIdList }, ...ACTIVE_STUDENT_ROSTER },
      _count: { _all: true },
    });
    studentCounts.forEach((c) => {
      studentCountByCourse[c.courseId] = c._count._all;
    });

    const gradedCounts = await prisma.assignmentProblemGrade.groupBy({
      by: ['assignmentId'],
      where: { assignmentId: { in: staffAssignmentIds } },
      _count: { _all: true },
    });
    gradedCounts.forEach((g) => {
      gradedCountByAssignment[g.assignmentId] = g._count._all;
    });
  }

  const now = new Date();
  const results: CalendarAssignment[] = [];
  for (const a of assignments) {
    // The resolution-only fields must not leak into the calendar payload.
    const { unlockAt, allowLateSubmissions, lateCutoff, overrides, ...rest } = a;
    const isStaff = staffCourseIds.has(a.courseId);

    // Staff see the base due date; a student sees their own effective due date.
    let dueDate = a.dueDate;
    if (!isStaff) {
      dueDate = effectiveDeadline(
        { unlockAt, dueDate: a.dueDate, allowLateSubmissions, lateCutoff },
        overrides ?? [],
        userId,
        groupIdsFromOverrides(overrides ?? []),
      ).dueDate;
      // The widened query can return an assignment whose base due is in range but whose
      // override moved this student's effective due out of it; drop those.
      if (dueDate < startDate || dueDate > endDate) continue;
    }

    const entry = { ...rest, dueDate };
    if (isStaff) {
      const totalStudents = studentCountByCourse[a.courseId] ?? 0;
      const gradedCount = gradedCountByAssignment[a.id] ?? 0;
      const allGraded = totalStudents > 0 && gradedCount >= totalStudents;
      const duePassed = dueDate < now;
      results.push({
        ...entry,
        crossedOut: duePassed && allGraded,
        totalStudents,
        gradedCount,
        allGraded,
      });
    } else {
      results.push({
        ...entry,
        crossedOut: submissionSet.has(a.id) || gradeSet.has(a.id),
        studentHasSubmission: submissionSet.has(a.id),
        studentHasGrade: gradeSet.has(a.id),
      });
    }
  }
  return results;
}
