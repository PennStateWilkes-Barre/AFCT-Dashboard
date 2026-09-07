import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  groupSet: { findUnique: vi.fn(), updateMany: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
  assignment: { count: vi.fn() },
  roster: { findMany: vi.fn() },
}));
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

import {
  lockGroupSetIfUsed,
  isGroupSetLocked,
  assertGroupSetUnlocked,
  groupSetDeletionBlockers,
  findGroupSet,
  fetchEligibleStudents,
  activeStudentIds,
  loadGroupSetSummaries,
  loadGroupSetDetail,
  activeStudentRosterWhere,
} from './group-set-service';
import { GroupSetLockedError } from './group-sets';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('lockGroupSetIfUsed', () => {
  it('is a no-op when there is no group set (individual assignment)', async () => {
    await lockGroupSetIfUsed(prismaMock as never, null);
    await lockGroupSetIfUsed(prismaMock as never, undefined);
    expect(prismaMock.groupSet.updateMany).not.toHaveBeenCalled();
  });

  it('stamps lockedAt only when still unset (sticky + idempotent)', async () => {
    await lockGroupSetIfUsed(prismaMock as never, 'gs1');
    const arg = prismaMock.groupSet.updateMany.mock.calls[0]![0];
    // The where filters lockedAt: null, so a second call never overwrites the first stamp.
    expect(arg.where).toEqual({ id: 'gs1', lockedAt: null });
    expect(arg.data.lockedAt).toBeInstanceOf(Date);
  });
});

describe('isGroupSetLocked', () => {
  it('is true once lockedAt is set, false otherwise', async () => {
    prismaMock.groupSet.findUnique.mockResolvedValueOnce({ lockedAt: new Date() });
    expect(await isGroupSetLocked('gs1')).toBe(true);
    prismaMock.groupSet.findUnique.mockResolvedValueOnce({ lockedAt: null });
    expect(await isGroupSetLocked('gs1')).toBe(false);
  });

  it('assertGroupSetUnlocked throws when locked', async () => {
    prismaMock.groupSet.findUnique.mockResolvedValue({ lockedAt: new Date() });
    await expect(assertGroupSetUnlocked('gs1')).rejects.toBeInstanceOf(GroupSetLockedError);
  });
});

describe('groupSetDeletionBlockers', () => {
  it('blocks a locked set and a referenced set, allows an empty unlocked one', async () => {
    prismaMock.groupSet.findUnique.mockResolvedValue({ lockedAt: new Date() });
    prismaMock.assignment.count.mockResolvedValue(2);
    expect(await groupSetDeletionBlockers('gs1')).toHaveLength(2);

    prismaMock.groupSet.findUnique.mockResolvedValue({ lockedAt: null });
    prismaMock.assignment.count.mockResolvedValue(0);
    expect(await groupSetDeletionBlockers('gs1')).toEqual([]);
  });
});

/**
 * What these lookups are scoped to.
 *
 * A group set belongs to exactly one course, and so does the roster it can draw members from.
 * Every one of these takes the course id as its first argument and is trusted to use it: the
 * prisma mock answers from its fixture regardless, so without the `courseId` `findGroupSet`
 * happily returns another course's set and the eligible-students list offers people who are
 * not in the course at all.
 */
describe('what the group set lookups are scoped to', () => {
  const whereOf = (fn: { mock: { calls: unknown[][] } }) =>
    (fn.mock.calls[0][0] as { where: unknown }).where;

  it('finds a set only inside its course', async () => {
    prismaMock.groupSet.findFirst.mockResolvedValue({ id: 'gs1' });

    await findGroupSet('c1', 'gs1');

    expect(whereOf(prismaMock.groupSet.findFirst)).toEqual({ id: 'gs1', courseId: 'c1' });
  });

  it('lists a set’s full detail only inside its course', async () => {
    prismaMock.groupSet.findFirst.mockResolvedValue(null);
    prismaMock.roster.findMany.mockResolvedValue([]);

    await loadGroupSetDetail('c1', 'gs1');

    expect(whereOf(prismaMock.groupSet.findFirst)).toEqual({ id: 'gs1', courseId: 'c1' });
  });

  it('summarises only this course’s sets', async () => {
    prismaMock.groupSet.findMany.mockResolvedValue([]);

    await loadGroupSetSummaries('c1');

    expect(whereOf(prismaMock.groupSet.findMany)).toEqual({ courseId: 'c1' });
  });

  it('offers only active students of this course', async () => {
    prismaMock.roster.findMany.mockResolvedValue([]);

    await fetchEligibleStudents('c1');

    expect(whereOf(prismaMock.roster.findMany)).toEqual(activeStudentRosterWhere('c1'));
  });

  it('checks the given ids against this course’s active roster only', async () => {
    prismaMock.roster.findMany.mockResolvedValue([{ userId: 'u1' }]);

    await activeStudentIds('c1', ['u1', 'u2']);

    expect(whereOf(prismaMock.roster.findMany)).toEqual({
      ...activeStudentRosterWhere('c1'),
      userId: { in: ['u1', 'u2'] },
    });
  });
});
