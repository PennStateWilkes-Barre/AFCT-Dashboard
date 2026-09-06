import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  assignment: { findMany: vi.fn() },
  assignmentProblem: { findMany: vi.fn() },
  assignmentProblemGrade: { findMany: vi.fn() },
  submission: { groupBy: vi.fn(), findMany: vi.fn() },
  submissionGrant: { findMany: vi.fn() },
  groupMembership: { findMany: vi.fn() },
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

import { getStudentCourseAssignments } from './student-assignments';
import { assignedToStudentWhere } from '@/lib/assignment-visibility';

const studentOverride = (over: Record<string, unknown>) => ({
  targetType: 'STUDENT',
  userId: 'stu-1',
  groupId: null,
  unlockAt: null,
  dueDate: null,
  lateCutoff: null,
  allowLateSubmissions: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.assignmentProblem.findMany.mockResolvedValue([
    {
      assignmentId: 'a1',
      maxPoints: 10,
      maxSubmissions: 1,
      problem: { id: 'p1', title: 'P1', type: 'FA', autograderEnabled: true },
    },
  ]);
  prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);
  prismaMock.submission.groupBy.mockResolvedValue([]);
  prismaMock.submission.findMany.mockResolvedValue([]);
  prismaMock.submissionGrant.findMany.mockResolvedValue([]);
  prismaMock.groupMembership.findMany.mockResolvedValue([]);
});

describe('getStudentCourseAssignments', () => {
  it('applies the student due-date override', async () => {
    prismaMock.assignment.findMany.mockResolvedValue([
      {
        id: 'a1',
        title: 'A1',
        description: 'desc',
        unlockAt: null,
        dueDate: new Date('2026-01-10T23:59:00.000Z'),
        allowLateSubmissions: false,
        lateCutoff: null,
        overrides: [studentOverride({ dueDate: new Date('2026-01-20T23:59:00.000Z') })],
      },
    ]);

    const result = await getStudentCourseAssignments('stu-1', 'c1');

    expect(result[0].dueDate).toEqual(new Date('2026-01-20T23:59:00.000Z'));
    expect(result[0].locked).toBe(false);
    expect(result[0].problems).toHaveLength(1);
  });

  it('raises maxSubmissions by the grants that apply to this student', async () => {
    prismaMock.assignment.findMany.mockResolvedValue([
      {
        id: 'a1',
        title: 'A1',
        description: 'desc',
        unlockAt: null,
        dueDate: new Date('2026-01-10T23:59:00.000Z'),
        allowLateSubmissions: false,
        lateCutoff: null,
        overrides: [],
      },
    ]);
    prismaMock.submissionGrant.findMany.mockResolvedValue([
      {
        assignmentId: 'a1',
        problemId: 'p1',
        targetType: 'STUDENT',
        userId: 'stu-1',
        groupId: null,
        extraSubmissions: 2,
      },
      // Someone else's grant must not leak into this student's cap.
      {
        assignmentId: 'a1',
        problemId: 'p1',
        targetType: 'STUDENT',
        userId: 'stu-2',
        groupId: null,
        extraSubmissions: 5,
      },
    ]);

    const result = await getStudentCourseAssignments('stu-1', 'c1');

    expect(result[0].problems[0].maxSubmissions).toBe(3); // base 1 + granted 2
  });

  it('locks description and problems before unlock', async () => {
    prismaMock.assignment.findMany.mockResolvedValue([
      {
        id: 'a1',
        title: 'A1',
        description: 'secret',
        unlockAt: new Date('2999-01-01T00:00:00.000Z'), // far future
        dueDate: new Date('2999-01-08T00:00:00.000Z'),
        allowLateSubmissions: false,
        lateCutoff: null,
        overrides: [],
      },
    ]);

    const result = await getStudentCourseAssignments('stu-1', 'c1');

    expect(result[0].locked).toBe(true);
    expect(result[0].description).toBeNull();
    expect(result[0].problems).toEqual([]);
  });

  it('re-sorts by the effective due date (an extension moves the assignment later)', async () => {
    prismaMock.assignment.findMany.mockResolvedValue([
      {
        id: 'a1',
        title: 'A1 base earlier',
        description: null,
        unlockAt: null,
        dueDate: new Date('2026-01-05T23:59:00.000Z'),
        allowLateSubmissions: false,
        lateCutoff: null,
        // This student is extended past a2's due date.
        overrides: [studentOverride({ dueDate: new Date('2026-02-01T23:59:00.000Z') })],
      },
      {
        id: 'a2',
        title: 'A2 base later',
        description: null,
        unlockAt: null,
        dueDate: new Date('2026-01-10T23:59:00.000Z'),
        allowLateSubmissions: false,
        lateCutoff: null,
        overrides: [],
      },
    ]);
    prismaMock.assignmentProblem.findMany.mockResolvedValue([]);

    const result = await getStudentCourseAssignments('stu-1', 'c1');

    // a2 (Jan 10) now comes before a1 (extended to Feb 1).
    expect(result.map((a) => a.id)).toEqual(['a2', 'a1']);
  });
});

/**
 * This list is shared by the student's web grades page and the desktop client's assignment
 * endpoint, so a zero shown in one and a blank in the other is a disagreement students would
 * meet daily.
 */
describe('work nobody handed in', () => {
  const overdue = (over: Record<string, unknown> = {}) => ({
    id: 'a1',
    title: 'A1',
    description: 'desc',
    groupSetId: null,
    unlockAt: null,
    dueDate: new Date('2026-01-10T23:59:00.000Z'),
    allowLateSubmissions: false,
    lateCutoff: null,
    missingWorkIsZero: true,
    isPublished: true,
    course: { isArchived: false },
    overrides: [],
    ...over,
  });

  const problemRow = {
    assignmentId: 'a1',
    problemId: 'p1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    maxPoints: 10,
    maxSubmissions: 3,
    autograderEnabled: true,
    problem: {
      id: 'p1',
      title: 'P1',
      description: null,
      descriptionJson: null,
      type: 'RE',
      maxStates: null,
      isDeterministic: null,
    },
  };

  it('scores it zero and marks it, once the deadline has passed', async () => {
    prismaMock.assignment.findMany.mockResolvedValue([overdue()]);
    prismaMock.assignmentProblem.findMany.mockResolvedValue([problemRow]);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);
    prismaMock.submission.groupBy.mockResolvedValue([]);

    const [assignment] = await getStudentCourseAssignments('stu-1', 'c1');

    expect(assignment.problems[0].grade).toBe(0);
    expect(assignment.problems[0].missing).toBe(true);
  });

  it('leaves work they handed in alone', async () => {
    prismaMock.assignment.findMany.mockResolvedValue([overdue()]);
    prismaMock.assignmentProblem.findMany.mockResolvedValue([problemRow]);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);
    prismaMock.submission.groupBy.mockResolvedValue([
      { assignmentId: 'a1', problemId: 'p1', _count: { id: 1 } },
    ]);

    const [assignment] = await getStudentCourseAssignments('stu-1', 'c1');

    expect(assignment.problems[0].grade).toBeNull();
    expect(assignment.problems[0].missing).toBe(false);
  });

  it('respects an extension that has not run out', async () => {
    prismaMock.assignment.findMany.mockResolvedValue([
      overdue({ overrides: [studentOverride({ dueDate: new Date('2099-01-01T00:00:00.000Z') })] }),
    ]);
    prismaMock.assignmentProblem.findMany.mockResolvedValue([problemRow]);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);
    prismaMock.submission.groupBy.mockResolvedValue([]);

    const [assignment] = await getStudentCourseAssignments('stu-1', 'c1');

    expect(assignment.problems[0].grade).toBeNull();
    expect(assignment.problems[0].missing).toBe(false);
  });
});

/**
 * A grant aimed at a group, seen from the student's side.
 *
 * The number a student is shown and the number the submit path enforces have to be the same
 * number. They are computed by the same resolver but from separately fetched group ids, and
 * this is the side that decides what the page says: a cap shown too low costs an attempt the
 * student had, one shown too high is the "told 5, blocked at 3" complaint.
 */
describe('extra attempts granted to a group', () => {
  const groupAssignment = (over: Record<string, unknown> = {}) => ({
    id: 'a1',
    title: 'Group Lab',
    description: 'desc',
    unlockAt: null,
    dueDate: new Date('2026-01-10T23:59:00.000Z'),
    allowLateSubmissions: false,
    lateCutoff: null,
    groupSetId: 'gs1',
    overrides: [],
    ...over,
  });

  const groupGrant = (groupId: string, extraSubmissions = 2) => ({
    assignmentId: 'a1',
    problemId: 'p1',
    targetType: 'GROUP' as const,
    userId: null,
    groupId,
    extraSubmissions,
  });

  it('raises the cap for a member of the group it was granted to', async () => {
    prismaMock.assignment.findMany.mockResolvedValue([groupAssignment()]);
    prismaMock.groupMembership.findMany.mockResolvedValue([{ groupSetId: 'gs1', groupId: 'g1' }]);
    prismaMock.submissionGrant.findMany.mockResolvedValue([groupGrant('g1')]);

    const result = await getStudentCourseAssignments('stu-1', 'c1');

    expect(result[0].problems[0].maxSubmissions).toBe(3); // base 1 + granted 2
  });

  it('leaves a non-member on the base cap', async () => {
    prismaMock.assignment.findMany.mockResolvedValue([groupAssignment()]);
    // In the set, but in a different group from the one that was granted the extras.
    prismaMock.groupMembership.findMany.mockResolvedValue([{ groupSetId: 'gs1', groupId: 'g2' }]);
    prismaMock.submissionGrant.findMany.mockResolvedValue([groupGrant('g1')]);

    const result = await getStudentCourseAssignments('stu-1', 'c1');

    expect(result[0].problems[0].maxSubmissions).toBe(1);
  });

  it('ignores a grant to a group of theirs in some other set', async () => {
    prismaMock.assignment.findMany.mockResolvedValue([groupAssignment()]);
    // Their group in another course. The grant query is deliberately broad (it matches any
    // group the student is in), so the set scoping has to happen when the cap is resolved.
    prismaMock.groupMembership.findMany.mockResolvedValue([
      { groupSetId: 'some-other-set', groupId: 'gOther' },
    ]);
    prismaMock.submissionGrant.findMany.mockResolvedValue([groupGrant('gOther')]);

    const result = await getStudentCourseAssignments('stu-1', 'c1');

    expect(result[0].problems[0].maxSubmissions).toBe(1);
  });

  it('does not apply a group grant to an individual assignment', async () => {
    prismaMock.assignment.findMany.mockResolvedValue([groupAssignment({ groupSetId: null })]);
    prismaMock.groupMembership.findMany.mockResolvedValue([{ groupSetId: 'gs1', groupId: 'g1' }]);
    prismaMock.submissionGrant.findMany.mockResolvedValue([groupGrant('g1')]);

    const result = await getStudentCourseAssignments('stu-1', 'c1');

    expect(result[0].problems[0].maxSubmissions).toBe(1);
  });

  it('adds a student grant and a group grant together, the way the submit path does', async () => {
    prismaMock.assignment.findMany.mockResolvedValue([groupAssignment()]);
    prismaMock.groupMembership.findMany.mockResolvedValue([{ groupSetId: 'gs1', groupId: 'g1' }]);
    prismaMock.submissionGrant.findMany.mockResolvedValue([
      groupGrant('g1', 2),
      {
        assignmentId: 'a1',
        problemId: 'p1',
        targetType: 'STUDENT' as const,
        userId: 'stu-1',
        groupId: null,
        extraSubmissions: 3,
      },
    ]);

    const result = await getStudentCourseAssignments('stu-1', 'c1');

    expect(result[0].problems[0].maxSubmissions).toBe(6); // base 1 + 2 + 3
  });
});

/**
 * The query's own gate, asserted rather than assumed.
 *
 * The prisma mock answers whatever it is told to regardless of the `where`, so nothing about
 * these fixtures notices if the gate goes: deleting the audience filter outright left the whole
 * suite green while a student could read work assigned to other people. This feeds the grades
 * page and the native client, so that is a disclosure, not a display bug.
 */
describe('what the assignment query is scoped to', () => {
  const whereOf = () =>
    (prismaMock.assignment.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;

  it('asks only for published work assigned to this student', async () => {
    await getStudentCourseAssignments('stu-1', 'c1');

    const where = whereOf();
    expect(where).toMatchObject({ courseId: 'c1', isPublished: true });
    // Directly, by an assignee row, or through a group: the shared definition, not a copy.
    expect(where).toMatchObject(assignedToStudentWhere('stu-1'));
  });

  it('drops both gates only when a privileged caller asks it to', async () => {
    await getStudentCourseAssignments('stu-1', 'c1', {
      includeUnpublished: true,
      includeUnassigned: true,
    });

    const where = whereOf();
    expect(where).toEqual({ courseId: 'c1' });
  });

  it('keeps the audience gate when only the publish gate is widened', async () => {
    // Staff previewing drafts still must not be handed somebody else's audience by accident.
    await getStudentCourseAssignments('stu-1', 'c1', { includeUnpublished: true });

    const where = whereOf();
    expect(where).not.toHaveProperty('isPublished');
    expect(where).toMatchObject(assignedToStudentWhere('stu-1'));
  });
});
