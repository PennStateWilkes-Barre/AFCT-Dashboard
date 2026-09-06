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
  // Assigned and open by default; the audience/unlock cases override it.
  contentGateMock.mockResolvedValue({ assigned: true, locked: false, unlockAt: null });
});

describe('GET /api/courses/[id]/assignments/[aid]/student-context', () => {
  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);

    const res = await GET(new Request(url), { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });

    expect(res.status).toBe(401);
  });

  it('returns 403 when the user is not on the course roster', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue(null);

    const res = await GET(new Request(url), { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });

    expect(res.status).toBe(403);
  });

  it('returns 404 when assignment does not exist in the course', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue({
      id: 'r1',
      role: 'STUDENT',
      course: { isPublished: true },
    });
    prismaMock.assignment.findFirst.mockResolvedValue(null);

    const res = await GET(new Request(url), { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });

    expect(res.status).toBe(404);
    expect(prismaMock.assignment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'a1', courseId: 'c1' } }),
    );
  });

  it('returns grouped student context', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue({
      id: 'r1',
      role: 'STUDENT',
      course: { isPublished: true },
    });
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      isPublished: true,
      problems: [
        { problemId: 'p1', showFeedback: true },
        { problemId: 'p2', showFeedback: true },
      ],
    });
    prismaMock.submission.findMany.mockResolvedValue([
      {
        id: 's1',
        submittedAt: new Date('2026-03-01T10:00:00.000Z'),
        grade: 95,
        feedback: 'Nice',
        correct: true,
        fileName: 'f.jff',
        originalFileName: 'orig.jff',
        problemId: 'p1',
      },
    ]);
    prismaMock.comment.findMany.mockResolvedValue([
      {
        id: 'c1',
        content: 'LGTM',
        createdAt: new Date('2026-03-01T11:00:00.000Z'),
        problemId: 'p1',
        author: { id: 'faculty-1', firstName: 'Ada', lastName: 'Lovelace' },
        roster: { role: 'FACULTY' },
      },
    ]);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([{ problemId: 'p1', grade: 95 }]);

    const res = await GET(new Request(url), { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assignmentGrade).toBe(95);
    expect(body.submissionCount).toBe(1);
    expect(body.submissionsByProblem.p1).toHaveLength(1);
    expect(body.submissionsByProblem.p2).toHaveLength(0);
    expect(body.commentsByProblem.p1).toHaveLength(1);
    expect(body.commentsByProblem.p2).toHaveLength(0);
  });

  it('returns 404 when an unpublished assignment is requested by a student', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue({
      id: 'r1',
      role: 'STUDENT',
      course: { isPublished: true },
    });
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      isPublished: false,
      problems: [],
    });

    const res = await GET(new Request(url), { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });

    expect(res.status).toBe(404);
  });

  it('buckets submissions and comments for problems not in the assignment list', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue({
      id: 'r1',
      role: 'STUDENT',
      course: { isPublished: true },
    });
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      isPublished: true,
      problems: [{ problemId: 'p1' }],
    });
    // Submission/comment reference 'p2', which was not pre-seeded from the problem list.
    prismaMock.submission.findMany.mockResolvedValue([
      {
        id: 's1',
        submittedAt: new Date('2026-03-01T10:00:00.000Z'),
        feedback: null,
        correct: null,
        fileName: 'f.jff',
        originalFileName: 'orig.jff',
        problemId: 'p2',
        status: 'PENDING',
      },
    ]);
    prismaMock.comment.findMany.mockResolvedValue([
      {
        id: 'c1',
        content: 'note',
        createdAt: new Date('2026-03-01T11:00:00.000Z'),
        problemId: 'p2',
        author: { id: 'admin-1', firstName: 'Al', lastName: 'Min' },
        roster: null,
      },
    ]);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);

    const res = await GET(new Request(url), { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.submissionsByProblem.p2).toHaveLength(1);
    expect(body.commentsByProblem.p2).toHaveLength(1);
    // No grades -> assignmentGrade stays null.
    expect(body.assignmentGrade).toBeNull();
  });

  it('returns 500 when a data fetch fails', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue({
      id: 'r1',
      role: 'STUDENT',
      course: { isPublished: true },
    });
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      isPublished: true,
      problems: [{ problemId: 'p1' }],
    });
    prismaMock.submission.findMany.mockRejectedValue(new Error('db down'));

    const res = await GET(new Request(url), { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });

    expect(res.status).toBe(500);
  });

  it('masks an assignment the student is not assigned as 404', async () => {
    // Course membership plus published used to be the whole check, so any enrolled
    // student who guessed a published id got back the assignment's problem ids.
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue({
      id: 'r1',
      role: 'STUDENT',
      course: { isPublished: true },
    });
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      isPublished: true,
      problems: [
        { problemId: 'p1', showFeedback: true },
        { problemId: 'p2', showFeedback: true },
      ],
    });
    contentGateMock.mockResolvedValue({ assigned: false, locked: true, unlockAt: null });

    const res = await GET(new Request(url), { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });

    expect(res.status).toBe(404);
    // Nothing was queried for a caller who should not know it exists.
    expect(prismaMock.submission.findMany).not.toHaveBeenCalled();
  });

  it('returns an empty locked context before the student unlock time', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue({
      id: 'r1',
      role: 'STUDENT',
      course: { isPublished: true },
    });
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      isPublished: true,
      problems: [{ problemId: 'p1' }],
    });
    contentGateMock.mockResolvedValue({ assigned: true, locked: true, unlockAt: new Date() });

    const res = await GET(new Request(url), { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });
    const body = await res.json();

    // 200 rather than 404: it legitimately exists for them, it just is not open yet.
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ locked: true, submissionCount: 0, problemGrades: {} });
    // The problem ids must not come back either - they are useful keys elsewhere.
    expect(body.submissionsByProblem).toEqual({});
  });
});

/**
 * The switch that decides whether a student reads the evaluator's witness string.
 *
 * This is the route the student's problem workspace is built from, so it is the one that matters
 * most. Staff read the same route when they look at a student's page, and must keep everything.
 */
describe('GET student context, feedback visibility', () => {
  const asStudentOn = (showFeedback: boolean, submission: Record<string, unknown> = {}) => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue({
      id: 'r1',
      role: 'STUDENT',
      course: { isPublished: true },
    });
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      isPublished: true,
      problems: [{ problemId: 'p1', showFeedback }],
    });
    prismaMock.submission.findMany.mockResolvedValue([
      {
        id: 's1',
        submittedAt: new Date('2026-03-01T10:00:00.000Z'),
        feedback: 'The string aab is accepted but should be rejected.',
        correct: false,
        status: 'COMPLETED',
        fileName: 'f.jff',
        originalFileName: 'orig.jff',
        problemId: 'p1',
        ...submission,
      },
    ]);
    prismaMock.comment.findMany.mockResolvedValue([]);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);
  };

  const read = async () => {
    const res = await GET(new Request(url), { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });
    expect(res.status).toBe(200);
    return (await res.json()).submissionsByProblem.p1[0];
  };

  it('sends the feedback when the problem shows it', async () => {
    asStudentOn(true);

    expect(await read()).toMatchObject({
      feedback: 'The string aab is accepted but should be rejected.',
      feedbackVisible: true,
    });
  });

  it('withholds it when the problem does not', async () => {
    asStudentOn(false);

    // Null, and said to be withheld. Without the flag the workspace renders "No feedback",
    // which tells the student the evaluator had nothing to say.
    expect(await read()).toMatchObject({ feedback: null, feedbackVisible: false });
  });

  it('still explains a run that failed', async () => {
    asStudentOn(false, { status: 'FAILED', feedback: 'The file could not be parsed.' });

    expect(await read()).toMatchObject({
      feedback: 'The file could not be parsed.',
      feedbackVisible: true,
    });
  });

  it('keeps everything for staff looking at the same page', async () => {
    asStudentOn(false);
    // Course staff, reading a student's work. The feedback is stored for them by design.
    prismaMock.roster.findFirst.mockResolvedValue({
      id: 'r1',
      role: 'FACULTY',
      course: { isPublished: true },
    });

    expect(await read()).toMatchObject({
      feedback: 'The string aab is accepted but should be rejected.',
      feedbackVisible: true,
    });
  });
});

/**
 * The student's own view of work they did not hand in.
 *
 * The number here and the cell their professor reads in the gradebook have to be the same one, so
 * this route applies the same resolver rather than its own reading of the setting.
 */
describe('GET student context, missing work', () => {
  const DUE = new Date('2026-03-01T00:00:00.000Z');

  const setup = (over: Record<string, unknown> = {}, submissions: unknown[] = []) => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue({
      id: 'r1',
      role: 'STUDENT',
      course: { isPublished: true },
    });
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      isPublished: true,
      groupSetId: null,
      missingWorkIsZero: true,
      dueDate: DUE,
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
      ...over,
    });
    prismaMock.submission.findMany.mockResolvedValue(submissions);
    prismaMock.comment.findMany.mockResolvedValue([]);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);
  };

  const read = async () => {
    const res = await GET(new Request(url), { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });
    expect(res.status).toBe(200);
    return res.json();
  };

  it('scores work they never handed in as zero, and says which', async () => {
    setup();

    const body = await read();
    expect(body.problemGrades.p1).toBe(0);
    expect(body.missingProblems).toEqual(['p1']);
    // And the total agrees, which is the number their professor sees in the gradebook cell.
    expect(body.assignmentGrade).toBe(0);
  });

  it('leaves work they handed in alone while it waits to be marked', async () => {
    setup({}, [
      {
        id: 's1',
        submittedAt: DUE,
        feedback: null,
        correct: null,
        status: 'PENDING',
        fileName: 'f.jff',
        originalFileName: 'f.jff',
        problemId: 'p1',
      },
    ]);

    const body = await read();
    expect(body.problemGrades.p1).toBeNull();
    expect(body.missingProblems).toEqual([]);
    expect(body.assignmentGrade).toBeNull();
  });

  it('says nothing while the assignment does not ask for it', async () => {
    setup({ missingWorkIsZero: false });

    const body = await read();
    expect(body.problemGrades.p1).toBeNull();
    expect(body.missingProblems).toEqual([]);
  });
});

/**
 * Group work is the only case where "who submitted this" is a real question: the caller is
 * looking at their whole group's attempts, and on an individual assignment every row would
 * name the reader.
 */
describe('GET student context, group work', () => {
  const submission = (over: Record<string, unknown> = {}) => ({
    id: 's1',
    submittedAt: new Date('2026-03-01T10:00:00.000Z'),
    feedback: null,
    feedbackVisible: true,
    correct: true,
    fileName: 'a.jff',
    originalFileName: 'a.jff',
    problemId: 'p1',
    status: 'COMPLETED',
    student: { firstName: 'Ada', lastName: 'Lovelace' },
    ...over,
  });

  const setup = (groupSetId: string | null) => {
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
    if (groupSetId) {
      prismaMock.groupMembership.findFirst.mockResolvedValue({ groupId: 'g1' });
      prismaMock.studentGroup.findUnique.mockResolvedValue({
        id: 'g1',
        name: 'Team Turing',
        memberships: [
          { roster: { user: { id: 'u1', firstName: 'Grace', lastName: 'Hopper' } } },
          { roster: { user: { id: 'u2', firstName: 'Ada', lastName: 'Lovelace' } } },
        ],
      });
    }
    prismaMock.submission.findMany.mockResolvedValue([submission()]);
    prismaMock.comment.findMany.mockResolvedValue([]);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);
  };

  const read = async () => {
    const res = await GET(new Request(url), { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });
    expect(res.status).toBe(200);
    return res.json();
  };

  it('names who made each attempt on a group assignment', async () => {
    setup('gs1');

    const body = await read();
    expect(body.submissionsByProblem.p1[0].submittedBy).toBe('Ada Lovelace');
  });

  it("names the group and the caller's groupmates, the caller excluded", async () => {
    setup('gs1');

    const body = await read();
    expect(body.group).toEqual({ id: 'g1', name: 'Team Turing' });
    // The caller is left out of the list; the card names them separately as the reader.
    expect(body.groupMembers).toEqual([{ id: 'u2', firstName: 'Ada', lastName: 'Lovelace' }]);
  });

  it('omits the submitter on an individual assignment, where it would name the reader', async () => {
    setup(null);

    const body = await read();
    expect(body.submissionsByProblem.p1[0]).not.toHaveProperty('submittedBy');
    expect(body.group).toBeNull();
    expect(body.groupMembers).toEqual([]);
  });

  it('falls back to Unknown rather than an empty cell when the submitter has no name', async () => {
    setup('gs1');
    prismaMock.submission.findMany.mockResolvedValue([
      submission({ student: { firstName: null, lastName: null } }),
    ]);

    const body = await read();
    expect(body.submissionsByProblem.p1[0].submittedBy).toBe('Unknown');
  });
});

/**
 * The cap the assignment page shows, with extra attempts granted.
 *
 * This is the number beside "Max Submissions" on the problem a student is about to submit to,
 * so it has to be the one the submit path will actually enforce. Both go through
 * `effectiveMaxSubmissions`, but each fetches its own group ids, and that is where the two
 * have drifted apart before.
 */
describe('GET student context, granted attempts', () => {
  const setup = (over: { groupSetId?: string | null; membership?: boolean } = {}) => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue({
      id: 'r1',
      role: 'STUDENT',
      course: { isPublished: true },
    });
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      isPublished: true,
      groupSetId: over.groupSetId === undefined ? 'gs1' : over.groupSetId,
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
          maxSubmissions: 2,
          showFeedback: true,
          maxPoints: 10,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
    });
    if (over.membership !== false) {
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

  const read = async () => {
    const res = await GET(new Request(url), { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });
    expect(res.status).toBe(200);
    return res.json();
  };

  const grant = (over: Record<string, unknown>) => ({
    problemId: 'p1',
    targetType: 'STUDENT',
    userId: 'u1',
    groupId: null,
    extraSubmissions: 3,
    ...over,
  });

  it('raises the cap by a grant made to the student', async () => {
    setup();
    prismaMock.submissionGrant.findMany.mockResolvedValue([grant({})]);

    const body = await read();
    expect(body.problemLimits.p1).toEqual({ max: 5, granted: 3 }); // base 2 + 3
  });

  it("raises the cap by a grant made to the student's group", async () => {
    setup();
    prismaMock.submissionGrant.findMany.mockResolvedValue([
      grant({ targetType: 'GROUP', userId: null, groupId: 'g1', extraSubmissions: 2 }),
    ]);

    const body = await read();
    expect(body.problemLimits.p1).toEqual({ max: 4, granted: 2 });
  });

  it('ignores a grant to a group the student is not in', async () => {
    setup();
    prismaMock.submissionGrant.findMany.mockResolvedValue([
      grant({ targetType: 'GROUP', userId: null, groupId: 'someone-elses-group' }),
    ]);

    const body = await read();
    expect(body.problemLimits.p1).toEqual({ max: 2, granted: 0 });
  });

  it('ignores a group grant when the student is in no group at all', async () => {
    setup({ membership: false });
    prismaMock.submissionGrant.findMany.mockResolvedValue([
      grant({ targetType: 'GROUP', userId: null, groupId: 'g1' }),
    ]);

    const body = await read();
    expect(body.problemLimits.p1).toEqual({ max: 2, granted: 0 });
  });
});

/**
 * Feedback written to a group has to reach the group.
 *
 * On group work the schema expects staff to address the group rather than each member, so the
 * shared submission carries one thread. The staff review route has always matched
 * `aboutGroupId`; this one matched only the caller's own name, so an instructor's comment on
 * group work was written, stored, shown back to the instructor, and seen by nobody it was for.
 */
describe('GET student context, comments on group work', () => {
  const setup = (membership: boolean) => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue({
      id: 'r1',
      role: 'STUDENT',
      course: { isPublished: true },
    });
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      isPublished: true,
      groupSetId: 'gs1',
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

  const whereOfCommentQuery = () =>
    (prismaMock.comment.findMany.mock.calls[0][0] as { where: { OR: unknown[] } }).where;

  it("asks for comments addressed to the caller's group", async () => {
    setup(true);

    await GET(new Request(url), { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });

    expect(whereOfCommentQuery().OR).toContainEqual({ aboutGroupId: 'g1' });
  });

  it('still asks for their own, which is all an individual assignment has', async () => {
    setup(true);

    await GET(new Request(url), { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });

    const or = whereOfCommentQuery().OR;
    expect(or).toContainEqual({ aboutStudentId: 'u1' });
    expect(or).toContainEqual({ authorId: 'u1' });
  });

  it("asks for no group's thread when the caller is in no group", async () => {
    setup(false);

    await GET(new Request(url), { params: Promise.resolve({ id: 'c1', aid: 'a1' }) });

    // Never an unscoped `aboutGroupId` clause: that would hand them another group's feedback.
    expect(whereOfCommentQuery().OR).toHaveLength(2);
  });
});
