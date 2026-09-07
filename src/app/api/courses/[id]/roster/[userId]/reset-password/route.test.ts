import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const prismaMock = vi.hoisted(() => ({
  roster: {
    findFirst: vi.fn(),
  },
  user: {
    update: vi.fn(),
  },
}));

const authMock = vi.hoisted(() => vi.fn());
const activityLogMock = vi.hoisted(() => vi.fn());
const isAdminMock = vi.hoisted(() => vi.fn());
const canManageCourseMock = vi.hoisted(() => vi.fn());
const canAccessCourseMock = vi.hoisted(() => vi.fn());
const isCourseArchivedMock = vi.hoisted(() => vi.fn());
const invalidateSessionUserMock = vi.hoisted(() => vi.fn());
const isStrongPasswordMock = vi.hoisted(() => vi.fn());
const logDenialMock = vi.hoisted(() =>
  vi.fn(() => new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })),
);
const logErrorMock = vi.hoisted(() => vi.fn());
const bcryptHashMock = vi.hoisted(() => vi.fn(async () => 'hashed-password'));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/activity-log-utils', () => ({ createEnhancedActivityLog: activityLogMock }));
vi.mock('@/lib/permissions', () => ({
  isAdmin: isAdminMock,
  canManageCourse: canManageCourseMock,
  canAccessCourse: canAccessCourseMock,
  isCourseArchived: isCourseArchivedMock,
}));
vi.mock('@/lib/api/activity', () => ({ logDenial: logDenialMock, logError: logErrorMock }));
vi.mock('@/lib/password-policy', () => ({
  isStrongPassword: isStrongPasswordMock,
  passwordRequirementText: 'Password too weak',
}));
vi.mock('@/lib/session-user-cache', () => ({ invalidateSessionUser: invalidateSessionUserMock }));
vi.mock('bcrypt', () => ({ default: { hash: bcryptHashMock } }));

import { POST } from './route';

function postReq(body: unknown) {
  return new NextRequest('http://localhost/api/courses/c1/roster/stu1/reset-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve({ id: 'c1', userId: 'stu1' }) };

beforeEach(() => {
  vi.resetAllMocks();
  // Default: an authenticated course staff member (FACULTY/TA/admin all pass the
  // wrapper via canManageCourse). Individual tests override.
  authMock.mockResolvedValue({ user: { id: 'staff1' } });
  canManageCourseMock.mockResolvedValue(true);
  canAccessCourseMock.mockResolvedValue(true);
  isAdminMock.mockReturnValue(false);
  isStrongPasswordMock.mockReturnValue(true);
  prismaMock.user.update.mockResolvedValue({ id: 'stu1' });
});

describe('POST /api/courses/[id]/roster/[userId]/reset-password', () => {
  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);
    const res = await POST(postReq({ newPassword: 'x' }), ctx);
    expect(res.status).toBe(401);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is not course staff', async () => {
    canManageCourseMock.mockResolvedValue(false);
    const res = await POST(postReq({ newPassword: 'x' }), ctx);
    expect(res.status).toBe(403);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('returns 404 when the target is not on this roster', async () => {
    prismaMock.roster.findFirst.mockResolvedValue(null);
    const res = await POST(postReq({ newPassword: 'Str0ng!pass' }), ctx);
    expect(res.status).toBe(404);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('denies resetting a staff member (target is FACULTY)', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'FACULTY',
      user: { isAdmin: false, email: 'faculty@example.edu' },
    });
    const res = await POST(postReq({ newPassword: 'Str0ng!pass' }), ctx);
    expect(res.status).toBe(403);
    expect(logDenialMock).toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('denies resetting a global administrator even if enrolled as a student', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'STUDENT',
      user: { isAdmin: true, email: 'admin@example.edu' },
    });
    const res = await POST(postReq({ newPassword: 'Str0ng!pass' }), ctx);
    expect(res.status).toBe(403);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('rejects a weak password with 400', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'STUDENT',
      user: { isAdmin: false, email: 'student@example.edu' },
    });
    isStrongPasswordMock.mockReturnValue(false);
    const res = await POST(postReq({ newPassword: 'weak' }), ctx);
    expect(res.status).toBe(400);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('resets a student password, invalidates sessions, and logs it', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'STUDENT',
      user: { isAdmin: false, email: 'student@example.edu' },
    });
    const res = await POST(postReq({ newPassword: 'Str0ng!pass', isTemporary: true }), ctx);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });

    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'stu1' },
        data: expect.objectContaining({
          password: 'hashed-password',
          temporaryPassword: true,
        }),
      }),
    );
    expect(invalidateSessionUserMock).toHaveBeenCalledWith('stu1');
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      expect.anything(),
      expect.objectContaining({
        action: 'RESET_STUDENT_PASSWORD',
        courseId: 'c1',
        // The account, not just its id: an entry that does not say whose password was reset is
        // the one thing somebody auditing a reset needs and cannot get.
        metadata: expect.objectContaining({
          targetUserId: 'stu1',
          targetEmail: 'student@example.edu',
          temporaryPassword: true,
        }),
      }),
    );
  });

  it('returns 500 and logs an error when the update fails', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'STUDENT',
      user: { isAdmin: false, email: 'student@example.edu' },
    });
    prismaMock.user.update.mockRejectedValue(new Error('db down'));
    const res = await POST(postReq({ newPassword: 'Str0ng!pass' }), ctx);
    expect(res.status).toBe(500);
    expect(logErrorMock).toHaveBeenCalled();
  });
});

/**
 * Whose password this resets.
 *
 * `withCourseAuth` proves the caller is staff of the course in the URL. The person whose
 * password is about to change comes from the path, and the only thing tying them to that
 * course is this lookup: without the `courseId` a staff member could reset the password of
 * somebody they have no relationship with at all, since the update that follows goes by user
 * id alone. The prisma mock returns its fixture either way, so nothing else here notices.
 */
describe('who this reset can reach', () => {
  it('finds the target only on this course roster', async () => {
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'STUDENT',
      user: { isAdmin: false, email: 'student@example.edu' },
    });

    const res = await POST(postReq({ newPassword: 'Str0ng!pass' }), ctx);
    expect(res.status).toBe(200);

    expect(prismaMock.roster.findFirst.mock.calls[0][0]).toMatchObject({
      where: { courseId: 'c1', userId: 'stu1' },
    });
  });
});
