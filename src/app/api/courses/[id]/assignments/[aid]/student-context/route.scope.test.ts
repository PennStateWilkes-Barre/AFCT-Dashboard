/**
 * Whose work this route hands back, asserted on the query rather than on the fixtures.
 *
 * A file of its own, next to the main spec, the way DiscussionPanel splits its audience and
 * avatar concerns. Two reasons: the main spec is already long, and both this and the logging
 * work were appending to its end at the same time, which is a merge conflict for no reason.
 *
 * The prisma mock returns whatever it is given regardless of the `where`, so no fixture
 * notices if a scope goes: deleting the clause that limits submissions to the caller and their
 * group left every test in the main spec passing while the route returned the whole class's
 * attempts. That is other students' work, so it is the query that has to be checked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMock = vi.hoisted(() => vi.fn());
const contentGateMock = vi.hoisted(() => vi.fn());
const prismaMock = vi.hoisted(() => ({
  assignment: { findFirst: vi.fn() },
  roster: { findFirst: vi.fn() },
  submission: { findMany: vi.fn() },
  comment: { findMany: vi.fn() },
  assignmentProblemGrade: { findMany: vi.fn() },
  submissionGrant: { findMany: vi.fn() },
  groupMembership: { findFirst: vi.fn() },
  studentGroup: { findUnique: vi.fn() },
}));

vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/assignment-student-gate', () => ({
  resolveStudentContentGate: contentGateMock,
}));

import { GET } from './route';

const url = 'http://localhost/api/courses/c1/assignments/a1/student-context';

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.roster.findFirst.mockResolvedValue(null);
  prismaMock.submissionGrant.findMany.mockResolvedValue([]);
  prismaMock.groupMembership.findFirst.mockResolvedValue(null);
  prismaMock.studentGroup.findUnique.mockResolvedValue(null);
  contentGateMock.mockResolvedValue({ assigned: true, locked: false, unlockAt: null });
});

describe('what this route is scoped to', () => {
  const setup = (groupSetId: string | null, membership: boolean) => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue({
      id: 'r1',
      role: 'STUDENT',
      course: { isPublished: true },
    });
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      isPublished: true,
      groupSetId,
      missingWorkIsZero: false,
      dueDate: new Date('2026-03-05T00:00:00.000Z'),
      unlockAt: null,
      lateCutoff: null,
      allowLateSubmissions: false,
      assignedToEveryone: true,
      course: { isArchived: false },
      overrides: [],
      problems: [
        {
          problemId: 'p1',
          maxSubmissions: 3,
          showFeedback: true,
          maxPoints: 10,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
    });
    if (membership) {
      prismaMock.groupMembership.findFirst.mockResolvedValue({ groupId: 'g1' });
      prismaMock.studentGroup.findUnique.mockResolvedValue({
        id: 'g1',
        name: 'Team 1',
        memberships: [{ roster: { user: { id: 'u1', firstName: 'Ada', lastName: 'L' } } }],
      });
    }
    prismaMock.submission.findMany.mockResolvedValue([]);
    prismaMock.comment.findMany.mockResolvedValue([]);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);
  };

  const submissionWhere = () =>
    (prismaMock.submission.findMany.mock.calls[0][0] as { where: { OR?: unknown[] } }).where;

  const read = () => GET(new Request(url), { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });

  it("asks only for this student's own attempts on an individual assignment", async () => {
    setup(null, false);

    await read();

    expect(submissionWhere().OR).toEqual([{ studentId: 'u1' }]);
  });

  it("adds their group's shared set on a group assignment, and nobody else's", async () => {
    setup('gs1', true);

    await read();

    expect(submissionWhere().OR).toEqual([{ studentId: 'u1' }, { studentGroupId: 'g1' }]);
  });

  it('asks for no group set when the student is in no group', async () => {
    setup('gs1', false);

    await read();

    // Never an unscoped group clause: that would hand them another group's work.
    expect(submissionWhere().OR).toEqual([{ studentId: 'u1' }]);
  });

  it('only ever asks for grades belonging to this student', async () => {
    setup(null, false);

    await read();

    expect(prismaMock.assignmentProblemGrade.findMany.mock.calls[0][0]).toMatchObject({
      where: { studentId: 'u1' },
    });
  });

  /**
   * The assignment and its problems bound every one of these reads as well as the student
   * does. Without them a student would be handed their own attempts, comments, grades and
   * grants from every assignment in the installation, which is the same page showing work
   * from a course they are not even in. Asserted as whole `where` objects so a key going
   * missing fails here rather than passing quietly.
   */
  const whereOf = (fn: { mock: { calls: unknown[][] } }) =>
    (fn.mock.calls[0][0] as { where: unknown }).where;

  it('bounds every read to this assignment and its problems', async () => {
    setup(null, false);

    await read();

    expect(whereOf(prismaMock.submission.findMany)).toEqual({
      assignmentId: 'a1',
      problemId: { in: ['p1'] },
      OR: [{ studentId: 'u1' }],
    });
    expect(whereOf(prismaMock.comment.findMany)).toEqual({
      assignmentId: 'a1',
      problemId: { in: ['p1'] },
      OR: [{ aboutStudentId: 'u1' }, { authorId: 'u1' }],
    });
    expect(whereOf(prismaMock.assignmentProblemGrade.findMany)).toEqual({
      assignmentId: 'a1',
      studentId: 'u1',
      problemId: { in: ['p1'] },
    });
    expect(whereOf(prismaMock.submissionGrant.findMany)).toEqual({
      assignmentId: 'a1',
      problemId: { in: ['p1'] },
      OR: [{ userId: 'u1' }],
    });
  });

  it("adds the caller's own group, and only theirs, to the comment and grant reads", async () => {
    setup('gs1', true);

    await read();

    expect(whereOf(prismaMock.comment.findMany)).toEqual({
      assignmentId: 'a1',
      problemId: { in: ['p1'] },
      OR: [{ aboutStudentId: 'u1' }, { authorId: 'u1' }, { aboutGroupId: 'g1' }],
    });
    expect(whereOf(prismaMock.submissionGrant.findMany)).toEqual({
      assignmentId: 'a1',
      problemId: { in: ['p1'] },
      OR: [{ userId: 'u1' }, { groupId: 'g1' }],
    });
  });

  it("looks up the caller's membership in this assignment's group set only", async () => {
    setup('gs1', true);

    await read();

    expect(whereOf(prismaMock.groupMembership.findFirst)).toEqual({
      userId: 'u1',
      groupSetId: 'gs1',
    });
  });
});
