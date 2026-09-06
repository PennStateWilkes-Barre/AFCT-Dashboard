import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  course: { findUnique: vi.fn() },
  roster: { findMany: vi.fn() },
  assignment: { findMany: vi.fn() },
  groupMembership: { findMany: vi.fn() },
  assignmentOverride: { findMany: vi.fn() },
  assignmentProblemGrade: { findMany: vi.fn() },
  submission: { findMany: vi.fn() },
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

import { getCourseStatistics } from './course-statistics-service';

const DUE = new Date('2026-09-10T23:59:00.000Z');
const GRADED_AT = new Date('2026-09-11T09:00:00.000Z');

const rosterRow = (
  userId: string,
  over: { status?: 'ENROLLED' | 'DROPPED'; inactive?: boolean } = {},
) => ({
  userId,
  status: over.status ?? 'ENROLLED',
  user: { inactive: over.inactive ?? false },
});

const problem = (problemId: string, maxPoints = 10, type: string | null = 'FA') => ({
  problemId,
  maxPoints,
  // Long before any fixture deadline, so a problem is never treated as added late.
  createdAt: new Date('2020-01-01T00:00:00.000Z'),
  problem: { type },
});

const assignment = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  title: 'Homework 1',
  dueDate: DUE,
  unlockAt: null,
  lateCutoff: null,
  allowLateSubmissions: false,
  isPublished: true,
  assignedToEveryone: true,
  groupSetId: null,
  // Off unless a test turns it on, matching every assignment that existed before the setting.
  missingWorkIsZero: false,
  assignees: [] as { userId: string | null; groupId: string | null }[],
  problems: [problem('p1')],
  ...over,
});

const grade = (studentId: string, problemId: string, value: number, assignmentId = 'a1') => ({
  studentId,
  assignmentId,
  problemId,
  grade: value,
  updatedAt: GRADED_AT,
});

/**
 * Membership rows, handed back in full whatever the query asked for.
 *
 * Deliberately unfiltered, which is the one case where ignoring the where clause is the point:
 * it stands in for a database that returns rows from other sets, which is what the unscoped
 * query used to produce and what a future edit could reintroduce. The service has to reach the
 * right answer anyway, because the index keys every row by the set it came from rather than
 * flattening them onto the student. The scoping of the query itself is a separate guarantee,
 * asserted separately below.
 */
const setMemberships = (rows: { groupSetId: string; userId: string; groupId: string }[]) => {
  prismaMock.groupMembership.findMany.mockResolvedValue(
    rows.map((r) => ({
      userId: r.userId,
      groupId: r.groupId,
      group: { groupSetId: r.groupSetId },
    })),
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.course.findUnique.mockResolvedValue({
    id: 'c1',
    name: 'Theory of Computation',
    timezone: 'America/New_York',
  });
  prismaMock.roster.findMany.mockResolvedValue([]);
  prismaMock.assignment.findMany.mockResolvedValue([]);
  prismaMock.groupMembership.findMany.mockResolvedValue([]);
  prismaMock.assignmentOverride.findMany.mockResolvedValue([]);
  prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);
  prismaMock.submission.findMany.mockResolvedValue([]);
});

describe('getCourseStatistics', () => {
  it('returns null for a course that is not there', async () => {
    prismaMock.course.findUnique.mockResolvedValue(null);
    expect(await getCourseStatistics('nope')).toBeNull();
  });

  it('counts enrolled students with working accounts, and says who it left out', async () => {
    prismaMock.roster.findMany.mockResolvedValue([
      rosterRow('s1'),
      rosterRow('s2', { status: 'DROPPED' }),
      rosterRow('s3', { inactive: true }),
    ]);

    const stats = (await getCourseStatistics('c1'))!;

    expect(stats.studentCount).toBe(1);
    expect(stats.exclusions).toEqual([
      { reason: 'dropped', count: 1 },
      { reason: 'inactive', count: 1 },
    ]);
  });

  it('computes the course average the way the Grades tab does', async () => {
    prismaMock.roster.findMany.mockResolvedValue([rosterRow('s1'), rosterRow('s2')]);
    prismaMock.assignment.findMany.mockResolvedValue([
      assignment({ id: 'a1' }),
      assignment({ id: 'a2', title: 'Homework 2' }),
    ]);
    // s1 is marked on both; s2 only on the first, and the second is set but unmarked.
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([
      grade('s1', 'p1', 10, 'a1'),
      grade('s1', 'p1', 8, 'a2'),
      grade('s2', 'p1', 10, 'a1'),
    ]);

    const stats = (await getCourseStatistics('c1'))!;

    /**
     * s1 is 18 of 20, s2 is 10 of 10: each is measured against the work that has actually been
     * marked for them, which is what the Grades tab now shows too. It used to divide s2 by 20,
     * scoring their unmarked assignment as a zero and reporting the class at 70%.
     *
     * With no assignment counting missing work as zero, the two readings agree by construction:
     * "accountable" and "graded" describe the same work until something is missing.
     */
    expect(stats.distribution.includedCount).toBe(2);
    expect(stats.distribution.mean).toBeCloseTo(95, 5);
    expect(stats.distributionGradedOnly.mean).toBeCloseTo(95, 5);
    expect(stats.distribution.assignmentsCounted).toBe(2);
    expect(stats.distribution.assignmentsWithGrades).toBe(2);
  });

  it('leaves an unpublished draft out of everybody denominator', async () => {
    prismaMock.roster.findMany.mockResolvedValue([rosterRow('s1')]);
    prismaMock.assignment.findMany.mockResolvedValue([
      assignment({ id: 'a1' }),
      assignment({ id: 'draft', title: 'Not out yet', isPublished: false }),
    ]);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([grade('s1', 'p1', 10, 'a1')]);

    const stats = (await getCourseStatistics('c1'))!;

    // Full marks on everything the class can see. Counting the draft would report 50%.
    expect(stats.distribution.mean).toBe(100);
    expect(stats.distribution.assignmentsCounted).toBe(1);
  });

  it('measures a group assignment in teams, not in the students inside them', async () => {
    prismaMock.roster.findMany.mockResolvedValue(
      ['u1', 'u2', 'u3'].map((userId) => rosterRow(userId)),
    );
    prismaMock.assignment.findMany.mockResolvedValue([
      assignment({ id: 'team', title: 'Group work', groupSetId: 'gs1' }),
    ]);
    prismaMock.groupMembership.findMany.mockResolvedValue([
      { userId: 'u1', groupId: 'g1', group: { groupSetId: 'gs1' } },
      { userId: 'u2', groupId: 'g1', group: { groupSetId: 'gs1' } },
      { userId: 'u3', groupId: 'g2', group: { groupSetId: 'gs1' } },
    ]);
    // The autograder fans one grade out to every member, so g1 has two identical rows.
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([
      grade('u1', 'p1', 10, 'team'),
      grade('u2', 'p1', 10, 'team'),
      grade('u3', 'p1', 5, 'team'),
    ]);

    const stats = (await getCourseStatistics('c1'))!;
    const row = stats.assignments.find((a) => a.id === 'team')!;

    // Two teams. Counted per student, the bigger team would have outweighed the smaller one
    // in a chart that looks like it is about difficulty.
    expect(row.unit).toBe('group');
    expect(row.gradedCount).toBe(2);
    expect(row.boxplot?.median).toBe(75);
    // Each student still carries the group's grade into their own course average.
    expect(stats.distribution.includedCount).toBe(3);
  });

  it('counts a problem set twice as two performances', async () => {
    prismaMock.roster.findMany.mockResolvedValue([rosterRow('s1')]);
    prismaMock.assignment.findMany.mockResolvedValue([
      assignment({ id: 'a1', problems: [problem('shared', 10, 'CFG')] }),
      // The same problem again on the midterm: a second occasion, not a repeat of the first.
      assignment({ id: 'midterm', title: 'Midterm', problems: [problem('shared', 10, 'CFG')] }),
    ]);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([
      grade('s1', 'shared', 10, 'a1'),
      grade('s1', 'shared', 4, 'midterm'),
    ]);

    const stats = (await getCourseStatistics('c1'))!;
    const cfg = stats.problemTypes.find((t) => t.type === 'CFG')!;

    expect(cfg.totalCount).toBe(2);
    expect(cfg.gradedCount).toBe(2);
    expect(cfg.boxplot?.median).toBe(70);
  });

  it('gives an untyped problem a bucket of its own', async () => {
    prismaMock.roster.findMany.mockResolvedValue([rosterRow('s1')]);
    prismaMock.assignment.findMany.mockResolvedValue([
      assignment({ problems: [problem('p1', 10, null)] }),
    ]);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([grade('s1', 'p1', 7)]);

    const stats = (await getCourseStatistics('c1'))!;

    expect(stats.problemTypes.map((t) => t.type)).toEqual(['untyped']);
  });

  it('counts the grading queue in pieces of work', async () => {
    prismaMock.roster.findMany.mockResolvedValue([rosterRow('s1'), rosterRow('s2')]);
    prismaMock.assignment.findMany.mockResolvedValue([
      assignment({ problems: [problem('p1'), problem('p2')] }),
    ]);
    // s1's first problem is marked; everything else is not.
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([grade('s1', 'p1', 10)]);
    prismaMock.submission.findMany.mockResolvedValue([
      {
        studentId: 's1',
        studentGroupId: null,
        assignmentId: 'a1',
        problemId: 'p2',
        submittedAt: new Date('2026-09-09T10:00:00Z'),
      },
    ]);

    const stats = (await getCourseStatistics('c1'))!;
    const row = stats.workload[0]!;
    const states = Object.fromEntries(row.states.map((s) => [s.key, s.count]));

    // Two students times two problems: four pieces of work, not two students.
    expect(row.total).toBe(4);
    expect(states.graded).toBe(1);
    expect(states['ungraded-submitted']).toBe(1);
    expect(states['ungraded-missing']).toBe(2);
  });

  it('marks every published deadline on the timeline', async () => {
    prismaMock.roster.findMany.mockResolvedValue([rosterRow('s1')]);
    prismaMock.assignment.findMany.mockResolvedValue([
      assignment({ id: 'a1' }),
      assignment({ id: 'a2', title: 'Homework 2', dueDate: new Date('2026-09-24T23:59:00Z') }),
      assignment({ id: 'draft', isPublished: false }),
    ]);
    prismaMock.submission.findMany.mockResolvedValue([
      {
        studentId: 's1',
        studentGroupId: null,
        assignmentId: 'a1',
        problemId: 'p1',
        submittedAt: new Date('2026-09-09T10:00:00Z'),
      },
    ]);

    const stats = (await getCourseStatistics('c1'))!;

    expect(stats.dueDates.map((d) => d.id)).toEqual(['a1', 'a2']);
    expect(stats.timeline.reduce((n, p) => n + p.count, 0)).toBe(1);
  });

  it('ignores submissions from students it does not count', async () => {
    prismaMock.roster.findMany.mockResolvedValue([
      rosterRow('s1'),
      rosterRow('gone', { status: 'DROPPED' }),
    ]);
    prismaMock.assignment.findMany.mockResolvedValue([assignment()]);
    prismaMock.submission.findMany.mockResolvedValue([
      {
        studentId: 'gone',
        studentGroupId: null,
        assignmentId: 'a1',
        problemId: 'p1',
        submittedAt: new Date('2026-09-09T10:00:00Z'),
      },
    ]);

    const stats = (await getCourseStatistics('c1'))!;

    // Their work is kept and stays reviewable; it is the figures about the current class
    // that they are not part of.
    expect(stats.timeline).toEqual([]);
  });

  it('judges each assignment against the date its participants are held to', async () => {
    prismaMock.roster.findMany.mockResolvedValue(
      ['ada', 'bob', 'cy', 'di'].map((userId) => rosterRow(userId)),
    );
    prismaMock.assignment.findMany.mockResolvedValue([assignment()]);
    // Di has an extension into the following week.
    prismaMock.assignmentOverride.findMany.mockResolvedValue([
      {
        assignmentId: 'a1',
        targetType: 'STUDENT',
        userId: 'di',
        groupId: null,
        unlockAt: null,
        dueDate: new Date('2026-09-17T23:59:00.000Z'),
        lateCutoff: null,
        allowLateSubmissions: null,
      },
    ]);
    const sent = (studentId: string, at: string) => ({
      studentId,
      studentGroupId: null,
      assignmentId: 'a1',
      problemId: 'p1',
      submittedAt: new Date(at),
    });
    prismaMock.submission.findMany.mockResolvedValue([
      sent('ada', '2026-09-09T10:00:00Z'),
      // In on time, then revised after the deadline: the later attempt is the one that holds
      // the grade, so this is neither simply on time nor simply late.
      sent('bob', '2026-09-09T10:00:00Z'),
      sent('bob', '2026-09-12T10:00:00Z'),
      sent('cy', '2026-09-12T09:00:00Z'),
      // Same moment as Cy, but Di has until the 17th.
      sent('di', '2026-09-12T09:00:00Z'),
    ]);

    const stats = (await getCourseStatistics('c1'))!;
    const row = stats.turnIn[0]!;
    const states = Object.fromEntries(row.states.map((s) => [s.key, s.count]));

    expect(states).toEqual({
      'on-time': 2, // Ada, and Di on her own date
      'revised-late': 1, // Bob
      late: 1, // Cy
      missing: 0,
    });
    expect(row.exceptions).toBe(1);
  });

  it('counts a whole group assignment against the group deadline', async () => {
    prismaMock.roster.findMany.mockResolvedValue(['u1', 'u2'].map((userId) => rosterRow(userId)));
    prismaMock.assignment.findMany.mockResolvedValue([
      assignment({ id: 'team', title: 'Group work', groupSetId: 'gs1' }),
    ]);
    prismaMock.groupMembership.findMany.mockResolvedValue([
      { userId: 'u1', groupId: 'g1', group: { groupSetId: 'gs1' } },
      { userId: 'u2', groupId: 'g2', group: { groupSetId: 'gs1' } },
    ]);
    prismaMock.assignmentOverride.findMany.mockResolvedValue([
      {
        assignmentId: 'team',
        targetType: 'GROUP',
        userId: null,
        groupId: 'g2',
        unlockAt: null,
        dueDate: new Date('2026-09-17T23:59:00.000Z'),
        lateCutoff: null,
        allowLateSubmissions: null,
      },
    ]);
    prismaMock.submission.findMany.mockResolvedValue(
      ['g1', 'g2'].map((groupId, i) => ({
        studentId: i === 0 ? 'u1' : 'u2',
        studentGroupId: groupId,
        assignmentId: 'team',
        problemId: 'p1',
        submittedAt: new Date('2026-09-12T09:00:00Z'),
      })),
    );

    const stats = (await getCourseStatistics('c1'))!;
    const states = Object.fromEntries(stats.turnIn[0]!.states.map((s) => [s.key, s.count]));

    // Same moment for both teams; only the one with the extension was on time.
    expect(states['on-time']).toBe(1);
    expect(states.late).toBe(1);
  });

  it('counts attempts by topic, starting again when a problem is met a second time', async () => {
    prismaMock.roster.findMany.mockResolvedValue([rosterRow('s1')]);
    prismaMock.assignment.findMany.mockResolvedValue([
      assignment({ id: 'a1', problems: [problem('shared', 10, 'CFG')] }),
      assignment({ id: 'midterm', title: 'Midterm', problems: [problem('shared', 10, 'CFG')] }),
    ]);
    const try_ = (assignmentId: string, at: string, correct: boolean, status = 'COMPLETED') => ({
      studentId: 's1',
      studentGroupId: null,
      assignmentId,
      problemId: 'shared',
      submittedAt: new Date(at),
      correct,
      status,
    });
    prismaMock.submission.findMany.mockResolvedValue([
      // First time round: wrong, then right. Two attempts.
      try_('a1', '2026-09-01T10:00:00Z', false),
      try_('a1', '2026-09-01T11:00:00Z', true),
      // The same problem on the midterm is a fresh run, not a third attempt at the first one.
      try_('midterm', '2026-10-01T10:00:00Z', true),
    ]);

    const stats = (await getCourseStatistics('c1'))!;
    const cfg = stats.attemptsByType.find((row) => row.type === 'CFG')!;
    const buckets = Object.fromEntries(cfg.attempts.buckets.map((b) => [b.label, b.count]));

    expect(cfg.attempts.solvedCount).toBe(2);
    expect(buckets['1']).toBe(1); // the midterm run
    expect(buckets['2']).toBe(1); // the first run
    expect(cfg.firstTry).toEqual({ correct: 1, submitted: 2 });
  });

  it('does not count an evaluation that failed as a try', async () => {
    prismaMock.roster.findMany.mockResolvedValue([rosterRow('s1')]);
    prismaMock.assignment.findMany.mockResolvedValue([
      assignment({ problems: [problem('p1', 10, 'FA')] }),
    ]);
    prismaMock.submission.findMany.mockResolvedValue([
      {
        studentId: 's1',
        studentGroupId: null,
        assignmentId: 'a1',
        problemId: 'p1',
        submittedAt: new Date('2026-09-01T10:00:00Z'),
        correct: false,
        status: 'FAILED',
      },
      {
        studentId: 's1',
        studentGroupId: null,
        assignmentId: 'a1',
        problemId: 'p1',
        submittedAt: new Date('2026-09-01T11:00:00Z'),
        correct: true,
        status: 'COMPLETED',
      },
    ]);

    const stats = (await getCourseStatistics('c1'))!;
    const fa = stats.attemptsByType.find((row) => row.type === 'FA')!;

    // Solved on their first real try: our broken run is not a mistake of theirs.
    expect(fa.attempts.buckets.find((b) => b.label === '1')!.count).toBe(1);
  });

  it('holds up in the first week of a course, with nothing in it', async () => {
    prismaMock.roster.findMany.mockResolvedValue([rosterRow('s1')]);

    const stats = (await getCourseStatistics('c1'))!;

    expect(stats.assignments).toEqual([]);
    expect(stats.problemTypes).toEqual([]);
    expect(stats.distribution.includedCount).toBe(0);
    expect(stats.atRisk).toEqual({ belowThreshold: 0, threshold: 60, missingTwoOrMore: 0 });
    expect(stats.turnIn).toEqual([]);
    expect(stats.attemptsByType).toEqual([]);
  });
});

/**
 * Where the two readings come apart.
 *
 * Without an assignment counting missing work as zero they describe the same work and show the
 * same number. Turn it on and the first reading starts counting what nobody handed in, which is
 * the whole point of having two.
 */
describe('the course average once missing work counts', () => {
  // The shared fixture's due date is in the future, so nothing is ever late against it. These
  // need a deadline that has actually passed.
  const PAST = new Date('2020-01-10T23:59:00.000Z');

  it('counts unsubmitted work against the student, and the other reading does not', async () => {
    prismaMock.roster.findMany.mockResolvedValue([rosterRow('s1')]);
    prismaMock.assignment.findMany.mockResolvedValue([
      assignment({ id: 'a1', missingWorkIsZero: true, dueDate: PAST }),
      assignment({ id: 'a2', title: 'Homework 2', missingWorkIsZero: true, dueDate: PAST }),
    ]);
    // Marked on the first and full marks; nothing at all on the second, past its deadline.
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([grade('s1', 'p1', 10, 'a1')]);
    prismaMock.submission.findMany.mockResolvedValue([]);

    const stats = (await getCourseStatistics('c1'))!;

    // 10 of 20: the work they did not hand in is in the denominator.
    expect(stats.distribution.mean).toBeCloseTo(50, 5);
    // 10 of 10: only what has been marked.
    expect(stats.distributionGradedOnly.mean).toBeCloseTo(100, 5);
  });

  it('leaves work they handed in but nobody has marked out of both', async () => {
    prismaMock.roster.findMany.mockResolvedValue([rosterRow('s1')]);
    prismaMock.assignment.findMany.mockResolvedValue([
      assignment({ id: 'a1', missingWorkIsZero: true, dueDate: PAST }),
      assignment({ id: 'a2', title: 'Homework 2', missingWorkIsZero: true, dueDate: PAST }),
    ]);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([grade('s1', 'p1', 10, 'a1')]);
    // They submitted the second one. It is waiting on a marker, so it is nobody's zero.
    prismaMock.submission.findMany.mockResolvedValue([
      {
        studentId: 's1',
        studentGroupId: null,
        assignmentId: 'a2',
        problemId: 'p1',
        submittedAt: PAST,
        correct: null,
        status: 'PENDING',
      },
    ]);

    const stats = (await getCourseStatistics('c1'))!;

    expect(stats.distribution.mean).toBeCloseTo(100, 5);
    expect(stats.distributionGradedOnly.mean).toBeCloseTo(100, 5);
  });
});

/**
 * The scoping bug, from the statistics side.
 *
 * `missing-work` reads an empty group list as the exemption: on a group assignment, being in
 * no group means there was no way to submit, so no zero. This service asked the membership
 * table with no filter at all, so a student whose only group was in another course came back
 * looking like a group member here, lost the exemption, and had a zero folded into the course
 * average that the professor then read as their performance.
 */
describe('a student whose only group is in another set', () => {
  it('is not made accountable for group work they had no way to hand in', async () => {
    prismaMock.roster.findMany.mockResolvedValue([rosterRow('u1')]);
    prismaMock.assignment.findMany.mockResolvedValue([
      // Marked work, so this student has a percentage at all: one with no graded cell is left
      // out of the distribution entirely, derived zeros or not.
      assignment({ id: 'a1', problems: [problem('p1', 10)] }),
      // Group work, past due, counting unsubmitted as zero.
      assignment({
        id: 'a2',
        title: 'Group Lab',
        groupSetId: 'gs1',
        missingWorkIsZero: true,
        // The shared DUE is a future date, and a future deadline stops the rule at
        // "not due yet" before it ever reaches the question about groups.
        dueDate: new Date('2020-01-01T00:00:00.000Z'),
        problems: [problem('p2', 10)],
      }),
    ]);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([grade('u1', 'p1', 10, 'a1')]);
    // u1 is in a group, but it belongs to a different set: another course's teams. They are in
    // no group for a2, so they could not have submitted it and it must not count against them.
    setMemberships([{ groupSetId: 'some-other-set', userId: 'u1', groupId: 'gOther' }]);

    const stats = (await getCourseStatistics('c1'))!;

    // 10 of 10, the work actually asked of them. Attributing the other set's group to this
    // assignment made a2 accountable too and reported this student at 50%.
    expect(stats.distribution.includedCount).toBe(1);
    expect(stats.distribution.mean).toBeCloseTo(100, 5);
  });

  it("asks the membership table only for this course's own sets", async () => {
    prismaMock.roster.findMany.mockResolvedValue([rosterRow('u1')]);
    prismaMock.assignment.findMany.mockResolvedValue([assignment({ groupSetId: 'gs1' })]);
    setMemberships([]);

    await getCourseStatistics('c1');

    // It used to pass no `where` whatsoever, so one course's statistics page read every
    // membership row in the installation. Five universities share one deployment.
    expect(prismaMock.groupMembership.findMany.mock.calls[0][0]).toMatchObject({
      where: { groupSetId: { in: ['gs1'] } },
    });
  });
});

/**
 * What the course statistics reads are scoped to.
 *
 * Given a course id, every read here has to stay inside it: the cohort, the assignments, the
 * overrides and grades those assignments produced, and the submissions. The prisma mocks
 * answer from their fixtures whatever the `where` says, so nothing above notices a missing
 * key: without the `courseId` the roster read is every student in the installation, and the
 * submission read is every attempt ever made. This service already shipped one bug of exactly
 * that shape (an unscoped membership read), so the queries are asserted whole.
 */
describe('what the course statistics reads are scoped to', () => {
  const whereOf = (fn: { mock: { calls: unknown[][] } }) =>
    (fn.mock.calls[0][0] as { where: unknown }).where;

  it('keeps the cohort, the work, and the attempts inside this course', async () => {
    prismaMock.roster.findMany.mockResolvedValue([rosterRow('s1')]);
    prismaMock.assignment.findMany.mockResolvedValue([
      {
        id: 'a1',
        title: 'A1',
        dueDate: DUE,
        unlockAt: null,
        lateCutoff: null,
        allowLateSubmissions: false,
        isPublished: true,
        assignedToEveryone: true,
        missingWorkIsZero: false,
        groupSetId: null,
        assignees: [],
        problems: [problem('p1')],
      },
    ]);

    await getCourseStatistics('c1');

    expect(whereOf(prismaMock.roster.findMany)).toEqual({ courseId: 'c1', role: 'STUDENT' });
    expect(whereOf(prismaMock.assignment.findMany)).toEqual({ courseId: 'c1' });
    expect(whereOf(prismaMock.submission.findMany)).toEqual({ courseId: 'c1' });
    // The rows hanging off those assignments, bounded by the ids this course produced.
    expect(whereOf(prismaMock.assignmentOverride.findMany)).toEqual({
      assignmentId: { in: ['a1'] },
    });
    expect(whereOf(prismaMock.assignmentProblemGrade.findMany)).toEqual({
      assignmentId: { in: ['a1'] },
    });
  });
});
