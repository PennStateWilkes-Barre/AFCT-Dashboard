import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  submission: { findMany: vi.fn(), count: vi.fn() },
  assignmentProblemGrade: { findMany: vi.fn() },
  assignment: { findMany: vi.fn() },
  // Group overrides name a group; a submission names a student, so the members are read once
  // for the whole page rather than per row.
  groupMembership: { findMany: vi.fn() },
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

import { getAutograderSubmissionsPage } from './autograder-submissions';

const row = {
  id: 's1',
  studentId: 'u1',
  courseId: 'c1',
  assignmentId: 'a1',
  problemId: 'p1',
  correct: true,
  feedback: 'Looks good',
  submittedAt: new Date('2026-01-02T00:00:00.000Z'),
  status: 'COMPLETED',
  fileName: 'file.jff',
  originalFileName: 'orig.jff',
  student: { email: 'stu@example.com', firstName: 'Stu', lastName: 'Dent' },
  course: { name: 'Course 1' },
  assignmentProblem: {
    maxPoints: 10,
    assignment: { title: 'Assignment 1', dueDate: new Date('2026-01-01T00:00:00.000Z') },
    problem: { title: 'Problem 1', type: 'CFG' },
  },
};

/** The AND clauses the query was built from, for asserting on one at a time. */
const whereClauses = () => prismaMock.submission.findMany.mock.calls[0][0].where.AND;

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.submission.count.mockResolvedValue(0);
  prismaMock.submission.findMany.mockResolvedValue([]);
  prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);
  prismaMock.assignment.findMany.mockResolvedValue([]);
  prismaMock.groupMembership.findMany.mockResolvedValue([]);
});

describe('getAutograderSubmissionsPage', () => {
  // The page lists everything a student has handed in, so a hand-graded problem is included
  // and simply has no queue state to report.
  it('does not exclude problems whose autograder is switched off', async () => {
    await getAutograderSubmissionsPage({ skip: 0, take: 10 });

    expect(whereClauses()).not.toContainEqual({ assignmentProblem: { autograderEnabled: true } });
  });

  it('applies skip and take', async () => {
    await getAutograderSubmissionsPage({ skip: 40, take: 20 });

    expect(prismaMock.submission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 40, take: 20 }),
    );
  });

  it('counts with the same where clause as the rows', async () => {
    await getAutograderSubmissionsPage({ skip: 0, take: 10, courseIds: ['c1'] });

    expect(prismaMock.submission.count.mock.calls[0][0].where).toEqual(
      prismaMock.submission.findMany.mock.calls[0][0].where,
    );
  });

  describe('scope', () => {
    it('adds no scope clause when nothing is selected', async () => {
      await getAutograderSubmissionsPage({
        skip: 0,
        take: 10,
        courseIds: [],
        assignmentIds: [],
        problemIds: [],
      });

      expect(whereClauses()).toHaveLength(0);
    });

    it('prefers problems over assignments and courses', async () => {
      await getAutograderSubmissionsPage({
        skip: 0,
        take: 10,
        courseIds: ['c1'],
        assignmentIds: ['a1'],
        problemIds: ['p1'],
      });

      expect(whereClauses()).toContainEqual({ problemId: { in: ['p1'] } });
      expect(whereClauses()).not.toContainEqual({ assignmentId: { in: ['a1'] } });
      expect(whereClauses()).not.toContainEqual({ courseId: { in: ['c1'] } });
    });

    it('falls back to assignments, then courses', async () => {
      await getAutograderSubmissionsPage({
        skip: 0,
        take: 10,
        courseIds: ['c1'],
        assignmentIds: ['a1'],
      });
      expect(whereClauses()).toContainEqual({ assignmentId: { in: ['a1'] } });

      vi.clearAllMocks();
      prismaMock.submission.count.mockResolvedValue(0);
      prismaMock.submission.findMany.mockResolvedValue([]);

      await getAutograderSubmissionsPage({ skip: 0, take: 10, courseIds: ['c1'] });
      expect(whereClauses()).toContainEqual({ courseId: { in: ['c1'] } });
    });
  });

  describe('status filter', () => {
    it('maps the three queue states onto status', async () => {
      await getAutograderSubmissionsPage({ skip: 0, take: 10, status: ['pending', 'failed'] });

      expect(whereClauses()).toContainEqual({
        OR: [{ status: 'PENDING' }, { status: 'FAILED' }],
      });
    });

    it('splits COMPLETED on correct, counting a null result as incorrect', async () => {
      await getAutograderSubmissionsPage({ skip: 0, take: 10, status: ['correct', 'incorrect'] });

      expect(whereClauses()).toContainEqual({
        OR: [
          { status: 'COMPLETED', correct: true },
          { status: 'COMPLETED', OR: [{ correct: false }, { correct: null }] },
        ],
      });
    });

    it('adds no clause when every value is selected', async () => {
      await getAutograderSubmissionsPage({
        skip: 0,
        take: 10,
        status: ['pending', 'processing', 'failed', 'correct', 'incorrect'],
      });

      expect(whereClauses()).toHaveLength(0);
    });
  });

  describe('timing filter', () => {
    /**
     * The filter reads the assignments in scope twice: once for the ids, once with their
     * overrides. The second read is what carries the per-student dates.
     */
    const withAssignments = (
      rows: { id: string; dueDate: Date }[],
      overrides: Record<string, unknown>[] = [],
    ) => {
      prismaMock.assignment.findMany
        .mockResolvedValueOnce(rows.map((r) => ({ id: r.id })))
        .mockResolvedValueOnce(
          rows.map((r) => ({
            id: r.id,
            dueDate: r.dueDate,
            unlockAt: null,
            allowLateSubmissions: false,
            lateCutoff: null,
            overrides: overrides.filter((o) => o.assignmentId === r.id),
          })),
        );
    };

    it('emits one clause per assignment for Late', async () => {
      const due = new Date('2026-01-01T00:00:00.000Z');
      withAssignments([
        { id: 'a1', dueDate: due },
        { id: 'a2', dueDate: due },
      ]);

      await getAutograderSubmissionsPage({ skip: 0, take: 10, timing: ['late'] });

      expect(whereClauses()).toContainEqual({
        OR: [
          { assignmentId: 'a1', submittedAt: { gt: due } },
          { assignmentId: 'a2', submittedAt: { gt: due } },
        ],
      });
    });

    /**
     * A student with an extension is judged against their own date. Showing them as late for
     * submitting inside an extension the instructor gave them is a report of something that
     * did not happen, and the filter has to agree with the chip.
     */
    it('judges a student with an extension against their own date', async () => {
      const base = new Date('2026-01-01T00:00:00.000Z');
      const extended = new Date('2026-01-02T23:59:00.000Z');
      withAssignments(
        [{ id: 'a1', dueDate: base }],
        [
          {
            assignmentId: 'a1',
            targetType: 'STUDENT',
            userId: 's1',
            groupId: null,
            unlockAt: null,
            dueDate: extended,
            lateCutoff: null,
            allowLateSubmissions: null,
          },
        ],
      );

      await getAutograderSubmissionsPage({ skip: 0, take: 10, timing: ['late'] });

      expect(whereClauses()).toContainEqual({
        OR: [
          // Everybody else against the assignment's own date...
          { assignmentId: 'a1', studentId: { notIn: ['s1'] }, submittedAt: { gt: base } },
          // ...and the student with the extension against theirs.
          { assignmentId: 'a1', studentId: 's1', submittedAt: { gt: extended } },
        ],
      });
    });

    it('expands a group extension to the group members', async () => {
      const base = new Date('2026-01-01T00:00:00.000Z');
      const extended = new Date('2026-01-03T23:59:00.000Z');
      withAssignments(
        [{ id: 'a1', dueDate: base }],
        [
          {
            assignmentId: 'a1',
            targetType: 'GROUP',
            userId: null,
            groupId: 'g1',
            unlockAt: null,
            dueDate: extended,
            lateCutoff: null,
            allowLateSubmissions: null,
          },
        ],
      );
      prismaMock.groupMembership.findMany.mockResolvedValue([
        { groupId: 'g1', userId: 's1' },
        { groupId: 'g1', userId: 's2' },
      ]);

      await getAutograderSubmissionsPage({ skip: 0, take: 10, timing: ['ontime'] });

      // A submission names a student and an override names a group, so the members are what
      // the clause can be written against.
      expect(whereClauses()).toContainEqual({
        OR: [
          { assignmentId: 'a1', studentId: { notIn: ['s1', 's2'] }, submittedAt: { lte: base } },
          { assignmentId: 'a1', studentId: 's1', submittedAt: { lte: extended } },
          { assignmentId: 'a1', studentId: 's2', submittedAt: { lte: extended } },
        ],
      });
    });

    it('compares the other way for On time', async () => {
      const due = new Date('2026-01-01T00:00:00.000Z');
      withAssignments([{ id: 'a1', dueDate: due }]);

      await getAutograderSubmissionsPage({ skip: 0, take: 10, timing: ['ontime'] });

      expect(whereClauses()).toContainEqual({
        OR: [{ assignmentId: 'a1', submittedAt: { lte: due } }],
      });
    });

    it('does not query assignments when both values are selected', async () => {
      await getAutograderSubmissionsPage({ skip: 0, take: 10, timing: ['ontime', 'late'] });

      expect(prismaMock.assignment.findMany).not.toHaveBeenCalled();
      expect(whereClauses()).toHaveLength(0);
    });

    it('scopes the assignment lookup the same way as the rows', async () => {
      await getAutograderSubmissionsPage({
        skip: 0,
        take: 10,
        problemIds: ['p1'],
        timing: ['late'],
      });

      expect(prismaMock.assignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { problems: { some: { problemId: { in: ['p1'] } } } },
        }),
      );
    });
  });

  describe('search', () => {
    it('spans every field when the scope is all', async () => {
      await getAutograderSubmissionsPage({ skip: 0, take: 10, q: 'dent', field: 'all' });

      const or = whereClauses().find((c: { OR?: unknown[] }) => c.OR)?.OR;
      expect(or).toHaveLength(8);
    });

    it('narrows to one relation when a scope is picked', async () => {
      await getAutograderSubmissionsPage({ skip: 0, take: 10, q: 'dent', field: 'course' });

      expect(whereClauses()).toContainEqual({
        OR: [{ course: { name: { contains: 'dent', mode: 'insensitive' } } }],
      });
    });
  });

  describe('sorting', () => {
    it('defaults to newest first with a stable tiebreaker', async () => {
      await getAutograderSubmissionsPage({ skip: 0, take: 10 });

      expect(prismaMock.submission.findMany.mock.calls[0][0].orderBy).toEqual([
        { submittedAt: 'desc' },
        { id: 'asc' },
      ]);
    });

    it('falls back to the default for a column that is not sortable', async () => {
      await getAutograderSubmissionsPage({ skip: 0, take: 10, sortBy: 'timing', sortDir: 'asc' });

      expect(prismaMock.submission.findMany.mock.calls[0][0].orderBy).toEqual([
        { submittedAt: 'asc' },
        { id: 'asc' },
      ]);
    });

    it('sorts a student by surname then forename', async () => {
      await getAutograderSubmissionsPage({ skip: 0, take: 10, sortBy: 'student', sortDir: 'asc' });

      expect(prismaMock.submission.findMany.mock.calls[0][0].orderBy).toEqual([
        { student: { lastName: 'asc' } },
        { student: { firstName: 'asc' } },
        { id: 'asc' },
      ]);
    });

    it('sorts through a relation for assignment titles', async () => {
      await getAutograderSubmissionsPage({
        skip: 0,
        take: 10,
        sortBy: 'assignment',
        sortDir: 'desc',
      });

      expect(prismaMock.submission.findMany.mock.calls[0][0].orderBy).toEqual([
        { assignmentProblem: { assignment: { title: 'desc' } } },
        { id: 'asc' },
      ]);
    });
  });

  describe('rows', () => {
    it('flattens a row and joins its recorded grade', async () => {
      prismaMock.submission.count.mockResolvedValue(1);
      prismaMock.submission.findMany.mockResolvedValue([row]);
      prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([
        { studentId: 'u1', assignmentId: 'a1', problemId: 'p1', grade: 8 },
      ]);

      const { rows, total } = await getAutograderSubmissionsPage({ skip: 0, take: 10 });

      expect(total).toBe(1);
      expect(rows[0]).toMatchObject({
        id: 's1',
        studentFirstName: 'Stu',
        studentLastName: 'Dent',
        studentEmail: 'stu@example.com',
        courseName: 'Course 1',
        assignmentTitle: 'Assignment 1',
        problemTitle: 'Problem 1',
        dueDate: '2026-01-01T00:00:00.000Z',
        problemType: 'CFG',
        submittedAt: '2026-01-02T00:00:00.000Z',
        grade: 8,
        maxPoints: 10,
      });
    });

    it('defaults the recorded grade to null when there is no grade row', async () => {
      prismaMock.submission.findMany.mockResolvedValue([row]);

      const { rows } = await getAutograderSubmissionsPage({ skip: 0, take: 10 });

      expect(rows[0].grade).toBeNull();
    });

    it('matches grades on exact triples rather than crossing three id lists', async () => {
      prismaMock.submission.findMany.mockResolvedValue([row]);

      await getAutograderSubmissionsPage({ skip: 0, take: 10 });

      expect(prismaMock.assignmentProblemGrade.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { OR: [{ studentId: 'u1', assignmentId: 'a1', problemId: 'p1' }] },
        }),
      );
    });

    it('skips the grade query entirely for an empty page', async () => {
      await getAutograderSubmissionsPage({ skip: 0, take: 10 });

      expect(prismaMock.assignmentProblemGrade.findMany).not.toHaveBeenCalled();
    });
  });
});

/**
 * What the row carries as its due date.
 *
 * The client draws the Late / On time chip from this field, so the student's own date has to be
 * the one that travels: an extension the instructor gave has to show as on time here, or the
 * page reports something that did not happen.
 */
describe('the due date on a row', () => {
  const submissionRow = (over: Record<string, unknown> = {}) => ({ ...row, ...over });

  const pageWith = (
    rows: Record<string, unknown>[],
    assignment: Record<string, unknown>,
    memberships: { groupId: string; userId: string }[] = [],
  ) => {
    prismaMock.submission.findMany.mockResolvedValue(rows);
    prismaMock.submission.count.mockResolvedValue(rows.length);
    prismaMock.assignment.findMany.mockResolvedValue([assignment]);
    prismaMock.groupMembership.findMany.mockResolvedValue(memberships);
  };

  const baseAssignment = (overrides: Record<string, unknown>[] = []) => ({
    id: 'a1',
    dueDate: new Date('2026-01-01T23:59:00.000Z'),
    unlockAt: null,
    allowLateSubmissions: false,
    lateCutoff: null,
    overrides,
  });

  it('is the assignment date when the student has no override', async () => {
    pageWith([submissionRow()], baseAssignment());

    const { rows } = await getAutograderSubmissionsPage({ skip: 0, take: 10 });

    expect(rows[0]?.dueDate).toBe('2026-01-01T23:59:00.000Z');
  });

  it("is the student's own date when they have an extension", async () => {
    pageWith(
      [submissionRow({ studentId: 's1' })],
      baseAssignment([
        {
          targetType: 'STUDENT',
          userId: 's1',
          groupId: null,
          unlockAt: null,
          dueDate: new Date('2026-01-02T23:59:00.000Z'),
          lateCutoff: null,
          allowLateSubmissions: null,
        },
      ]),
    );

    const { rows } = await getAutograderSubmissionsPage({ skip: 0, take: 10 });

    expect(rows[0]?.dueDate).toBe('2026-01-02T23:59:00.000Z');
  });

  it('is the group date for a member of a group with an extension', async () => {
    pageWith(
      [submissionRow({ studentId: 's2' })],
      baseAssignment([
        {
          targetType: 'GROUP',
          userId: null,
          groupId: 'g1',
          unlockAt: null,
          dueDate: new Date('2026-01-03T23:59:00.000Z'),
          lateCutoff: null,
          allowLateSubmissions: null,
        },
      ]),
      [{ groupId: 'g1', userId: 's2' }],
    );

    const { rows } = await getAutograderSubmissionsPage({ skip: 0, take: 10 });

    expect(rows[0]?.dueDate).toBe('2026-01-03T23:59:00.000Z');
  });

  it('leaves a student outside the group on the assignment date', async () => {
    pageWith(
      [submissionRow({ studentId: 'somebody-else' })],
      baseAssignment([
        {
          targetType: 'GROUP',
          userId: null,
          groupId: 'g1',
          unlockAt: null,
          dueDate: new Date('2026-01-03T23:59:00.000Z'),
          lateCutoff: null,
          allowLateSubmissions: null,
        },
      ]),
      [{ groupId: 'g1', userId: 's2' }],
    );

    const { rows } = await getAutograderSubmissionsPage({ skip: 0, take: 10 });

    expect(rows[0]?.dueDate).toBe('2026-01-01T23:59:00.000Z');
  });
});

/**
 * Which memberships the group-extension lookup reads.
 *
 * A GROUP override names a group; a submission names a student, so the members are read once
 * and matched up. That read is bounded by the groups the overrides on this page actually
 * mention. The prisma mock returns its fixture whatever the `where` says, so without the
 * `groupId` it reads every membership row in the installation to answer a question about one
 * page of submissions.
 */
describe('which memberships the group extension reads', () => {
  it('asks only about the groups named by these overrides', async () => {
    prismaMock.submission.findMany.mockResolvedValue([{ ...row, studentId: 's1' }]);
    prismaMock.submission.count.mockResolvedValue(1);
    prismaMock.assignment.findMany.mockResolvedValue([
      {
        id: 'a1',
        dueDate: new Date('2026-01-01T23:59:00.000Z'),
        unlockAt: null,
        allowLateSubmissions: false,
        lateCutoff: null,
        overrides: [
          {
            targetType: 'GROUP',
            userId: null,
            groupId: 'g1',
            unlockAt: null,
            dueDate: new Date('2026-01-05T23:59:00.000Z'),
            lateCutoff: null,
            allowLateSubmissions: null,
          },
        ],
      },
    ]);
    prismaMock.groupMembership.findMany.mockResolvedValue([{ groupId: 'g1', userId: 's1' }]);

    const { rows } = await getAutograderSubmissionsPage({ skip: 0, take: 10 });

    expect(prismaMock.groupMembership.findMany.mock.calls[0][0]).toMatchObject({
      where: { groupId: { in: ['g1'] } },
    });
    // And the extension actually reached the member, which is why the read exists.
    expect(rows[0]?.dueDate).toBe('2026-01-05T23:59:00.000Z');
  });
});
