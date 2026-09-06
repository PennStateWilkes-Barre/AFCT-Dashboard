import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  problem: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  assignmentProblem: {
    findMany: vi.fn(),
    createMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  assignment: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
  },
  course: { findUnique: vi.fn() },
  roster: { findFirst: vi.fn() },
}));

const authMock = vi.hoisted(() => vi.fn());
const activityLogMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/activity-log-utils', () => ({ createEnhancedActivityLog: activityLogMock }));

import { POST, DELETE } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  // Not on any course roster by default; individual tests grant admin/staff via auth.
  prismaMock.roster.findFirst.mockResolvedValue(null);
  prismaMock.course.findUnique.mockResolvedValue({ isArchived: false });
});

describe('POST /api/courses/[id]/[aid]/problems (add problems)', () => {
  beforeEach(() => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.assignmentProblem.findMany.mockResolvedValue([]);
    prismaMock.assignmentProblem.createMany.mockResolvedValue({ count: 0 });
    // withAssignmentAuth resolves the assignment (and its course membership) here.
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      courseId: 'c1',
      isPublished: true,
      isGroup: false,
    });
    prismaMock.assignment.findUnique.mockResolvedValue({
      id: 'assignment-1',
      problems: [{ problem: { id: 'p1', title: 'P1' } }],
    });
  });

  it('returns 403 when user is not authorized', async () => {
    authMock.mockResolvedValue({ user: { id: 'student-1', role: 'STUDENT' } });

    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ problemIds: ['p1'] }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });
    expect(res.status).toBe(403);
  });

  it('returns 409 when the course is archived', async () => {
    prismaMock.course.findUnique.mockResolvedValue({ isArchived: true });

    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ problemIds: ['p1'] }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });
    expect(res.status).toBe(409);
    expect(prismaMock.assignmentProblem.createMany).not.toHaveBeenCalled();
  });

  it('returns 400 for empty body', async () => {
    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid JSON', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad',
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });
    expect(res.status).toBe(400);
    consoleSpy.mockRestore();
  });

  it('returns 400 for invalid problemSettings', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        problemIds: ['p1'],
        // maxSubmissions 0 violates the refine (must be -1 or >= 1)
        problemSettings: [
          { problemId: 'p1', maxPoints: 5, maxSubmissions: 0, autograderEnabled: true },
        ],
      }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid problemSettings in request body');
    consoleSpy.mockRestore();
  });

  it('treats a non-array problemIds as empty', async () => {
    prismaMock.problem.findMany.mockResolvedValue([]);
    prismaMock.assignmentProblem.findMany.mockResolvedValue([]);

    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ problemIds: 'not-an-array' }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });
    expect(res.status).toBe(200);
    expect(prismaMock.problem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: [] } }) }),
    );
    expect(prismaMock.assignmentProblem.createMany).not.toHaveBeenCalled();
  });

  it('reports protected problems that already have submissions', async () => {
    prismaMock.problem.findMany.mockResolvedValue([{ id: 'p1' }]);
    // Existing link with submissions > 0 -> reported as protected, not re-added.
    prismaMock.assignmentProblem.findMany.mockResolvedValue([
      { problemId: 'p1', _count: { submissions: 3 } },
    ]);
    prismaMock.assignment.findUnique.mockResolvedValue({
      id: 'assignment-1',
      problems: [{ problem: { id: 'p1', title: 'P1' } }],
    });

    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ problemIds: ['p1'] }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metadata.protectedProblems).toBe(1);
    expect(body.metadata.message).toContain('preserved');
    expect(prismaMock.assignmentProblem.createMany).not.toHaveBeenCalled();
  });

  it('still succeeds when activity logging fails', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    prismaMock.problem.findMany.mockResolvedValue([{ id: 'p1' }]);
    prismaMock.assignmentProblem.findMany.mockResolvedValue([]);
    activityLogMock.mockRejectedValueOnce(new Error('log down'));

    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ problemIds: ['p1'] }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });
    expect(res.status).toBe(200);
    consoleSpy.mockRestore();
  });

  it('returns 500 when a non-Error is thrown', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.problem.findMany.mockRejectedValueOnce('boom');

    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ problemIds: ['p1'] }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });
    expect(res.status).toBe(500);
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      expect.anything(),
      expect.objectContaining({
        action: 'ASSIGNMENT_ADD_PROBLEMS_ERROR',
        metadata: { error: 'unknown error' },
      }),
    );
    consoleSpy.mockRestore();
  });

  it('adds new problems without removing existing ones', async () => {
    prismaMock.problem.findMany.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]);
    prismaMock.assignmentProblem.findMany.mockResolvedValue([
      { problemId: 'p1', _count: { submissions: 0 } },
    ]);
    prismaMock.assignmentProblem.createMany.mockResolvedValue({ count: 1 });
    prismaMock.assignment.findUnique.mockResolvedValue({
      id: 'assignment-1',
      problems: [{ problem: { id: 'p1', title: 'P1' } }, { problem: { id: 'p2', title: 'P2' } }],
    });

    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ problemIds: ['p1', 'p2'] }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(prismaMock.assignmentProblem.createMany).toHaveBeenCalledWith({
      data: [
        {
          assignmentId: 'a1',
          problemId: 'p2',
          maxPoints: 0,
          maxSubmissions: 1,
          autograderEnabled: true,
          showFeedback: true,
        },
      ],
    });
    expect(body.problems).toHaveLength(2);
    expect(body.metadata.newProblemsAdded).toBe(1);
    // Success log renamed to match its ADD_* error/denied siblings; no group mapping here.
    const successCall = activityLogMock.mock.calls.find(
      (c) => c[2]?.action === 'ADD_ASSIGNMENT_PROBLEMS',
    );
    expect(successCall).toBeDefined();
    expect(successCall?.[2].metadata).not.toHaveProperty('groupId');
    expect(successCall?.[2].metadata).not.toHaveProperty('mappedGroupCount');
  });

  it('ignores invalid problem ids not in the course', async () => {
    prismaMock.problem.findMany.mockResolvedValue([{ id: 'p1' }]);
    prismaMock.assignmentProblem.findMany.mockResolvedValue([]);
    prismaMock.assignmentProblem.createMany.mockResolvedValue({ count: 1 });

    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ problemIds: ['p1', 'p999'] }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });
    expect(res.status).toBe(200);
    expect(prismaMock.assignmentProblem.createMany).toHaveBeenCalledWith({
      data: [
        {
          assignmentId: 'a1',
          problemId: 'p1',
          maxPoints: 0,
          maxSubmissions: 1,
          autograderEnabled: true,
          showFeedback: true,
        },
      ],
    });
  });

  it('applies provided problem settings for new problems', async () => {
    prismaMock.problem.findMany.mockResolvedValue([{ id: 'p2' }]);
    prismaMock.assignmentProblem.findMany.mockResolvedValue([]);

    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        problemIds: ['p2'],
        problemSettings: [
          {
            problemId: 'p2',
            maxPoints: 15,
            maxSubmissions: -1,
            autograderEnabled: false,
            showFeedback: true,
          },
        ],
      }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });
    expect(res.status).toBe(200);
    expect(prismaMock.assignmentProblem.createMany).toHaveBeenCalledWith({
      data: [
        {
          assignmentId: 'a1',
          problemId: 'p2',
          maxPoints: 15,
          maxSubmissions: -1,
          autograderEnabled: false,
          showFeedback: true,
        },
      ],
    });
  });
});

describe('DELETE /api/courses/[id]/[aid]/problems (remove a problem)', () => {
  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);

    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems', {
      method: 'DELETE',
      body: JSON.stringify({ problemId: 'p1' }),
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });

    expect(res.status).toBe(401);
  });

  it('returns 409 when the course is archived', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN', isAdmin: true } });
    prismaMock.course.findUnique.mockResolvedValue({ isArchived: true });

    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems', {
      method: 'DELETE',
      body: JSON.stringify({ problemId: 'p1' }),
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });

    expect(res.status).toBe(409);
    expect(prismaMock.assignmentProblem.deleteMany).not.toHaveBeenCalled();
  });

  it('returns 400 when missing problemId', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN', isAdmin: true } });

    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems', {
      method: 'DELETE',
      body: JSON.stringify({}),
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });

    expect(res.status).toBe(400);
  });

  it('returns 404 when assignment missing', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN', isAdmin: true } });
    prismaMock.assignment.findFirst.mockResolvedValue(null);

    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems', {
      method: 'DELETE',
      body: JSON.stringify({ problemId: 'p1' }),
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });

    expect(res.status).toBe(404);
  });

  it('returns 404 when problem missing', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN', isAdmin: true } });
    prismaMock.assignment.findFirst.mockResolvedValue({ id: 'a1' });
    prismaMock.problem.findFirst.mockResolvedValue(null);

    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems', {
      method: 'DELETE',
      body: JSON.stringify({ problemId: 'p1' }),
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });

    expect(res.status).toBe(404);
  });

  it('removes problem and returns updated list', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN', isAdmin: true } });
    prismaMock.assignment.findFirst.mockResolvedValue({ id: 'a1' });
    prismaMock.problem.findFirst.mockResolvedValue({ id: 'p1', title: 'Problem' });
    prismaMock.assignment.findUnique.mockResolvedValue({
      problems: [
        {
          problem: {
            id: 'p1',
            title: 'Problem',
            description: null,
            type: null,
            maxStates: null,
            isDeterministic: null,
          },
        },
      ],
    });

    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems', {
      method: 'DELETE',
      body: JSON.stringify({ problemId: 'p1' }),
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.problems).toHaveLength(1);
    expect(prismaMock.assignmentProblem.deleteMany).toHaveBeenCalledWith({
      where: { assignmentId: 'a1', problemId: 'p1' },
    });
    expect(activityLogMock).toHaveBeenCalled();
  });

  it('returns an empty problem list when the reload comes back null', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN', isAdmin: true } });
    prismaMock.assignment.findFirst.mockResolvedValue({ id: 'a1' });
    prismaMock.problem.findFirst.mockResolvedValue({ id: 'p1', title: 'Problem' });
    prismaMock.assignment.findUnique.mockResolvedValue(null);

    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems', {
      method: 'DELETE',
      body: JSON.stringify({ problemId: 'p1' }),
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.problems).toEqual([]);
  });

  it('returns 500 and logs when removal throws a non-Error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN', isAdmin: true } });
    prismaMock.assignment.findFirst.mockResolvedValue({ id: 'a1' });
    prismaMock.problem.findFirst.mockResolvedValue({ id: 'p1', title: 'Problem' });
    prismaMock.assignmentProblem.deleteMany.mockRejectedValueOnce('boom');

    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems', {
      method: 'DELETE',
      body: JSON.stringify({ problemId: 'p1' }),
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });

    expect(res.status).toBe(500);
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      expect.anything(),
      expect.objectContaining({
        action: 'ASSIGNMENT_REMOVE_PROBLEM_ERROR',
        metadata: { error: 'unknown error' },
      }),
    );
    consoleSpy.mockRestore();
  });
});

/**
 * What the problem link checks are scoped to.
 *
 * The problem ids come from the request body, so both the add and the remove path have to
 * confirm each one belongs to this course. The existing-links read is bounded the same way,
 * through the assignment's own course. The prisma mock answers from its fixture whatever the
 * `where` says: without the `courseId` a problem from another course can be attached to this
 * assignment, which puts another course's problem statement in front of these students.
 */
describe('what the problem link checks are scoped to', () => {
  const whereOf = (fn: { mock: { calls: unknown[][] } }) =>
    (fn.mock.calls[0][0] as { where: unknown }).where;

  beforeEach(() => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      courseId: 'c1',
      isPublished: true,
      isGroup: false,
    });
    prismaMock.assignment.findUnique.mockResolvedValue({
      id: 'a1',
      problems: [{ problem: { id: 'p1', title: 'P1' } }],
    });
    activityLogMock.mockResolvedValue(undefined);
  });

  it('accepts only problems from this course, and reads links through this assignment', async () => {
    prismaMock.problem.findMany.mockResolvedValue([{ id: 'p1' }]);
    prismaMock.assignmentProblem.findMany.mockResolvedValue([]);
    prismaMock.assignmentProblem.createMany.mockResolvedValue({ count: 1 });

    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ problemIds: ['p1'] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });
    expect(res.status).toBe(200);

    expect(whereOf(prismaMock.problem.findMany)).toEqual({ id: { in: ['p1'] }, courseId: 'c1' });
    expect(whereOf(prismaMock.assignmentProblem.findMany)).toEqual({
      assignmentId: 'a1',
      assignment: { courseId: 'c1' },
    });
  });

  it('removes a link only for a problem in this course', async () => {
    prismaMock.problem.findFirst.mockResolvedValue({ id: 'p1' });
    prismaMock.assignmentProblem.deleteMany.mockResolvedValue({ count: 1 });

    const req = new Request('http://localhost/api/courses/c1/assignments/a1/problems', {
      method: 'DELETE',
      body: JSON.stringify({ problemId: 'p1' }),
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });
    expect(res.status).toBe(200);

    expect(whereOf(prismaMock.problem.findFirst)).toEqual({ id: 'p1', courseId: 'c1' });
  });
});
