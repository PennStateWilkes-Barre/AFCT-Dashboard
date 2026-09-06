import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const prismaMock = vi.hoisted(() => ({
  groupSet: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
  course: { findUnique: vi.fn() },
  roster: { findFirst: vi.fn() },
  $transaction: vi.fn(),
}));
const authMock = vi.hoisted(() => vi.fn());
const activityLogMock = vi.hoisted(() => vi.fn());
const serviceMock = vi.hoisted(() => ({
  findGroupSet: vi.fn(),
  loadGroupSetDetail: vi.fn(),
  groupSetDeletionBlockers: vi.fn(async (): Promise<string[]> => []),
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/activity-log-utils', () => ({ createEnhancedActivityLog: activityLogMock }));
vi.mock('@/lib/group-set-service', () => serviceMock);

import { GET, PATCH, DELETE } from './route';

const ctx = { params: { id: 'c1', setId: 'gs1' } } as never;

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: 'staff', role: 'FACULTY' } });
  prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
  prismaMock.course.findUnique.mockResolvedValue({ isArchived: false });
  serviceMock.findGroupSet.mockResolvedValue({ id: 'gs1', courseId: 'c1', name: 'Project 1' });
  prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({ groupSet: { delete: vi.fn() }, assignment: { count: vi.fn(async () => 0) } }),
  );
});

describe('GET group-set detail', () => {
  it('404 when the set is not in this course', async () => {
    serviceMock.loadGroupSetDetail.mockResolvedValue(null);
    const res = await GET(new NextRequest('http://localhost/x'), ctx);
    expect(res.status).toBe(404);
  });

  it('returns the detail', async () => {
    serviceMock.loadGroupSetDetail.mockResolvedValue({ id: 'gs1', name: 'Project 1', groups: [] });
    const res = await GET(new NextRequest('http://localhost/x'), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe('gs1');
  });
});

describe('PATCH rename set', () => {
  const patch = (body: unknown) =>
    PATCH(
      new NextRequest('http://localhost/x', { method: 'PATCH', body: JSON.stringify(body) }),
      ctx,
    );

  it('409 on a duplicate name in the course (case-insensitive)', async () => {
    prismaMock.groupSet.findFirst.mockResolvedValue({ id: 'other' });
    const res = await patch({ name: ' project 2 ' });
    expect(res.status).toBe(409);
    expect(prismaMock.groupSet.update).not.toHaveBeenCalled();
    // "in the course" is the whole point of the rule, and only the `courseId` in this query
    // says so: without it a name already used in somebody else's course would be refused here.
    expect(prismaMock.groupSet.findFirst.mock.calls[0][0]).toMatchObject({
      where: { courseId: 'c1' },
    });
  });

  it('renames when the name is free', async () => {
    prismaMock.groupSet.findFirst.mockResolvedValue(null);
    prismaMock.groupSet.update.mockResolvedValue({ id: 'gs1', name: 'Project 2' });
    const res = await patch({ name: 'Project 2' });
    expect(res.status).toBe(200);
    expect(activityLogMock).toHaveBeenCalled();
  });
});

describe('DELETE set', () => {
  it('deletes when there are no dependencies', async () => {
    const res = await DELETE(new NextRequest('http://localhost/x', { method: 'DELETE' }), ctx);
    expect(res.status).toBe(200);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(activityLogMock).toHaveBeenCalled();
  });

  it('404 when the set is missing', async () => {
    serviceMock.findGroupSet.mockResolvedValue(null);
    const res = await DELETE(new NextRequest('http://localhost/x', { method: 'DELETE' }), ctx);
    expect(res.status).toBe(404);
  });

  it('409 when an assignment references the set', async () => {
    serviceMock.groupSetDeletionBlockers.mockResolvedValue([
      'This group set is used by 1 assignment.',
    ]);
    const res = await DELETE(new NextRequest('http://localhost/x', { method: 'DELETE' }), ctx);
    expect(res.status).toBe(409);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});
