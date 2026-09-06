import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GroupSetLockedError } from '@/lib/group-sets';

const prismaMock = vi.hoisted(() => ({
  studentGroup: { findMany: vi.fn() },
  groupMembership: { findMany: vi.fn(), deleteMany: vi.fn(), upsert: vi.fn() },
  course: { findUnique: vi.fn() },
  roster: { findFirst: vi.fn() },
  // Per-student membership entries are written in one statement after the transaction.
  activityLog: { createMany: vi.fn() },
  $transaction: vi.fn(),
}));
const authMock = vi.hoisted(() => vi.fn());
const activityLogMock = vi.hoisted(() => vi.fn());
const serviceMock = vi.hoisted(() => ({
  findGroupSet: vi.fn(),
  activeStudentIds: vi.fn(),
  loadGroupSetDetail: vi.fn(),
  assertGroupSetUnlocked: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/activity-log-utils', () => ({ createEnhancedActivityLog: activityLogMock }));
vi.mock('@/lib/group-set-service', () => serviceMock);

import { POST } from './route';

const ctx = { params: { id: 'c1', setId: 'gs1' } } as never;
const txMock = { groupMembership: { deleteMany: vi.fn(), upsert: vi.fn() } };
const post = (body: unknown) =>
  POST(
    new NextRequest('http://localhost/api/courses/c1/group-sets/gs1/memberships', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    ctx,
  );

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: 'staff', role: 'FACULTY' } });
  prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
  prismaMock.course.findUnique.mockResolvedValue({ isArchived: false });
  serviceMock.findGroupSet.mockResolvedValue({ id: 'gs1', courseId: 'c1' });
  serviceMock.loadGroupSetDetail.mockResolvedValue({
    id: 'gs1',
    name: 'S',
    groups: [],
    eligibleStudents: [],
    basis: 'x',
  });
  serviceMock.activeStudentIds.mockResolvedValue(new Set(['u1', 'u2']));
  // Names as well as ids: the same query answers the "are these groups in this set" check and
  // the lookup that puts readable names on the audit rows.
  prismaMock.studentGroup.findMany.mockResolvedValue([
    { id: 'g1', name: 'Group A' },
    { id: 'g2', name: 'Group B' },
  ]);
  // Where each affected student was before the edit, which the per-student entries record as
  // their from-group. Empty by default: nobody was in a group yet.
  prismaMock.groupMembership.findMany.mockResolvedValue([]);
  prismaMock.activityLog.createMany.mockResolvedValue({ count: 0 });
  txMock.groupMembership.deleteMany.mockReset();
  txMock.groupMembership.upsert.mockReset();
  prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(txMock));
});

describe('POST memberships', () => {
  it('assigns, moves, and removes in one atomic transaction', async () => {
    const res = await post({
      operations: [
        { userId: 'u1', groupId: 'g1' }, // assign/move
        { userId: 'u2', groupId: 'g2' }, // assign/move
        { userId: 'u3', groupId: null }, // remove
      ],
    });
    expect(res.status).toBe(200);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(txMock.groupMembership.deleteMany).toHaveBeenCalledWith({
      where: { groupSetId: 'gs1', userId: { in: ['u3'] } },
    });
    // A move is a single upsert on the (set, user) key: never a two-group state.
    expect(txMock.groupMembership.upsert).toHaveBeenCalledTimes(2);
    expect(activityLogMock).toHaveBeenCalled();
  });

  it('rejects assigning an ineligible (inactive/non-student) student', async () => {
    serviceMock.activeStudentIds.mockResolvedValue(new Set(['u1'])); // u2 not eligible
    const res = await post({
      operations: [
        { userId: 'u1', groupId: 'g1' },
        { userId: 'u2', groupId: 'g1' },
      ],
    });
    expect(res.status).toBe(400);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a group that does not belong to the set', async () => {
    const res = await post({ operations: [{ userId: 'u1', groupId: 'other' }] });
    expect(res.status).toBe(400);
  });

  it('rejects duplicate userIds in one request', async () => {
    const res = await post({
      operations: [
        { userId: 'u1', groupId: 'g1' },
        { userId: 'u1', groupId: null },
      ],
    });
    expect(res.status).toBe(400);
  });

  it('409 when expectedBasis is stale', async () => {
    prismaMock.groupMembership.findMany.mockResolvedValue([{ userId: 'u1', groupId: 'g1' }]);
    const res = await post({
      operations: [{ userId: 'u2', groupId: 'g2' }],
      expectedBasis: 'definitely-stale',
    });
    expect(res.status).toBe(409);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('404 when the set is not in this course', async () => {
    serviceMock.findGroupSet.mockResolvedValue(null);
    const res = await post({ operations: [{ userId: 'u1', groupId: 'g1' }] });
    expect(res.status).toBe(404);
  });

  it('409 when the set is locked (has submissions)', async () => {
    serviceMock.assertGroupSetUnlocked.mockRejectedValue(new GroupSetLockedError());
    const res = await post({ operations: [{ userId: 'u1', groupId: 'g1' }] });
    expect(res.status).toBe(409);
  });
});

/**
 * A move has to record where the student came FROM.
 *
 * The request carries only the destination group, so the previous one has to be read before
 * the upsert. Without it the log cannot answer "whose work did this group's grade land on
 * before the reshuffle", which is the question the entry exists for.
 */
describe('membership audit', () => {
  // An earlier test leaves this rejecting, and clearAllMocks resets calls but not
  // implementations, so say what this block needs rather than inheriting a locked set.
  beforeEach(() => {
    serviceMock.assertGroupSetUnlocked.mockResolvedValue(undefined);
  });

  it('records the group a student moved out of, not just the one they went to', async () => {
    prismaMock.groupMembership.findMany.mockResolvedValue([{ userId: 'u1', groupId: 'g1' }]);

    const res = await post({ operations: [{ userId: 'u1', groupId: 'g2' }] });
    expect(res.status).toBe(200);

    const rows = prismaMock.activityLog.createMany.mock.calls[0]?.[0]?.data ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('GROUP_MEMBERSHIP_ASSIGNED');
    // Both, on purpose: the id is what survives a rename, the name is what a person reading
    // the log can act on. Without the names the entry read "one student, cmtf35e5j00 to
    // cmtf35e5i00".
    expect(rows[0].metadata).toMatchObject({
      targetUserId: 'u1',
      fromGroupId: 'g1',
      toGroupId: 'g2',
      fromGroupName: 'Group A',
      toGroupName: 'Group B',
    });
  });

  it('writes one row per student rather than a capped list on the summary', async () => {
    // More than the old 100-name cap: the point is that none of them go missing.
    const many = Array.from({ length: 150 }, (_, i) => `u${i}`);
    serviceMock.activeStudentIds.mockResolvedValue(new Set(many));
    prismaMock.groupMembership.findMany.mockResolvedValue([]);

    const res = await post({ operations: many.map((userId) => ({ userId, groupId: 'g1' })) });
    expect(res.status).toBe(200);

    const rows = prismaMock.activityLog.createMany.mock.calls[0]?.[0]?.data ?? [];
    expect(rows).toHaveLength(150);

    const summary = activityLogMock.mock.calls.at(-1)?.[2];
    expect(summary.metadata.assignedCount).toBe(150);
    // The truncated copy is gone: one version of the truth, in the rows above.
    expect(summary.metadata.assigned).toBeUndefined();
  });
});

/**
 * Whose previous groups are read before an edit.
 *
 * A membership edit records where each student came from, and that "before" picture is this
 * one read. The prisma mock answers with its fixture whatever the `where` says, so without
 * the `userId` it reads everybody in the set and the per-student audit entries would name the
 * wrong from-group, which is exactly the half a group grade turns on.
 */
describe('whose previous groups the audit reads', () => {
  it('asks only about the students this edit touches, in this set', async () => {
    const res = await post({
      operations: [
        { userId: 'u1', groupId: 'g1' },
        { userId: 'u3', groupId: null },
      ],
    });
    expect(res.status).toBe(200);

    expect(prismaMock.groupMembership.findMany.mock.calls[0][0]).toMatchObject({
      where: { groupSetId: 'gs1', userId: { in: ['u3', 'u1'] } },
    });
  });
});
