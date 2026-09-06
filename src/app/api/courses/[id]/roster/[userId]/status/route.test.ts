import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const prismaMock = vi.hoisted(() => ({
  roster: {
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  course: {
    findUnique: vi.fn(),
  },
}));

const authMock = vi.hoisted(() => vi.fn());
const activityLogMock = vi.hoisted(() => vi.fn());
const isAdminMock = vi.hoisted(() => vi.fn());
const canManageCourseMock = vi.hoisted(() => vi.fn());
const canAccessCourseMock = vi.hoisted(() => vi.fn());
const isCourseArchivedMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/activity-log-utils', () => ({ createEnhancedActivityLog: activityLogMock }));
vi.mock('@/lib/permissions', () => ({
  isAdmin: isAdminMock,
  canManageCourse: canManageCourseMock,
  canAccessCourse: canAccessCourseMock,
  isCourseArchived: isCourseArchivedMock,
}));

import { PATCH } from './route';

function patch(body: unknown, id = 'c1', userId = 'u1') {
  const req = new NextRequest(`http://localhost/api/courses/${id}/roster/${userId}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return PATCH(req, { params: Promise.resolve({ id, userId }) });
}

beforeEach(() => {
  vi.resetAllMocks();
  // The wrapper gates on canManageCourse (roles: ['FACULTY']); default allow, individual
  // tests override. Not archived by default.
  canManageCourseMock.mockResolvedValue(true);
  canAccessCourseMock.mockResolvedValue(true);
  isAdminMock.mockReturnValue(false);
  prismaMock.course.findUnique.mockResolvedValue({ isArchived: false });
  isCourseArchivedMock.mockImplementation(async () => {
    const course = await prismaMock.course.findUnique();
    return course?.isArchived === true;
  });
});

describe('PATCH /api/courses/[id]/roster/[userId]/status', () => {
  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);
    const res = await patch({ status: 'DROPPED' });
    expect(res.status).toBe(401);
  });

  it('returns 403 when the caller is not faculty/admin', async () => {
    authMock.mockResolvedValue({ user: { id: 'ta', inactive: false } });
    canManageCourseMock.mockResolvedValue(false);
    const res = await patch({ status: 'DROPPED' });
    expect(res.status).toBe(403);
  });

  it('drops an enrolled student, stamps droppedAt, and logs it', async () => {
    authMock.mockResolvedValue({ user: { id: 'fac', inactive: false } });
    prismaMock.roster.findFirst.mockResolvedValue({
      id: 'r1',
      role: 'STUDENT',
      status: 'ENROLLED',
    });
    prismaMock.roster.update.mockResolvedValue({ id: 'r1', status: 'DROPPED' });

    const res = await patch({ status: 'DROPPED' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: 'DROPPED', changed: true });

    // Which roster row was looked up, not just that one was. The update goes by id, so the
    // lookup is the only thing tying this to the student named in the URL: without the
    // `userId` it drops whoever findFirst happens to return.
    expect(prismaMock.roster.findFirst.mock.calls[0][0]).toMatchObject({
      where: { courseId: 'c1', userId: 'u1' },
    });

    const updateArg = prismaMock.roster.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 'r1' });
    expect(updateArg.data.status).toBe('DROPPED');
    expect(updateArg.data.droppedAt).toBeInstanceOf(Date);

    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      expect.anything(),
      expect.objectContaining({ action: 'DROP_FROM_COURSE', category: 'COURSE' }),
    );
  });

  it('re-enrolls a dropped student and clears droppedAt', async () => {
    authMock.mockResolvedValue({ user: { id: 'fac', inactive: false } });
    prismaMock.roster.findFirst.mockResolvedValue({
      id: 'r1',
      role: 'STUDENT',
      status: 'DROPPED',
    });
    prismaMock.roster.update.mockResolvedValue({ id: 'r1', status: 'ENROLLED' });

    const res = await patch({ status: 'ENROLLED' });
    expect(res.status).toBe(200);
    const updateArg = prismaMock.roster.update.mock.calls[0][0];
    expect(updateArg.data.status).toBe('ENROLLED');
    expect(updateArg.data.droppedAt).toBeNull();
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      expect.anything(),
      expect.objectContaining({ action: 'REENROLL_IN_COURSE' }),
    );
  });

  it('is idempotent: setting the current status changes nothing', async () => {
    authMock.mockResolvedValue({ user: { id: 'fac', inactive: false } });
    prismaMock.roster.findFirst.mockResolvedValue({
      id: 'r1',
      role: 'STUDENT',
      status: 'DROPPED',
    });

    const res = await patch({ status: 'DROPPED' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ changed: false });
    expect(prismaMock.roster.update).not.toHaveBeenCalled();
    expect(activityLogMock).not.toHaveBeenCalled();
  });

  it('rejects dropping a non-student (400)', async () => {
    authMock.mockResolvedValue({ user: { id: 'fac', inactive: false } });
    prismaMock.roster.findFirst.mockResolvedValue({ id: 'r1', role: 'TA', status: 'ENROLLED' });

    const res = await patch({ status: 'DROPPED' });
    expect(res.status).toBe(400);
    expect(prismaMock.roster.update).not.toHaveBeenCalled();
  });

  it('returns 404 when the user is not on the roster', async () => {
    authMock.mockResolvedValue({ user: { id: 'fac', inactive: false } });
    prismaMock.roster.findFirst.mockResolvedValue(null);

    const res = await patch({ status: 'DROPPED' });
    expect(res.status).toBe(404);
  });

  it('returns 409 when the course is archived', async () => {
    authMock.mockResolvedValue({ user: { id: 'fac', inactive: false } });
    prismaMock.course.findUnique.mockResolvedValue({ isArchived: true });

    const res = await patch({ status: 'DROPPED' });
    expect(res.status).toBe(409);
  });

  it('rejects an invalid status value (400)', async () => {
    authMock.mockResolvedValue({ user: { id: 'fac', inactive: false } });
    const res = await patch({ status: 'BOGUS' });
    expect(res.status).toBe(400);
  });
});
