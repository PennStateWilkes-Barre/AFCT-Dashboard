import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const prismaMock = vi.hoisted(() => ({
  groupSet: { findFirst: vi.fn(), create: vi.fn() },
  course: { findUnique: vi.fn() },
  roster: { findFirst: vi.fn() },
}));
const authMock = vi.hoisted(() => vi.fn());
const activityLogMock = vi.hoisted(() => vi.fn());
const serviceMock = vi.hoisted(() => ({ loadGroupSetSummaries: vi.fn() }));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/activity-log-utils', () => ({ createEnhancedActivityLog: activityLogMock }));
vi.mock('@/lib/group-set-service', () => serviceMock);

import { GET, POST } from './route';

const ctx = { params: { id: 'c1' } } as never;
const staff = () => authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
const post = (body: unknown) =>
  POST(
    new NextRequest('http://localhost/api/courses/c1/group-sets', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    ctx,
  );

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
  prismaMock.course.findUnique.mockResolvedValue({ isArchived: false });
});

describe('GET /api/courses/[id]/group-sets', () => {
  it('403 for a student', async () => {
    authMock.mockResolvedValue({ user: { id: 's1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'STUDENT' });
    const res = await GET(new NextRequest('http://localhost/api/courses/c1/group-sets'), ctx);
    expect(res.status).toBe(403);
  });

  it('returns summaries for staff', async () => {
    staff();
    serviceMock.loadGroupSetSummaries.mockResolvedValue([
      { id: 'gs1', name: 'Project 1', locked: false, groupCount: 2, assignedCount: 4 },
    ]);
    const res = await GET(new NextRequest('http://localhost/api/courses/c1/group-sets'), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
  });
});

describe('POST /api/courses/[id]/group-sets', () => {
  it('401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);
    const res = await post({ name: 'X' });
    expect(res.status).toBe(401);
  });

  it('409 on a duplicate name (case-insensitive)', async () => {
    staff();
    prismaMock.groupSet.findFirst.mockResolvedValue({ id: 'existing' });
    const res = await post({ name: '  project 1 ' });
    expect(res.status).toBe(409);
    expect(prismaMock.groupSet.create).not.toHaveBeenCalled();
  });

  it('creates a set with the requested empty groups', async () => {
    staff();
    prismaMock.groupSet.findFirst.mockResolvedValue(null);
    prismaMock.groupSet.create.mockResolvedValue({ id: 'gs1', name: 'Project 1' });
    const res = await post({ name: 'Project 1', initialGroupCount: 3 });
    expect(res.status).toBe(201);
    const arg = prismaMock.groupSet.create.mock.calls[0]![0];
    expect(arg.data.groups.create).toHaveLength(3);
    expect(arg.data.groups.create[0].name).toBe('Group 1');
    expect(activityLogMock).toHaveBeenCalled();
  });

  it('allows the same name in a different course (no clash found)', async () => {
    staff();
    prismaMock.groupSet.findFirst.mockResolvedValue(null);
    prismaMock.groupSet.create.mockResolvedValue({ id: 'gs2', name: 'Project 1' });
    const res = await post({ name: 'Project 1' });
    expect(res.status).toBe(201);
  });

  it('409 when the course is archived', async () => {
    staff();
    prismaMock.course.findUnique.mockResolvedValue({ isArchived: true });
    const res = await post({ name: 'Project 1' });
    expect(res.status).toBe(409);
    expect(prismaMock.groupSet.create).not.toHaveBeenCalled();
  });
});

/**
 * Which names count as taken.
 *
 * The uniqueness check is per course: two courses may each have a "Project 1". The prisma
 * mock answers with its fixture whatever the `where` says, so without the `courseId` a name
 * already used in somebody else's course would block this one, and the friendly 409 would be
 * about a set the instructor cannot see.
 */
describe('which names a new group set clashes with', () => {
  it('checks the name against this course only', async () => {
    staff();
    prismaMock.groupSet.findFirst.mockResolvedValue(null);
    prismaMock.groupSet.create.mockResolvedValue({ id: 'gs1', name: 'Project 1' });

    const res = await post({ name: 'Project 1' });
    expect(res.status).toBe(201);

    expect(prismaMock.groupSet.findFirst.mock.calls[0][0]).toMatchObject({
      where: { courseId: 'c1', name: { equals: 'Project 1', mode: 'insensitive' } },
    });
  });
});
