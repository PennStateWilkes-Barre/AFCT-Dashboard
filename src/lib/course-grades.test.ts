import { describe, it, expect, beforeEach, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  roster: { findMany: vi.fn(), count: vi.fn() },
  user: { findMany: vi.fn() },
  assignment: { findMany: vi.fn() },
  groupMembership: { findMany: vi.fn() },
  assignmentProblemGrade: { groupBy: vi.fn(), findMany: vi.fn() },
  submission: { findMany: vi.fn() },
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

import {
  getCourseGradeMatrix,
  getCourseGradeColumns,
  getCourseGradePage,
  getCourseGradeStructure,
  getCourseGradeValues,
} from './course-grades';

beforeEach(() => {
  vi.clearAllMocks();
  // Enrolled and working accounts, spelled out. A roster row without `status` resolves as
  // inactive, and missing-work exempts an inactive student ('not-active') before it looks at
  // anything else, so a bare `{ userId }` default silently makes every missing-work assertion
  // in this file pass whatever the rule does. Nothing here depended on that, but a test added
  // later would have, and one did while this was being written.
  prismaMock.roster.findMany.mockResolvedValue([
    { userId: 's1', status: 'ENROLLED', user: { inactive: false } },
    { userId: 's2', status: 'ENROLLED', user: { inactive: false } },
  ]);
  // The missing-work rule reads per-problem grades and submissions. Empty by default, so the
  // tests that are not about it keep asserting what they always did.
  prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);
  prismaMock.submission.findMany.mockResolvedValue([]);
  prismaMock.user.findMany.mockResolvedValue([
    {
      id: 's1',
      firstName: 'Ada',
      lastName: 'L',
      email: 'a@x.io',
      avatar: null,
      cropX: null,
      cropY: null,
      zoom: null,
    },
    {
      id: 's2',
      firstName: 'Alan',
      lastName: 'T',
      email: 't@x.io',
      avatar: null,
      cropX: null,
      cropY: null,
      zoom: null,
    },
  ]);
  prismaMock.groupMembership.findMany.mockResolvedValue([]);
  prismaMock.assignmentProblemGrade.groupBy.mockResolvedValue([]);
});

describe('getCourseGradeMatrix: assigned map', () => {
  it('marks students assigned via everyone, individual override, and group override', async () => {
    prismaMock.assignment.findMany.mockResolvedValue([
      // Assigned to everyone: both students assigned.
      {
        id: 'a1',
        title: 'A1',
        dueDate: null,
        isPublished: true,
        assignedToEveryone: true,
        problems: [],
        assignees: [],
      },
      // Not everyone, individual assignee for s1 only.
      {
        id: 'a2',
        title: 'A2',
        dueDate: null,
        isPublished: true,
        assignedToEveryone: false,
        problems: [],
        assignees: [{ userId: 's1', groupId: null }],
      },
      // Not everyone, group assignee on g1 (s2 is a member). A group assignee row only
      // exists on a group assignment, and the assignees route refuses a group that is not in
      // this assignment's own set, so the fixture carries the set the way real data does.
      {
        id: 'a3',
        title: 'A3',
        dueDate: null,
        isPublished: true,
        assignedToEveryone: false,
        groupSetId: 'gs1',
        problems: [],
        assignees: [{ userId: null, groupId: 'g1' }],
      },
    ]);
    prismaMock.groupMembership.findMany.mockResolvedValue([
      { groupSetId: 'gs1', userId: 's2', groupId: 'g1' },
    ]);

    const matrix = await getCourseGradeMatrix('c1');

    // Everyone -> both assigned.
    expect(matrix.assigned.s1.a1).toBe(true);
    expect(matrix.assigned.s2.a1).toBe(true);
    // Individual override for s1 only.
    expect(matrix.assigned.s1.a2).toBe(true);
    expect(matrix.assigned.s2.a2).toBe(false);
    // Group override: only the group member (s2) is assigned.
    expect(matrix.assigned.s1.a3).toBe(false);
    expect(matrix.assigned.s2.a3).toBe(true);

    // Membership lookup is batched into a single query for the whole roster.
    expect(prismaMock.groupMembership.findMany).toHaveBeenCalledTimes(1);
    // And scoped to the sets in play. It used to ask for every membership these students hold
    // anywhere; see the missing-work case below for what that cost.
    expect(prismaMock.groupMembership.findMany.mock.calls[0][0].where).toEqual({
      groupSetId: { in: ['gs1'] },
      userId: { in: ['s1', 's2'] },
    });
  });

  /**
   * The bug this scoping fixes. `missing-work` treats an empty group list as the exemption:
   * on a group assignment, no group means no way to submit, so no zero. The membership query
   * was unscoped, so a student in a group in some *other* course or set came back with a
   * non-empty list, lost the exemption, and was scored zero on work they could never hand in.
   * Since the LMS passback that zero leaves the building.
   */
  it('does not zero a student whose only group is in another set', async () => {
    const due = new Date('2020-01-01T00:00:00.000Z'); // long past, so the deadline has gone
    prismaMock.assignment.findMany.mockResolvedValue([
      {
        id: 'a1',
        title: 'Group Lab',
        dueDate: due,
        unlockAt: null,
        lateCutoff: null,
        allowLateSubmissions: false,
        isPublished: true,
        assignedToEveryone: true,
        missingWorkIsZero: true,
        groupSetId: 'gs1',
        course: { isArchived: false },
        overrides: [],
        assignees: [],
        problems: [{ problemId: 'p1', maxPoints: 10, createdAt: due }],
      },
    ]);
    // s2 is in a group, but in a DIFFERENT set: another course's project teams, say. The mock
    // ignores the where clause on purpose, so this is the row the old unscoped query would
    // have returned and the scoped one would not. s1 is in no group anywhere.
    //
    // Neither is in a group for THIS assignment, so neither could have submitted and neither
    // is scored zero. Before the fix s2 came back holding gOther, lost the exemption, and was
    // given a 0 they had no way to avoid.
    prismaMock.groupMembership.findMany.mockResolvedValue([
      { groupSetId: 'some-other-set', userId: 's2', groupId: 'gOther' },
    ]);

    const matrix = await getCourseGradeMatrix('c1');

    expect(matrix.grades.s1.a1).toBeNull();
    expect(matrix.grades.s2.a1).toBeNull();
  });
});

/*
 * The whole-course matrix stays unpaginated because the LMS export builds on it, so these
 * pin the value-side behaviour that the export depends on. They used to live in the grades
 * route test, which no longer returns a matrix.
 */
describe('getCourseGradeMatrix: values', () => {
  const oneAssignment = () =>
    prismaMock.assignment.findMany.mockResolvedValue([
      {
        id: 'a1',
        title: 'A1',
        dueDate: null,
        isPublished: true,
        assignedToEveryone: true,
        problems: [{ maxPoints: 10 }],
        assignees: [],
      },
    ]);

  it('sums problem grades into one assignment total per student', async () => {
    oneAssignment();
    prismaMock.assignmentProblemGrade.groupBy.mockResolvedValue([
      { studentId: 's1', assignmentId: 'a1', _sum: { grade: 95 } },
    ]);

    const matrix = await getCourseGradeMatrix('c1');

    expect(matrix.grades).toEqual({ s1: { a1: 95 }, s2: { a1: null } });
  });

  it('fills nulls when nothing is graded', async () => {
    oneAssignment();

    const matrix = await getCourseGradeMatrix('c1');

    expect(matrix.grades).toEqual({ s1: { a1: null }, s2: { a1: null } });
  });

  it('coerces a null sum to 0 and ignores rows for unknown students', async () => {
    oneAssignment();
    prismaMock.assignmentProblemGrade.groupBy.mockResolvedValue([
      { studentId: 's1', assignmentId: 'a1', _sum: { grade: null } },
      { studentId: 'ghost', assignmentId: 'a1', _sum: { grade: 5 } },
    ]);

    const matrix = await getCourseGradeMatrix('c1');

    expect(matrix.grades.s1.a1).toBe(0);
    expect(matrix.grades.ghost).toBeUndefined();
  });

  it('treats a null problem maxPoints as 0 when summing assignment points', async () => {
    prismaMock.assignment.findMany.mockResolvedValue([
      {
        id: 'a1',
        title: 'A1',
        dueDate: null,
        isPublished: true,
        assignedToEveryone: true,
        problems: [{ maxPoints: null }, { maxPoints: 5 }],
        assignees: [],
      },
    ]);

    const matrix = await getCourseGradeMatrix('c1');

    expect(matrix.assignments[0].maxPoints).toBe(5);
  });

  it('skips the grade aggregate entirely when there are no assignments', async () => {
    prismaMock.assignment.findMany.mockResolvedValue([]);

    const matrix = await getCourseGradeMatrix('c1');

    expect(matrix.assignments).toEqual([]);
    expect(prismaMock.assignmentProblemGrade.groupBy).not.toHaveBeenCalled();
  });

  it('skips the user lookup when the roster is empty', async () => {
    prismaMock.roster.findMany.mockResolvedValue([]);
    prismaMock.assignment.findMany.mockResolvedValue([]);

    const matrix = await getCourseGradeMatrix('c1');

    expect(matrix.students).toEqual([]);
    expect(prismaMock.user.findMany).not.toHaveBeenCalled();
  });
});

describe('drafts and the Average column', () => {
  it('leaves an unpublished assignment out of the denominator', async () => {
    prismaMock.assignment.findMany.mockResolvedValue([
      {
        id: 'live',
        title: 'Homework 1',
        dueDate: null,
        isPublished: true,
        assignedToEveryone: true,
        problems: [{ maxPoints: 10 }],
        assignees: [],
      },
      {
        // Written but not out yet. Staff grade drafts here, so it stays a column; counting
        // it would measure students against work they have never seen.
        id: 'draft',
        title: 'Homework 2',
        dueDate: null,
        isPublished: false,
        assignedToEveryone: true,
        problems: [{ maxPoints: 10 }],
        assignees: [],
      },
    ]);
    prismaMock.roster.findMany.mockResolvedValue([
      { userId: 'ada', status: 'ENROLLED' },
      { userId: 'bob', status: 'ENROLLED' },
    ]);
    prismaMock.user.findMany.mockResolvedValue([
      {
        id: 'ada',
        firstName: 'Ada',
        lastName: 'A',
        email: 'ada@example.com',
        avatar: null,
        cropX: null,
        cropY: null,
        zoom: null,
      },
      {
        id: 'bob',
        firstName: 'Bob',
        lastName: 'B',
        email: 'bob@example.com',
        avatar: null,
        cropX: null,
        cropY: null,
        zoom: null,
      },
    ]);
    prismaMock.groupMembership.findMany.mockResolvedValue([]);
    // Ada aced the work that is out. Bob half did it and has full marks on the draft, which
    // nobody could have attempted. Counting the draft would rank Bob (75%) above Ada (50%);
    // ignoring it ranks Ada (100%) above Bob (50%), which is the truth about the course.
    prismaMock.assignmentProblemGrade.groupBy.mockResolvedValue([
      { studentId: 'ada', assignmentId: 'live', _sum: { grade: 10 } },
      { studentId: 'bob', assignmentId: 'live', _sum: { grade: 5 } },
      { studentId: 'bob', assignmentId: 'draft', _sum: { grade: 10 } },
    ]);

    prismaMock.roster.count.mockResolvedValue(2);

    const page = await getCourseGradePage({
      courseId: 'c1',
      skip: 0,
      take: 10,
      sortBy: 'totalGrade',
      sortDir: 'desc',
    });

    expect(page.rows.map((r) => r.id)).toEqual(['ada', 'bob']);
  });
});

describe('getCourseGradeColumns', () => {
  it('returns the columns and the course student total, with no student rows', async () => {
    prismaMock.assignment.findMany.mockResolvedValue([
      {
        id: 'a1',
        title: 'A1',
        dueDate: null,
        isPublished: true,
        assignedToEveryone: true,
        problems: [{ maxPoints: 10 }],
        assignees: [],
      },
    ]);
    prismaMock.roster.count.mockResolvedValue(1200);

    const columns = await getCourseGradeColumns('c1');

    expect(columns.assignments).toEqual([
      { id: 'a1', title: 'A1', dueDate: null, maxPoints: 10, isPublished: true },
    ]);
    expect(columns.totalStudents).toBe(1200);
  });
});

describe('getCourseGradePage', () => {
  const twoAssignments = () =>
    prismaMock.assignment.findMany.mockResolvedValue([
      {
        id: 'a1',
        title: 'A1',
        dueDate: null,
        isPublished: true,
        assignedToEveryone: true,
        problems: [{ maxPoints: 10 }],
        assignees: [],
      },
      {
        id: 'a2',
        title: 'A2',
        dueDate: null,
        isPublished: true,
        assignedToEveryone: true,
        problems: [{ maxPoints: 10 }],
        assignees: [],
      },
    ]);

  beforeEach(() => {
    prismaMock.roster.count.mockResolvedValue(2);
    prismaMock.roster.findMany.mockResolvedValue([
      { userId: 's1', status: 'ENROLLED' },
      { userId: 's2', status: 'ENROLLED' },
    ]);
    twoAssignments();
  });

  it('returns rows carrying their own assigned flags and grades', async () => {
    prismaMock.assignmentProblemGrade.groupBy.mockResolvedValue([
      { studentId: 's1', assignmentId: 'a1', _sum: { grade: 8 } },
    ]);

    const { rows, total } = await getCourseGradePage({ courseId: 'c1', skip: 0, take: 10 });

    expect(total).toBe(2);
    expect(rows[0]).toMatchObject({ id: 's1', enrollmentStatus: 'ENROLLED' });
    expect(rows[0].grades).toEqual({ a1: 8, a2: null });
    expect(rows[0].assigned).toEqual({ a1: true, a2: true });
  });

  it('keeps dropped students, labelled, so their grades stay editable', async () => {
    prismaMock.roster.findMany.mockResolvedValue([{ userId: 's2', status: 'DROPPED' }]);
    prismaMock.user.findMany.mockResolvedValue([
      {
        id: 's2',
        firstName: 'Alan',
        lastName: 'T',
        email: 't@x.io',
        avatar: null,
        cropX: null,
        cropY: null,
        zoom: null,
      },
    ]);

    const { rows } = await getCourseGradePage({ courseId: 'c1', skip: 0, take: 10 });

    expect(rows[0].enrollmentStatus).toBe('DROPPED');
    // The roster query never filters on status.
    expect(prismaMock.roster.findMany.mock.calls[0][0].where).not.toHaveProperty('status');
  });

  it('searches the student, not the grades', async () => {
    await getCourseGradePage({ courseId: 'c1', skip: 0, take: 10, q: 'ada' });

    expect(prismaMock.roster.findMany.mock.calls[0][0].where.user).toEqual({
      OR: [
        { firstName: { contains: 'ada', mode: 'insensitive' } },
        { lastName: { contains: 'ada', mode: 'insensitive' } },
        { email: { contains: 'ada', mode: 'insensitive' } },
      ],
    });
  });

  describe('sorting', () => {
    it('lets the database order and slice a student-field sort', async () => {
      await getCourseGradePage({ courseId: 'c1', skip: 20, take: 10, sortBy: 'lastName' });

      const call = prismaMock.roster.findMany.mock.calls[0][0];
      expect(call.orderBy[0]).toEqual({ user: { lastName: 'asc' } });
      // Only the page is touched for the cheap tier.
      expect(call.skip).toBe(20);
      expect(call.take).toBe(10);
    });

    it('orders by one assignment column without loading the whole matrix', async () => {
      prismaMock.assignmentProblemGrade.groupBy.mockResolvedValue([
        { studentId: 's2', assignmentId: 'a1', _sum: { grade: 9 } },
        { studentId: 's1', assignmentId: 'a1', _sum: { grade: 3 } },
      ]);

      const { rows } = await getCourseGradePage({
        courseId: 'c1',
        skip: 0,
        take: 10,
        sortBy: 'a1',
        sortDir: 'desc',
      });

      expect(rows.map((r) => r.id)).toEqual(['s2', 's1']);
      // Scoped to the one column being sorted, not every assignment.
      expect(
        prismaMock.assignmentProblemGrade.groupBy.mock.calls[0][0].where.assignmentId.in,
      ).toEqual(['a1']);
      // The candidate list is ordered by the server, so it must not also skip/take.
      expect(prismaMock.roster.findMany.mock.calls[0][0].skip).toBeUndefined();
    });

    it('orders by Average, counting only assignments the student is assigned', async () => {
      // s1 is assigned both (10 + 10 available) and earns 8 -> 40%.
      // s2 is assigned only a1 (10 available) and earns 8 -> 80%, so s2 leads on desc.
      prismaMock.assignment.findMany.mockResolvedValue([
        {
          id: 'a1',
          title: 'A1',
          dueDate: null,
          isPublished: true,
          assignedToEveryone: true,
          problems: [{ problemId: 'p1', maxPoints: 10, createdAt: new Date('2026-01-01') }],
          assignees: [],
        },
        {
          id: 'a2',
          title: 'A2',
          dueDate: null,
          isPublished: true,
          assignedToEveryone: false,
          problems: [{ problemId: 'p2', maxPoints: 10, createdAt: new Date('2026-01-01') }],
          assignees: [{ userId: 's1', groupId: null }],
        },
      ]);
      // s1 is marked on both of theirs and scores 8 + 2 of 20; s2 is marked on their one and
      // scores 8 of 10. The denominator is what has been marked, so both are measured against
      // the work that was actually assessed and s2 still leads.
      prismaMock.assignmentProblemGrade.groupBy.mockResolvedValue([
        { studentId: 's1', assignmentId: 'a1', _sum: { grade: 8 } },
        { studentId: 's1', assignmentId: 'a2', _sum: { grade: 2 } },
        { studentId: 's2', assignmentId: 'a1', _sum: { grade: 8 } },
      ]);
      prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([
        { studentId: 's1', assignmentId: 'a1', problemId: 'p1' },
        { studentId: 's1', assignmentId: 'a2', problemId: 'p2' },
        { studentId: 's2', assignmentId: 'a1', problemId: 'p1' },
      ]);

      const { rows } = await getCourseGradePage({
        courseId: 'c1',
        skip: 0,
        take: 10,
        sortBy: 'totalGrade',
        sortDir: 'desc',
      });

      expect(rows.map((r) => r.id)).toEqual(['s2', 's1']);
    });

    it('sorts students with no graded work last, whichever way the column points', async () => {
      prismaMock.assignmentProblemGrade.groupBy.mockResolvedValue([
        { studentId: 's2', assignmentId: 'a1', _sum: { grade: 5 } },
      ]);
      // The base fixture's assignments carry no problems, and the denominator is now built from
      // them, so this test needs one to have anything to order by at all.
      prismaMock.assignment.findMany.mockResolvedValue([
        {
          id: 'a1',
          title: 'A1',
          dueDate: null,
          isPublished: true,
          assignedToEveryone: true,
          problems: [{ problemId: 'p1', maxPoints: 10, createdAt: new Date('2026-01-01') }],
          assignees: [],
        },
      ]);
      // The per-problem row is what puts points in s2's denominator. s1 has neither a grade nor
      // any missing work, so they still have nothing to be ordered by.
      prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([
        { studentId: 's2', assignmentId: 'a1', problemId: 'p1' },
      ]);

      const asc = await getCourseGradePage({
        courseId: 'c1',
        skip: 0,
        take: 10,
        sortBy: 'totalGrade',
        sortDir: 'asc',
      });
      const desc = await getCourseGradePage({
        courseId: 'c1',
        skip: 0,
        take: 10,
        sortBy: 'totalGrade',
        sortDir: 'desc',
      });

      // s1 has nothing graded, so it trails in both directions.
      expect(asc.rows[asc.rows.length - 1].id).toBe('s1');
      expect(desc.rows[desc.rows.length - 1].id).toBe('s1');
    });

    it('slices the ordered list to the requested page', async () => {
      prismaMock.assignmentProblemGrade.groupBy.mockResolvedValue([
        { studentId: 's1', assignmentId: 'a1', _sum: { grade: 1 } },
        { studentId: 's2', assignmentId: 'a1', _sum: { grade: 2 } },
      ]);
      prismaMock.user.findMany.mockResolvedValue([
        {
          id: 's2',
          firstName: 'Alan',
          lastName: 'T',
          email: 't@x.io',
          avatar: null,
          cropX: null,
          cropY: null,
          zoom: null,
        },
      ]);

      const { rows } = await getCourseGradePage({
        courseId: 'c1',
        skip: 1,
        take: 1,
        sortBy: 'a1',
        sortDir: 'asc',
      });

      expect(rows.map((r) => r.id)).toEqual(['s2']);
    });
  });

  it('returns nothing without touching users when the page is empty', async () => {
    prismaMock.roster.findMany.mockResolvedValue([]);
    prismaMock.roster.count.mockResolvedValue(0);

    const { rows, total } = await getCourseGradePage({ courseId: 'c1', skip: 0, take: 10 });

    expect(rows).toEqual([]);
    expect(total).toBe(0);
    expect(prismaMock.user.findMany).not.toHaveBeenCalled();
  });
});

/**
 * What the Average column means now.
 *
 * It used to put every published, assigned assignment's full points in the denominator whether or
 * not anyone had marked it, so work sitting in a TA's queue read as a zero and a mid-term average
 * mostly measured how much term was left. The denominator is now what the student is accountable
 * for: work that has been marked, plus work nobody handed in on an assignment that scores missing
 * work zero.
 */
describe('the Average denominator', () => {
  const twoProblems = [
    {
      id: 'a1',
      title: 'A1',
      dueDate: new Date('2026-01-10T00:00:00.000Z'),
      isPublished: true,
      assignedToEveryone: true,
      missingWorkIsZero: false,
      groupSetId: null,
      unlockAt: null,
      lateCutoff: null,
      allowLateSubmissions: false,
      course: { isArchived: false },
      overrides: [],
      problems: [
        { problemId: 'p1', maxPoints: 10, createdAt: new Date('2026-01-01') },
        { problemId: 'p2', maxPoints: 10, createdAt: new Date('2026-01-01') },
      ],
      assignees: [],
    },
  ];

  it('leaves work that is still waiting to be marked out of it', async () => {
    prismaMock.assignment.findMany.mockResolvedValue(twoProblems);
    // Marked on one problem out of two, and scored full marks on it.
    prismaMock.assignmentProblemGrade.groupBy.mockResolvedValue([
      { studentId: 's1', assignmentId: 'a1', _sum: { grade: 10 } },
    ]);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([
      { studentId: 's1', assignmentId: 'a1', problemId: 'p1' },
    ]);

    const { rows } = await getCourseGradePage({ courseId: 'c1', skip: 0, take: 10 });
    const s1 = rows.find((r) => r.id === 's1');

    // 10 of 10, not 10 of 20. The unmarked problem is nobody's fault yet.
    expect(s1?.accountable.a1).toBe(10);
  });

  it('counts work nobody handed in, once the assignment says so', async () => {
    prismaMock.assignment.findMany.mockResolvedValue([
      { ...twoProblems[0], missingWorkIsZero: true },
    ]);
    prismaMock.assignmentProblemGrade.groupBy.mockResolvedValue([
      { studentId: 's1', assignmentId: 'a1', _sum: { grade: 10 } },
    ]);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([
      { studentId: 's1', assignmentId: 'a1', problemId: 'p1' },
    ]);
    prismaMock.roster.findMany.mockResolvedValue([
      { userId: 's1', status: 'ENROLLED', user: { inactive: false } },
      { userId: 's2', status: 'ENROLLED', user: { inactive: false } },
    ]);

    const { rows } = await getCourseGradePage({ courseId: 'c1', skip: 0, take: 10 });
    const s1 = rows.find((r) => r.id === 's1');

    // Both problems now: one marked, one nobody handed in past the deadline.
    expect(s1?.accountable.a1).toBe(20);
    // Not flagged as an untouched assignment, because they did hand in the other half.
    expect(s1?.missing).not.toContain('a1');
  });

  it('flags an assignment the student handed nothing in for', async () => {
    prismaMock.assignment.findMany.mockResolvedValue([
      { ...twoProblems[0], missingWorkIsZero: true },
    ]);
    prismaMock.assignmentProblemGrade.groupBy.mockResolvedValue([]);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);
    prismaMock.roster.findMany.mockResolvedValue([
      { userId: 's1', status: 'ENROLLED', user: { inactive: false } },
      { userId: 's2', status: 'ENROLLED', user: { inactive: false } },
    ]);

    const { rows } = await getCourseGradePage({ courseId: 'c1', skip: 0, take: 10 });

    // The cell can then say zero AND say why, rather than showing a bare zero that reads like
    // a mark they earned.
    expect(rows.find((r) => r.id === 's1')?.missing).toContain('a1');
  });

  it('says nothing for a dropped student', async () => {
    prismaMock.assignment.findMany.mockResolvedValue([
      { ...twoProblems[0], missingWorkIsZero: true },
    ]);
    prismaMock.assignmentProblemGrade.groupBy.mockResolvedValue([]);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);
    prismaMock.roster.findMany.mockResolvedValue([
      { userId: 's1', status: 'DROPPED', user: { inactive: false } },
      { userId: 's2', status: 'ENROLLED', user: { inactive: false } },
    ]);

    const { rows } = await getCourseGradePage({ courseId: 'c1', skip: 0, take: 10 });

    expect(rows.find((r) => r.id === 's1')?.missing).toEqual([]);
  });
});

/**
 * What every gradebook query is scoped to.
 *
 * These helpers take a course id and are trusted to stay inside it. The prisma mock answers
 * with its fixture whatever the `where` says, so a dropped scoping key changes nothing any
 * other test in this file can see: `{ courseId, role: 'STUDENT' }` without the `courseId`
 * still returns two students here, and in production would return every student in the
 * installation. Each assertion below is on the whole `where`, not a subset, so any key going
 * missing fails rather than only the ones somebody thought to name.
 */
describe('what the gradebook queries are scoped to', () => {
  const whereOf = (fn: { mock: { calls: unknown[][] } }, i = 0) =>
    (fn.mock.calls[i]?.[0] as { where?: unknown } | undefined)?.where;

  const oneAssignment = () =>
    prismaMock.assignment.findMany.mockResolvedValue([
      {
        id: 'a1',
        title: 'A1',
        dueDate: null,
        isPublished: true,
        assignedToEveryone: true,
        problems: [{ maxPoints: 10 }],
        assignees: [],
      },
    ]);

  it('getCourseGradeStructure reads only this course', async () => {
    oneAssignment();

    await getCourseGradeStructure('c1');

    expect(whereOf(prismaMock.roster.findMany)).toEqual({ courseId: 'c1', role: 'STUDENT' });
    expect(whereOf(prismaMock.assignment.findMany)).toEqual({ courseId: 'c1' });
  });

  it('getCourseGradeValues reads only this course, and only these students and assignments', async () => {
    prismaMock.assignment.findMany.mockResolvedValue([{ id: 'a1' }]);

    await getCourseGradeValues('c1');

    expect(whereOf(prismaMock.roster.findMany)).toEqual({ courseId: 'c1', role: 'STUDENT' });
    expect(whereOf(prismaMock.assignment.findMany)).toEqual({ courseId: 'c1' });
    expect(whereOf(prismaMock.assignmentProblemGrade.groupBy)).toEqual({
      assignmentId: { in: ['a1'] },
      studentId: { in: ['s1', 's2'] },
    });
  });

  it('getCourseGradeMatrix keeps its roster, grade and submission reads inside the course', async () => {
    oneAssignment();

    await getCourseGradeMatrix('c1');

    // Both halves run: the structure's roster read and the accountability roster read.
    const rosterWheres = prismaMock.roster.findMany.mock.calls.map(
      (c) => (c[0] as { where: unknown }).where,
    );
    expect(rosterWheres).toContainEqual({ courseId: 'c1', role: 'STUDENT' });
    expect(rosterWheres).toContainEqual({ courseId: 'c1', userId: { in: ['s1', 's2'] } });

    expect(whereOf(prismaMock.assignmentProblemGrade.groupBy)).toEqual({
      assignmentId: { in: ['a1'] },
      studentId: { in: ['s1', 's2'] },
    });
    expect(whereOf(prismaMock.assignmentProblemGrade.findMany)).toEqual({
      assignmentId: { in: ['a1'] },
      studentId: { in: ['s1', 's2'] },
    });
    // No groups in this fixture, so the submission read is by student alone.
    expect(whereOf(prismaMock.submission.findMany)).toEqual({
      assignmentId: { in: ['a1'] },
      OR: [{ studentId: { in: ['s1', 's2'] } }],
    });
  });

  it('getCourseGradeColumns counts only this course', async () => {
    oneAssignment();
    prismaMock.roster.count.mockResolvedValue(2);

    await getCourseGradeColumns('c1');

    expect(whereOf(prismaMock.roster.count)).toEqual({ courseId: 'c1', role: 'STUDENT' });
    expect(whereOf(prismaMock.assignment.findMany)).toEqual({ courseId: 'c1' });
  });

  it('getCourseGradePage reads the page students from this course only', async () => {
    oneAssignment();
    prismaMock.roster.count.mockResolvedValue(2);
    prismaMock.roster.findMany.mockResolvedValue([
      { userId: 's1', status: 'ENROLLED', user: { inactive: false } },
      { userId: 's2', status: 'ENROLLED', user: { inactive: false } },
    ]);

    await getCourseGradePage({ courseId: 'c1', skip: 0, take: 10 });

    const rosterWheres = prismaMock.roster.findMany.mock.calls.map(
      (c) => (c[0] as { where: unknown }).where,
    );
    // The page itself, then the accountability read for the ids on it.
    expect(rosterWheres[0]).toMatchObject({ courseId: 'c1', role: 'STUDENT' });
    expect(rosterWheres[1]).toEqual({ courseId: 'c1', userId: { in: ['s1', 's2'] } });
  });

  /**
   * Sorting by the total takes a different path: it reads every candidate, not just the page,
   * and builds the sort key from its own roster and grade reads. Those are separate queries
   * from the ones above and need their own scope.
   */
  it('sorting by total keeps the candidate reads inside the course', async () => {
    oneAssignment();
    prismaMock.roster.count.mockResolvedValue(2);
    prismaMock.roster.findMany.mockResolvedValue([
      { userId: 's1', status: 'ENROLLED', user: { inactive: false } },
      { userId: 's2', status: 'ENROLLED', user: { inactive: false } },
    ]);

    await getCourseGradePage({ courseId: 'c1', skip: 0, take: 10, sortBy: 'totalGrade' });

    const rosterWheres = prismaMock.roster.findMany.mock.calls.map(
      (c) => (c[0] as { where: unknown }).where,
    );
    expect(rosterWheres[0]).toMatchObject({ courseId: 'c1', role: 'STUDENT' });
    expect(rosterWheres[1]).toEqual({ courseId: 'c1', userId: { in: ['s1', 's2'] } });
    // The sort key's own grade read, which is a different call site from the page's.
    expect(whereOf(prismaMock.assignmentProblemGrade.groupBy)).toEqual({
      assignmentId: { in: ['a1'] },
      studentId: { in: ['s1', 's2'] },
    });
  });
});
