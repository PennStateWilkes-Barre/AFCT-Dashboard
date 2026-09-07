import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  assignment: { findUnique: vi.fn() },
  groupMembership: { findMany: vi.fn() },
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

import { resolveStudentAssignmentGroupIds, resolveStudentSubmissionGroupId, loadStudentGroupIndex } from './assignment-groups';

/**
 * The single definition of "which group is this student in, for this assignment".
 *
 * Five call sites depend on it (the two submission paths, the staff review data, the
 * per-student group lookup and the submission detail read), so a change in meaning here moves
 * what students are allowed to do. The rule it encodes: a group assignment means the members
 * share one submission set and one cap, so the group collectively gets the problem's
 * `maxSubmissions`, not that many each.
 *
 * It reads GroupMembership, deliberately. The previous version read GROUP `AssignmentOverride`
 * rows, which are date-only and absent from an ordinary group assignment, so it returned
 * nothing and the members submitted as individuals.
 */

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.assignment.findUnique.mockResolvedValue({ groupSetId: 'gs-1' });
  prismaMock.groupMembership.findMany.mockResolvedValue([{ groupId: 'group-9' }]);
});

describe('resolveStudentAssignmentGroupIds', () => {
  it("returns the student's group in the assignment's set", async () => {
    await expect(resolveStudentAssignmentGroupIds('a-1', 'u-1')).resolves.toEqual(['group-9']);
    expect(prismaMock.groupMembership.findMany).toHaveBeenCalledWith({
      where: { groupSetId: 'gs-1', userId: 'u-1' },
      select: { groupId: true },
    });
  });

  it('does not depend on the assignment carrying an assignee or override row', async () => {
    // The default group assignment has neither. Nothing here consults them.
    await resolveStudentAssignmentGroupIds('a-1', 'u-1');
    const where = prismaMock.groupMembership.findMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('assignmentId');
    expect(JSON.stringify(where)).not.toContain('override');
  });

  it('is empty for an individual assignment, without asking about memberships', async () => {
    prismaMock.assignment.findUnique.mockResolvedValue({ groupSetId: null });
    await expect(resolveStudentAssignmentGroupIds('a-1', 'u-1')).resolves.toEqual([]);
    expect(prismaMock.groupMembership.findMany).not.toHaveBeenCalled();
  });

  it('is empty when the assignment does not exist', async () => {
    prismaMock.assignment.findUnique.mockResolvedValue(null);
    await expect(resolveStudentAssignmentGroupIds('nope', 'u-1')).resolves.toEqual([]);
    expect(prismaMock.groupMembership.findMany).not.toHaveBeenCalled();
  });

  it('is empty for a student in the course but in none of the set’s groups', async () => {
    prismaMock.groupMembership.findMany.mockResolvedValue([]);
    await expect(resolveStudentAssignmentGroupIds('a-1', 'u-1')).resolves.toEqual([]);
  });

  it('scopes the membership lookup to this set, so another set’s group cannot leak in', async () => {
    prismaMock.assignment.findUnique.mockResolvedValue({ groupSetId: 'gs-2' });
    await resolveStudentAssignmentGroupIds('a-1', 'u-1');
    expect(prismaMock.groupMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ groupSetId: 'gs-2' }) }),
    );
  });
});

describe('resolveStudentSubmissionGroupId', () => {
  it('is the one group when there is one', async () => {
    await expect(resolveStudentSubmissionGroupId('a-1', 'u-1')).resolves.toBe('group-9');
  });

  it('is null for an individual assignment', async () => {
    prismaMock.assignment.findUnique.mockResolvedValue({ groupSetId: null });
    await expect(resolveStudentSubmissionGroupId('a-1', 'u-1')).resolves.toBeNull();
  });

  it('is null for an ungrouped student', async () => {
    prismaMock.groupMembership.findMany.mockResolvedValue([]);
    await expect(resolveStudentSubmissionGroupId('a-1', 'u-1')).resolves.toBeNull();
  });
});

/**
 * What the group index asks for.
 *
 * `loadStudentGroupIndex` exists because the version before it asked for every membership
 * these students hold anywhere, which is a different question and the wrong one (it cost the
 * gradebook its missing-work exemption). The prisma mock answers from its fixture whatever
 * the `where` says, so the only way to hold that fix in place is to assert the query.
 */
describe('loadStudentGroupIndex', () => {
  it('asks only about these group sets and these students', async () => {
    prismaMock.groupMembership.findMany.mockResolvedValue([
      { groupSetId: 'gs1', userId: 'u1', groupId: 'g1' },
    ]);

    const index = await loadStudentGroupIndex(['gs1', null, 'gs1'], ['u1', 'u2']);

    expect(prismaMock.groupMembership.findMany.mock.calls[0][0]).toMatchObject({
      where: { groupSetId: { in: ['gs1'] }, userId: { in: ['u1', 'u2'] } },
    });
    expect(index.for('gs1', 'u1')).toEqual(['g1']);
    expect(index.for('gs1', 'u2')).toEqual([]);
    expect(index.all()).toEqual(['g1']);
  });

  it('asks nothing when there is no group set or nobody to ask about', async () => {
    await loadStudentGroupIndex([null, undefined], ['u1']);
    await loadStudentGroupIndex(['gs1'], []);

    expect(prismaMock.groupMembership.findMany).not.toHaveBeenCalled();
  });
});
