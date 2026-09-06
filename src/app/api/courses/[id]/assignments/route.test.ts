import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const prismaMock = vi.hoisted(() => {
  const mock = {
    course: { findUnique: vi.fn() },
    assignment: { findMany: vi.fn(), create: vi.fn() },
    assignmentAssignee: { createMany: vi.fn() },
    roster: { findFirst: vi.fn(), findMany: vi.fn() },
    groupSet: { findFirst: vi.fn() },
    studentGroup: { findMany: vi.fn() },
    $transaction: vi.fn(),
  };
  // The create handler writes the assignment (+ any assignees) in one transaction; run the
  // callback against this same mock so `prismaMock.assignment.create` assertions still hold.
  mock.$transaction.mockImplementation(async (cb: (tx: typeof mock) => unknown) => cb(mock));
  return mock;
});

const authMock = vi.hoisted(() => vi.fn());
const activityLogMock = vi.hoisted(() => vi.fn());
const resolveTzMock = vi.hoisted(() => vi.fn());
const toEndOfDayMock = vi.hoisted(() => vi.fn());
const toDateTimeMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/activity-log-utils', () => ({ createEnhancedActivityLog: activityLogMock }));
vi.mock('@/lib/course-timezone', () => ({ resolveCourseTimezone: resolveTzMock }));
vi.mock('@/lib/date-convert', () => ({
  toEndOfDayInTimezone: toEndOfDayMock,
  toDateTimeInTimezone: toDateTimeMock,
}));

import { GET, POST } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.roster.findFirst.mockResolvedValue(null);
  prismaMock.course.findUnique.mockResolvedValue({ isArchived: false });
  resolveTzMock.mockResolvedValue('America/New_York');
  toEndOfDayMock.mockReturnValue(new Date('2026-01-10T23:59:00.000Z'));
  toDateTimeMock.mockReturnValue(new Date('2026-01-12T12:00:00.000Z'));
});

describe('GET /api/courses/[id]/assignments', () => {
  it('returns 400 when courseId missing', async () => {
    // Empty courseId can't match a roster row, so this test uses a global admin to
    // pass the auth gate and reach the 400 (missing course id) branch.
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN', isAdmin: true } });

    const req = new NextRequest('http://localhost/api/courses//assignments');
    const res = await GET(req, { params: Promise.resolve({ id: '' }) });

    expect(res.status).toBe(400);
  });

  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);

    const req = new NextRequest('http://localhost/api/courses/c1/assignments');
    const res = await GET(req, { params: Promise.resolve({ id: 'c1' }) });

    expect(res.status).toBe(401);
  });

  it('returns 404 when course not found', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.course.findUnique.mockResolvedValue(null);

    const req = new NextRequest('http://localhost/api/courses/c1/assignments');
    const res = await GET(req, { params: Promise.resolve({ id: 'c1' }) });

    expect(res.status).toBe(404);
  });

  it('defaults totalGrade to 0 when a problem has no grades', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.course.findUnique.mockResolvedValue({ id: 'c1' });
    prismaMock.assignment.findMany.mockResolvedValue([
      {
        id: 'a1',
        title: 'A',
        dueDate: new Date('2025-01-01T00:00:00Z'),
        description: null,
        problems: [{ maxPoints: 10, grades: [] }],
      },
    ]);

    const req = new NextRequest('http://localhost/api/courses/c1/assignments');
    const res = await GET(req, { params: Promise.resolve({ id: 'c1' }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].totalGrade).toBe(0);
    expect(body[0].maxGrade).toBe(10);
  });

  it('lists published only by default, but includes drafts when asked', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.course.findUnique.mockResolvedValue({ id: 'c1' });
    prismaMock.assignment.findMany.mockResolvedValue([]);

    await GET(new NextRequest('http://localhost/api/courses/c1/assignments'), {
      params: Promise.resolve({ id: 'c1' }),
    });
    expect(prismaMock.assignment.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { courseId: 'c1', isPublished: true } }),
    );

    await GET(
      new NextRequest('http://localhost/api/courses/c1/assignments?includeUnpublished=1'),
      { params: Promise.resolve({ id: 'c1' }) },
    );
    expect(prismaMock.assignment.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { courseId: 'c1' } }),
    );
  });

  it('returns 500 when fetching assignments throws', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.course.findUnique.mockResolvedValue({ id: 'c1' });
    prismaMock.assignment.findMany.mockRejectedValueOnce(new Error('db down'));

    const req = new NextRequest('http://localhost/api/courses/c1/assignments');
    const res = await GET(req, { params: Promise.resolve({ id: 'c1' }) });

    expect(res.status).toBe(500);
  });

  it('returns assignments with grade totals', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.course.findUnique.mockResolvedValue({ id: 'c1' });
    // include problems needed for grade math
    prismaMock.assignment.findMany.mockResolvedValue([
      {
        id: 'a1',
        title: 'A',
        dueDate: new Date('2025-01-01T00:00:00Z'),
        description: null,
        problems: [
          {
            maxPoints: 10,
            grades: [{ grade: 7 }],
          },
          {
            maxPoints: 5,
            grades: [{ grade: 3 }],
          },
        ],
      },
    ]);

    const req = new NextRequest('http://localhost/api/courses/c1/assignments', {
      headers: { authorization: 'Bearer test-token' },
    });
    const res = await GET(req, { params: Promise.resolve({ id: 'c1' }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([
      {
        id: 'a1',
        title: 'A',
        dueDate: new Date('2025-01-01T00:00:00.000Z').toISOString(),
        description: null,
        totalGrade: 10,
        maxGrade: 15,
        problemCount: 2,
        isGroup: false,
      },
    ]);
  });
});

describe('POST /api/courses/[id]/assignments', () => {
  const post = (body: unknown, id = 'c1') =>
    POST(
      new NextRequest(`http://localhost/api/courses/${id}/assignments`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );

  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);

    const res = await post({ title: 'New' });

    expect(res.status).toBe(401);
  });

  it('returns 403 when the caller is not course staff', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'STUDENT' });

    const res = await post({ title: 'New' });

    expect(res.status).toBe(403);
  });

  it('returns 400 when title is missing', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });

    const res = await post({ description: 'no title' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when a late cutoff is given but late submissions are disabled', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });

    const res = await post({
      title: 'New',
      dueDate: '2026-01-10',
      allowLateSubmissions: false,
      lateCutoff: '2026-01-12',
    });

    expect(res.status).toBe(400);
  });

  it('accepts a null lateCutoff for a no-late assignment (wizard payload)', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.assignment.create.mockResolvedValue({
      id: 'a1',
      title: 'New',
      description: null,
      isPublished: false,
      isGroup: false,
      dueDate: new Date('2026-01-10T23:59:00.000Z'),
      allowLateSubmissions: false,
      lateCutoff: null,
      courseId: 'c1',
    });

    // The create wizard sends lateCutoff: null (and unlockAt undefined) when late is off.
    const res = await post({
      title: 'New',
      dueDate: '2026-01-10',
      allowLateSubmissions: false,
      lateCutoff: null,
      unlockAt: null,
    });

    expect(res.status).toBe(201);
  });

  it('allows late submissions with no cutoff (accepted with no deadline)', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.assignment.create.mockResolvedValue({
      id: 'a1',
      title: 'New',
      description: null,
      isPublished: false,
      isGroup: false,
      dueDate: new Date('2026-01-10T23:59:00.000Z'),
      allowLateSubmissions: true,
      lateCutoff: null,
      courseId: 'c1',
    });

    const res = await post({
      title: 'New',
      dueDate: '2026-01-10',
      allowLateSubmissions: true,
    });

    expect(res.status).toBe(201);
    expect(prismaMock.assignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ allowLateSubmissions: true, lateCutoff: null }),
      }),
    );
  });

  it('persists groupSetId for a group assignment assigned to all groups', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    (prismaMock.groupSet.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'gs1' });
    (prismaMock.assignment.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'a1',
      title: 'New',
      description: null,
      isPublished: false,
      groupSetId: 'gs1',
      assignedToEveryone: true,
      dueDate: new Date('2026-01-10T23:59:00.000Z'),
      allowLateSubmissions: false,
      lateCutoff: null,
      courseId: 'c1',
    });

    const res = await post({ title: 'New', dueDate: '2026-01-10', groupSetId: 'gs1' });

    expect(res.status).toBe(201);
    expect(prismaMock.assignment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ groupSetId: 'gs1' }) }),
    );
    // No audience rows for "everyone".
    expect(prismaMock.assignmentAssignee.createMany).not.toHaveBeenCalled();
  });

  it('writes assignee rows for an individual assignment assigned to specific students', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    (prismaMock.roster.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { userId: 'stu-1' },
    ]);
    (prismaMock.assignment.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'a1',
      title: 'New',
      description: null,
      isPublished: false,
      groupSetId: null,
      assignedToEveryone: false,
      dueDate: new Date('2026-01-10T23:59:00.000Z'),
      allowLateSubmissions: false,
      lateCutoff: null,
      courseId: 'c1',
    });

    const res = await post({
      title: 'New',
      dueDate: '2026-01-10',
      assignedToEveryone: false,
      assignees: [{ userId: 'stu-1' }],
    });

    expect(res.status).toBe(201);
    expect(prismaMock.assignmentAssignee.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ targetType: 'STUDENT', userId: 'stu-1', assignmentId: 'a1' })],
      }),
    );
  });

  it('rejects a subset assignment with no assignees', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });

    const res = await post({ title: 'New', dueDate: '2026-01-10', assignedToEveryone: false });

    expect(res.status).toBe(400);
    expect(prismaMock.assignment.create).not.toHaveBeenCalled();
  });

  it('rejects a group target on an individual assignment', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });

    const res = await post({
      title: 'New',
      dueDate: '2026-01-10',
      assignedToEveryone: false,
      assignees: [{ groupId: 'g1' }],
    });

    expect(res.status).toBe(400);
    expect(prismaMock.assignment.create).not.toHaveBeenCalled();
  });

  it('returns 400 when the late cutoff precedes the due date', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    toEndOfDayMock.mockReturnValue(new Date('2026-01-15T23:59:00.000Z'));
    toDateTimeMock.mockReturnValue(new Date('2026-01-12T12:00:00.000Z'));

    const res = await post({
      title: 'New',
      dueDate: '2026-01-15',
      allowLateSubmissions: true,
      lateCutoff: '2026-01-12',
    });

    expect(res.status).toBe(400);
  });

  it('creates the assignment in the path course and logs it', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.assignment.create.mockResolvedValue({
      id: 'a1',
      title: 'New',
      description: null,
      isPublished: false,
      isGroup: false,
      dueDate: new Date('2026-01-10T23:59:00.000Z'),
      allowLateSubmissions: false,
      lateCutoff: null,
      courseId: 'c1',
    });

    const res = await post({ title: 'New', dueDate: '2026-01-10' });

    expect(res.status).toBe(201);
    expect(prismaMock.assignment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ courseId: 'c1', title: 'New' }) }),
    );
    expect(activityLogMock).toHaveBeenCalled();
  });

  it('keeps a legacy plain-text create working (PLAIN_TEXT, no rich JSON)', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.assignment.create.mockResolvedValue({
      id: 'a1',
      title: 'New',
      description: 'plain body',
      isPublished: false,
      dueDate: new Date('2026-01-10T23:59:00.000Z'),
      allowLateSubmissions: false,
      lateCutoff: null,
      courseId: 'c1',
    });

    const res = await post({ title: 'New', dueDate: '2026-01-10', description: 'plain body' });

    expect(res.status).toBe(201);
    const data = prismaMock.assignment.create.mock.calls[0][0].data;
    expect(data.description).toBe('plain body');
    expect(data.descriptionFormat).toBe('PLAIN_TEXT');
  });

  it('derives the plain-text description from rich JSON on create', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.assignment.create.mockResolvedValue({
      id: 'a1',
      title: 'New',
      description: 'rich body',
      isPublished: false,
      dueDate: new Date('2026-01-10T23:59:00.000Z'),
      allowLateSubmissions: false,
      lateCutoff: null,
      courseId: 'c1',
    });

    const res = await post({
      title: 'New',
      dueDate: '2026-01-10',
      // Plain text deliberately disagrees: the JSON must win.
      description: 'IGNORED',
      descriptionJson: {
        version: 1,
        document: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'rich body' }] }],
        },
      },
    });

    expect(res.status).toBe(201);
    const data = prismaMock.assignment.create.mock.calls[0][0].data;
    expect(data.description).toBe('rich body');
    expect(data.descriptionFormat).toBe('TIPTAP_JSON');
  });

  it('rejects malformed rich JSON without writing anything', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });

    const res = await post({
      title: 'New',
      dueDate: '2026-01-10',
      // An unsupported node type: schema validation must reject the request.
      descriptionJson: { version: 1, document: { type: 'doc', content: [{ type: 'image' }] } },
    });

    expect(res.status).toBe(400);
    expect(prismaMock.assignment.create).not.toHaveBeenCalled();
  });

  it('stores an available-from (unlockAt) date', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    // Available-from before the (mocked) due date so the ordering check passes.
    toDateTimeMock.mockReturnValue(new Date('2026-01-05T00:00:00.000Z'));
    prismaMock.assignment.create.mockResolvedValue({
      id: 'a1',
      title: 'New',
      description: null,
      isPublished: false,
      isGroup: false,
      dueDate: new Date('2026-01-10T23:59:00.000Z'),
      unlockAt: new Date('2026-01-05T00:00:00.000Z'),
      allowLateSubmissions: false,
      lateCutoff: null,
      courseId: 'c1',
    });

    const res = await post({ title: 'New', dueDate: '2026-01-10', unlockAt: '2026-01-05' });

    expect(res.status).toBe(201);
    expect(prismaMock.assignment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unlockAt: expect.any(Date) }) }),
    );
  });

  it('rejects an unlockAt after the due date', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });

    const res = await post({ title: 'New', dueDate: '2026-01-10', unlockAt: '2026-01-20' });

    expect(res.status).toBe(400);
    expect(prismaMock.assignment.create).not.toHaveBeenCalled();
  });

  it('returns 409 when the course is archived', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.course.findUnique.mockResolvedValue({ isArchived: true });

    const res = await post({ title: 'New', dueDate: '2026-01-10' });

    expect(res.status).toBe(409);
    expect(prismaMock.assignment.create).not.toHaveBeenCalled();
  });

  it('returns 500 and logs when creation fails', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.assignment.create.mockRejectedValue(new Error('db down'));

    const res = await post({ title: 'New', dueDate: '2026-01-10' });

    expect(res.status).toBe(500);
  });

  it('returns 500 when creation throws a non-Error value', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.assignment.create.mockRejectedValueOnce('boom');

    const res = await post({ title: 'New', dueDate: '2026-01-10' });

    expect(res.status).toBe(500);
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      expect.anything(),
      expect.objectContaining({
        action: 'ASSIGNMENT_CREATE_ERROR',
        metadata: { error: 'unknown error' },
      }),
    );
  });
});

/**
 * What the audience checks are scoped to.
 *
 * Creating an assignment validates the group set, the groups and the students it is aimed at.
 * All three come from the request body, so each check has to bound itself to the course in the
 * URL (and, for groups, to the set the assignment uses). The prisma mock answers from its
 * fixture whatever the `where` says, so without those keys another course's group set passes
 * validation, a group from a different set becomes a valid target, and a student who is not
 * enrolled here can be assigned work.
 */
describe('what the assignment audience checks are scoped to', () => {
  const post = (body: unknown, id = 'c1') =>
    POST(
      new NextRequest(`http://localhost/api/courses/${id}/assignments`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );

  const whereOf = (fn: { mock: { calls: unknown[][] } }) =>
    (fn.mock.calls[0][0] as { where: unknown }).where;

  const created = (over: Record<string, unknown> = {}) => ({
    id: 'a1',
    title: 'New',
    description: null,
    isPublished: false,
    groupSetId: null,
    assignedToEveryone: false,
    dueDate: new Date('2026-01-10T23:59:00.000Z'),
    allowLateSubmissions: false,
    lateCutoff: null,
    courseId: 'c1',
    ...over,
  });

  beforeEach(() => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.assignmentAssignee.createMany.mockResolvedValue({ count: 1 });
    activityLogMock.mockResolvedValue(undefined);
  });

  it('accepts a group set only from this course, and groups only from that set', async () => {
    prismaMock.groupSet.findFirst.mockResolvedValue({ id: 'gs1' });
    prismaMock.studentGroup.findMany.mockResolvedValue([{ id: 'g1' }]);
    prismaMock.assignment.create.mockResolvedValue(created({ groupSetId: 'gs1' }));

    const res = await post({
      title: 'New',
      dueDate: '2026-01-10',
      groupSetId: 'gs1',
      assignedToEveryone: false,
      assignees: [{ groupId: 'g1' }],
    });
    expect(res.status).toBe(201);

    expect(whereOf(prismaMock.groupSet.findFirst)).toEqual({ id: 'gs1', courseId: 'c1' });
    expect(whereOf(prismaMock.studentGroup.findMany)).toEqual({
      id: { in: ['g1'] },
      groupSetId: 'gs1',
    });
  });

  it('accepts student targets only from this course’s active roster', async () => {
    prismaMock.roster.findMany.mockResolvedValue([{ userId: 'stu-1' }]);
    prismaMock.assignment.create.mockResolvedValue(created());

    const res = await post({
      title: 'New',
      dueDate: '2026-01-10',
      assignedToEveryone: false,
      assignees: [{ userId: 'stu-1' }],
    });
    expect(res.status).toBe(201);

    expect(whereOf(prismaMock.roster.findMany)).toMatchObject({
      courseId: 'c1',
      userId: { in: ['stu-1'] },
    });
  });
});
