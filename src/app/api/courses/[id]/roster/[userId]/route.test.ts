import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  roster: {
    findFirst: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
  },
  assignment: {
    findMany: vi.fn(),
  },
  assignmentAssignee: {
    deleteMany: vi.fn(),
  },
  assignmentOverride: {
    deleteMany: vi.fn(),
  },
  submissionGrant: {
    deleteMany: vi.fn(),
  },
  submission: {
    findFirst: vi.fn(),
  },
  course: {
    findUnique: vi.fn(),
  },
  // DELETE/PATCH wrap the last-faculty re-check + mutation in a serializable
  // transaction; run the callback against the same mock.
  $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(prismaMock)),
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

import { DELETE, GET, PATCH } from './route';

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) so each test's mockResolvedValueOnce queue
  // starts empty; the roster route makes several findFirst calls and leaked
  // queue entries would otherwise cascade between tests.
  vi.resetAllMocks();
  // Sensible defaults; individual tests override. The DELETE/PATCH wrappers gate on
  // canManageCourse (admin or course FACULTY); the DELETE handler consults isAdmin
  // for the faculty-can't-remove-faculty rule.
  canManageCourseMock.mockResolvedValue(true);
  canAccessCourseMock.mockResolvedValue(true);
  isAdminMock.mockReturnValue(false);
  // Default: course is not archived; archived-block tests override. The wrapper's
  // isCourseArchived reads course.findUnique, so mirror that here.
  prismaMock.course.findUnique.mockResolvedValue({ isArchived: false });
  isCourseArchivedMock.mockImplementation(async () => {
    const course = await prismaMock.course.findUnique();
    return course?.isArchived === true;
  });
});

describe('GET /api/courses/[id]/roster/[userId]', () => {
  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u1');
    const res = await GET(req, { params: Promise.resolve({ id: 'c1', userId: 'u1' }) });

    expect(res.status).toBe(401);
  });

  it('returns 404 when roster entry not found', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } });
    prismaMock.roster.findFirst.mockResolvedValue(null);

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u2');
    const res = await GET(req, { params: Promise.resolve({ id: 'c1', userId: 'u2' }) });

    expect(res.status).toBe(404);
  });

  it('returns roster data when found', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } });
    prismaMock.roster.findFirst
      .mockResolvedValueOnce({
        id: 'r1',
        role: 'STUDENT',
        user: { id: 'u2', firstName: 'A', lastName: 'B', email: 'u2@example.com', role: 'STUDENT' },
      })
      .mockResolvedValueOnce({ role: 'ADMIN' });

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u2');
    const res = await GET(req, { params: Promise.resolve({ id: 'c1', userId: 'u2' }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.roster).toBeTruthy();
    expect(body.viewerCourseRole).toBe('ADMIN');
  });

  it('resolves "me" to current user', async () => {
    // A non-staff member reading their OWN entry: allowed without staff rights.
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    canManageCourseMock.mockResolvedValue(false);
    prismaMock.roster.findFirst
      .mockResolvedValueOnce({
        id: 'r1',
        role: 'STUDENT',
        user: { id: 'u1', firstName: 'A', lastName: 'B', email: 'u1@example.com', role: 'STUDENT' },
      })
      .mockResolvedValueOnce({ role: 'STUDENT' });

    const req = new NextRequest('http://localhost/api/courses/c1/roster/me');
    const res = await GET(req, { params: Promise.resolve({ id: 'c1', userId: 'me' }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.roster.user.id).toBe('u1');
  });

  it('returns 403 when a non-staff member reads another member’s entry', async () => {
    // Enrolled (wrapper passes) but not staff, targeting a different user.
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    canManageCourseMock.mockResolvedValue(false);

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u2');
    const res = await GET(req, { params: Promise.resolve({ id: 'c1', userId: 'u2' }) });

    expect(res.status).toBe(403);
    // Must not leak the target's profile.
    expect(prismaMock.roster.findFirst).not.toHaveBeenCalled();
  });

  it('returns null viewerCourseRole when the viewer has no roster entry', async () => {
    // Branch 171: `viewerRoster?.role ?? null`, admin viewer not on the roster.
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    isAdminMock.mockReturnValue(true);
    prismaMock.roster.findFirst
      .mockResolvedValueOnce({
        id: 'r1',
        role: 'STUDENT',
        user: { id: 'u2', firstName: 'A', lastName: 'B', email: 'u2@example.com', role: 'STUDENT' },
      })
      .mockResolvedValueOnce(null); // viewer has no roster entry

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u2');
    const res = await GET(req, { params: Promise.resolve({ id: 'c1', userId: 'u2' }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.viewerCourseRole).toBeNull();
    expect(body.viewerIsAdmin).toBe(true);
  });

  it('handles server errors gracefully', async () => {
    // Authorized, but the roster lookup throws; the handler's catch returns 500.
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    prismaMock.roster.findFirst.mockRejectedValue(new Error('DB error'));

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u1');
    const res = await GET(req, { params: Promise.resolve({ id: 'c1', userId: 'u1' }) });

    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/courses/[id]/roster/[userId]', () => {
  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u1', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'c1', userId: 'u1' }) });

    expect(res.status).toBe(401);
  });

  it('returns 403 when user lacks permission', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    canManageCourseMock.mockResolvedValue(false);

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u2', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'c1', userId: 'u2' }) });

    expect(res.status).toBe(403);
  });

  it('returns 403 when a TA tries to remove a user', async () => {
    // The wrapper gates on FACULTY-or-admin, so a TA never reaches the handler.
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    canManageCourseMock.mockResolvedValue(false);

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u2', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'c1', userId: 'u2' }) });

    expect(res.status).toBe(403);
  });

  it('returns 403 when a faculty member tries to remove another faculty member', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    canManageCourseMock.mockResolvedValue(true);
    isAdminMock.mockReturnValue(false);
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' }); // target

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u2', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'c1', userId: 'u2' }) });

    expect(res.status).toBe(403);
  });

  it('lets a global admin remove a faculty member', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    canManageCourseMock.mockResolvedValue(true);
    isAdminMock.mockReturnValue(true);
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' }); // target
    prismaMock.assignment.findMany.mockResolvedValue([]);
    prismaMock.roster.count.mockResolvedValue(2); // not the only faculty
    prismaMock.roster.deleteMany.mockResolvedValue({ count: 1 });

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u2', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'c1', userId: 'u2' }) });

    expect(res.status).toBe(200);
    // The audit entry carries a uniform `targetUserId` (the removed member) so all
    // privileged-on-student actions can be queried by the same key.
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      expect.anything(),
      expect.objectContaining({
        action: 'REMOVE_FROM_COURSE',
        metadata: expect.objectContaining({ targetUserId: 'u2' }),
      }),
    );
  });

  it('returns 400 when user has submissions', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    isAdminMock.mockReturnValue(true);
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'STUDENT' }); // target
    prismaMock.assignment.findMany.mockResolvedValue([{ id: 'a1' }]);
    prismaMock.submission.findFirst.mockResolvedValue({ id: 's1' });

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u2', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'c1', userId: 'u2' }) });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('submissions');
  });

  it('returns 400 when removing only faculty member', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    isAdminMock.mockReturnValue(true);
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' }); // target
    prismaMock.assignment.findMany.mockResolvedValue([]);
    prismaMock.roster.count.mockResolvedValue(1);

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u2', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'c1', userId: 'u2' }) });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('only faculty member');
  });

  it('removes roster entry when allowed', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    isAdminMock.mockReturnValue(true);
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'STUDENT' }); // target
    prismaMock.assignment.findMany.mockResolvedValue([]);
    prismaMock.roster.deleteMany.mockResolvedValue({ count: 1 });

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u2', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'c1', userId: 'u2' }) });

    expect(res.status).toBe(200);
    expect(activityLogMock).toHaveBeenCalled();
  });

  it('removes a student who has assignments but no submissions', async () => {
    // Exercises branch 64: assignments exist but existingSubmission is null → proceeds.
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    isAdminMock.mockReturnValue(true);
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'STUDENT' }); // target
    prismaMock.assignment.findMany.mockResolvedValue([{ id: 'a1' }]);
    prismaMock.submission.findFirst.mockResolvedValue(null);
    prismaMock.roster.deleteMany.mockResolvedValue({ count: 1 });

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u2', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'c1', userId: 'u2' }) });

    expect(res.status).toBe(200);
    // The one person, not the roster. `toHaveBeenCalled` alone passed with the `userId`
    // deleted from the where, which is the difference between removing a student and
    // emptying the course.
    expect(prismaMock.roster.deleteMany).toHaveBeenCalledWith({
      where: { courseId: 'c1', userId: 'u2' },
    });
    // The user's audience rows and due-date overrides in this course are cleared alongside
    // the roster row.
    expect(prismaMock.assignmentAssignee.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u2', assignmentId: { in: ['a1'] } },
    });
    expect(prismaMock.assignmentOverride.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u2', assignmentId: { in: ['a1'] } },
    });
    // And their extra-attempt grants, which reactivate the same way: granted, removed before
    // using them, re-added later, and back holding a cap nobody decided to give them.
    expect(prismaMock.submissionGrant.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u2', assignmentId: { in: ['a1'] } },
    });
  });

  it('returns 409 when the removal transaction hits a serialization conflict', async () => {
    // The submission check and delete run in one serializable transaction; a racing
    // submission insert (created under Serializable too) makes Postgres abort one
    // transaction with P2034, which the handler surfaces as a 409 retry. This is the
    // TOCTOU guard: a submission can't slip in between the check and the delete.
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    isAdminMock.mockReturnValue(true);
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'STUDENT' }); // target
    prismaMock.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('write conflict', {
        code: 'P2034',
        clientVersion: 'test',
      }),
    );

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u2', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'c1', userId: 'u2' }) });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('conflict');
  });

  it('returns 409 when the course is archived', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    isAdminMock.mockReturnValue(true);
    canManageCourseMock.mockResolvedValue(true);
    prismaMock.course.findUnique.mockResolvedValue({ isArchived: true });

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u2', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'c1', userId: 'u2' }) });

    expect(res.status).toBe(409);
    expect(prismaMock.roster.deleteMany).not.toHaveBeenCalled();
  });

  it('handles server errors gracefully', async () => {
    // Authorized, but the target lookup throws; the handler's catch returns 500.
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    isAdminMock.mockReturnValue(true);
    prismaMock.roster.findFirst.mockRejectedValue(new Error('DB error'));

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u2', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'c1', userId: 'u2' }) });

    expect(res.status).toBe(500);
  });

  it('returns 500 and logs "unknown error" when a non-Error is thrown', async () => {
    // Branch 108: `err instanceof Error ? err.message : 'unknown error'`.
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    isAdminMock.mockReturnValue(true);
    prismaMock.roster.findFirst.mockRejectedValue('boom');

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u2', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'c1', userId: 'u2' }) });

    expect(res.status).toBe(500);
    expect(activityLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        action: 'ROSTER_REMOVE_ERROR',
        metadata: expect.objectContaining({ error: 'unknown error' }),
      }),
    );
  });
});

describe('PATCH /api/courses/[id]/roster/[userId]', () => {
  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u1', {
      method: 'PATCH',
      body: JSON.stringify({ role: 'TA' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'c1', userId: 'u1' }) });

    expect(res.status).toBe(401);
  });

  it('returns 400 when role invalid', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    canManageCourseMock.mockResolvedValue(true);

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u2', {
      method: 'PATCH',
      body: JSON.stringify({ role: 'INVALID' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'c1', userId: 'u2' }) });

    expect(res.status).toBe(400);
  });

  it('returns 403 when user lacks permission', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'TA' } });
    canManageCourseMock.mockResolvedValue(false);

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u2', {
      method: 'PATCH',
      body: JSON.stringify({ role: 'TA' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'c1', userId: 'u2' }) });

    expect(res.status).toBe(403);
  });

  it('returns 404 when the roster entry does not exist', async () => {
    // Branch 231: `!target` → 404.
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    canManageCourseMock.mockResolvedValue(true);
    prismaMock.roster.findFirst.mockResolvedValue(null); // target missing

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u2', {
      method: 'PATCH',
      body: JSON.stringify({ role: 'TA' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'c1', userId: 'u2' }) });

    expect(res.status).toBe(404);
    expect(prismaMock.roster.update).not.toHaveBeenCalled();
  });

  it('returns 400 when demoting the only faculty member', async () => {
    // Branches 234 + 238: target is FACULTY, demoted to non-FACULTY, only one faculty.
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    canManageCourseMock.mockResolvedValue(true);
    prismaMock.roster.findFirst.mockResolvedValue({ id: 'r1', role: 'FACULTY' }); // target
    prismaMock.roster.count.mockResolvedValue(1); // only faculty

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u2', {
      method: 'PATCH',
      body: JSON.stringify({ role: 'STUDENT' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'c1', userId: 'u2' }) });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('only course faculty member');
    expect(prismaMock.roster.update).not.toHaveBeenCalled();
  });

  it('demotes a faculty member when another faculty remains', async () => {
    // Branch 238 false: facultyCount > 1 → proceeds with the update.
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    canManageCourseMock.mockResolvedValue(true);
    prismaMock.roster.findFirst.mockResolvedValue({ id: 'r1', role: 'FACULTY' }); // target
    prismaMock.roster.count.mockResolvedValue(2); // another faculty remains
    prismaMock.roster.update.mockResolvedValue({ id: 'r1', role: 'STUDENT' });

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u2', {
      method: 'PATCH',
      body: JSON.stringify({ role: 'STUDENT' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'c1', userId: 'u2' }) });

    expect(res.status).toBe(200);
    expect(prismaMock.roster.update).toHaveBeenCalled();
  });

  it('updates role when allowed', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    canManageCourseMock.mockResolvedValue(true);
    prismaMock.roster.findFirst.mockResolvedValue({ id: 'r1', role: 'STUDENT' }); // target
    prismaMock.roster.update.mockResolvedValue({ id: 'r1', role: 'TA' });
    prismaMock.roster.count.mockResolvedValue(2);

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u2', {
      method: 'PATCH',
      body: JSON.stringify({ role: 'TA' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'c1', userId: 'u2' }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(activityLogMock).toHaveBeenCalled();
  });

  it('returns 409 when the course is archived', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    canManageCourseMock.mockResolvedValue(true);
    prismaMock.course.findUnique.mockResolvedValue({ isArchived: true });

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u2', {
      method: 'PATCH',
      body: JSON.stringify({ role: 'TA' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'c1', userId: 'u2' }) });

    expect(res.status).toBe(409);
    expect(prismaMock.roster.update).not.toHaveBeenCalled();
  });

  it('returns 500 when the update fails', async () => {
    // Lines 268-275: PATCH catch block.
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    canManageCourseMock.mockResolvedValue(true);
    prismaMock.roster.findFirst.mockResolvedValue({ id: 'r1', role: 'STUDENT' }); // target
    prismaMock.roster.update.mockRejectedValue(new Error('db down'));

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u2', {
      method: 'PATCH',
      body: JSON.stringify({ role: 'TA' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'c1', userId: 'u2' }) });

    expect(res.status).toBe(500);
    expect(activityLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: 'ROSTER_UPDATE_ERROR' }),
    );
  });

  it('returns 500 and logs "unknown error" when a non-Error is thrown', async () => {
    // Branch 273: `err instanceof Error ? err.message : 'unknown error'`.
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    canManageCourseMock.mockResolvedValue(true);
    prismaMock.roster.findFirst.mockResolvedValue({ id: 'r1', role: 'STUDENT' }); // target
    prismaMock.roster.update.mockRejectedValue('boom');

    const req = new NextRequest('http://localhost/api/courses/c1/roster/u2', {
      method: 'PATCH',
      body: JSON.stringify({ role: 'TA' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'c1', userId: 'u2' }) });

    expect(res.status).toBe(500);
    expect(activityLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        action: 'ROSTER_UPDATE_ERROR',
        metadata: expect.objectContaining({ error: 'unknown error' }),
      }),
    );
  });
});

/**
 * Which course each lookup in this route is asking about.
 *
 * Every one of these can lose its `courseId` with the rest of the file still green, because
 * the prisma mock answers regardless of the query. They are not all the same kind of wrong:
 * two decide who is acted on, one decides what the caller may do, and one is a safety guard
 * whose failure is silent.
 */
describe('the course scoping of every roster lookup', () => {
  const req = new NextRequest('http://localhost/api/courses/c1/roster/u2');
  const params = { params: Promise.resolve({ id: 'c1', userId: 'u2' }) };

  const whereOfCall = (fn: { mock: { calls: unknown[][] } }, i = 0) =>
    (fn.mock.calls[i][0] as { where: Record<string, unknown> }).where;

  it('reads the target for the dialog from this course', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    isAdminMock.mockReturnValue(true);
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'STUDENT',
      user: { id: 'u2', email: 'a@b.c' },
    });

    await GET(req, params);

    expect(whereOfCall(prismaMock.roster.findFirst)).toMatchObject({
      courseId: 'c1',
      userId: 'u2',
    });
  });

  it('counts the remaining faculty within this course, not the whole installation', async () => {
    // The guard is "you cannot remove the last faculty member". Counting every FACULTY row
    // anywhere would keep the total comfortably above one forever, so the guard would never
    // fire and a course could be left with nobody running it.
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    isAdminMock.mockReturnValue(true);
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.roster.count.mockResolvedValue(1);

    const res = await DELETE(req, params);

    expect(res.status).toBe(400);
    expect(whereOfCall(prismaMock.roster.count)).toEqual({ courseId: 'c1', role: 'FACULTY' });
  });

  it('checks for submissions by the person being removed, not by anyone', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    isAdminMock.mockReturnValue(true);
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'STUDENT' });
    prismaMock.assignment.findMany.mockResolvedValue([{ id: 'a1' }]);
    prismaMock.submission.findFirst.mockResolvedValue({ id: 's1' });

    const res = await DELETE(req, params);

    expect(res.status).toBe(400);
    // Their submissions on THIS course's assignments. The assignment list is read first and
    // is itself course-scoped; without either key the guard would refuse to remove somebody
    // over work they did in a course they are not being removed from.
    expect(whereOfCall(prismaMock.submission.findFirst)).toEqual({
      studentId: 'u2',
      assignmentId: { in: ['a1'] },
    });
    expect(whereOfCall(prismaMock.assignment.findMany)).toEqual({ courseId: 'c1' });
  });
});

/**
 * The same course scoping on the two verbs that change things.
 *
 * A role change and a removal both find their target with `{ courseId, userId }` and then act
 * on it by id, so the lookup is the only thing tying the action to the course in the URL.
 * `viewerRoster` decides what the caller is allowed to do, read from their role in this course
 * rather than whichever course they happen to teach in.
 */
describe('the course scoping of the verbs that change things', () => {
  const params = { params: Promise.resolve({ id: 'c1', userId: 'u2' }) };
  const patchReq = (role: string) =>
    new NextRequest('http://localhost/api/courses/c1/roster/u2', {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    });

  const wheres = (fn: { mock: { calls: unknown[][] } }) =>
    fn.mock.calls.map((c) => (c[0] as { where: Record<string, unknown> }).where);

  it('finds the person being removed on this course roster', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    isAdminMock.mockReturnValue(true);
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'STUDENT' });
    prismaMock.assignment.findMany.mockResolvedValue([]);
    prismaMock.roster.deleteMany.mockResolvedValue({ count: 1 });

    await DELETE(new NextRequest('http://localhost/api/courses/c1/roster/u2'), params);

    expect(wheres(prismaMock.roster.findFirst)[0]).toMatchObject({
      courseId: 'c1',
      userId: 'u2',
    });
  });

  it('finds the person being re-roled in this course', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: false } });
    isAdminMock.mockReturnValue(false);
    canManageCourseMock.mockResolvedValue(true);
    prismaMock.roster.findFirst.mockResolvedValue({ id: 'r1', role: 'STUDENT' });
    prismaMock.roster.count.mockResolvedValue(2);
    prismaMock.roster.update.mockResolvedValue({ id: 'r1', role: 'TA' });

    await PATCH(patchReq('TA'), params);

    expect(wheres(prismaMock.roster.findFirst)[0]).toMatchObject({
      courseId: 'c1',
      userId: 'u2',
    });
  });

  it("reads the caller's own standing in this course, for the actions the dialog offers", async () => {
    // A non-admin viewer: the route looks up their role here to decide what they may do, and
    // reading it from whichever other course they teach in would answer a different question.
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: false } });
    isAdminMock.mockReturnValue(false);
    canAccessCourseMock.mockResolvedValue(true);
    prismaMock.roster.findFirst
      .mockResolvedValueOnce({ role: 'STUDENT', user: { id: 'u2', email: 'a@b.c' } })
      .mockResolvedValueOnce({ role: 'FACULTY' });

    await GET(new NextRequest('http://localhost/api/courses/c1/roster/u2'), params);

    const asked = wheres(prismaMock.roster.findFirst);
    expect(asked).toContainEqual(expect.objectContaining({ courseId: 'c1', userId: 'u1' }));
  });

  it("counts this course's faculty before demoting the last one", async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    canManageCourseMock.mockResolvedValue(true);
    prismaMock.roster.findFirst.mockResolvedValue({ id: 'r1', role: 'FACULTY' });
    prismaMock.roster.count.mockResolvedValue(1);

    const res = await PATCH(patchReq('STUDENT'), params);

    expect(res.status).toBe(400);
    expect(wheres(prismaMock.roster.count)[0]).toEqual({ courseId: 'c1', role: 'FACULTY' });
  });
});
