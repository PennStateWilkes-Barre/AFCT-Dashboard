import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  assignmentProblem: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  course: {
    findUnique: vi.fn(),
  },
  roster: {
    findFirst: vi.fn(),
  },
  // The settings dialog reads how many attempts already exist, so GET needs this delegate.
  submission: {
    count: vi.fn(),
  },
}));

const authMock = vi.hoisted(() => vi.fn());
const activityLogMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/activity-log-utils', () => ({ createEnhancedActivityLog: activityLogMock }));

import { GET, PUT } from './route';

describe('PUT /api/courses/[id]/[aid]/problems/[pid]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks doesn't reset implementations, so drop any leaked mockRejectedValue.
    activityLogMock.mockReset();
    authMock.mockResolvedValue({ user: { id: 'admin-1', isAdmin: true } });
    prismaMock.roster.findFirst.mockResolvedValue(null);
    prismaMock.course.findUnique.mockResolvedValue({ isArchived: false });
    prismaMock.assignmentProblem.findUnique.mockResolvedValue({
      assignment: { courseId: 'c1' },
      problem: { title: 'Problem 1' },
    });
    prismaMock.assignmentProblem.update.mockResolvedValue({
      assignmentId: 'a1',
      problemId: 'p1',
      maxPoints: 20,
      maxSubmissions: 3,
      autograderEnabled: true,
    });
  });

  it('returns 403 when user is unauthorized', async () => {
    authMock.mockResolvedValue({ user: { id: 'student-1' } });

    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems/p1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxPoints: 10, maxSubmissions: 2, autograderEnabled: true }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: 'c1', aid: 'a1', pid: 'p1' }) });
    expect(res.status).toBe(403);
  });

  it('returns 409 when the course is archived', async () => {
    prismaMock.course.findUnique.mockResolvedValue({ isArchived: true });

    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems/p1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxPoints: 10, maxSubmissions: 2, autograderEnabled: true }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: 'c1', aid: 'a1', pid: 'p1' }) });
    expect(res.status).toBe(409);
    expect(prismaMock.assignmentProblem.update).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid payload', async () => {
    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems/p1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: 'c1', aid: 'a1', pid: 'p1' }) });
    expect(res.status).toBe(400);
  });

  it('returns 404 when assignment problem link is missing', async () => {
    prismaMock.assignmentProblem.findUnique.mockResolvedValue(null);

    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems/p1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxPoints: 10, maxSubmissions: 2, autograderEnabled: true }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: 'c1', aid: 'a1', pid: 'p1' }) });
    expect(res.status).toBe(404);
  });

  it('updates assignment problem settings', async () => {
    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems/p1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxPoints: 25, maxSubmissions: -1, autograderEnabled: false }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: 'c1', aid: 'a1', pid: 'p1' }) });
    expect(res.status).toBe(200);

    expect(prismaMock.assignmentProblem.update).toHaveBeenCalledWith({
      where: {
        assignmentId_problemId: {
          assignmentId: 'a1',
          problemId: 'p1',
        },
      },
      data: {
        maxPoints: 25,
        maxSubmissions: -1,
        autograderEnabled: false,
        // Not in the request body above. The schema defaults it to true rather than false, so
        // an older client that knows nothing about this setting cannot switch feedback off.
        showFeedback: true,
      },
      select: {
        assignmentId: true,
        problemId: true,
        maxPoints: true,
        maxSubmissions: true,
        autograderEnabled: true,
        showFeedback: true,
      },
    });
  });

  it('returns 400 for an invalid JSON body', async () => {
    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems/p1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });

    const res = await PUT(req, { params: Promise.resolve({ id: 'c1', aid: 'a1', pid: 'p1' }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid JSON body.');
  });

  it('still succeeds when activity logging fails', async () => {
    activityLogMock.mockRejectedValue(new Error('log down'));

    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems/p1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxPoints: 10, maxSubmissions: 2, autograderEnabled: true }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: 'c1', aid: 'a1', pid: 'p1' }) });
    expect(res.status).toBe(200);
  });

  it('returns 404 when the link belongs to a different course', async () => {
    prismaMock.assignmentProblem.findUnique.mockResolvedValue({
      assignment: { courseId: 'other-course' },
      problem: { title: 'Problem 1' },
    });

    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems/p1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxPoints: 10, maxSubmissions: 2, autograderEnabled: true }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: 'c1', aid: 'a1', pid: 'p1' }) });
    expect(res.status).toBe(404);
  });

  it('returns 500 when the update fails', async () => {
    prismaMock.assignmentProblem.update.mockRejectedValue(new Error('db down'));

    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems/p1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxPoints: 10, maxSubmissions: 2, autograderEnabled: true }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: 'c1', aid: 'a1', pid: 'p1' }) });
    expect(res.status).toBe(500);
  });

  it('returns 500 and logs when a non-Error is thrown', async () => {
    prismaMock.assignmentProblem.update.mockRejectedValue('boom');

    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems/p1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxPoints: 10, maxSubmissions: 2, autograderEnabled: true }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: 'c1', aid: 'a1', pid: 'p1' }) });
    expect(res.status).toBe(500);
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      expect.anything(),
      expect.objectContaining({
        action: 'ASSIGNMENT_PROBLEM_SETTINGS_UPDATE_ERROR',
        metadata: { error: 'unknown error' },
      }),
    );
  });
});

/**
 * What the attempt count on the settings dialog counts.
 *
 * The dialog shows how many attempts have been made at this problem on this assignment, and
 * that number is what tells an instructor whether lowering the cap would strand somebody. The
 * prisma mock answers with its fixture whatever the `where` says, so without either key the
 * count is every attempt at the problem across every assignment, or every attempt on the
 * assignment across every problem.
 */
describe('what the attempt count is scoped to', () => {
  it('counts attempts at this problem on this assignment', async () => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: 'admin-1', isAdmin: true } });
    prismaMock.roster.findFirst.mockResolvedValue(null);
    prismaMock.course.findUnique.mockResolvedValue({ isArchived: false });
    prismaMock.assignmentProblem.findUnique.mockResolvedValue({
      maxPoints: 20,
      maxSubmissions: 3,
      autograderEnabled: true,
      showFeedback: true,
    });
    prismaMock.submission.count.mockResolvedValue(4);

    const res = await GET(
      new Request('http://localhost/api/courses/c1/assignments/a1/problems/p1'),
      { params: Promise.resolve({ id: 'c1', aid: 'a1', pid: 'p1' }) },
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ submissionCount: 4 });

    expect(prismaMock.submission.count).toHaveBeenCalledWith({
      where: { assignmentId: 'a1', problemId: 'p1' },
    });
  });
});
