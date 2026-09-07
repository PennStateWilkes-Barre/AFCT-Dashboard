import type { Prisma } from '@prisma/client';

/**
 * A student is "assigned" an assignment when it is assigned to everyone, when an
 * AssignmentAssignee row names them individually, or when a GROUP assignee row names a
 * group they belong to. This is the single definition both the DB queries (via
 * `assignedToStudentWhere`) and the in-memory checks (`isStudentAssigned`) use, so "assign
 * to specific students / groups" is enforced consistently across every student surface.
 *
 * Membership is the AssignmentAssignee table only. Date/late AssignmentOverride rows are a
 * separate concern (WHEN, not WHO) and never affect whether someone is assigned.
 */
export function assignedToStudentWhere(userId: string): Prisma.AssignmentWhereInput {
  return {
    OR: [
      { assignedToEveryone: true },
      { assignees: { some: { userId } } },
      // Group target: the assignee row points at a StudentGroup this student belongs to.
      { assignees: { some: { studentGroup: { memberships: { some: { userId } } } } } },
    ],
  };
}

/**
 * The AssignmentOverride rows that apply to one student: their own STUDENT override plus
 * any GROUP override on a group they belong to. Filtering by this means every row returned
 * is already relevant to that student, so callers can derive the group ids straight from
 * the result instead of doing a second membership read.
 */
export function overridesForStudentWhere(userId: string): Prisma.AssignmentOverrideWhereInput {
  return {
    OR: [{ userId }, { studentGroup: { memberships: { some: { userId } } } }],
  };
}

/**
 * The student's group ids, read back off override rows selected with
 * `overridesForStudentWhere`.
 *
 * `effectiveDeadline` only lets a GROUP override apply when its groupId is in the list it is
 * given, so a caller that selects group overrides and then passes no groups gets the base
 * date back and no error. That is a wrong deadline, not a crash, and it is exactly what the
 * dashboard and the calendar were doing.
 *
 * Safe because of how the rows were selected: `overridesForStudentWhere` returns GROUP rows
 * only for groups this student belongs to, so every groupId present is one of theirs and no
 * extra membership query is needed. Use the two together, always.
 */
export function groupIdsFromOverrides(
  overrides: ReadonlyArray<{ groupId?: string | null }>,
): string[] {
  return overrides.map((o) => o.groupId).filter((id): id is string => id != null);
}

export function isStudentAssigned(
  assignment: { assignedToEveryone: boolean },
  assignees: Array<{ userId: string | null; groupId?: string | null }>,
  userId: string,
  studentGroupIds: readonly string[] = [],
): boolean {
  // `!== false` so a missing flag (e.g. a partial select) defaults to assigned, matching
  // the NOT NULL default true on the column.
  if (assignment.assignedToEveryone !== false) return true;
  return assignees.some(
    (a) => a.userId === userId || (a.groupId != null && studentGroupIds.includes(a.groupId)),
  );
}
