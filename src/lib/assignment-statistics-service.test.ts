import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  assignment: { findFirst: vi.fn() },
  assignmentOverride: { findMany: vi.fn() },
  assignmentProblemGrade: { findMany: vi.fn() },
  roster: { findMany: vi.fn() },
  groupMembership: { findMany: vi.fn() },
  studentGroup: { findMany: vi.fn() },
  submission: { findMany: vi.fn() },
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

import { getAssignmentStatistics } from './assignment-statistics-service';

const DUE = new Date('2026-08-10T23:59:00.000Z');
const LATER = new Date('2026-08-17T23:59:00.000Z');
const GRADED_AT = new Date('2026-08-11T09:00:00.000Z');

/** A roster row as the loader reads it: standing, and whether the account still works. */
const rosterRow = (
  userId: string,
  over: { status?: 'ENROLLED' | 'DROPPED'; inactive?: boolean } = {},
) => ({
  userId,
  status: over.status ?? 'ENROLLED',
  user: { inactive: over.inactive ?? false },
});

/**
 * Install the roster the loader will read.
 *
 * The two branches ask different questions of the same table: the individual one wants every
 * student who has ever been on the roster (so it can report who was left out), the group one
 * wants only students who could still do the work. A mock that ignored the where-clause would
 * hand both the same answer and hide exactly that distinction.
 */
const setRoster = (rows: ReturnType<typeof rosterRow>[]) => {
  prismaMock.roster.findMany.mockImplementation((args?: { where?: Record<string, unknown> }) => {
    const where = (args?.where ?? {}) as {
      status?: string;
      user?: { inactive?: boolean };
    };
    return Promise.resolve(
      rows.filter((row) => {
        if (where.status && row.status !== where.status) return false;
        if (where.user?.inactive === false && row.user.inactive) return false;
        return true;
      }),
    );
  });
};

/** A grade row. `updatedAt` is what tells a stale grade from a settled one. */
const gradeRow = (studentId: string, problemId: string, grade: number, updatedAt = GRADED_AT) => ({
  studentId,
  problemId,
  grade,
  updatedAt,
});

/** An override row. Only a different due date makes it an exception. */
const overrideRow = (over: Record<string, unknown>) => ({
  targetType: 'STUDENT',
  userId: null,
  groupId: null,
  unlockAt: null,
  dueDate: null,
  lateCutoff: null,
  allowLateSubmissions: null,
  ...over,
});

function baseAssignment(over: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    title: 'HW 1',
    dueDate: DUE,
    unlockAt: null,
    lateCutoff: null,
    allowLateSubmissions: false,
    assignedToEveryone: true,
    groupSetId: null,
    course: { timezone: 'America/New_York' },
    assignees: [],
    problems: [
      { problemId: 'p1', maxPoints: 10, autograderEnabled: true, problem: { title: 'Problem 1' } },
      { problemId: 'p2', maxPoints: 10, autograderEnabled: true, problem: { title: 'Problem 2' } },
    ],
    ...over,
  };
}

const statusFor = (
  stats: { problems: { id: string; status: { key: string; count: number }[] }[] },
  id: string,
) =>
  Object.fromEntries(stats.problems.find((p) => p.id === id)!.status.map((s) => [s.key, s.count]));

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.assignmentOverride.findMany.mockResolvedValue([]);
  prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);
  setRoster([]);
  prismaMock.groupMembership.findMany.mockResolvedValue([]);
  prismaMock.studentGroup.findMany.mockResolvedValue([]);
  prismaMock.submission.findMany.mockResolvedValue([]);
});

describe('getAssignmentStatistics - individual assignment', () => {
  it('measures in students, reports per-problem queue status, and counts exceptions', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(baseAssignment());
    setRoster([rosterRow('s1'), rosterRow('s2')]);
    // s1 fully graded 100%, s2 ungraded
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([
      gradeRow('s1', 'p1', 10),
      gradeRow('s1', 'p2', 10),
    ]);
    // A student due-date exception for s2.
    prismaMock.assignmentOverride.findMany.mockResolvedValue([
      overrideRow({ userId: 's2', dueDate: LATER }),
    ]);
    // s1's submissions: p1 solved (Completed), p2 still queued (Pending). s2 never submitted.
    prismaMock.submission.findMany.mockResolvedValue([
      {
        studentId: 's1',
        studentGroupId: null,
        problemId: 'p1',
        submittedAt: new Date('2026-08-01T10:00:00Z'),
        correct: true,
        status: 'COMPLETED',
      },
      {
        studentId: 's1',
        studentGroupId: null,
        problemId: 'p2',
        submittedAt: new Date('2026-08-01T11:00:00Z'),
        correct: false,
        status: 'PENDING',
      },
    ]);

    const stats = (await getAssignmentStatistics('c1', 'a1'))!;

    expect(stats.unit).toBe('student');
    expect(stats.participantCount).toBe(2);
    expect(stats.exceptionCount).toBe(1); // s2
    expect(stats.timezone).toBe('America/New_York');
    expect(stats.baseDueDate).toBe(DUE.toISOString());

    // s1 fully graded 100% -> histogram last bin, s2 excluded (ungraded)
    expect(stats.histogram.includedCount).toBe(1);
    expect(stats.histogram.excludedCount).toBe(1);
    expect(stats.histogram.bins[9]!.count).toBe(1);

    // p1: s1 completed, s2 missing. p2: s1 pending, s2 missing.
    expect(statusFor(stats, 'p1')['completed']).toBe(1);
    expect(statusFor(stats, 'p1')['missing']).toBe(1);
    expect(statusFor(stats, 'p2')['pending']).toBe(1);
    expect(statusFor(stats, 'p2')['missing']).toBe(1);

    // Attempts-to-solve, per problem: s1 solved p1 on the first try; p2 never solved.
    const p1 = stats.problems.find((p) => p.id === 'p1')!;
    const p2 = stats.problems.find((p) => p.id === 'p2')!;
    expect(p1.attempts.solvedCount).toBe(1);
    expect(p1.attempts.buckets.find((b) => b.label === '1')!.count).toBe(1);
    expect(p2.attempts.solvedCount).toBe(0);
    expect(p2.attempts.unsolvedCount).toBe(1); // pending submission, never correct
    // First-attempt success on p1: s1 got it right first try.
    expect(p1.firstAttemptCorrect).toBe(1);
    expect(p1.firstAttemptSubmitted).toBe(1);
  });

  it('only counts students who are actually assigned', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(
      baseAssignment({ assignedToEveryone: false, assignees: [{ userId: 's1', groupId: null }] }),
    );
    setRoster([rosterRow('s1'), rosterRow('s2')]);

    const stats = (await getAssignmentStatistics('c1', 'a1'))!;
    expect(stats.participantCount).toBe(1); // only s1 is assigned
    // s2 was never given this work, so they are not an exclusion: they are not in the picture.
    expect(stats.exclusions).toEqual([]);
  });
});

it('leaves out dropped students and disabled accounts, and says how many', async () => {
  prismaMock.assignment.findFirst.mockResolvedValue(baseAssignment());
  setRoster([
    rosterRow('s1'),
    rosterRow('s2', { status: 'DROPPED' }),
    rosterRow('s3', { inactive: true }),
    // Dropped AND disabled: reported once, the way the roster reports them.
    rosterRow('s4', { status: 'DROPPED', inactive: true }),
  ]);

  const stats = (await getAssignmentStatistics('c1', 'a1'))!;

  expect(stats.participantCount).toBe(1);
  expect(stats.exclusions).toEqual([
    { reason: 'dropped', count: 2 },
    { reason: 'inactive', count: 1 },
  ]);
});

it('counts an exception only when the due date actually moves', async () => {
  prismaMock.assignment.findFirst.mockResolvedValue(baseAssignment());
  setRoster([rosterRow('s1'), rosterRow('s2'), rosterRow('s3')]);
  prismaMock.assignmentOverride.findMany.mockResolvedValue([
    // Opens early, due at the same moment as everybody else.
    overrideRow({ userId: 's1', unlockAt: new Date('2026-08-01T00:00:00.000Z') }),
    // Edited until every field was cleared: changes nothing.
    overrideRow({ userId: 's2' }),
    // A real extension.
    overrideRow({ userId: 's3', dueDate: LATER }),
  ]);

  const stats = (await getAssignmentStatistics('c1', 'a1'))!;

  expect(stats.exceptionCount).toBe(1);
});

it('reports what is waiting on the grader, separately from the queue', async () => {
  prismaMock.assignment.findFirst.mockResolvedValue(
    baseAssignment({
      problems: [
        {
          problemId: 'p1',
          maxPoints: 10,
          autograderEnabled: false,
          problem: { title: 'Problem 1' },
        },
      ],
    }),
  );
  setRoster([rosterRow('s1'), rosterRow('s2'), rosterRow('s3')]);
  // s1 is marked; s2 was marked and then submitted again; s3 is waiting.
  prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([
    gradeRow('s1', 'p1', 8),
    gradeRow('s2', 'p1', 6),
  ]);
  prismaMock.submission.findMany.mockResolvedValue(
    [
      { studentId: 's1', at: '2026-08-09T10:00:00Z' },
      { studentId: 's2', at: '2026-08-09T10:00:00Z' },
      // After GRADED_AT: the grade on record is no longer about the work on record.
      { studentId: 's2', at: '2026-08-12T10:00:00Z' },
      { studentId: 's3', at: '2026-08-09T12:00:00Z' },
    ].map((r) => ({
      studentId: r.studentId,
      studentGroupId: null,
      problemId: 'p1',
      submittedAt: new Date(r.at),
      correct: true,
      status: 'COMPLETED',
    })),
  );

  const stats = (await getAssignmentStatistics('c1', 'a1'))!;
  const p1 = stats.problems.find((p) => p.id === 'p1')!;
  const grading = Object.fromEntries(p1.grading.map((g) => [g.key, g.count]));

  expect(p1.autograderEnabled).toBe(false);
  expect(grading).toEqual({
    graded: 1,
    'graded-stale': 1,
    'ungraded-submitted': 1,
    'ungraded-missing': 0,
  });
  // The queue says all three are done, which is exactly why the page cannot say "done"
  // from it on a problem a person marks.
  expect(statusFor(stats, 'p1')['completed']).toBe(3);
});

it('does not count an evaluation that failed as an attempt the student got wrong', async () => {
  prismaMock.assignment.findFirst.mockResolvedValue(
    baseAssignment({
      problems: [
        { problemId: 'p1', maxPoints: 10, autograderEnabled: true, problem: { title: 'P1' } },
      ],
    }),
  );
  setRoster([rosterRow('s1')]);
  prismaMock.submission.findMany.mockResolvedValue([
    // Our evaluator broke on the first run; the student's next attempt was right.
    {
      studentId: 's1',
      studentGroupId: null,
      problemId: 'p1',
      submittedAt: new Date('2026-08-01T10:00:00Z'),
      correct: false,
      status: 'FAILED',
    },
    {
      studentId: 's1',
      studentGroupId: null,
      problemId: 'p1',
      submittedAt: new Date('2026-08-01T11:00:00Z'),
      correct: true,
      status: 'COMPLETED',
    },
  ]);

  const stats = (await getAssignmentStatistics('c1', 'a1'))!;
  const p1 = stats.problems.find((p) => p.id === 'p1')!;

  // Solved on their first real attempt, not their second.
  expect(p1.attempts.buckets.find((b) => b.label === '1')!.count).toBe(1);
  expect(p1.firstAttemptCorrect).toBe(1);
  // The failed run still happened, so the timeline keeps both events.
  expect(stats.timeline.reduce((n, point) => n + point.count, 0)).toBe(2);
});

it('judges lateness on the attempt that holds the grade, against each student own date', async () => {
  prismaMock.assignment.findFirst.mockResolvedValue(
    baseAssignment({
      problems: [
        { problemId: 'p1', maxPoints: 10, autograderEnabled: true, problem: { title: 'P1' } },
      ],
    }),
  );
  setRoster(['s1', 's2', 's3', 's4', 's5'].map((userId) => rosterRow(userId)));
  // s4 has an extension past the moment they actually submitted.
  prismaMock.assignmentOverride.findMany.mockResolvedValue([
    overrideRow({ userId: 's4', dueDate: LATER }),
  ]);
  const attempt = (studentId: string, at: string) => ({
    studentId,
    studentGroupId: null,
    problemId: 'p1',
    submittedAt: new Date(at),
    correct: false,
    status: 'COMPLETED',
  });
  prismaMock.submission.findMany.mockResolvedValue([
    // s1: in before the deadline and left it there.
    attempt('s1', '2026-08-09T10:00:00Z'),
    // s2: in on time, then revised after the deadline. The later attempt holds the grade,
    // so it is not simply "on time", and it is not simply "late" either.
    attempt('s2', '2026-08-09T10:00:00Z'),
    attempt('s2', '2026-08-12T10:00:00Z'),
    // s3: nothing until after the deadline.
    attempt('s3', '2026-08-12T09:00:00Z'),
    // s4: same moment as s3, but they have until the 17th.
    attempt('s4', '2026-08-12T09:00:00Z'),
    // s5: nothing at all.
  ]);

  const stats = (await getAssignmentStatistics('c1', 'a1'))!;
  const p1 = stats.problems.find((p) => p.id === 'p1')!;
  const turnIn = Object.fromEntries(p1.turnIn.map((t) => [t.key, t.count]));

  expect(turnIn).toEqual({
    'on-time': 2, // s1, and s4 on their own date
    'revised-late': 1, // s2
    late: 1, // s3
    missing: 1, // s5
  });
});

describe('getAssignmentStatistics - group assignment', () => {
  it('measures in groups, aggregates member grades, and reports queue status', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(baseAssignment({ groupSetId: 'gs1' }));
    prismaMock.studentGroup.findMany.mockResolvedValue([
      { id: 'g1', memberships: [{ userId: 'u1' }, { userId: 'u2' }] },
      { id: 'g2', memberships: [{ userId: 'u3' }] },
      { id: 'gEmpty', memberships: [] }, // memberless: excluded
    ]);
    // Autograde fans the grade out to every member; g1 fully graded 100%.
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([
      gradeRow('u1', 'p1', 10),
      gradeRow('u1', 'p2', 10),
      gradeRow('u2', 'p1', 10),
      gradeRow('u2', 'p2', 10),
    ]);
    prismaMock.assignmentOverride.findMany.mockResolvedValue([
      overrideRow({ targetType: 'GROUP', groupId: 'g2', dueDate: LATER }),
    ]);
    // Everybody in a group is still on the roster and still has an account.
    setRoster(['u1', 'u2', 'u3'].map((userId) => rosterRow(userId)));
    // g1's submissions: p1 completed, p2 failed. g2 never submitted.
    prismaMock.submission.findMany.mockResolvedValue([
      {
        studentId: 'u1',
        studentGroupId: 'g1',
        problemId: 'p1',
        submittedAt: new Date('2026-08-01T10:00:00Z'),
        correct: true,
        status: 'COMPLETED',
      },
      {
        studentId: 'u1',
        studentGroupId: 'g1',
        problemId: 'p2',
        submittedAt: new Date('2026-08-01T11:00:00Z'),
        correct: false,
        status: 'FAILED',
      },
    ]);

    const stats = (await getAssignmentStatistics('c1', 'a1'))!;

    expect(stats.unit).toBe('group');
    expect(stats.participantCount).toBe(2); // g1 + g2, gEmpty excluded
    expect(stats.exclusions).toEqual([{ reason: 'empty-group', count: 1 }]);
    expect(stats.exceptionCount).toBe(1); // g2

    // g1 graded 100% -> included; g2 ungraded -> excluded
    expect(stats.histogram.includedCount).toBe(1);
    expect(stats.histogram.bins[9]!.count).toBe(1);

    // p1: g1 completed, g2 missing. p2: g1 failed, g2 missing.
    expect(statusFor(stats, 'p1')['completed']).toBe(1);
    expect(statusFor(stats, 'p1')['missing']).toBe(1);
    expect(statusFor(stats, 'p2')['failed']).toBe(1);
    expect(statusFor(stats, 'p2')['missing']).toBe(1);
  });
});

describe('getAssignmentStatistics - group cohort edge cases', () => {
  it('drops a group whose members have all left, and keeps grades written by one of them', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(baseAssignment({ groupSetId: 'gs1' }));
    prismaMock.studentGroup.findMany.mockResolvedValue([
      { id: 'g1', memberships: [{ userId: 'u1' }, { userId: 'u2' }] },
      // Both members dropped: nobody is left to do this work.
      { id: 'gGone', memberships: [{ userId: 'u3' }, { userId: 'u4' }] },
    ]);
    setRoster([
      rosterRow('u1'),
      // u2 left after the group was graded; the grade is still the group's.
      rosterRow('u2', { status: 'DROPPED' }),
      rosterRow('u3', { status: 'DROPPED' }),
      rosterRow('u4', { status: 'DROPPED' }),
    ]);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([
      gradeRow('u2', 'p1', 10),
      gradeRow('u2', 'p2', 10),
    ]);

    const stats = (await getAssignmentStatistics('c1', 'a1'))!;

    expect(stats.participantCount).toBe(1);
    expect(stats.exclusions).toEqual([{ reason: 'empty-group', count: 1 }]);
    // Read from the member who left: membership decides who is counted, not whether the
    // work is graded. Anything else would put marked work back on the grader's queue.
    expect(stats.histogram.includedCount).toBe(1);
    expect(stats.histogram.bins[9]!.count).toBe(1);
  });

  it('says when an assigned student is in no group and cannot submit', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(baseAssignment({ groupSetId: 'gs1' }));
    prismaMock.studentGroup.findMany.mockResolvedValue([
      { id: 'g1', memberships: [{ userId: 'u1' }] },
    ]);
    setRoster([rosterRow('u1'), rosterRow('u2')]);
    prismaMock.groupMembership.findMany.mockResolvedValue([{ userId: 'u1', groupId: 'g1' }]);

    const stats = (await getAssignmentStatistics('c1', 'a1'))!;

    expect(stats.participantCount).toBe(1);
    expect(stats.exclusions).toEqual([{ reason: 'no-group', count: 1 }]);
  });
});

it('returns null when the assignment is not in the course', async () => {
  prismaMock.assignment.findFirst.mockResolvedValue(null);
  expect(await getAssignmentStatistics('c1', 'missing')).toBeNull();
});

/**
 * Scope, not behaviour, and worth being explicit about which.
 *
 * The group ids this service looks up are only ever compared against the assignment's own
 * assignee rows, and a group from another set can never match one, so an over-broad lookup did
 * not change a number here the way it did on the gradebook. It was still the wrong question,
 * and it read every membership row these students hold anywhere. This asserts the query, since
 * there is no observable behaviour to assert.
 */
describe('the membership lookup', () => {
  it("asks only about the assignment's own group set", async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(baseAssignment({ groupSetId: 'gs1' }));
    prismaMock.studentGroup.findMany.mockResolvedValue([
      { id: 'g1', memberships: [{ userId: 'u1' }] },
    ]);
    setRoster([rosterRow('u1'), rosterRow('u2')]);
    prismaMock.groupMembership.findMany.mockResolvedValue([{ userId: 'u1', groupId: 'g1' }]);

    await getAssignmentStatistics('c1', 'a1');

    for (const call of prismaMock.groupMembership.findMany.mock.calls) {
      expect(call[0]).toMatchObject({ where: { groupSetId: 'gs1' } });
    }
  });

  it('does not go near the table for an individual assignment, which has no groups', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(baseAssignment({ groupSetId: null }));
    setRoster([rosterRow('u1')]);

    await getAssignmentStatistics('c1', 'a1');

    expect(prismaMock.groupMembership.findMany).not.toHaveBeenCalled();
  });
});

/**
 * What the statistics reads are scoped to.
 *
 * This loader is handed a course and an assignment and is trusted to stay inside both. The
 * prisma mocks answer from their fixtures whatever the `where` says, so every assertion in
 * this file passes just as happily when a scope key is gone: without the `courseId` the
 * cohort is every student in the installation, and without the `assignmentId` the overrides,
 * grades and submissions are every one ever recorded. Whole-object assertions, so a key going
 * missing fails here.
 */
describe('what the statistics reads are scoped to', () => {
  const whereOf = (fn: { mock: { calls: unknown[][] } }) =>
    (fn.mock.calls[0][0] as { where: unknown }).where;

  const rosterWheres = () =>
    prismaMock.roster.findMany.mock.calls.map((c) => (c[0] as { where: unknown }).where);

  it('reads the assignment from this course, and its rows for this assignment only', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(baseAssignment());
    setRoster([rosterRow('s1')]);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);
    prismaMock.assignmentOverride.findMany.mockResolvedValue([]);
    prismaMock.submission.findMany.mockResolvedValue([]);

    await getAssignmentStatistics('c1', 'a1');

    expect(whereOf(prismaMock.assignment.findFirst)).toEqual({ id: 'a1', courseId: 'c1' });
    expect(whereOf(prismaMock.assignmentOverride.findMany)).toEqual({ assignmentId: 'a1' });
    expect(whereOf(prismaMock.assignmentProblemGrade.findMany)).toEqual({ assignmentId: 'a1' });
    // Individual assignment: group submissions are deliberately excluded, not merely unasked.
    expect(whereOf(prismaMock.submission.findMany)).toEqual({
      assignmentId: 'a1',
      studentGroupId: null,
    });
    expect(rosterWheres()[0]).toMatchObject({ courseId: 'c1' });
  });

  it('reads groups from this assignment’s group set, and their members only', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(baseAssignment({ groupSetId: 'gs1' }));
    prismaMock.studentGroup.findMany.mockResolvedValue([
      { id: 'g1', memberships: [{ userId: 'u1' }] },
    ]);
    // u2 is on the roster but in no group, so the loader asks which group they are in. That
    // read is the only caller of the membership query, and it is the one being checked here.
    setRoster([rosterRow('u1'), rosterRow('u2')]);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);
    prismaMock.assignmentOverride.findMany.mockResolvedValue([]);
    prismaMock.submission.findMany.mockResolvedValue([]);
    prismaMock.groupMembership.findMany.mockResolvedValue([]);

    await getAssignmentStatistics('c1', 'a1');

    expect(whereOf(prismaMock.studentGroup.findMany)).toEqual({ groupSetId: 'gs1' });
    // The "is this group still staffed" read is course-scoped.
    for (const w of rosterWheres()) expect(w).toMatchObject({ courseId: 'c1' });
    // Group assignment: only submissions that belong to a group.
    expect(whereOf(prismaMock.submission.findMany)).toEqual({
      assignmentId: 'a1',
      studentGroupId: { not: null },
    });
    expect(whereOf(prismaMock.groupMembership.findMany)).toEqual({
      groupSetId: 'gs1',
      userId: { in: ['u2'] },
    });
  });
});
