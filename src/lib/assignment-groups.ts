import { prisma } from '@/lib/prisma';

/**
 * The StudentGroup ids a student works in for this assignment: their group in the
 * assignment's group set, if it has one. At most one, because `GroupMembership` is unique
 * on (groupSetId, userId). Empty for an individual assignment, or for a student who is in
 * the set's course but not in any of its groups.
 *
 * **Membership is what decides this, not the audience rows.** A group assignment means the
 * group works together: the members share one submission set, one submission count, and one
 * cap, so "the group gets 5 attempts" is 5 between them rather than 5 each. That has to hold
 * however the assignment was targeted, and the default targeting is `assignedToEveryone`,
 * which carries no assignee rows at all.
 *
 * This used to read GROUP `AssignmentOverride` rows instead, which are date-only and usually
 * absent, so it returned nothing for an ordinary group assignment. The members then submitted
 * as individuals: separate submission sets, and a private cap each. Every read path that
 * shows a student their group had already been written against membership, so the two
 * disagreed, and an extra-submission grant aimed at a group was displayed but never enforced.
 */
export async function resolveStudentAssignmentGroupIds(
  assignmentId: string,
  userId: string,
): Promise<string[]> {
  const assignment = await prisma.assignment.findUnique({
    where: { id: assignmentId },
    select: { groupSetId: true },
  });
  if (!assignment?.groupSetId) return [];

  const rows = await prisma.groupMembership.findMany({
    where: { groupSetId: assignment.groupSetId, userId },
    select: { groupId: true },
  });
  return rows.map((r) => r.groupId);
}

/**
 * The single group submission set a student's submit should write to for an assignment, or
 * null for an individual submission. Given the one-group-per-set rule this is the first
 * (only) group the student belongs to in the assignment's set.
 */
export async function resolveStudentSubmissionGroupId(
  assignmentId: string,
  userId: string,
): Promise<string | null> {
  const ids = await resolveStudentAssignmentGroupIds(assignmentId, userId);
  return ids[0] ?? null;
}

/**
 * The same rule as `resolveStudentAssignmentGroupIds`, answered in one query for a whole
 * gradebook: which groups each student is in, **within a named group set**.
 *
 * The batch paths (the gradebook, the exports, both statistics services) each grew their own
 * `groupMembership.findMany` and each forgot the set. They asked "every group this person is
 * in", anywhere, in any course, and handed that to `missing-work`, whose `groupIds` input is
 * documented as the groups in *this assignment's own* set and whose empty case is the
 * exemption: no group means no way to submit, so no zero. A student in no group here but in
 * some group elsewhere therefore lost the exemption and was scored zero on a group assignment
 * they were never in a group for, and since the LMS passback that zero left the building.
 *
 * Hence an index rather than a map: `for()` takes the set id, so a caller cannot ask the
 * question without saying which assignment it is about. A null set id is an individual
 * assignment, which has no groups by definition.
 */
export type StudentGroupIndex = {
  /** This student's groups in that set. Empty for an individual assignment, or for a student
   *  who is in the set's course but in none of its groups. */
  for(groupSetId: string | null | undefined, userId: string): string[];
  /** Every group id in the index, for widening a submissions query to group-owned rows. */
  all(): string[];
};

export async function loadStudentGroupIndex(
  groupSetIds: ReadonlyArray<string | null | undefined>,
  userIds: readonly string[],
): Promise<StudentGroupIndex> {
  const setIds = [...new Set(groupSetIds.filter((id): id is string => !!id))];
  const byKey = new Map<string, string[]>();
  const every = new Set<string>();

  if (setIds.length > 0 && userIds.length > 0) {
    const rows = await prisma.groupMembership.findMany({
      where: { groupSetId: { in: setIds }, userId: { in: [...userIds] } },
      select: { groupSetId: true, userId: true, groupId: true },
    });
    for (const r of rows) {
      // A space, not a NUL: cuids contain neither, and a raw NUL in a source file makes git
      // and grep treat it as binary. The same choice `missing-work.ts` documents.
      const key = `${r.groupSetId} ${r.userId}`;
      byKey.set(key, [...(byKey.get(key) ?? []), r.groupId]);
      every.add(r.groupId);
    }
  }

  return {
    for: (groupSetId, userId) => (groupSetId ? (byKey.get(`${groupSetId} ${userId}`) ?? []) : []),
    all: () => [...every],
  };
}
