import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const prismaMock = vi.hoisted(() => ({
  // findMany: the handler reads who is already on the roster BEFORE inserting, so the
  // per-student audit entries describe what actually changed rather than what was pasted.
  roster: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    createMany: vi.fn(),
    updateMany: vi.fn(),
  },
  course: { findUnique: vi.fn() },
  activityLog: { createMany: vi.fn() },
}));

const authMock = vi.hoisted(() => vi.fn());
const activityLogMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/activity-log-utils', () => ({ createEnhancedActivityLog: activityLogMock }));

import { POST } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  // Default: caller not enrolled (denied); authorized tests grant a course role.
  prismaMock.roster.findFirst.mockResolvedValue(null);
  // Default: course is not archived; archived-block tests override.
  prismaMock.course.findUnique.mockResolvedValue({ isArchived: false });
  prismaMock.roster.createMany.mockResolvedValue({ count: 0 });
  prismaMock.roster.updateMany.mockResolvedValue({ count: 0 });
  // Nobody on the roster yet, so every pasted id counts as a new enrolment.
  prismaMock.roster.findMany.mockResolvedValue([]);
  prismaMock.activityLog.createMany.mockResolvedValue({ count: 0 });
});

describe('POST /api/courses/[id]/roster/bulk', () => {
  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);

    const req = new NextRequest('http://localhost/api/courses/c1/roster/bulk', {
      method: 'POST',
      body: JSON.stringify({ userIds: ['u1'] }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'c1' }) });

    expect(res.status).toBe(401);
  });

  it('returns 403 when forbidden', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });

    const req = new NextRequest('http://localhost/api/courses/c1/roster/bulk', {
      method: 'POST',
      body: JSON.stringify({ userIds: ['u1'] }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'c1' }) });

    expect(res.status).toBe(403);
  });

  it('returns 409 when the course is archived', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.course.findUnique.mockResolvedValue({ isArchived: true });

    const req = new NextRequest('http://localhost/api/courses/c1/roster/bulk', {
      method: 'POST',
      body: JSON.stringify({ userIds: ['u1'] }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'c1' }) });

    expect(res.status).toBe(409);
    expect(prismaMock.roster.createMany).not.toHaveBeenCalled();
  });

  it('returns 400 when no users provided', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });

    const req = new NextRequest('http://localhost/api/courses/c1/roster/bulk', {
      method: 'POST',
      body: JSON.stringify({ userIds: [] }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'c1' }) });

    expect(res.status).toBe(400);
  });

  it('bulk enrolls users, skipping rows that already exist', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN', isAdmin: true } });

    const req = new NextRequest('http://localhost/api/courses/c1/roster/bulk', {
      method: 'POST',
      body: JSON.stringify({ userIds: ['u1'] }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'c1' }) });

    expect(res.status).toBe(200);
    // skipDuplicates is what keeps a concurrent self-join from aborting the batch, and
    // (crucially) means an already-enrolled member is skipped rather than re-roled.
    expect(prismaMock.roster.createMany).toHaveBeenCalledWith({
      data: [{ courseId: 'c1', userId: 'u1', role: 'STUDENT' }],
      skipDuplicates: true,
    });
    expect(activityLogMock).toHaveBeenCalled();
  });

  it('inserts every listed user as STUDENT in a single statement and never re-roles', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN', isAdmin: true } });

    const req = new NextRequest('http://localhost/api/courses/c1/roster/bulk', {
      method: 'POST',
      body: JSON.stringify({ userIds: ['u1', 'u2', 'u3', 'u4'] }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'c1' }) });

    expect(res.status).toBe(200);
    // One statement for four users, and still one for four hundred: that is the point.
    expect(prismaMock.roster.createMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.roster.createMany.mock.calls[0][0].data).toHaveLength(4);
    // Additive only: skipDuplicates leaves existing members alone, so no existing
    // FACULTY/TA is demoted to STUDENT by a bulk-enroll.
    expect(prismaMock.roster.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
  });

  it('re-enrolls previously dropped students, scoped to STUDENT rows only', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN', isAdmin: true } });
    prismaMock.roster.updateMany.mockResolvedValue({ count: 2 });

    const req = new NextRequest('http://localhost/api/courses/c1/roster/bulk', {
      method: 'POST',
      body: JSON.stringify({ userIds: ['u1', 'u2'] }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'c1' }) });

    expect(res.status).toBe(200);
    // The re-enroll flips only DROPPED student rows, never a FACULTY/TA row or a role.
    expect(prismaMock.roster.updateMany).toHaveBeenCalledWith({
      where: { courseId: 'c1', userId: { in: ['u1', 'u2'] }, role: 'STUDENT', status: 'DROPPED' },
      data: { status: 'ENROLLED', droppedAt: null },
    });
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      expect.anything(),
      expect.objectContaining({ metadata: expect.objectContaining({ reEnrolledCount: 2 }) }),
    );
  });

  it('returns 400 when userIds is missing entirely (defaults to [])', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });

    // Body has no userIds → `(body?.userIds ?? [])` falls back to [] (branch at line 40).
    const req = new NextRequest('http://localhost/api/courses/c1/roster/bulk', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'c1' }) });
    expect(res.status).toBe(400);
  });

  it('filters out falsy user ids and returns 400 when none remain', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });

    // Empty strings survive String() but are dropped by filter(Boolean) → empty list (line 40).
    const req = new NextRequest('http://localhost/api/courses/c1/roster/bulk', {
      method: 'POST',
      body: JSON.stringify({ userIds: ['', ''] }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'c1' }) });
    expect(res.status).toBe(400);
  });

  it('returns 500 when the enrollment insert fails', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.roster.createMany.mockRejectedValue(new Error('insert failed'));

    const req = new NextRequest('http://localhost/api/courses/c1/roster/bulk', {
      method: 'POST',
      body: JSON.stringify({ userIds: ['u1'] }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'c1' }) });
    expect(res.status).toBe(500);
  });

  it('returns 500 and logs "unknown error" when a non-Error is thrown', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    // Throw a non-Error to exercise the `: 'unknown error'` branch.
    prismaMock.roster.createMany.mockRejectedValueOnce('boom');

    const req = new NextRequest('http://localhost/api/courses/c1/roster/bulk', {
      method: 'POST',
      body: JSON.stringify({ userIds: ['u1'] }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'c1' }) });
    expect(res.status).toBe(500);
    expect(activityLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        action: 'COURSE_BULK_ENROLL_ERROR',
        metadata: expect.objectContaining({ error: 'unknown error' }),
      }),
    );
  });
});

/**
 * The per-student entries have to describe what HAPPENED, not what was pasted.
 *
 * `createMany` with skipDuplicates returns a count and not which rows it wrote, so the only
 * honest source is the roster as it stood before the insert. Logging the request's own list
 * would mint enrolment events for people who were already enrolled, and these rows are study
 * data as well as an audit trail.
 */
describe('bulk enrolment audit', () => {
  it('writes one entry per student who actually joined, and none for those already there', async () => {
    authMock.mockResolvedValue({ user: { id: 'staff', isAdmin: true } });
    prismaMock.roster.findMany.mockResolvedValue([
      { userId: 'already', status: 'ENROLLED', role: 'STUDENT' },
      { userId: 'dropped', status: 'DROPPED', role: 'STUDENT' },
    ]);
    prismaMock.roster.createMany.mockResolvedValue({ count: 1 });
    prismaMock.roster.updateMany.mockResolvedValue({ count: 1 });

    const req = new NextRequest('http://localhost/api/courses/c1/roster/bulk', {
      method: 'POST',
      body: JSON.stringify({ userIds: ['fresh', 'already', 'dropped'] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'c1' }) });

    expect(res.status).toBe(200);
    const rows = prismaMock.activityLog.createMany.mock.calls[0]?.[0]?.data ?? [];
    const byUser = new Map(
      rows.map((r: { action: string; metadata: { targetUserId: string } }) => [
        r.metadata.targetUserId,
        r.action,
      ]),
    );

    expect(byUser.get('fresh')).toBe('ENROLL_USER');
    expect(byUser.get('dropped')).toBe('REENROLL_IN_COURSE');
    // The one who was already enrolled: nothing happened to them, so nothing is recorded.
    expect(byUser.has('already')).toBe(false);
  });

  it('summarises what changed rather than what was asked for', async () => {
    authMock.mockResolvedValue({ user: { id: 'staff', isAdmin: true } });
    prismaMock.roster.findMany.mockResolvedValue([
      { userId: 'already', status: 'ENROLLED', role: 'STUDENT' },
    ]);

    const req = new NextRequest('http://localhost/api/courses/c1/roster/bulk', {
      method: 'POST',
      body: JSON.stringify({ userIds: ['fresh', 'already'] }),
    });
    await POST(req, { params: Promise.resolve({ id: 'c1' }) });

    const summary = activityLogMock.mock.calls.at(-1)?.[2];
    expect(summary.action).toBe('BULK_ENROLL_USERS');
    expect(summary.metadata.enrolledIds).toEqual(['fresh']);
    expect(summary.metadata.requestedCount).toBe(2);
    expect(summary.metadata.alreadyEnrolledCount).toBe(1);
  });
});

/**
 * Who counted as already enrolled.
 *
 * The before-picture decides which pasted names are logged as new enrolments. The prisma mock
 * answers with its fixture whatever the `where` says, so without the `courseId` somebody
 * enrolled in a different course would be treated as already here and their enrolment would
 * go unlogged, and without the `userId` list the read covers the whole roster.
 */
describe('who the bulk enrolment counts as already here', () => {
  it('reads the existing roster rows for this course and these people only', async () => {
    authMock.mockResolvedValue({ user: { id: 'staff', isAdmin: true } });
    prismaMock.roster.findMany.mockResolvedValue([]);

    const req = new NextRequest('http://localhost/api/courses/c1/roster/bulk', {
      method: 'POST',
      body: JSON.stringify({ userIds: ['u1', 'u2'] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'c1' }) });
    expect(res.status).toBe(200);

    expect(prismaMock.roster.findMany.mock.calls[0][0]).toMatchObject({
      where: { courseId: 'c1', userId: { in: ['u1', 'u2'] } },
    });
  });
});
