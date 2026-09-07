import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

const txMock = vi.hoisted(() => ({
  groupSet: { findUnique: vi.fn() },
  studentGroup: { delete: vi.fn() },
}));

const prismaMock = vi.hoisted(() => ({
  roster: { findFirst: vi.fn() },
  course: { findUnique: vi.fn() },
  studentGroup: { findFirst: vi.fn(), update: vi.fn() },
  groupSet: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));

const authMock = vi.hoisted(() => vi.fn());
const activityLogMock = vi.hoisted(() => vi.fn());
const logErrorMock = vi.hoisted(() => vi.fn());
const assertUnlockedMock = vi.hoisted(() => vi.fn());
const deleteGroupMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/activity-log-utils', () => ({ createEnhancedActivityLog: activityLogMock }));
vi.mock('@/lib/api/activity', () => ({ logError: logErrorMock }));
vi.mock('@/lib/group-set-service', () => ({
  assertGroupSetUnlocked: assertUnlockedMock,
  deleteGroupIfSetUnlocked: deleteGroupMock,
}));

import { PATCH, DELETE } from './route';
import { GroupSetLockedError } from '@/lib/group-sets';

const url = 'http://localhost/api/courses/c1/group-sets/s1/groups/g1';
const patchReq = (body: unknown) =>
  new NextRequest(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const deleteReq = () => new NextRequest(url, { method: 'DELETE' });
const ctx = { params: Promise.resolve({ id: 'c1', setId: 's1', groupId: 'g1' }) };

const staff = () => prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: 'u1' } });
  prismaMock.roster.findFirst.mockResolvedValue(null);
  prismaMock.course.findUnique.mockResolvedValue({ isArchived: false });
  // Both the group lookup and the clash check go through studentGroup.findFirst; the
  // clash query is the one that filters on a name.
  prismaMock.studentGroup.findFirst.mockImplementation(
    async (args: { where?: { name?: unknown } }) =>
      args?.where?.name ? null : { id: 'g1', name: 'Team A', groupSet: { name: 'Labs' } },
  );
  prismaMock.studentGroup.update.mockResolvedValue({ id: 'g1', name: 'Team B' });
  prismaMock.$transaction.mockImplementation(async (fn: (tx: typeof txMock) => unknown) =>
    fn(txMock),
  );
  txMock.groupSet.findUnique.mockResolvedValue({ lockedAt: null });
  txMock.studentGroup.delete.mockResolvedValue({ id: 'g1' });
  assertUnlockedMock.mockResolvedValue(undefined);
  deleteGroupMock.mockResolvedValue(undefined);
  activityLogMock.mockResolvedValue(undefined);
  logErrorMock.mockResolvedValue(undefined);
});

/**
 * Renaming and deleting one group inside a set.
 *
 * Both verbs are staff-only and both are blocked once the course is archived. Delete
 * additionally has to respect the set lock, which is what stops group membership changing
 * after work has been submitted or graded against it: if membership could move afterwards,
 * a grade would no longer describe the group that earned it.
 */
describe('PATCH /api/courses/[id]/group-sets/[setId]/groups/[groupId]', () => {
  it('401s when signed out', async () => {
    authMock.mockResolvedValue(null);

    expect((await PATCH(patchReq({ name: 'Team B' }), ctx)).status).toBe(401);
    expect(prismaMock.studentGroup.update).not.toHaveBeenCalled();
  });

  it('403s for a student', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'STUDENT' });

    expect((await PATCH(patchReq({ name: 'Team B' }), ctx)).status).toBe(403);
    expect(prismaMock.studentGroup.update).not.toHaveBeenCalled();
  });

  it('refuses to rename anything in an archived course', async () => {
    // The archive freeze answers 409, and applies to admins too.
    staff();
    prismaMock.course.findUnique.mockResolvedValue({ isArchived: true });

    const res = await PATCH(patchReq({ name: 'Team B' }), ctx);

    expect(res.status).toBe(409);
    expect(prismaMock.studentGroup.update).not.toHaveBeenCalled();
  });

  it('400s when the body carries no usable name', async () => {
    staff();

    expect((await PATCH(patchReq({ name: '' }), ctx)).status).toBe(400);
    expect(prismaMock.studentGroup.update).not.toHaveBeenCalled();
  });

  it('400s when a path parameter is missing', async () => {
    staff();

    const res = await PATCH(patchReq({ name: 'Team B' }), {
      params: Promise.resolve({ id: 'c1', setId: '', groupId: 'g1' }),
    });

    expect(res.status).toBe(400);
  });

  it('404s when the group is not in this set and course', async () => {
    // The lookup is scoped by set and course, so a group id from another course cannot
    // be renamed by guessing it.
    staff();
    prismaMock.studentGroup.findFirst.mockResolvedValue(null);

    expect((await PATCH(patchReq({ name: 'Team B' }), ctx)).status).toBe(404);
    expect(prismaMock.studentGroup.update).not.toHaveBeenCalled();
  });

  it('409s when another group in the set already holds the name', async () => {
    staff();
    prismaMock.studentGroup.findFirst.mockImplementation(
      async (args: { where?: { name?: unknown } }) =>
        args?.where?.name ? { id: 'g2' } : { id: 'g1', name: 'Team A' },
    );

    const res = await PATCH(patchReq({ name: 'Team B' }), ctx);

    expect(res.status).toBe(409);
    expect(prismaMock.studentGroup.update).not.toHaveBeenCalled();
  });

  it('compares names case-insensitively, and excludes the group being renamed', async () => {
    staff();

    await PATCH(patchReq({ name: 'Team B' }), ctx);

    const clashQuery = prismaMock.studentGroup.findFirst.mock.calls[1][0];
    expect(clashQuery.where.name).toEqual({ equals: 'Team B', mode: 'insensitive' });
    expect(clashQuery.where.id).toEqual({ not: 'g1' });
  });

  it('renames the group and records both names', async () => {
    staff();

    const res = await PATCH(patchReq({ name: 'Team B' }), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'g1', name: 'Team B' });
    expect(activityLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        userId: 'u1',
        action: 'UPDATE_GROUP_SET_GROUP',
        // The set's name too, so the log entry says which set the group is in rather than
        // leaving the group's name to be read as the set's.
        metadata: expect.objectContaining({
          name: 'Team B',
          previousName: 'Team A',
          groupName: 'Team B',
          groupSetName: 'Labs',
        }),
      }),
    );
  });

  it('turns a unique-constraint race into a 409 rather than a 500', async () => {
    // Two staff renaming to the same name at once: the check above passes for both and
    // the database is what actually refuses one of them.
    staff();
    prismaMock.studentGroup.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    expect((await PATCH(patchReq({ name: 'Team B' }), ctx)).status).toBe(409);
  });

  it('500s without leaking the underlying error', async () => {
    staff();
    prismaMock.studentGroup.update.mockRejectedValue(new Error('relation does not exist'));

    const res = await PATCH(patchReq({ name: 'Team B' }), ctx);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to rename group' });
    expect(logErrorMock).toHaveBeenCalled();
  });
});

describe('DELETE /api/courses/[id]/group-sets/[setId]/groups/[groupId]', () => {
  it('401s when signed out', async () => {
    authMock.mockResolvedValue(null);

    expect((await DELETE(deleteReq(), ctx)).status).toBe(401);
    expect(deleteGroupMock).not.toHaveBeenCalled();
  });

  it('403s for a student', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'STUDENT' });

    expect((await DELETE(deleteReq(), ctx)).status).toBe(403);
    expect(deleteGroupMock).not.toHaveBeenCalled();
  });

  it('refuses to delete anything in an archived course', async () => {
    staff();
    prismaMock.course.findUnique.mockResolvedValue({ isArchived: true });

    expect((await DELETE(deleteReq(), ctx)).status).toBe(409);
    expect(deleteGroupMock).not.toHaveBeenCalled();
  });

  it('404s when the group is not in this set and course', async () => {
    staff();
    prismaMock.studentGroup.findFirst.mockResolvedValue(null);

    expect((await DELETE(deleteReq(), ctx)).status).toBe(404);
    expect(assertUnlockedMock).not.toHaveBeenCalled();
  });

  it('409s when the set is already locked', async () => {
    staff();
    assertUnlockedMock.mockRejectedValue(new GroupSetLockedError());

    const res = await DELETE(deleteReq(), ctx);

    expect(res.status).toBe(409);
    expect(deleteGroupMock).not.toHaveBeenCalled();
  });

  it('reports a lock discovered during the delete as a refusal, not a server error', async () => {
    // The early check passes and work lands before the delete commits. Closing that race
    // is the service's job, under the set's row lock; what matters here is that the route
    // turns its refusal into a 409. The race itself is covered in group-set-lock.db.test.ts,
    // which needs a real database to mean anything.
    staff();
    deleteGroupMock.mockRejectedValue(new GroupSetLockedError());

    const res = await DELETE(deleteReq(), ctx);

    expect(res.status).toBe(409);
  });

  it('deletes the group and records the name it had', async () => {
    staff();

    const res = await DELETE(deleteReq(), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(deleteGroupMock).toHaveBeenCalledWith('s1', 'g1');
    expect(activityLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        action: 'DELETE_GROUP_SET_GROUP',
        metadata: expect.objectContaining({
          deletedName: 'Team A',
          groupName: 'Team A',
          groupSetName: 'Labs',
        }),
      }),
    );
  });

  it('500s without leaking the underlying error', async () => {
    staff();
    deleteGroupMock.mockRejectedValue(new Error('deadlock detected'));

    const res = await DELETE(deleteReq(), ctx);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to delete group' });
    expect(logErrorMock).toHaveBeenCalled();
  });
});

/**
 * Which group this can rename or delete.
 *
 * The group id comes from the path, and the update and delete that follow go by id alone, so
 * this lookup is the only thing confirming the group belongs to the set and the course in the
 * URL. The prisma mock returns the same fixture whatever the `where` says, so without the
 * nested `groupSet: { courseId }` a group in another course could be renamed or deleted from
 * a URL scoped to your own.
 */
describe('which group this can reach', () => {
  it('resolves the group through this set and this course', async () => {
    staff();

    const res = await PATCH(patchReq({ name: 'Team B' }), ctx);
    expect(res.status).toBe(200);

    // The first call is the group lookup; the later one filters on a name (the clash check).
    expect(prismaMock.studentGroup.findFirst.mock.calls[0][0]).toMatchObject({
      where: { id: 'g1', groupSetId: 's1', groupSet: { courseId: 'c1' } },
    });
  });
});
