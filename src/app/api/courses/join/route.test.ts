import { describe, it, expect, beforeEach, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  course: {
    findUnique: vi.fn(),
  },
  roster: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
}));

const authMock = vi.hoisted(() => vi.fn());
const activityLogMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/activity-log-utils', () => ({ createEnhancedActivityLog: activityLogMock }));

import { POST } from './route';
import { clearBucketsFor } from '@/lib/security/rate-limiter';

const buildCourse = (overrides: Record<string, unknown> = {}) => ({
  id: 'course-1',
  name: 'Course 1',
  regCode: 'ABC123',
  isPublished: true,
  isArchived: false,
  registrationOpenAt: new Date('2000-01-01T00:00:00.000Z'),
  registrationCloseAt: new Date('2999-01-01T00:00:00.000Z'),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  // The limiter is module-level state; a fresh user id per suite run keeps tests honest,
  // but clearing the bucket keeps them independent of execution order too.
  clearBucketsFor(['join-code:user-1', 'join-code:guesser']);
});

describe('POST /api/courses/join', () => {
  it('returns 401 when not authenticated', async () => {
    authMock.mockResolvedValue(null);

    const req = new Request('http://localhost/api/courses/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'ABC123' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 400 when code is invalid', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1', isAdmin: false } });

    const req = new Request('http://localhost/api/courses/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'AB' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 404 when course not found', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1', isAdmin: false } });
    prismaMock.course.findUnique.mockResolvedValue(null);

    const req = new Request('http://localhost/api/courses/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'ABC123' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it('returns 404 for admins when course is unpublished', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1', isAdmin: true } });
    prismaMock.course.findUnique.mockResolvedValue(buildCourse({ isPublished: false }));

    const req = new Request('http://localhost/api/courses/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'ABC123' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it('returns 404 for students when course is unpublished', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1', isAdmin: false } });
    prismaMock.course.findUnique.mockResolvedValue(buildCourse({ isPublished: false }));

    const req = new Request('http://localhost/api/courses/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'ABC123' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it('returns 400 when admin tries to join', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1', isAdmin: true } });
    prismaMock.course.findUnique.mockResolvedValue(buildCourse());
    prismaMock.roster.findUnique.mockResolvedValue(null);

    const req = new Request('http://localhost/api/courses/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'ABC123' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when already enrolled', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1', isAdmin: false } });
    prismaMock.course.findUnique.mockResolvedValue(buildCourse());
    prismaMock.roster.findUnique.mockResolvedValue({ role: 'STUDENT' });

    const req = new Request('http://localhost/api/courses/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'ABC123' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('refuses a dropped student with 403 and does not re-enroll them', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1', isAdmin: false } });
    prismaMock.course.findUnique.mockResolvedValue(buildCourse());
    prismaMock.roster.findUnique.mockResolvedValue({ role: 'STUDENT', status: 'DROPPED' });

    const req = new Request('http://localhost/api/courses/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'ABC123' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/dropped/i);
    // Re-enrollment is a staff action; the join code must not restore access.
    expect(prismaMock.roster.create).not.toHaveBeenCalled();
  });

  it('creates roster entry for student', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1', isAdmin: false } });
    prismaMock.course.findUnique.mockResolvedValue(buildCourse());
    prismaMock.roster.findUnique.mockResolvedValue(null);
    prismaMock.roster.create.mockResolvedValue({ id: 'roster-1' });

    const req = new Request('http://localhost/api/courses/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'ABC123' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(prismaMock.roster.create).toHaveBeenCalledWith({
      data: { courseId: 'course-1', userId: 'user-1', role: 'STUDENT' },
    });
  });

  it('returns 400 when registration has not opened yet', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1', isAdmin: false } });
    prismaMock.course.findUnique.mockResolvedValue(
      buildCourse({
        registrationOpenAt: new Date('2999-01-01T00:00:00.000Z'),
        registrationCloseAt: new Date('2999-12-31T23:59:59.000Z'),
      }),
    );
    prismaMock.roster.findUnique.mockResolvedValue(null);

    const req = new Request('http://localhost/api/courses/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'ABC123' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Registration is not open yet for this course.');
  });

  it('returns 400 when the registration window is not configured', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1', isAdmin: false } });
    prismaMock.course.findUnique.mockResolvedValue(
      buildCourse({ registrationOpenAt: null, registrationCloseAt: null }),
    );
    prismaMock.roster.findUnique.mockResolvedValue(null);

    const req = new Request('http://localhost/api/courses/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'ABC123' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Registration is currently closed for this course.');
  });

  it('returns 500 and logs when creating the roster entry throws', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1', isAdmin: false } });
    prismaMock.course.findUnique.mockResolvedValue(buildCourse());
    prismaMock.roster.findUnique.mockResolvedValue(null);
    prismaMock.roster.create.mockRejectedValueOnce(new Error('db down'));

    const req = new Request('http://localhost/api/courses/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'ABC123' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Failed to join the course.');
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      req,
      expect.objectContaining({ action: 'COURSE_JOIN_ERROR', severity: 'ERROR' }),
    );
  });

  it('returns 500 with a generic message when a non-Error is thrown', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1', isAdmin: false } });
    prismaMock.course.findUnique.mockResolvedValue(buildCourse());
    prismaMock.roster.findUnique.mockResolvedValue(null);
    prismaMock.roster.create.mockRejectedValueOnce('boom');

    const req = new Request('http://localhost/api/courses/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'ABC123' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(500);
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      req,
      expect.objectContaining({
        action: 'COURSE_JOIN_ERROR',
        metadata: expect.objectContaining({ error: 'unknown error' }),
      }),
    );
  });

  it('returns 400 when registration window has closed', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1', isAdmin: false } });
    prismaMock.course.findUnique.mockResolvedValue(
      buildCourse({
        registrationOpenAt: new Date('2000-01-01T00:00:00.000Z'),
        registrationCloseAt: new Date('2000-12-31T23:59:59.000Z'),
      }),
    );
    prismaMock.roster.findUnique.mockResolvedValue(null);

    const req = new Request('http://localhost/api/courses/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'ABC123' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Registration is closed for this course.');
  });
});
describe('join-code guessing', () => {
  const makeRequest = (body: unknown) =>
    new Request('http://localhost/api/courses/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /**
   * The code space is what makes registration codes safe, and that only holds if nobody
   * gets to walk it: without a limiter a student can try codes as fast as the database
   * answers, signed in the whole time.
   */
  it('blocks a signed-in user after repeated wrong codes', async () => {
    authMock.mockResolvedValue({ user: { id: 'guesser', isAdmin: false } });
    prismaMock.course.findUnique.mockResolvedValue(null);

    let last: Response | null = null;
    for (let i = 0; i < 11; i++) {
      last = await POST(makeRequest({ code: `WRONG${String(i).padStart(3, '0')}` }));
    }

    expect(last?.status).toBe(429);
    expect(last?.headers.get('Retry-After')).toMatch(/^\d+$/);
    // The refusal is itself a security event: a walk through the code space should be
    // visible to whoever reads the log, not just slowed down.
    expect(activityLogMock.mock.calls.at(-1)?.[2]).toMatchObject({
      action: 'COURSE_JOIN_RATE_LIMIT',
      severity: 'SECURITY',
    });
  });

  it("does not let one user's guessing block another", async () => {
    authMock.mockResolvedValue({ user: { id: 'guesser', isAdmin: false } });
    prismaMock.course.findUnique.mockResolvedValue(null);
    for (let i = 0; i < 11; i++) {
      await POST(makeRequest({ code: 'WRONGAAA' }));
    }

    authMock.mockResolvedValue({ user: { id: 'user-1', isAdmin: false } });
    const res = await POST(makeRequest({ code: 'WRONGAAA' }));

    expect(res.status).toBe(404);
  });
});

/**
 * The join response is a student's payload, and the registration code is the one thing the
 * course route says in as many words must never reach a student's client. They had just typed
 * it, so nothing is learned; a rule that holds in one route and not its neighbour is the
 * problem.
 */
describe('what joining hands back', () => {
  it('names the course without returning its registration code', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1', isAdmin: false } });
    prismaMock.course.findUnique.mockResolvedValue(buildCourse({ code: 'CS101' }));
    prismaMock.roster.findUnique.mockResolvedValue(null);
    prismaMock.roster.create.mockResolvedValue({ id: 'roster-1' });

    const res = await POST(
      new Request('http://localhost/api/courses/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'ABC123' }),
      }),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.course).toEqual({ id: 'course-1', name: 'Course 1', code: 'CS101' });
    // The one field the course route says in as many words must never reach a student.
    expect(body.course).not.toHaveProperty('regCode');
  });
});
