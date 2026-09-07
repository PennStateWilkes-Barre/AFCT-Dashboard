import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const prismaMock = vi.hoisted(() => ({
  assignmentProblem: { findUnique: vi.fn() },
  studentGroup: { findFirst: vi.fn() },
  assignmentProblemGrade: { findMany: vi.fn(), upsert: vi.fn() },
  roster: { findFirst: vi.fn() },
  course: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));

const authMock = vi.hoisted(() => vi.fn());
const activityLogMock = vi.hoisted(() => vi.fn());
const canManageCourseMock = vi.hoisted(() => vi.fn());
const canAccessCourseMock = vi.hoisted(() => vi.fn());
const lockGroupSetMock = vi.hoisted(() => vi.fn());

/** Flipped by the archived-course test; every other test runs against a live course. */
const archivedMock = vi.hoisted(() => ({ current: false }));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/activity-log-utils', () => ({ createEnhancedActivityLog: activityLogMock }));
vi.mock('@/lib/permissions', () => ({
  canManageCourse: canManageCourseMock,
  canAccessCourse: canAccessCourseMock,
  isCourseArchived: async () => archivedMock.current,
}));
vi.mock('@/lib/group-set-service', () => ({ lockGroupSetIfUsed: lockGroupSetMock }));

import { POST } from './route';

const params = { id: 'c1', aid: 'a1', pid: 'p1', groupId: 'g1' };

const post = (body: Record<string, unknown>) =>
  POST(
    new NextRequest('http://localhost/group-grade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve(params) },
  );

const tx = {
  assignmentProblemGrade: { upsert: vi.fn() },
};

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: 'fac1', isAdmin: true } });
  canManageCourseMock.mockResolvedValue(true);
  canAccessCourseMock.mockResolvedValue(true);
  prismaMock.assignmentProblem.findUnique.mockResolvedValue({
    assignment: { courseId: 'c1', groupSetId: 'gs1' },
    maxPoints: 10,
  });
  prismaMock.studentGroup.findFirst.mockResolvedValue({
    id: 'g1',
    name: 'Group 3',
    memberships: [
      { roster: { userId: 's1' } },
      { roster: { userId: 's2' } },
      { roster: { userId: 's3' } },
    ],
  });
  prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);
  tx.assignmentProblemGrade.upsert.mockResolvedValue({});
  prismaMock.$transaction.mockImplementation(async (cb: (c: typeof tx) => unknown) => cb(tx));
});

describe('POST group-grade', () => {
  // The whole point: one action, one grade on every member's own row, so the gradebook and
  // exports keep working without knowing groups exist.
  it('writes a grade row for every member', async () => {
    const res = await post({ grade: 8 });

    expect(res.status).toBe(200);
    expect(tx.assignmentProblemGrade.upsert).toHaveBeenCalledTimes(3);
    const graded = tx.assignmentProblemGrade.upsert.mock.calls.map(
      (c) => c[0].where.assignmentId_problemId_studentId.studentId,
    );
    expect(graded.sort()).toEqual(['s1', 's2', 's3']);
  });

  // Without the provenance a later change to one member is indistinguishable from a group
  // that was never graded together.
  it('stamps each row with the group and the value applied', async () => {
    await post({ grade: 8 });

    const first = tx.assignmentProblemGrade.upsert.mock.calls[0][0];
    expect(first.create).toMatchObject({ groupGradeGroupId: 'g1', groupGradeValue: 8 });
    expect(first.update).toMatchObject({ groupGradeGroupId: 'g1', groupGradeValue: 8 });
  });

  /**
   * A group grade is a person's decision for every member, and it stays one even after a
   * member is released back to the autograder. Without the source recorded here, releasing
   * one member told them the autograder had chosen their mark.
   */
  it('records that a person set every one of those grades', async () => {
    await post({ grade: 8 });

    for (const [args] of tx.assignmentProblemGrade.upsert.mock.calls) {
      expect(args.create).toMatchObject({ gradeSource: 'MANUAL', gradedManually: true });
      expect(args.update).toMatchObject({ gradeSource: 'MANUAL', gradedManually: true });
    }
  });

  it('locks the group set, so membership cannot move under a grade', async () => {
    await post({ grade: 8 });

    expect(lockGroupSetMock).toHaveBeenCalledWith(tx, 'gs1');
  });

  describe('members who already differ', () => {
    beforeEach(() => {
      prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([
        { studentId: 's2', grade: 5, student: { firstName: 'Grace', lastName: 'Hopper' } },
      ]);
    });

    // A deliberate individual adjustment must not be erased by a routine group grade.
    it('reports them and writes nothing', async () => {
      const res = await post({ grade: 8 });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.conflicts).toEqual([{ studentId: 's2', name: 'Grace Hopper', grade: 5 }]);
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('applies once the grader confirms', async () => {
      const res = await post({ grade: 8, overwrite: true });

      expect(res.status).toBe(200);
      expect(tx.assignmentProblemGrade.upsert).toHaveBeenCalledTimes(3);
    });

    it('records whose grade was overwritten', async () => {
      await post({ grade: 8, overwrite: true });

      expect(activityLogMock).toHaveBeenCalledWith(
        prismaMock,
        expect.anything(),
        expect.objectContaining({
          action: 'GROUP_PROBLEM_GRADE_UPDATED',
          metadata: expect.objectContaining({ overwroteDiffering: ['s2'] }),
        }),
      );
    });

    // Members already carrying the same grade are not a conflict; re-applying is a no-op
    // from the grader's point of view and must not demand a confirmation.
    it('does not treat a matching grade as a conflict', async () => {
      prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([
        { studentId: 's2', grade: 8, student: { firstName: 'Grace', lastName: 'Hopper' } },
      ]);

      const res = await post({ grade: 8 });

      expect(res.status).toBe(200);
    });
  });

  it('rejects a grade above the problem maximum', async () => {
    const res = await post({ grade: 11 });

    expect(res.status).toBe(400);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a negative grade', async () => {
    const res = await post({ grade: -1 });

    expect(res.status).toBe(400);
  });

  it('refuses a group that is not in this assignment set', async () => {
    prismaMock.studentGroup.findFirst.mockResolvedValue(null);

    const res = await post({ grade: 8 });

    expect(res.status).toBe(404);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('refuses an individual assignment', async () => {
    prismaMock.assignmentProblem.findUnique.mockResolvedValue({
      assignment: { courseId: 'c1', groupSetId: null },
      maxPoints: 10,
    });

    const res = await post({ grade: 8 });

    expect(res.status).toBe(400);
  });

  it('refuses a group with nobody in it', async () => {
    prismaMock.studentGroup.findFirst.mockResolvedValue({
      id: 'g1',
      name: 'Empty',
      memberships: [],
    });

    const res = await post({ grade: 8 });

    expect(res.status).toBe(404);
  });

  it('refuses a problem from another course', async () => {
    prismaMock.assignmentProblem.findUnique.mockResolvedValue({
      assignment: { courseId: 'other', groupSetId: 'gs1' },
      maxPoints: 10,
    });

    const res = await post({ grade: 8 });

    expect(res.status).toBe(404);
  });
});

/**
 * An archived course is read-only, and this writes a grade for every member of the group.
 */
it('refuses to grade a group when the course is archived', async () => {
  authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
  canManageCourseMock.mockResolvedValue(true);
  archivedMock.current = true;

  const res = await post({ grade: 10 });

  expect(res.status).toBe(409);
  archivedMock.current = false;
});

/**
 * Whose rows a group grade can reach.
 *
 * The group id comes from the path, so the only thing tying it to this assignment is the
 * `groupSetId` on the lookup, and the only thing tying the "already graded differently"
 * warning to this piece of work is the assignment and problem on that read. The prisma mock
 * answers from its fixture whatever the `where` says: without the `groupSetId` a group from
 * an unrelated set is graded, and without the `assignmentId` or `problemId` the warning is
 * computed from those students' grades on completely different work, so a real clash would
 * be missed and a false one reported.
 */
describe('whose rows a group grade can reach', () => {
  const whereOf = (fn: { mock: { calls: unknown[][] } }) =>
    (fn.mock.calls[0][0] as { where: unknown }).where;

  it('takes the group from this assignment’s set, and reads existing grades for this problem only', async () => {
    const res = await post({ grade: 8 });
    expect(res.status).toBe(200);

    expect(whereOf(prismaMock.studentGroup.findFirst)).toEqual({
      id: 'g1',
      groupSetId: 'gs1',
    });
    expect(whereOf(prismaMock.assignmentProblemGrade.findMany)).toEqual({
      assignmentId: 'a1',
      problemId: 'p1',
      studentId: { in: ['s1', 's2', 's3'] },
    });
  });
});
