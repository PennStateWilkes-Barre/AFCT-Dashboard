import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  submission: { groupBy: vi.fn(), findMany: vi.fn() },
}));
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

import { findSubmissionMatches } from './matches';

const student = (id: string) => ({
  id,
  firstName: id.toUpperCase(),
  lastName: 'Student',
  avatar: null,
  cropX: null,
  cropY: null,
  zoom: null,
});

const submission = (over: Record<string, unknown>) => ({
  id: 'sub',
  problemId: 'p1',
  contentHash: 'hash-a',
  shapeHash: 'shape-a',
  // Null by default, which is what every submission stored before the column existed has.
  byteHash: null,
  assignmentId: 'a1',
  submittedAt: new Date('2026-08-14T12:00:00Z'),
  correct: null,
  // Null unless a case says otherwise: an attempt that never reached a result, and also
  // every attempt graded before the result time was recorded.
  evaluatedAt: null,
  fileName: 'stored.jff',
  originalFileName: 'answer.jff',
  studentId: 's1',
  studentGroupId: null,
  student: student('s1'),
  studentGroup: null,
  ...over,
});

const problems = new Map([
  ['p1', { title: 'Even zeros', type: 'FA' }],
  ['p2', { title: 'a^n b^n', type: 'CFG' }],
]);

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.submission.findMany.mockResolvedValue([]);
});

/**
 * The third check reads a second time, for every submission that carries a description,
 * and then once more to number the attempts. This drives those two calls without disturbing
 * the exact-match ones above.
 */
function withNearMatchRows(rows: Record<string, unknown>[]) {
  prismaMock.submission.findMany.mockImplementation(async (args: Record<string, any>) => {
    if (args?.where?.provenanceFeatures) return rows;
    // The attempt-numbering read.
    if (args?.select?.studentId && !args?.select?.student) {
      return rows.map((row) => ({
        id: row.id,
        problemId: row.problemId,
        studentId: row.studentId,
      }));
    }
    return [];
  });
}

/**
 * A class who each solved it their own way. Without them the two submissions under test are
 * the whole cohort, every feature they share is held by 100% of it, and the rarity rule
 * quite correctly finds nothing unusual about any of it.
 */
const nearCrowd = () =>
  Array.from({ length: 10 }, (_, index) =>
    nearRow({
      id: `crowd-${index}`,
      studentId: `crowd-student-${index}`,
      shapeHash: `crowd-shape-${index}`,
      contentHash: `crowd-hash-${index}`,
      student: student(`crowd-student-${index}`),
      provenanceFeatures: {
        version: 1,
        machineType: 'fa',
        stateCount: 4,
        transitionCount: 5,
        features: [`f:s:own-${index}`, `f:e:own-${index}`, `t:${index}>${index + 1}`],
      },
    }),
  );

const nearRow = (over: Record<string, unknown> = {}) => ({
  id: 'near-1',
  problemId: 'p1',
  studentId: 's1',
  studentGroupId: null,
  submittedAt: new Date('2026-08-15T12:00:00Z'),
  correct: true,
  assignmentId: 'a1',
  fileName: 'stored.jff',
  originalFileName: 'mine.jff',
  contentHash: 'hash-1',
  shapeHash: 'shape-1',
  provenanceFeatures: {
    version: 1,
    machineType: 'fa',
    stateCount: 4,
    transitionCount: 5,
    features: ['f:s:odd-a', 'f:e:odd-b', 't:4>7', 't:7>4', 'g:3,-2'],
  },
  student: student('s1'),
  studentGroup: null,
  ...over,
});

describe('findSubmissionMatches', () => {
  it('asks for nothing when the assignment has no problems', async () => {
    await expect(findSubmissionMatches('a1', [], problems)).resolves.toEqual([]);
    expect(prismaMock.submission.groupBy).not.toHaveBeenCalled();
  });

  it('reports a group when two students share the same content', async () => {
    prismaMock.submission.groupBy.mockResolvedValue([
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's1' },
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's2' },
      { problemId: 'p1', shapeHash: 'shape-b', contentHash: 'hash-b', studentId: 's3' },
    ]);
    prismaMock.submission.findMany.mockResolvedValue([
      submission({ id: 'sub-1', studentId: 's1', student: student('s1') }),
      submission({ id: 'sub-2', studentId: 's2', student: student('s2') }),
    ]);

    const [group, ...rest] = await findSubmissionMatches('a1', ['p1'], problems);

    expect(rest).toHaveLength(0);
    expect(group).toMatchObject({
      problem: { id: 'p1', title: 'Even zeros' },
      studentCount: 2,
      // s1, s2 and s3 all submitted this problem.
      problemStudentCount: 3,
    });
    expect(group?.submissions.map((s) => s.id)).toEqual(['sub-1', 'sub-2']);
  });

  it('does not treat one student resubmitting the same file as a match', async () => {
    prismaMock.submission.groupBy.mockResolvedValue([
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's1' },
    ]);

    await expect(findSubmissionMatches('a1', ['p1'], problems)).resolves.toEqual([]);
    // Nothing shared, so it never goes back for the submissions an exact match would need.
    // The third check still runs, which is the whole point of it.
    const exactReads = prismaMock.submission.findMany.mock.calls.filter(
      (call) => (call[0] as { where?: { OR?: unknown } } | undefined)?.where?.OR,
    );
    expect(exactReads).toHaveLength(0);
  });

  it('counts a student once however many times they submitted', async () => {
    prismaMock.submission.groupBy.mockResolvedValue([
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's1' },
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's2' },
    ]);
    prismaMock.submission.findMany.mockResolvedValue([
      submission({ id: 'sub-1', studentId: 's1', student: student('s1') }),
      submission({ id: 'sub-2', studentId: 's1', student: student('s1') }),
      submission({ id: 'sub-3', studentId: 's2', student: student('s2') }),
    ]);

    const [group] = await findSubmissionMatches('a1', ['p1'], problems);

    expect(group?.studentCount).toBe(2);
    expect(group?.submissions).toHaveLength(3);
  });

  it('puts the rare match above the one most of the class shares', async () => {
    // p2 is a grammar everybody wrote the same way; p1 is shared by exactly two.
    prismaMock.submission.groupBy.mockResolvedValue([
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's1' },
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's2' },
      ...['s1', 's2', 's3', 's4', 's5'].map((studentId) => ({
        problemId: 'p2',
        shapeHash: 'shape-c',
        contentHash: 'hash-c',
        studentId,
      })),
    ]);
    prismaMock.submission.findMany.mockResolvedValue([
      submission({ id: 'sub-1', problemId: 'p1', studentId: 's1', student: student('s1') }),
      submission({ id: 'sub-2', problemId: 'p1', studentId: 's2', student: student('s2') }),
      ...['s1', 's2', 's3', 's4', 's5'].map((id, index) => ({
        ...submission({
          id: `sub-c${index}`,
          problemId: 'p2',
          shapeHash: 'shape-c',
          contentHash: 'hash-c',
          studentId: id,
          student: student(id),
        }),
      })),
    ]);

    const groups = await findSubmissionMatches('a1', ['p1', 'p2'], problems);

    expect(groups.map((g) => [g.problem.id, g.studentCount, g.problemStudentCount])).toEqual([
      ['p1', 2, 2],
      ['p2', 5, 5],
    ]);
  });

  it('never groups across problems, even for identical content', async () => {
    // The same grammar submitted to two different problems is two separate questions.
    prismaMock.submission.groupBy.mockResolvedValue([
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's1' },
      { problemId: 'p2', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's2' },
    ]);

    await expect(findSubmissionMatches('a1', ['p1', 'p2'], problems)).resolves.toEqual([]);
  });

  it('says how close together two students submitted, ignoring their own resubmissions', async () => {
    prismaMock.submission.groupBy.mockResolvedValue([
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's1' },
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's2' },
    ]);
    prismaMock.submission.findMany.mockResolvedValue([
      submission({
        id: 'sub-1',
        studentId: 's1',
        student: student('s1'),
        submittedAt: new Date('2026-08-14T12:00:00Z'),
      }),
      // The same student again a minute later: closer, but not two people.
      submission({
        id: 'sub-2',
        studentId: 's1',
        student: student('s1'),
        submittedAt: new Date('2026-08-14T12:01:00Z'),
      }),
      submission({
        id: 'sub-3',
        studentId: 's2',
        student: student('s2'),
        submittedAt: new Date('2026-08-14T12:06:00Z'),
      }),
    ]);

    const [group] = await findSubmissionMatches('a1', ['p1'], problems);

    expect(group?.closestGapMs).toBe(5 * 60 * 1000);
  });

  it('ignores teammates on a group assignment holding the same file', async () => {
    // Every member's submit writes its own row against the shared set, so a whole team
    // matching itself is the feature working rather than anything to report.
    prismaMock.submission.groupBy.mockResolvedValue([
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's1' },
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's2' },
    ]);
    prismaMock.submission.findMany.mockResolvedValue([
      submission({ id: 'sub-1', studentId: 's1', student: student('s1'), studentGroupId: 'g1' }),
      submission({ id: 'sub-2', studentId: 's2', student: student('s2'), studentGroupId: 'g1' }),
    ]);

    await expect(findSubmissionMatches('a1', ['p1'], problems)).resolves.toEqual([]);
  });

  it('still reports a match that reaches outside the team', async () => {
    prismaMock.submission.groupBy.mockResolvedValue([
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's1' },
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's2' },
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's3' },
    ]);
    prismaMock.submission.findMany.mockResolvedValue([
      submission({ id: 'sub-1', studentId: 's1', student: student('s1'), studentGroupId: 'g1' }),
      submission({ id: 'sub-2', studentId: 's2', student: student('s2'), studentGroupId: 'g1' }),
      // Not on that team.
      submission({ id: 'sub-3', studentId: 's3', student: student('s3'), studentGroupId: null }),
    ]);

    const [group] = await findSubmissionMatches('a1', ['p1'], problems);

    expect(group?.studentCount).toBe(3);
  });

  it('groups a file that was redrawn or renamed with the one it came from', async () => {
    // Same machine, different bytes: dragged nodes, or states renamed.
    prismaMock.submission.groupBy.mockResolvedValue([
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's1' },
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-moved', studentId: 's2' },
    ]);
    prismaMock.submission.findMany.mockResolvedValue([
      submission({ id: 'sub-1', studentId: 's1', student: student('s1') }),
      submission({ id: 'sub-2', studentId: 's2', student: student('s2'), contentHash: 'hash-moved' }),
    ]);

    const [group] = await findSubmissionMatches('a1', ['p1'], problems);

    expect(group?.studentCount).toBe(2);
    // Nobody submitted the same FILE, so the group says so.
    expect(group?.identicalStudentCount).toBe(1);
    expect(group?.submissions.map((s) => s.contentKey)).toEqual(['hash-a', 'hash-mov']);
  });

  it('says how many of a match submitted the same file once formatting is set aside', async () => {
    prismaMock.submission.groupBy.mockResolvedValue([
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's1' },
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's2' },
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-moved', studentId: 's3' },
    ]);
    prismaMock.submission.findMany.mockResolvedValue([
      submission({ id: 'sub-1', studentId: 's1', student: student('s1') }),
      submission({ id: 'sub-2', studentId: 's2', student: student('s2') }),
      submission({ id: 'sub-3', studentId: 's3', student: student('s3'), contentHash: 'hash-moved' }),
    ]);

    const [group] = await findSubmissionMatches('a1', ['p1'], problems);

    expect(group?.studentCount).toBe(3);
    expect(group?.identicalStudentCount).toBe(2);
  });

  it('says how many of a match are identical byte for byte', async () => {
    // All three saved the same work; two of them saved the same bytes. The third differs only
    // in the ways the exact fingerprint is built to ignore, which is why the two counts differ.
    prismaMock.submission.groupBy.mockResolvedValue([
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's1' },
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's2' },
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's3' },
    ]);
    prismaMock.submission.findMany.mockResolvedValue([
      submission({ id: 'sub-1', studentId: 's1', student: student('s1'), byteHash: 'bytes-a' }),
      submission({ id: 'sub-2', studentId: 's2', student: student('s2'), byteHash: 'bytes-a' }),
      submission({ id: 'sub-3', studentId: 's3', student: student('s3'), byteHash: 'bytes-b' }),
    ]);

    const [group] = await findSubmissionMatches('a1', ['p1'], problems);

    expect(group?.identicalStudentCount).toBe(3);
    expect(group?.byteIdenticalStudentCount).toBe(2);
    // Identical bytes are identical contents, so the strict count can never exceed the other.
    expect(group?.byteIdenticalStudentCount).toBeLessThanOrEqual(group?.identicalStudentCount ?? 0);
  });

  it('claims nothing about bytes for submissions that were never hashed', async () => {
    // Rows from before the column existed. Bucketing their missing hashes together would
    // report them as the same file, which is the overclaim the check exists to remove.
    prismaMock.submission.groupBy.mockResolvedValue([
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's1' },
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's2' },
    ]);
    prismaMock.submission.findMany.mockResolvedValue([
      submission({ id: 'sub-1', studentId: 's1', student: student('s1') }),
      submission({ id: 'sub-2', studentId: 's2', student: student('s2') }),
    ]);

    const [group] = await findSubmissionMatches('a1', ['p1'], problems);

    expect(group?.identicalStudentCount).toBe(2);
    expect(group?.byteIdenticalStudentCount).toBe(1);
  });

  it('still matches a regular expression, which has no shape to speak of', async () => {
    prismaMock.submission.groupBy.mockResolvedValue([
      { problemId: 'p1', shapeHash: null, contentHash: 'hash-re', studentId: 's1' },
      { problemId: 'p1', shapeHash: null, contentHash: 'hash-re', studentId: 's2' },
    ]);
    prismaMock.submission.findMany.mockResolvedValue([
      submission({ id: 'sub-1', studentId: 's1', student: student('s1'), shapeHash: null, contentHash: 'hash-re' }),
      submission({ id: 'sub-2', studentId: 's2', student: student('s2'), shapeHash: null, contentHash: 'hash-re' }),
    ]);

    const [group] = await findSubmissionMatches('a1', ['p1'], problems);

    expect(group?.studentCount).toBe(2);
    expect(group?.identicalStudentCount).toBe(2);
  });

  it('flags work submitted after another student\'s copy had already been marked correct', async () => {
    prismaMock.submission.groupBy.mockResolvedValue([
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's1' },
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's2' },
    ]);
    prismaMock.submission.findMany.mockResolvedValue([
      submission({
        id: 'sub-1',
        studentId: 's1',
        student: student('s1'),
        correct: true,
        submittedAt: new Date('2026-08-14T12:00:00Z'),
        // The mark existed at 12:05, which is the moment the claim is about.
        evaluatedAt: new Date('2026-08-14T12:05:00Z'),
      }),
      submission({
        id: 'sub-2',
        studentId: 's2',
        student: student('s2'),
        correct: true,
        submittedAt: new Date('2026-08-14T12:30:00Z'),
        evaluatedAt: new Date('2026-08-14T12:31:00Z'),
      }),
    ]);

    const [group] = await findSubmissionMatches('a1', ['p1'], problems);

    expect(group?.reusedAfterPass).toBe(true);
  });

  it('does not claim reuse when the earlier attempt had not been marked yet', async () => {
    // Alice submits at 12:00 and her result lands at 12:05. Bob submits at 12:01. Comparing
    // submission times would call that reuse; there was nothing to reuse yet.
    prismaMock.submission.groupBy.mockResolvedValue([
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's1' },
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's2' },
    ]);
    prismaMock.submission.findMany.mockResolvedValue([
      submission({
        id: 'sub-1',
        studentId: 's1',
        student: student('s1'),
        correct: true,
        submittedAt: new Date('2026-08-14T12:00:00Z'),
        evaluatedAt: new Date('2026-08-14T12:05:00Z'),
      }),
      submission({
        id: 'sub-2',
        studentId: 's2',
        student: student('s2'),
        correct: true,
        submittedAt: new Date('2026-08-14T12:01:00Z'),
        evaluatedAt: new Date('2026-08-14T12:06:00Z'),
      }),
    ]);

    const [group] = await findSubmissionMatches('a1', ['p1'], problems);

    expect(group?.reusedAfterPass).toBe(false);
  });

  it('says nothing about reuse for work graded before result times were recorded', async () => {
    // Historical rows: correct, but nobody knows when the mark appeared.
    prismaMock.submission.groupBy.mockResolvedValue([
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's1' },
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's2' },
    ]);
    prismaMock.submission.findMany.mockResolvedValue([
      submission({
        id: 'sub-1',
        studentId: 's1',
        student: student('s1'),
        correct: true,
        submittedAt: new Date('2026-08-14T12:00:00Z'),
      }),
      submission({
        id: 'sub-2',
        studentId: 's2',
        student: student('s2'),
        correct: true,
        submittedAt: new Date('2026-08-14T14:00:00Z'),
      }),
    ]);

    const [group] = await findSubmissionMatches('a1', ['p1'], problems);

    expect(group?.reusedAfterPass).toBe(false);
  });

  it('never calls a student\'s own resubmission a reuse, or an incorrect result a pass', async () => {
    prismaMock.submission.groupBy.mockResolvedValue([
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's1' },
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's2' },
    ]);
    prismaMock.submission.findMany.mockResolvedValue([
      // s1 passed, then submitted the same work again: their own work, not a reuse.
      submission({
        id: 'sub-1',
        studentId: 's1',
        student: student('s1'),
        correct: true,
        submittedAt: new Date('2026-08-14T12:00:00Z'),
        evaluatedAt: new Date('2026-08-14T12:01:00Z'),
      }),
      submission({
        id: 'sub-1b',
        studentId: 's1',
        student: student('s1'),
        correct: true,
        submittedAt: new Date('2026-08-14T12:10:00Z'),
        evaluatedAt: new Date('2026-08-14T12:11:00Z'),
      }),
      // s2's copy arrived after an INCORRECT result of their own, which proves nothing.
      submission({
        id: 'sub-2',
        studentId: 's2',
        student: student('s2'),
        correct: false,
        submittedAt: new Date('2026-08-14T11:00:00Z'),
        evaluatedAt: new Date('2026-08-14T11:01:00Z'),
      }),
    ]);

    const [group] = await findSubmissionMatches('a1', ['p1'], problems);

    // s1's pass at 12:01 precedes nobody else's submission, so there is nothing to claim.
    expect(group?.reusedAfterPass).toBe(false);
  });

  it('does not flag it when the first copy had not passed', async () => {
    prismaMock.submission.groupBy.mockResolvedValue([
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's1' },
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's2' },
    ]);
    prismaMock.submission.findMany.mockResolvedValue([
      submission({
        id: 'sub-1',
        studentId: 's1',
        student: student('s1'),
        correct: false,
        submittedAt: new Date('2026-08-14T12:00:00Z'),
      }),
      submission({
        id: 'sub-2',
        studentId: 's2',
        student: student('s2'),
        correct: false,
        submittedAt: new Date('2026-08-14T12:30:00Z'),
      }),
    ]);

    const [group] = await findSubmissionMatches('a1', ['p1'], problems);

    expect(group?.reusedAfterPass).toBe(false);
  });

  it('does not flag a student resubmitting their own passing file', async () => {
    prismaMock.submission.groupBy.mockResolvedValue([
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's1' },
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's2' },
    ]);
    prismaMock.submission.findMany.mockResolvedValue([
      submission({ id: 'sub-1', studentId: 's1', student: student('s1'), correct: true, submittedAt: new Date('2026-08-14T12:00:00Z') }),
      submission({ id: 'sub-2', studentId: 's1', student: student('s1'), correct: true, submittedAt: new Date('2026-08-14T12:30:00Z') }),
      // The other student got there first, so nothing here was reused from a pass.
      submission({ id: 'sub-3', studentId: 's2', student: student('s2'), correct: null, submittedAt: new Date('2026-08-14T11:00:00Z') }),
    ]);

    const [group] = await findSubmissionMatches('a1', ['p1'], problems);

    expect(group?.reusedAfterPass).toBe(false);
  });

  it('needs the identical file, not merely the same work redrawn', async () => {
    prismaMock.submission.groupBy.mockResolvedValue([
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's1' },
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-moved', studentId: 's2' },
    ]);
    prismaMock.submission.findMany.mockResolvedValue([
      submission({ id: 'sub-1', studentId: 's1', student: student('s1'), correct: true, submittedAt: new Date('2026-08-14T12:00:00Z') }),
      submission({
        id: 'sub-2',
        studentId: 's2',
        student: student('s2'),
        contentHash: 'hash-moved',
        correct: true,
        submittedAt: new Date('2026-08-14T12:30:00Z'),
      }),
    ]);

    const [group] = await findSubmissionMatches('a1', ['p1'], problems);

    expect(group?.reusedAfterPass).toBe(false);
  });

  it('puts a reused pass above a rarer ordinary match', async () => {
    prismaMock.submission.groupBy.mockResolvedValue([
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's1' },
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's2' },
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's3' },
      { problemId: 'p2', shapeHash: 'shape-z', contentHash: 'hash-z', studentId: 's4' },
      { problemId: 'p2', shapeHash: 'shape-z', contentHash: 'hash-z', studentId: 's5' },
    ]);
    prismaMock.submission.findMany.mockResolvedValue([
      // Three students, so ordinarily this would sort below the pair below.
      submission({ id: 'sub-1', studentId: 's1', student: student('s1'), correct: true, submittedAt: new Date('2026-08-14T12:00:00Z'), evaluatedAt: new Date('2026-08-14T12:02:00Z') }),
      submission({ id: 'sub-2', studentId: 's2', student: student('s2'), correct: true, submittedAt: new Date('2026-08-14T12:30:00Z'), evaluatedAt: new Date('2026-08-14T12:32:00Z') }),
      submission({ id: 'sub-3', studentId: 's3', student: student('s3'), correct: true, submittedAt: new Date('2026-08-14T13:00:00Z'), evaluatedAt: new Date('2026-08-14T13:02:00Z') }),
      submission({ id: 'sub-4', problemId: 'p2', shapeHash: 'shape-z', contentHash: 'hash-z', studentId: 's4', student: student('s4') }),
      submission({ id: 'sub-5', problemId: 'p2', shapeHash: 'shape-z', contentHash: 'hash-z', studentId: 's5', student: student('s5') }),
    ]);

    const groups = await findSubmissionMatches('a1', ['p1', 'p2'], problems);

    expect(groups[0]?.problem.id).toBe('p1');
    expect(groups[0]?.reusedAfterPass).toBe(true);
  });

  it('knows when the matching work is the problem\'s own answer file', async () => {
    prismaMock.submission.groupBy.mockResolvedValue([
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's1' },
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's2' },
    ]);
    prismaMock.submission.findMany.mockResolvedValue([
      submission({ id: 'sub-1', studentId: 's1', student: student('s1') }),
      submission({ id: 'sub-2', studentId: 's2', student: student('s2') }),
    ]);

    const withAnswer = new Map([
      ['p1', { title: 'Even zeros', type: 'FA', answerContentHash: 'hash-a', answerShapeHash: null }],
    ]);

    const [group] = await findSubmissionMatches('a1', ['p1'], withAnswer);

    expect(group?.matchesAnswerFile).toBe(true);
  });

  it('reports a near match for two submissions the exact checks left behind', async () => {
    prismaMock.submission.groupBy.mockResolvedValue([]);
    withNearMatchRows([
      ...nearCrowd(),
      nearRow(),
      nearRow({
        id: 'near-2',
        studentId: 's2',
        shapeHash: 'shape-2',
        contentHash: 'hash-2',
        student: student('s2'),
        submittedAt: new Date('2026-08-15T12:20:00Z'),
      }),
    ]);

    const [group, ...rest] = await findSubmissionMatches('a1', ['p1'], problems);

    expect(rest).toHaveLength(0);
    expect(group).toMatchObject({ kind: 'near', studentCount: 2, identicalStudentCount: 1 });
    expect(group?.evidence.length).toBeGreaterThan(0);
    expect(group?.submissions.map((s) => s.id).sort()).toEqual(['near-1', 'near-2']);
  });

  it('never says a structural match is work reused after a pass', async () => {
    // The earlier student's work was marked correct long before the later submission, but
    // these two are not copies of each other: that is what makes it a structural match. What
    // passed is not what was submitted, so the sentence would describe something else.
    prismaMock.submission.groupBy.mockResolvedValue([]);
    withNearMatchRows([
      ...nearCrowd(),
      nearRow({
        correct: true,
        submittedAt: new Date('2026-08-15T10:00:00Z'),
        evaluatedAt: new Date('2026-08-15T10:01:00Z'),
      }),
      nearRow({
        id: 'near-2',
        studentId: 's2',
        shapeHash: 'shape-2',
        contentHash: 'hash-2',
        student: student('s2'),
        submittedAt: new Date('2026-08-15T12:20:00Z'),
      }),
    ]);

    const [group] = await findSubmissionMatches('a1', ['p1'], problems);

    expect(group?.kind).toBe('near');
    expect(group?.reusedAfterPass).toBe(false);
  });

  it('ignores a description written under rules this code does not know', async () => {
    prismaMock.submission.groupBy.mockResolvedValue([]);
    withNearMatchRows([
      ...nearCrowd(),
      nearRow({ provenanceFeatures: { ...nearRow().provenanceFeatures, version: 99 } }),
      nearRow({
        id: 'near-2',
        studentId: 's2',
        shapeHash: 'shape-2',
        student: student('s2'),
        provenanceFeatures: { ...nearRow().provenanceFeatures, version: 99 },
      }),
    ]);

    await expect(findSubmissionMatches('a1', ['p1'], problems)).resolves.toEqual([]);
  });

  it('does not repeat a pair the shape check already matched', async () => {
    prismaMock.submission.groupBy.mockResolvedValue([]);
    withNearMatchRows([
      ...nearCrowd(),
      nearRow(),
      nearRow({ id: 'near-2', studentId: 's2', student: student('s2') }),
    ]);

    // Both carry shape-1, so they are already one match; saying it again here adds nothing.
    await expect(findSubmissionMatches('a1', ['p1'], problems)).resolves.toEqual([]);
  });

  it('says nothing about a pair when the cohort is too small for anything to be unusual', async () => {
    prismaMock.submission.groupBy.mockResolvedValue([]);
    // Two students and nobody else: everything they share is held by the whole class.
    withNearMatchRows([
      nearRow(),
      nearRow({ id: 'near-2', studentId: 's2', shapeHash: 'shape-2', student: student('s2') }),
    ]);

    await expect(findSubmissionMatches('a1', ['p1'], problems)).resolves.toEqual([]);
  });

  it('only looks at submissions that have a hash, in this assignment', async () => {
    prismaMock.submission.groupBy.mockResolvedValue([]);

    await findSubmissionMatches('a1', ['p1'], problems);

    expect(prismaMock.submission.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { assignmentId: 'a1', problemId: { in: ['p1'] }, contentHash: { not: null } },
      }),
    );
  });

  it('never reaches into another assignment that sets the same problem', async () => {
    // A problem is reusable, so the same question can be set again next term or in another
    // section. Two students who never took the same assignment are not a match, so the
    // assignment is part of every read, not just the problem.
    prismaMock.submission.groupBy.mockResolvedValue([
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's1', studentGroupId: null },
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's2', studentGroupId: null },
    ]);
    prismaMock.submission.findMany.mockResolvedValue([
      submission({ id: 'sub-1', studentId: 's1', student: student('s1') }),
      submission({ id: 'sub-2', studentId: 's2', student: student('s2') }),
    ]);

    await findSubmissionMatches('a1', ['p1'], problems);

    // Every read is narrowed the same way: the group-by, the matched rows, the attempt
    // numbering and the provenance read the third check runs over.
    for (const call of prismaMock.submission.findMany.mock.calls) {
      expect((call[0] as { where: { assignmentId?: string } }).where.assignmentId).toBe('a1');
    }
    expect(prismaMock.submission.findMany).toHaveBeenCalled();
  });

  it('numbers attempts within this assignment, not across every assignment', async () => {
    prismaMock.submission.groupBy.mockResolvedValue([
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's1', studentGroupId: null },
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's2', studentGroupId: null },
    ]);
    prismaMock.submission.findMany.mockResolvedValue([
      submission({ id: 'sub-1', studentId: 's1', student: student('s1') }),
      submission({ id: 'sub-2', studentId: 's2', student: student('s2') }),
    ]);

    await findSubmissionMatches('a1', ['p1'], problems);

    const attemptRead = prismaMock.submission.findMany.mock.calls.find(
      (call) => (call[0] as { select?: Record<string, unknown> })?.select?.studentId &&
        !(call[0] as { select?: Record<string, unknown> })?.select?.student,
    );
    expect((attemptRead?.[0] as { where: { assignmentId: string } }).where.assignmentId).toBe('a1');
  });
});

/**
 * What the similarity reads are scoped to.
 *
 * Similarity compares one assignment's attempts against each other. Every read is bounded by
 * that assignment and by the problems it was asked about; the attempt-number read is bounded
 * by the exact (problem, student) pairs it already matched. The prisma mock answers from its
 * fixture whatever the `where` says, so a dropped key here would quietly compare a student's
 * work against attempts from another assignment (or another course entirely) and report the
 * overlap as if it meant something.
 */
describe('what the similarity reads are scoped to', () => {
  const findManyWheres = () =>
    prismaMock.submission.findMany.mock.calls.map((c) => (c[0] as { where: unknown }).where);

  it('bounds the exact-match, attempt-number and provenance reads to this assignment', async () => {
    prismaMock.submission.groupBy.mockResolvedValue([
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's1' },
      { problemId: 'p1', shapeHash: 'shape-a', contentHash: 'hash-a', studentId: 's2' },
    ]);
    prismaMock.submission.findMany.mockImplementation(
      async (args: { where?: { provenanceFeatures?: unknown } }) =>
        args?.where?.provenanceFeatures
          ? [nearRow()]
          : [
              submission({ id: 'sub-1', studentId: 's1', student: student('s1') }),
              submission({ id: 'sub-2', studentId: 's2', student: student('s2') }),
            ],
    );

    await findSubmissionMatches('a1', ['p1'], problems);

    const wheres = findManyWheres();
    // Every read names the assignment, whichever of the three it is.
    for (const w of wheres) expect(w).toMatchObject({ assignmentId: 'a1' });

    const exact = wheres.find((w) => (w as { OR?: unknown }).OR && !isPairList(w));
    expect(exact).toMatchObject({ assignmentId: 'a1', problemId: { in: ['p1'] } });

    const provenance = wheres.find((w) => (w as { provenanceFeatures?: unknown }).provenanceFeatures);
    expect(provenance).toMatchObject({ assignmentId: 'a1', problemId: { in: ['p1'] } });

    // The attempt-number read is bounded by the exact (problem, student) pairs it matched,
    // which is what makes "their third attempt" mean their third at this problem.
    const attempts = wheres.find(isPairList);
    expect(attempts).toEqual({
      assignmentId: 'a1',
      OR: [
        { problemId: 'p1', studentId: 's1' },
        { problemId: 'p1', studentId: 's2' },
      ],
    });
  });
});

/** The attempt-number read is the one whose `OR` is a list of (problemId, studentId) pairs. */
function isPairList(where: unknown): boolean {
  const or = (where as { OR?: unknown[] } | undefined)?.OR;
  return (
    Array.isArray(or) &&
    or.length > 0 &&
    or.every((clause) => {
      const c = clause as Record<string, unknown>;
      return typeof c.problemId === 'string' && typeof c.studentId === 'string';
    })
  );
}
