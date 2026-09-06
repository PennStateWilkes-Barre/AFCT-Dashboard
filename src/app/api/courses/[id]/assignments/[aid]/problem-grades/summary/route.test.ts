import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  roster: { findFirst: vi.fn() },
  assignment: { findFirst: vi.fn() },
  assignmentProblem: { count: vi.fn() },
  assignmentProblemGrade: { groupBy: vi.fn() },
}));

const authMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));

import { GET } from './route';

const defaultParams = { id: 'course-1', aid: 'assignment-1' };

describe('GET /api/courses/[id]/[aid]/problem-grades/summary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    authMock.mockResolvedValue({ user: { id: 'staff-1', role: 'FACULTY' } });
    prismaMock.assignment.findFirst.mockResolvedValue({ id: defaultParams.aid });
    prismaMock.assignmentProblem.count.mockResolvedValue(2);
    prismaMock.assignmentProblemGrade.groupBy.mockResolvedValue([]);
  });

  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);

    const res = await GET(new Request('http://localhost'), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(401);
  });

  it('returns 403 when user is not staff', async () => {
    authMock.mockResolvedValue({ user: { id: 'student-1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue(null);

    const res = await GET(new Request('http://localhost'), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(403);
    expect(prismaMock.assignment.findFirst).not.toHaveBeenCalled();
  });

  it('returns 404 when assignment is missing', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(null);

    const res = await GET(new Request('http://localhost'), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(404);
  });

  it('returns empty payload when no problems exist', async () => {
    prismaMock.assignmentProblem.count.mockResolvedValue(0);

    const res = await GET(new Request('http://localhost'), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({});
    expect(prismaMock.assignmentProblemGrade.groupBy).not.toHaveBeenCalled();
  });

  it("reports each student's completion and what they have earned", async () => {
    prismaMock.assignmentProblem.count.mockResolvedValue(3);
    prismaMock.assignmentProblemGrade.groupBy.mockResolvedValue([
      { studentId: 's1', _count: { grade: 3 }, _sum: { grade: 30 } },
      { studentId: 's2', _count: { grade: 2 }, _sum: { grade: 12 } },
    ]);

    const res = await GET(new Request('http://localhost'), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      s1: { graded: true, earned: 30 },
      s2: { graded: false, earned: 12 },
    });
  });

  it('returns 500 when the summary query throws', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.assignmentProblemGrade.groupBy.mockRejectedValueOnce(new Error('db down'));

    const res = await GET(new Request('http://localhost'), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(500);
    consoleSpy.mockRestore();
  });
});

/**
 * What this summary counts.
 *
 * The assignment comes from the path, so it has to be looked up inside the course the caller
 * was proven staff of, and the two counts have to be bounded by that assignment. The prisma
 * mock answers from its fixture whatever the `where` says: without the `courseId` an
 * assignment id from another course resolves, and without the `assignmentId` the grade
 * grouping is every grade in the installation, so the picker would show every student as
 * graded.
 */
describe('what the grade summary is scoped to', () => {
  const whereOf = (fn: { mock: { calls: unknown[][] } }) =>
    (fn.mock.calls[0][0] as { where: unknown }).where;

  it('counts problems and grades for this assignment, in this course', async () => {
    vi.clearAllMocks();
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    authMock.mockResolvedValue({ user: { id: 'staff-1', role: 'FACULTY' } });
    prismaMock.assignment.findFirst.mockResolvedValue({ id: 'assignment-1' });
    prismaMock.assignmentProblem.count.mockResolvedValue(2);
    prismaMock.assignmentProblemGrade.groupBy.mockResolvedValue([]);

    const res = await GET(new Request('http://localhost'), {
      params: Promise.resolve(defaultParams),
    });
    expect(res.status).toBe(200);

    expect(whereOf(prismaMock.assignment.findFirst)).toEqual({
      id: 'assignment-1',
      courseId: 'course-1',
    });
    expect(whereOf(prismaMock.assignmentProblem.count)).toEqual({
      assignmentId: 'assignment-1',
    });
    expect(whereOf(prismaMock.assignmentProblemGrade.groupBy)).toEqual({
      assignmentId: 'assignment-1',
    });
  });
});
