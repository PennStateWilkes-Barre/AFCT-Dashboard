import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  assignment: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
  assignmentProblem: { findFirst: vi.fn(), deleteMany: vi.fn() },
  assignmentProblemGrade: { findFirst: vi.fn() },
  submission: { count: vi.fn() },
  comment: { count: vi.fn() },
  user: { findUnique: vi.fn() },
  systemSettings: { findUnique: vi.fn() },
  course: { findUnique: vi.fn() },
  roster: { findFirst: vi.fn() },
}));

const authMock = vi.hoisted(() => vi.fn());
const activityLogMock = vi.hoisted(() => vi.fn());
const toEndOfDayMock = vi.hoisted(() => vi.fn());
const toDateTimeMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/activity-log-utils', () => ({ createEnhancedActivityLog: activityLogMock }));
vi.mock('@/lib/date-convert', () => ({
  toEndOfDayInTimezone: toEndOfDayMock,
  toDateTimeInTimezone: toDateTimeMock,
}));

import { GET, PUT, PATCH, DELETE } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.roster.findFirst.mockResolvedValue(null);
  prismaMock.course.findUnique.mockResolvedValue({ isArchived: false });
  prismaMock.user.findUnique.mockResolvedValue({ timezone: 'America/New_York' });
  toEndOfDayMock.mockReturnValue(new Date('2026-01-01T00:00:00.000Z'));
  toDateTimeMock.mockReturnValue(new Date('2026-01-02T00:00:00.000Z'));
  authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
});

describe('GET /api/courses/[id]/[aid]', () => {
  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);

    const res = await GET(new Request('http://localhost/api/courses/c1/assignments/a1'), {
      params: Promise.resolve({ id: 'c1', aid: 'a1' }),
    });

    expect(res.status).toBe(401);
  });

  it('returns 403 when a non-staff user is not enrolled', async () => {
    authMock.mockResolvedValue({ user: { id: 'stranger', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue(null);

    const res = await GET(new Request('http://localhost/api/courses/c1/assignments/a1'), {
      params: Promise.resolve({ id: 'c1', aid: 'a1' }),
    });

    expect(res.status).toBe(403);
  });

  it('allows an enrolled student to view a published assignment', async () => {
    authMock.mockResolvedValue({ user: { id: 'stu-1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'STUDENT',
      course: { isPublished: true },
    });
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      title: 'Assignment',
      isPublished: true,
      problems: [],
      course: { name: 'Course', code: 'C1', isArchived: false },
    });

    const res = await GET(
      new Request('http://localhost/api/courses/c1/assignments/a1?view=problems'),
      {
        params: Promise.resolve({ id: 'c1', aid: 'a1' }),
      },
    );

    expect(res.status).toBe(200);
    // The assignment id is a path parameter and the course gate says nothing about it, so this
    // lookup is what keeps a URL scoped to one course from reading another's assignment. It
    // can lose the `courseId` with every other test in this file still passing.
    expect(prismaMock.assignment.findFirst.mock.calls[0][0]).toMatchObject({
      where: { id: 'a1', courseId: 'c1' },
    });
  });

  it('locks description and problems for a student before the assignment unlocks', async () => {
    authMock.mockResolvedValue({ user: { id: 'stu-1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'STUDENT',
      course: { isPublished: true },
    });
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      title: 'Assignment',
      description: 'Secret details',
      descriptionFormat: 'TIPTAP_JSON',
      descriptionJson: {
        version: 1,
        document: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Secret details' }] }],
        },
      },
      isPublished: true,
      unlockAt: new Date('2999-01-01T00:00:00.000Z'), // far future -> locked
      dueDate: new Date('2999-01-08T00:00:00.000Z'),
      allowLateSubmissions: false,
      lateCutoff: null,
      assignedToEveryone: true,
      overrides: [],
      problems: [
        {
          maxPoints: 10,
          maxSubmissions: 1,
          autograderEnabled: true,
          problem: { id: 'p1', title: 'P1', description: 'hidden', type: 'FA' },
        },
      ],
      course: { name: 'Course', code: 'C1', isArchived: false },
    });

    const res = await GET(
      new Request('http://localhost/api/courses/c1/assignments/a1?view=problems'),
      { params: Promise.resolve({ id: 'c1', aid: 'a1' }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.locked).toBe(true);
    expect(body.description).toBeNull();
    // The rich document carries the same content, so the lock has to cover it too.
    expect(body.descriptionJson).toBeNull();
    expect(body.problems).toEqual([]);
  });

  it("gives a student their own override's dates, not the assignment's", async () => {
    // Reported by a student: a due-date override was set for them and the assignment still
    // showed the original date. Every other student surface resolved it; this one returned the
    // row as it stands and used the override only to decide whether the content was locked.
    authMock.mockResolvedValue({ user: { id: 'stu-1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'STUDENT',
      course: { isPublished: true },
    });
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      title: 'Assignment',
      description: 'Details',
      isPublished: true,
      unlockAt: null,
      dueDate: new Date('2026-10-01T23:59:00.000Z'),
      allowLateSubmissions: false,
      lateCutoff: null,
      assignedToEveryone: true,
      overrides: [
        {
          targetType: 'STUDENT',
          userId: 'stu-1',
          groupId: null,
          unlockAt: null,
          dueDate: new Date('2026-10-15T23:59:00.000Z'),
          lateCutoff: null,
          allowLateSubmissions: null,
        },
      ],
      problems: [],
      course: { name: 'Course', code: 'C1', isArchived: false },
    });

    const res = await GET(new Request('http://localhost/api/courses/c1/assignments/a1'), {
      params: Promise.resolve({ id: 'c1', aid: 'a1' }),
    });

    const body = await res.json();
    expect(body.dueDate).toBe('2026-10-15T23:59:00.000Z');
  });

  it("gives a student their group's override too", async () => {
    authMock.mockResolvedValue({ user: { id: 'stu-1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'STUDENT',
      course: { isPublished: true },
    });
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      title: 'Assignment',
      isPublished: true,
      unlockAt: null,
      dueDate: new Date('2026-10-01T23:59:00.000Z'),
      allowLateSubmissions: true,
      lateCutoff: new Date('2026-10-03T23:59:00.000Z'),
      assignedToEveryone: true,
      // The select filters these to the caller's own and their groups', so a group row here
      // is one of theirs.
      overrides: [
        {
          targetType: 'GROUP',
          userId: null,
          groupId: 'g1',
          unlockAt: null,
          dueDate: new Date('2026-10-20T23:59:00.000Z'),
          lateCutoff: new Date('2026-10-22T23:59:00.000Z'),
          allowLateSubmissions: null,
        },
      ],
      problems: [],
      course: { name: 'Course', code: 'C1', isArchived: false },
    });

    const res = await GET(new Request('http://localhost/api/courses/c1/assignments/a1'), {
      params: Promise.resolve({ id: 'c1', aid: 'a1' }),
    });

    const body = await res.json();
    expect(body.dueDate).toBe('2026-10-20T23:59:00.000Z');
    expect(body.lateCutoff).toBe('2026-10-22T23:59:00.000Z');
  });

  it('leaves staff looking at the assignment as it stands', async () => {
    // Staff set the base dates and manage the exceptions separately; showing them somebody
    // else's extension in place of the assignment's own date would be a different bug.
    authMock.mockResolvedValue({ user: { id: 'fac-1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'FACULTY',
      course: { isPublished: true },
    });
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      title: 'Assignment',
      isPublished: true,
      unlockAt: null,
      dueDate: new Date('2026-10-01T23:59:00.000Z'),
      allowLateSubmissions: false,
      lateCutoff: null,
      assignedToEveryone: true,
      overrides: [
        {
          targetType: 'STUDENT',
          userId: 'fac-1',
          groupId: null,
          unlockAt: null,
          dueDate: new Date('2026-10-15T23:59:00.000Z'),
          lateCutoff: null,
          allowLateSubmissions: null,
        },
      ],
      problems: [],
      course: { name: 'Course', code: 'C1', isArchived: false },
    });

    const res = await GET(new Request('http://localhost/api/courses/c1/assignments/a1'), {
      params: Promise.resolve({ id: 'c1', aid: 'a1' }),
    });

    const body = await res.json();
    expect(body.dueDate).toBe('2026-10-01T23:59:00.000Z');
  });

  const assignmentWithAnswerFile = {
    id: 'a1',
    title: 'Assignment',
    isPublished: true,
    problems: [
      {
        maxPoints: 10,
        maxSubmissions: 1,
        autograderEnabled: true,
        problem: {
          id: 'p1',
          title: 'Problem',
          description: null,
          type: 'DFA',
          maxStates: null,
          isDeterministic: true,
          fileName: 'stored-uuid.jff',
          originalFileName: 'solution_answer.jff',
        },
      },
    ],
    course: { name: 'Course', code: 'C1', isArchived: false },
  };

  it('withholds problem answer-key filenames from a student', async () => {
    authMock.mockResolvedValue({ user: { id: 'stu-1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'STUDENT',
      course: { isPublished: true },
    });
    prismaMock.assignment.findFirst.mockResolvedValue(assignmentWithAnswerFile);

    const res = await GET(
      new Request('http://localhost/api/courses/c1/assignments/a1?view=problems'),
      { params: Promise.resolve({ id: 'c1', aid: 'a1' }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.problems[0].problem.fileName).toBeNull();
    expect(body.problems[0].problem.originalFileName).toBeNull();
  });

  it('includes problem answer-key filenames for staff', async () => {
    // Default auth is an admin (staff); keep it.
    prismaMock.assignment.findFirst.mockResolvedValue(assignmentWithAnswerFile);

    const res = await GET(
      new Request('http://localhost/api/courses/c1/assignments/a1?view=problems'),
      { params: Promise.resolve({ id: 'c1', aid: 'a1' }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.problems[0].problem.fileName).toBe('stored-uuid.jff');
    expect(body.problems[0].problem.originalFileName).toBe('solution_answer.jff');
  });

  it('404-masks an unpublished assignment from a non-staff student', async () => {
    authMock.mockResolvedValue({ user: { id: 'stu-1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'STUDENT',
      course: { isPublished: true },
    });
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      title: 'Draft',
      isPublished: false,
      problems: [],
      course: { name: 'Course', code: 'C1', isArchived: false },
    });

    const res = await GET(
      new Request('http://localhost/api/courses/c1/assignments/a1?view=problems'),
      {
        params: Promise.resolve({ id: 'c1', aid: 'a1' }),
      },
    );

    expect(res.status).toBe(404);
  });

  it('lets staff view an unpublished assignment', async () => {
    // Admin (staff) is unaffected by the published masking.
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      title: 'Draft',
      isPublished: false,
      problems: [],
      course: { name: 'Course', code: 'C1', isArchived: false },
    });

    const res = await GET(new Request('http://localhost/api/courses/c1/assignments/a1'), {
      params: Promise.resolve({ id: 'c1', aid: 'a1' }),
    });

    expect(res.status).toBe(200);
  });

  it('returns 404 when assignment not found', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(null);

    const res = await GET(new Request('http://localhost/api/courses/c1/assignments/a1'), {
      params: Promise.resolve({ id: 'c1', aid: 'a1' }),
    });

    expect(res.status).toBe(404);
  });

  it('returns assignment details', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      title: 'Assignment',
      problems: [
        {
          problem: {
            id: 'p1',
            title: 'P1',
            description: null,
            type: null,
            maxStates: null,
            isDeterministic: null,
            fileName: null,
            originalFileName: null,
          },
        },
      ],
      course: {
        name: 'Course',
        code: 'C1',
        isArchived: false,
        roster: [{ role: 'FACULTY', user: { id: 'u1', firstName: 'A', lastName: 'B' } }],
      },
    });

    const res = await GET(new Request('http://localhost/api/courses/c1/assignments/a1'), {
      params: Promise.resolve({ id: 'c1', aid: 'a1' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.course.code).toBe('C1');
    expect(body.problems).toHaveLength(1);
  });

  it('omits roster for non-full views', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      title: 'Assignment',
      problems: [],
      course: {
        name: 'Course',
        code: 'C1',
        isArchived: false,
        roster: [{ role: 'FACULTY', user: { id: 'u1', firstName: 'A', lastName: 'B' } }],
      },
    });

    const res = await GET(
      new Request('http://localhost/api/courses/c1/assignments/a1?view=problems'),
      {
        params: Promise.resolve({ id: 'c1', aid: 'a1' }),
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.course.roster).toBeUndefined();
  });

  it('treats non-finite problem points as zero', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      title: 'Assignment',
      problems: [
        {
          maxPoints: NaN,
          maxSubmissions: 1,
          autograderEnabled: false,
          problem: {
            id: 'p1',
            title: 'P1',
            description: null,
            type: null,
            maxStates: null,
            isDeterministic: null,
            fileName: null,
            originalFileName: null,
          },
        },
      ],
      course: {
        name: 'Course',
        code: 'C1',
        isArchived: false,
        roster: [],
      },
    });

    const res = await GET(new Request('http://localhost/api/courses/c1/assignments/a1'), {
      params: Promise.resolve({ id: 'c1', aid: 'a1' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.maxPoints).toBe(0);
  });

  it('returns 500 when assignment query throws', async () => {
    prismaMock.assignment.findFirst.mockRejectedValue(new Error('db down'));

    const res = await GET(new Request('http://localhost/api/courses/c1/assignments/a1'), {
      params: Promise.resolve({ id: 'c1', aid: 'a1' }),
    });

    expect(res.status).toBe(500);
  });
});

const mutationParams = { params: Promise.resolve({ id: 'c1', aid: 'a1' }) };
const putReq = (body: unknown) =>
  new Request('http://localhost/api/courses/c1/assignments/a1', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
const existingAssignment = {
  id: 'a1',
  courseId: 'c1',
  title: 'Old',
  description: null,
  isGroup: false,
  isPublished: true,
  dueDate: new Date('2026-01-01T00:00:00.000Z'),
  allowLateSubmissions: false,
  lateCutoff: null,
};

describe('PUT /api/courses/[id]/assignments/[aid]', () => {
  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);
    const res = await PUT(putReq({ title: 'X' }), mutationParams);
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-staff caller', async () => {
    authMock.mockResolvedValue({ user: { id: 'stu-1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue(null);
    const res = await PUT(putReq({ title: 'X' }), mutationParams);
    expect(res.status).toBe(403);
  });

  it('404s when the assignment does not belong to the course (ownership check)', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(null);
    const res = await PUT(putReq({ title: 'X' }), mutationParams);
    expect(res.status).toBe(404);
    expect(prismaMock.assignment.findFirst).toHaveBeenCalledWith({
      where: { id: 'a1', courseId: 'c1' },
    });
  });

  it('updates the assignment', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({ ...existingAssignment });
    prismaMock.assignment.update.mockResolvedValue({ ...existingAssignment, title: 'New' });
    const res = await PUT(
      putReq({ title: 'New', dueDate: '2026-01-01', isPublished: true }),
      mutationParams,
    );
    expect(res.status).toBe(200);
    expect(prismaMock.assignment.update).toHaveBeenCalled();
  });

  it('blocks unpublishing when submissions exist', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({ ...existingAssignment });
    prismaMock.assignmentProblem.findFirst.mockResolvedValue({ assignmentId: 'a1' });
    const res = await PUT(putReq({ isPublished: false }), mutationParams);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('submissions');
    // Business-rule block, not an authz denial: WARNING + *_REJECTED with FK context.
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      expect.anything(),
      expect.objectContaining({
        action: 'ASSIGNMENT_UNPUBLISH_REJECTED',
        severity: 'WARNING',
        courseId: 'c1',
        assignmentId: 'a1',
        metadata: { reason: 'has submissions' },
      }),
    );
  });

  it('blocks unpublishing when grades exist (no submissions)', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({ ...existingAssignment });
    prismaMock.assignmentProblem.findFirst.mockResolvedValue(null);
    prismaMock.assignmentProblemGrade.findFirst.mockResolvedValue({ assignmentId: 'a1' });
    const res = await PUT(putReq({ isPublished: false }), mutationParams);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('grades');
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      expect.anything(),
      expect.objectContaining({
        action: 'ASSIGNMENT_UNPUBLISH_REJECTED',
        severity: 'WARNING',
        courseId: 'c1',
        assignmentId: 'a1',
        metadata: { reason: 'has grades' },
      }),
    );
  });

  it('returns 400 for an inconsistent late-submission window', async () => {
    // A cutoff supplied while late submissions are disabled is inconsistent.
    prismaMock.assignment.findFirst.mockResolvedValue({
      ...existingAssignment,
      allowLateSubmissions: false,
      lateCutoff: null,
    });
    const res = await PUT(
      putReq({ allowLateSubmissions: false, lateCutoff: '2026-01-20' }),
      mutationParams,
    );
    expect(res.status).toBe(400);
  });

  it('returns 500 when the update throws', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({ ...existingAssignment });
    prismaMock.assignment.update.mockRejectedValue(new Error('db down'));
    const res = await PUT(putReq({ title: 'New', dueDate: '2026-01-01' }), mutationParams);
    expect(res.status).toBe(500);
  });

  it('returns 409 when the course is archived', async () => {
    prismaMock.course.findUnique.mockResolvedValue({ isArchived: true });
    const res = await PUT(putReq({ title: 'New', dueDate: '2026-01-01' }), mutationParams);
    expect(res.status).toBe(409);
    expect(prismaMock.assignment.update).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/courses/[id]/assignments/[aid]', () => {
  it('404s when the assignment is not in the course', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(null);
    const res = await PATCH(
      new Request('http://localhost/api/courses/c1/assignments/a1', {
        method: 'PATCH',
        body: JSON.stringify({ title: 'X' }),
      }),
      mutationParams,
    );
    expect(res.status).toBe(404);
  });

  it('applies only the provided fields', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({ ...existingAssignment });
    prismaMock.assignment.update.mockResolvedValue({ ...existingAssignment, title: 'New' });
    const res = await PATCH(
      new Request('http://localhost/api/courses/c1/assignments/a1', {
        method: 'PATCH',
        body: JSON.stringify({ title: 'New' }),
      }),
      mutationParams,
    );
    expect(res.status).toBe(200);
    expect(prismaMock.assignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'a1' },
        data: expect.objectContaining({ title: 'New' }),
      }),
    );
  });

  const patchReq = (body: unknown) =>
    new Request('http://localhost/api/courses/c1/assignments/a1', {
      method: 'PATCH',
      body: JSON.stringify(body),
    });

  it('blocks unpublishing when submissions exist', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({ ...existingAssignment });
    prismaMock.assignmentProblem.findFirst.mockResolvedValue({ assignmentId: 'a1' });
    const res = await PATCH(patchReq({ isPublished: false }), mutationParams);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('submissions');
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      expect.anything(),
      expect.objectContaining({
        action: 'ASSIGNMENT_UNPUBLISH_REJECTED',
        severity: 'WARNING',
        courseId: 'c1',
        assignmentId: 'a1',
        metadata: { reason: 'has submissions' },
      }),
    );
  });

  it('blocks unpublishing when grades exist (no submissions)', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({ ...existingAssignment });
    prismaMock.assignmentProblem.findFirst.mockResolvedValue(null);
    prismaMock.assignmentProblemGrade.findFirst.mockResolvedValue({ assignmentId: 'a1' });
    const res = await PATCH(patchReq({ isPublished: false }), mutationParams);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('grades');
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      expect.anything(),
      expect.objectContaining({
        action: 'ASSIGNMENT_UNPUBLISH_REJECTED',
        severity: 'WARNING',
        courseId: 'c1',
        assignmentId: 'a1',
        metadata: { reason: 'has grades' },
      }),
    );
  });

  it('returns 400 for an inconsistent late-submission window', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({
      ...existingAssignment,
      allowLateSubmissions: false,
      lateCutoff: null,
    });
    // A cutoff supplied while late submissions are disabled is inconsistent.
    const res = await PATCH(
      patchReq({ allowLateSubmissions: false, lateCutoff: '2026-01-20' }),
      mutationParams,
    );
    expect(res.status).toBe(400);
  });

  it('returns 500 when the update throws', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({ ...existingAssignment });
    prismaMock.assignment.update.mockRejectedValue(new Error('db down'));
    const res = await PATCH(patchReq({ title: 'New' }), mutationParams);
    expect(res.status).toBe(500);
  });

  it('returns 409 when the course is archived', async () => {
    prismaMock.course.findUnique.mockResolvedValue({ isArchived: true });
    const res = await PATCH(patchReq({ title: 'New' }), mutationParams);
    expect(res.status).toBe(409);
    expect(prismaMock.assignment.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/courses/[id]/assignments/[aid]', () => {
  const delReq = () =>
    new Request('http://localhost/api/courses/c1/assignments/a1', { method: 'DELETE' });

  it('404s when the assignment is not in the course', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(null);
    const res = await DELETE(delReq(), mutationParams);
    expect(res.status).toBe(404);
  });

  it('400s when submissions exist', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({ id: 'a1' });
    prismaMock.submission.count.mockResolvedValue(3);
    const res = await DELETE(delReq(), mutationParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('submissions');
  });

  it('deletes when safe', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({ id: 'a1' });
    prismaMock.submission.count.mockResolvedValue(0);
    prismaMock.comment.count.mockResolvedValue(0);
    prismaMock.assignment.delete.mockResolvedValue({ id: 'a1', courseId: 'c1', title: 'Old' });
    const res = await DELETE(delReq(), mutationParams);
    expect(res.status).toBe(200);
    expect(prismaMock.assignmentProblem.deleteMany).toHaveBeenCalledWith({
      where: { assignmentId: 'a1' },
    });
    expect(prismaMock.assignment.delete).toHaveBeenCalledWith({ where: { id: 'a1' } });
  });

  it('400s when comments exist', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({ id: 'a1' });
    prismaMock.submission.count.mockResolvedValue(0);
    prismaMock.comment.count.mockResolvedValue(4);
    const res = await DELETE(delReq(), mutationParams);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('comments');
  });

  it('still succeeds when the activity-log write fails', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({ id: 'a1' });
    prismaMock.submission.count.mockResolvedValue(0);
    prismaMock.comment.count.mockResolvedValue(0);
    prismaMock.assignment.delete.mockResolvedValue({ id: 'a1', title: 'Old' });
    activityLogMock.mockRejectedValueOnce(new Error('log down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await DELETE(delReq(), mutationParams);
    expect(res.status).toBe(200);
  });

  it('returns 500 when the delete throws', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({ id: 'a1' });
    prismaMock.submission.count.mockResolvedValue(0);
    prismaMock.comment.count.mockResolvedValue(0);
    prismaMock.assignment.delete.mockRejectedValue(new Error('db down'));
    const res = await DELETE(delReq(), mutationParams);
    expect(res.status).toBe(500);
  });

  it('returns 409 when the course is archived', async () => {
    prismaMock.course.findUnique.mockResolvedValue({ isArchived: true });
    const res = await DELETE(delReq(), mutationParams);
    expect(res.status).toBe(409);
    expect(prismaMock.assignment.delete).not.toHaveBeenCalled();
  });
});
