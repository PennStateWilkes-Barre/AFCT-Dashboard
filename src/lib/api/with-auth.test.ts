import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMock = vi.hoisted(() => vi.fn());
const prismaMock = vi.hoisted(() => ({
  course: { findUnique: vi.fn() },
  assignment: { findFirst: vi.fn() },
  roster: { findFirst: vi.fn() },
}));
const createLogMock = vi.hoisted(() => vi.fn());
const canManageMock = vi.hoisted(() => vi.fn());
const canAccessMock = vi.hoisted(() => vi.fn());
const isArchivedMock = vi.hoisted(() => vi.fn());
const staffAnywhereMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/activity-log-utils', () => ({ createEnhancedActivityLog: createLogMock }));
// Keep isAdmin real (it's pure); stub the course-role checks (they hit Prisma).
vi.mock('@/lib/permissions', async (orig) => ({
  ...(await orig<typeof import('@/lib/permissions')>()),
  canManageCourse: canManageMock,
  canAccessCourse: canAccessMock,
  isCourseArchived: isArchivedMock,
  isCourseStaffAnywhere: staffAnywhereMock,
}));

import { withAdminAuth, withStaffAuth, withCourseAuth, withAssignmentAuth } from './with-auth';

const DENIED = { deniedAction: 'THING_DENIED' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('withAdminAuth', () => {
  it('runs the handler for a confirmed admin, passing session + user', async () => {
    const session = { user: { id: 'a1', isAdmin: true } };
    authMock.mockResolvedValue(session);
    const handler = vi.fn().mockResolvedValue(new Response('ok'));

    const req = new Request('http://localhost/x');
    const res = await withAdminAuth(handler, DENIED)(req, { params: 1 });

    expect(await (res as Response).text()).toBe('ok');
    expect(handler).toHaveBeenCalledWith(req, { params: 1 }, { session, user: session.user });
  });

  it('returns 401 (not logged) when there is no session', async () => {
    authMock.mockResolvedValue(null);
    const handler = vi.fn();

    const res = await withAdminAuth(handler, DENIED)(new Request('http://localhost/x'), {});

    expect(res.status).toBe(401);
    await expect((res as Response).json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(handler).not.toHaveBeenCalled();
    expect(createLogMock).not.toHaveBeenCalled();
  });

  it('returns 401 for a disabled/deleted account even if the token says admin', async () => {
    // The session callback marks a gone/disabled user inactive; the wrapper must
    // reject before the admin check so a stale JWT can't keep admin access.
    authMock.mockResolvedValue({ user: { id: 'a1', isAdmin: true, inactive: true } });
    const handler = vi.fn();

    const res = await withAdminAuth(handler, DENIED)(new Request('http://localhost/x'), {});

    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 403 Forbidden + logs a SECURITY denial for a signed-in non-admin', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: false } });
    const req = new Request('http://localhost/x');

    const res = await withAdminAuth(vi.fn(), DENIED)(req, {});

    expect(res.status).toBe(403);
    await expect((res as Response).json()).resolves.toEqual({ error: 'Forbidden' });
    expect(createLogMock).toHaveBeenCalledWith(
      prismaMock,
      req,
      expect.objectContaining({ userId: 'u1', action: 'THING_DENIED', severity: 'SECURITY' }),
    );
  });
});

describe('withStaffAuth', () => {
  it('runs the handler for course staff, whichever course they are staff of', async () => {
    const session = { user: { id: 'f1', isAdmin: false } };
    authMock.mockResolvedValue(session);
    staffAnywhereMock.mockResolvedValue(true);
    const handler = vi.fn().mockResolvedValue(new Response('ok'));

    const res = await withStaffAuth(handler, DENIED)(new Request('http://localhost/x'), {});

    expect(await (res as Response).text()).toBe('ok');
  });

  it('refuses a student and leaves a SECURITY trail', async () => {
    authMock.mockResolvedValue({ user: { id: 's1', isAdmin: false } });
    staffAnywhereMock.mockResolvedValue(false);
    const handler = vi.fn();

    const res = await withStaffAuth(handler, DENIED)(new Request('http://localhost/x'), {});

    expect((res as Response).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect(createLogMock).toHaveBeenCalledWith(
      prismaMock,
      expect.anything(),
      expect.objectContaining({ action: 'THING_DENIED', severity: 'SECURITY' }),
    );
  });

  it('turns away an unsigned request, and one from a disabled account, without a log', async () => {
    const handler = vi.fn();
    authMock.mockResolvedValue(null);
    expect(
      ((await withStaffAuth(handler, DENIED)(new Request('http://localhost/x'), {})) as Response)
        .status,
    ).toBe(401);

    authMock.mockResolvedValue({ user: { id: 'f1', inactive: true } });
    expect(
      ((await withStaffAuth(handler, DENIED)(new Request('http://localhost/x'), {})) as Response)
        .status,
    ).toBe(401);

    expect(createLogMock).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('withCourseAuth', () => {
  const ctx = () => ({ params: Promise.resolve({ id: 'c1' }) });
  const manage = { access: 'manage' as const, deniedAction: 'C_DENIED' };

  it('returns 401 when there is no session', async () => {
    authMock.mockResolvedValue(null);
    const res = await withCourseAuth(vi.fn(), manage)(new Request('http://localhost/x'), ctx());
    expect(res.status).toBe(401);
    expect(canManageMock).not.toHaveBeenCalled();
  });

  it('returns 401 for a disabled/deleted account before any course check', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', inactive: true } });
    const res = await withCourseAuth(vi.fn(), manage)(new Request('http://localhost/x'), ctx());
    expect(res.status).toBe(401);
    expect(canManageMock).not.toHaveBeenCalled();
  });

  it('runs the handler for a permitted manager, passing the resolved courseId', async () => {
    const session = { user: { id: 'u1' } };
    authMock.mockResolvedValue(session);
    canManageMock.mockResolvedValue(true);
    const handler = vi.fn().mockResolvedValue(new Response('ok'));

    const req = new Request('http://localhost/x');
    const c = ctx();
    const res = await withCourseAuth(handler, manage)(req, c);

    expect(await (res as Response).text()).toBe('ok');
    expect(canManageMock).toHaveBeenCalledWith(session.user, 'c1', undefined);
    expect(handler).toHaveBeenCalledWith(req, c, {
      session,
      user: session.user,
      courseId: 'c1',
    });
  });

  it('403s + logs a course-scoped denial when management is not allowed', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1' } });
    canManageMock.mockResolvedValue(false);
    const req = new Request('http://localhost/x');

    const res = await withCourseAuth(vi.fn(), manage)(req, ctx());

    expect(res.status).toBe(403);
    await expect((res as Response).json()).resolves.toEqual({ error: 'Forbidden' });
    expect(createLogMock).toHaveBeenCalledWith(
      prismaMock,
      req,
      expect.objectContaining({ action: 'C_DENIED', severity: 'SECURITY', courseId: 'c1' }),
    );
  });

  // The role is read at denial time because roles change.
  it('records why the refusal happened, with the role at the time', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1' } });
    canManageMock.mockResolvedValue(false);
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'STUDENT', status: 'ENROLLED' });

    await withCourseAuth(vi.fn(), manage)(new Request('http://localhost/x'), ctx());

    expect(createLogMock.mock.calls[0][2].metadata).toEqual({
      reason: 'student, needs faculty or ta',
      required: 'FACULTY or TA',
      role: 'STUDENT',
      status: 'ENROLLED',
    });
  });

  it('says so when the caller is not on the roster at all', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1' } });
    canManageMock.mockResolvedValue(false);
    prismaMock.roster.findFirst.mockResolvedValue(null);

    await withCourseAuth(vi.fn(), manage)(new Request('http://localhost/x'), ctx());

    expect(createLogMock.mock.calls[0][2].metadata).toMatchObject({
      reason: 'not enrolled in this course',
      role: null,
    });
  });

  // A dropped student is not the same event as a student who never enrolled.
  it('tells a dropped student apart from a stranger', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1' } });
    canManageMock.mockResolvedValue(false);
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'STUDENT', status: 'DROPPED' });

    await withCourseAuth(vi.fn(), manage)(new Request('http://localhost/x'), ctx());

    expect(createLogMock.mock.calls[0][2].metadata.reason).toBe('dropped from this course');
  });

  // A failed lookup must not turn the 403 into a 500.
  it('still refuses when the role lookup fails', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1' } });
    canManageMock.mockResolvedValue(false);
    prismaMock.roster.findFirst.mockRejectedValue(new Error('db down'));

    const res = await withCourseAuth(vi.fn(), manage)(new Request('http://localhost/x'), ctx());

    expect(res.status).toBe(403);
    expect(createLogMock.mock.calls[0][2].metadata.reason).toBe('not enrolled in this course');
  });

  /**
   * A course starts unpublished, so this is what every student sees who follows an LMS link
   * before their instructor publishes. It is the one denial the person cannot act on and the
   * instructor can fix in a click, so it says so instead of "Forbidden".
   */
  describe('a student in a course that is not published yet', () => {
    const read = { access: 'read' as const, deniedAction: 'C_READ_DENIED' };
    const enrolledButUnpublished = () => {
      authMock.mockResolvedValue({ user: { id: 'u1' } });
      canAccessMock.mockResolvedValue(false);
      prismaMock.roster.findFirst.mockResolvedValue({
        role: 'STUDENT',
        status: 'ENROLLED',
        course: { isPublished: false },
      });
    };

    it('tells them why, rather than refusing without a reason', async () => {
      enrolledButUnpublished();

      const res = await withCourseAuth(vi.fn(), read)(new Request('http://localhost/x'), ctx());

      expect(res.status).toBe(403);
      expect(await (res as Response).json()).toEqual({
        error: 'This course has not been published yet, so it is not open to students.',
      });
    });

    it('records the real reason, not a role that has nothing to do with it', async () => {
      enrolledButUnpublished();

      await withCourseAuth(vi.fn(), read)(new Request('http://localhost/x'), ctx());

      expect(createLogMock.mock.calls[0][2].metadata.reason).toBe('course not published');
    });

    /**
     * The same class of refusal as the unpublished one above: the student is enrolled, has
     * done nothing wrong, and can do nothing about it. Logged as its own reason so a reader
     * is not sent to the roster looking for a fault that is a date.
     */
    const enrolledButNotStarted = () => {
      authMock.mockResolvedValue({ user: { id: 'u1' } });
      canAccessMock.mockResolvedValue(false);
      prismaMock.roster.findFirst.mockResolvedValue({
        role: 'STUDENT',
        status: 'ENROLLED',
        course: { isPublished: true, startDate: new Date('2099-01-01') },
      });
    };

    it('says a course has not started, rather than refusing without a reason', async () => {
      enrolledButNotStarted();

      const res = await withCourseAuth(vi.fn(), read)(new Request('http://localhost/x'), ctx());

      expect(res.status).toBe(403);
      expect(await (res as Response).json()).toEqual({
        error: 'This course has not started yet, so it is not open to students.',
      });
    });

    it('records that reason too, not the role', async () => {
      enrolledButNotStarted();

      await withCourseAuth(vi.fn(), read)(new Request('http://localhost/x'), ctx());

      expect(createLogMock.mock.calls[0][2].metadata.reason).toBe('course not started');
    });

    it('keeps saying only Forbidden once the course is published', async () => {
      authMock.mockResolvedValue({ user: { id: 'u1' } });
      canAccessMock.mockResolvedValue(false);
      prismaMock.roster.findFirst.mockResolvedValue({
        role: 'STUDENT',
        status: 'ENROLLED',
        course: { isPublished: true },
      });

      const res = await withCourseAuth(vi.fn(), read)(new Request('http://localhost/x'), ctx());

      expect(await (res as Response).json()).toEqual({ error: 'Forbidden' });
    });

    it('does not explain a staff refusal that way', async () => {
      // Manage access is a different question, and an unpublished course does not block staff.
      authMock.mockResolvedValue({ user: { id: 'u1' } });
      canManageMock.mockResolvedValue(false);
      prismaMock.roster.findFirst.mockResolvedValue({
        role: 'STUDENT',
        status: 'ENROLLED',
        course: { isPublished: false },
      });

      const res = await withCourseAuth(vi.fn(), manage)(new Request('http://localhost/x'), ctx());

      expect(await (res as Response).json()).toEqual({ error: 'Forbidden' });
    });
  });

  it('uses canAccessCourse for read access', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1' } });
    canAccessMock.mockResolvedValue(true);
    const handler = vi.fn().mockResolvedValue(new Response('ok'));

    await withCourseAuth(handler, { access: 'read', deniedAction: 'C_READ_DENIED' })(
      new Request('http://localhost/x'),
      ctx(),
    );

    expect(canAccessMock).toHaveBeenCalledWith({ id: 'u1' }, 'c1');
    expect(handler).toHaveBeenCalled();
  });

  it('forwards a narrowed roles list to canManageCourse', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1' } });
    canManageMock.mockResolvedValue(true);

    await withCourseAuth(vi.fn().mockResolvedValue(new Response('ok')), {
      access: 'manage',
      deniedAction: 'C_DENIED',
      roles: ['FACULTY'],
    })(new Request('http://localhost/x'), ctx());

    expect(canManageMock).toHaveBeenCalledWith({ id: 'u1' }, 'c1', ['FACULTY']);
  });

  describe('blockWhenArchived', () => {
    const managed = () => {
      authMock.mockResolvedValue({ user: { id: 'u1' } });
      canManageMock.mockResolvedValue(true);
    };

    it('409s when the course is archived — even for a permitted manager', async () => {
      managed();
      isArchivedMock.mockResolvedValue(true);
      const handler = vi.fn();

      const res = await withCourseAuth(handler, { ...manage, blockWhenArchived: true })(
        new Request('http://localhost/x'),
        ctx(),
      );

      expect(res.status).toBe(409);
      expect(handler).not.toHaveBeenCalled();
    });

    it('409s even for an admin (the freeze is not bypassed by the admin short-circuit)', async () => {
      authMock.mockResolvedValue({ user: { id: 'a1', isAdmin: true } });
      canManageMock.mockResolvedValue(true);
      isArchivedMock.mockResolvedValue(true);
      const handler = vi.fn();

      const res = await withCourseAuth(handler, { ...manage, blockWhenArchived: true })(
        new Request('http://localhost/x'),
        ctx(),
      );

      expect(res.status).toBe(409);
      expect(handler).not.toHaveBeenCalled();
    });

    it('runs the handler when the course is not archived', async () => {
      managed();
      isArchivedMock.mockResolvedValue(false);
      const handler = vi.fn().mockResolvedValue(new Response('ok'));

      const res = await withCourseAuth(handler, { ...manage, blockWhenArchived: true })(
        new Request('http://localhost/x'),
        ctx(),
      );

      expect(await (res as Response).text()).toBe('ok');
      expect(handler).toHaveBeenCalled();
    });

    it('does not check archive state when the option is off', async () => {
      managed();
      const handler = vi.fn().mockResolvedValue(new Response('ok'));

      await withCourseAuth(handler, manage)(new Request('http://localhost/x'), ctx());

      expect(isArchivedMock).not.toHaveBeenCalled();
    });
  });
});

describe('withAssignmentAuth', () => {
  const ctx = () => ({ params: Promise.resolve({ id: 'c1', aid: 'a1' }) });
  const read = { access: 'read' as const, deniedAction: 'A_DENIED' };

  beforeEach(() => {
    authMock.mockResolvedValue({ user: { id: 'u1' } });
    canAccessMock.mockResolvedValue(true);
    canManageMock.mockResolvedValue(false);
  });

  it('resolves the assignment and passes it to the handler', async () => {
    const assignment = { id: 'a1', courseId: 'c1', isPublished: true, isGroup: false };
    prismaMock.assignment.findFirst.mockResolvedValue(assignment);
    const handler = vi.fn().mockResolvedValue(new Response('ok'));

    const res = await withAssignmentAuth(handler, read)(new Request('http://localhost/x'), ctx());

    expect(await (res as Response).text()).toBe('ok');
    expect(handler).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ courseId: 'c1', assignment }),
    );
  });

  it('404s when the assignment is not in this course', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(null);
    const handler = vi.fn();

    const res = await withAssignmentAuth(handler, read)(new Request('http://localhost/x'), ctx());

    expect(res.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it('404-masks an unpublished assignment for a non-staff reader', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      courseId: 'c1',
      isPublished: false,
      isGroup: false,
    });
    canManageMock.mockResolvedValue(false); // student
    const handler = vi.fn();

    const res = await withAssignmentAuth(handler, read)(new Request('http://localhost/x'), ctx());

    expect(res.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it('lets staff read an unpublished assignment', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      courseId: 'c1',
      isPublished: false,
      isGroup: false,
    });
    canManageMock.mockResolvedValue(true); // staff
    const handler = vi.fn().mockResolvedValue(new Response('ok'));

    const res = await withAssignmentAuth(handler, read)(new Request('http://localhost/x'), ctx());

    expect(await (res as Response).text()).toBe('ok');
    expect(handler).toHaveBeenCalled();
  });
});
