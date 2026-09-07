import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  roster: { findUnique: vi.fn(), findFirst: vi.fn() },
  assignment: { findMany: vi.fn() },
  assignmentProblem: { findMany: vi.fn() },
  assignmentProblemGrade: { findMany: vi.fn() },
  submission: { groupBy: vi.fn(), findMany: vi.fn() },
  submissionGrant: { findMany: vi.fn() },
  groupMembership: { findMany: vi.fn() },
}));

const authMock = vi.hoisted(() => vi.fn());
const throttledViewMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/api/activity', () => ({
  logThrottledView: throttledViewMock,
  VIEW_THROTTLE_MS: 600_000,
}));

import { GET } from './route';

const makeRequest = () => new Request('http://localhost/api/courses/c1/student-grades');
const params = (id = 'c1') => ({ params: Promise.resolve({ id }) });

const seedGradeData = () => {
  prismaMock.assignment.findMany.mockResolvedValue([
    {
      id: 'a1',
      title: 'Assignment 1',
      description: 'Desc',
      dueDate: new Date('2025-01-01T00:00:00.000Z'),
    },
  ]);
  prismaMock.assignmentProblem.findMany.mockResolvedValue([
    {
      assignmentId: 'a1',
      maxPoints: 10,
      maxSubmissions: 3,
      problem: { id: 'p1', title: 'Problem 1', autograderEnabled: true },
    },
  ]);
  prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([
    { assignmentId: 'a1', problemId: 'p1', grade: 7 },
  ]);
  prismaMock.submission.groupBy.mockResolvedValue([
    { assignmentId: 'a1', problemId: 'p1', _count: { id: 2 } },
  ]);
  prismaMock.submission.findMany.mockResolvedValue([
    { assignmentId: 'a1', problemId: 'p1', status: 'GRADED' },
  ]);
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.roster.findFirst.mockResolvedValue(null);
  prismaMock.submissionGrant.findMany.mockResolvedValue([]);
  prismaMock.groupMembership.findMany.mockResolvedValue([]);
});

describe('GET /api/courses/[id]/student-grades', () => {
  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);

    const res = await GET(makeRequest(), params());

    expect(res.status).toBe(401);
  });

  it('returns 400 when the course id is missing', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });

    const res = await GET(makeRequest(), params(''));

    expect(res.status).toBe(400);
  });

  it('returns 403 when the user is neither enrolled nor staff', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    prismaMock.roster.findUnique.mockResolvedValue(null);

    const res = await GET(makeRequest(), params());

    expect(res.status).toBe(403);
  });

  it('applies default values when a problem has no submissions or grades', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    prismaMock.roster.findUnique.mockResolvedValue({ id: 'r1' });
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'STUDENT',
      course: { isPublished: true },
    });
    prismaMock.assignment.findMany.mockResolvedValue([
      { id: 'a1', title: 'Assignment 1', description: null, dueDate: null },
    ]);
    prismaMock.assignmentProblem.findMany.mockResolvedValue([
      {
        assignmentId: 'a1',
        maxPoints: 10,
        maxSubmissions: 3,
        problem: { id: 'p1', title: 'Problem 1', autograderEnabled: false },
      },
    ]);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);
    prismaMock.submission.groupBy.mockResolvedValue([]);
    prismaMock.submission.findMany.mockResolvedValue([]);

    const res = await GET(makeRequest(), params());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assignments[0]).toMatchObject({ dueDate: null, grade: null });
    expect(body.assignments[0].problems[0]).toMatchObject({
      status: '',
      submissionCount: 0,
      grade: null,
    });
  });

  it('returns assignment grade payload for an enrolled student', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    prismaMock.roster.findUnique.mockResolvedValue({ id: 'r1' });
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'STUDENT',
      course: { isPublished: true },
    });
    seedGradeData();

    const res = await GET(makeRequest(), params());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assignments).toHaveLength(1);
    expect(body.assignments[0]).toMatchObject({
      id: 'a1',
      title: 'Assignment 1',
      maxPoints: 10,
      grade: 7,
    });
    expect(body.assignments[0].problems[0]).toMatchObject({
      id: 'p1',
      status: 'GRADED',
      submissionCount: 2,
      grade: 7,
      maxPoints: 10,
      maxSubmissions: 3,
    });
  });

  /**
   * That they checked their grades. The read is their own record, so it is not a disclosure
   * and was never logged; RQ1 and RQ2 ask what students do with feedback, and whether they
   * looked is part of that.
   */
  it('records that the student looked at their grades', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    prismaMock.roster.findUnique.mockResolvedValue({ id: 'r1' });
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'STUDENT',
      course: { isPublished: true },
    });
    seedGradeData();

    await GET(makeRequest(), params());

    expect(throttledViewMock).toHaveBeenCalledTimes(1);
    const entry = throttledViewMock.mock.calls[0][1];
    expect(entry).toMatchObject({
      userId: 'u1',
      action: 'STUDENT_GRADES_VIEWED',
      category: 'GRADE',
      courseId: 'c1',
      // Per course: without a key, two courses would share one throttle window and the
      // second would go unrecorded.
      key: 'c1',
    });
    // How much of it was marked, which separates checking a page full of grades from
    // checking one that has nothing on it yet.
    expect(entry.metadata).toMatchObject({ assignmentCount: 1, gradedCount: 1 });
  });

  it('allows staff to view grades without course membership', async () => {
    authMock.mockResolvedValue({ user: { id: 'staff-1', role: 'FACULTY', isAdmin: true } });
    prismaMock.roster.findUnique.mockResolvedValue(null);
    prismaMock.roster.findFirst.mockResolvedValue(null);
    seedGradeData();

    const res = await GET(makeRequest(), params());

    expect(res.status).toBe(200);
  });

  it('handles null grades, null problem points, extra problems, and problem-less assignments', async () => {
    // Branch 100: `grade.grade ?? null` for a null grade row.
    // Branch 125: second problem in the same assignment (acc[assignmentId] exists).
    // Branches 130-131: `Number(maxPoints ?? 0)` / `Number(maxSubmissions ?? 0)` for nulls.
    // Branch 137: `groupedProblems[assignment.id] ?? []` for an assignment with no problems.
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    prismaMock.roster.findUnique.mockResolvedValue({ id: 'r1' });
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'STUDENT',
      course: { isPublished: true },
    });
    prismaMock.assignment.findMany.mockResolvedValue([
      { id: 'a1', title: 'A1', description: null, dueDate: new Date('2025-01-01T00:00:00.000Z') },
      { id: 'a2', title: 'A2 (no problems)', description: null, dueDate: null },
    ]);
    prismaMock.assignmentProblem.findMany.mockResolvedValue([
      {
        assignmentId: 'a1',
        maxPoints: null,
        maxSubmissions: null,
        problem: { id: 'p1', title: 'P1', autograderEnabled: false },
      },
      {
        assignmentId: 'a1',
        maxPoints: 4,
        maxSubmissions: 2,
        problem: { id: 'p2', title: 'P2', autograderEnabled: true },
      },
    ]);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([
      { assignmentId: 'a1', problemId: 'p1', grade: null },
    ]);
    prismaMock.submission.groupBy.mockResolvedValue([]);
    prismaMock.submission.findMany.mockResolvedValue([]);

    const res = await GET(makeRequest(), params());

    expect(res.status).toBe(200);
    const body = await res.json();
    // a1 has two problems; null maxPoints/maxSubmissions coerced to 0.
    expect(body.assignments[0].problems).toHaveLength(2);
    expect(body.assignments[0].problems[0]).toMatchObject({
      id: 'p1',
      maxPoints: 0,
      maxSubmissions: 0,
      grade: null,
    });
    expect(body.assignments[0].maxPoints).toBe(4);
    // a2 has no problems.
    expect(body.assignments[1].problems).toEqual([]);
    expect(body.assignments[1].grade).toBeNull();
  });

  it('returns 500 when the query fails', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN', isAdmin: true } });
    prismaMock.roster.findUnique.mockResolvedValue({ id: 'r1' });
    prismaMock.assignment.findMany.mockRejectedValue(new Error('db down'));

    const res = await GET(makeRequest(), params());

    expect(res.status).toBe(500);
  });

  it('returns 500 with dev detail from a non-Error thrown value', async () => {
    // Branch 169: `error instanceof Error ? error.message : String(error)`.
    // Branch 173: NODE_ENV === 'development' includes the detail.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('NODE_ENV', 'development');
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN', isAdmin: true } });
    prismaMock.roster.findUnique.mockResolvedValue({ id: 'r1' });
    prismaMock.assignment.findMany.mockRejectedValue('kaboom');

    const res = await GET(makeRequest(), params());

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.detail).toBe('kaboom');

    consoleSpy.mockRestore();
  });
});
