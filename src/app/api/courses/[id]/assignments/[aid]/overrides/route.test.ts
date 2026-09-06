import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const prismaMock = vi.hoisted(() => ({
  course: { findUnique: vi.fn() },
  assignment: { findFirst: vi.fn() },
  assignmentOverride: { findMany: vi.fn(), create: vi.fn() },
  assignmentAssignee: { findFirst: vi.fn() },
  roster: { findFirst: vi.fn(), findUnique: vi.fn() },
  studentGroup: { findFirst: vi.fn() },
}));

const authMock = vi.hoisted(() => vi.fn());
const activityLogMock = vi.hoisted(() => vi.fn());
const resolveTzMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/activity-log-utils', () => ({ createEnhancedActivityLog: activityLogMock }));
vi.mock('@/lib/course-timezone', () => ({ resolveCourseTimezone: resolveTzMock }));

import { GET, POST } from './route';

// Individual assignment (no group set) assigned to everyone.
const INDIVIDUAL_ASSIGNMENT = {
  id: 'a1',
  unlockAt: null,
  dueDate: new Date('2026-01-10T23:59:00.000Z'),
  lateCutoff: null,
  allowLateSubmissions: false,
  assignedToEveryone: true,
  groupSetId: null as string | null,
};
// Group assignment tied to set gs1, assigned to all groups.
const GROUP_ASSIGNMENT = { ...INDIVIDUAL_ASSIGNMENT, groupSetId: 'gs1' };

const ctx = { params: Promise.resolve({ id: 'c1', aid: 'a1' }) };

const post = (body: unknown) =>
  POST(
    new NextRequest('http://localhost/api/courses/c1/assignments/a1/overrides', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    ctx,
  );

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: 'staff-1', role: 'FACULTY' } });
  prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' }); // course-auth wrapper
  prismaMock.course.findUnique.mockResolvedValue({ isArchived: false });
  prismaMock.assignment.findFirst.mockResolvedValue(INDIVIDUAL_ASSIGNMENT);
  prismaMock.assignmentAssignee.findFirst.mockResolvedValue(null);
  prismaMock.assignmentOverride.create.mockResolvedValue({
    id: 'o1',
    targetType: 'STUDENT',
    userId: 'stu-1',
    groupId: null,
    unlockAt: null,
    dueDate: new Date('2026-01-20T23:59:00.000Z'),
    lateCutoff: null,
    allowLateSubmissions: null,
  });
  resolveTzMock.mockResolvedValue('UTC');
});

describe('POST /api/courses/[id]/assignments/[aid]/overrides', () => {
  it('creates a student override on an individual assignment and logs it', async () => {
    prismaMock.roster.findUnique.mockResolvedValue({ role: 'STUDENT' });

    const res = await post({ userId: 'stu-1', dueDate: '2026-01-20' });

    expect(res.status).toBe(201);
    expect(prismaMock.assignmentOverride.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          targetType: 'STUDENT',
          userId: 'stu-1',
          createdById: 'staff-1',
        }),
      }),
    );
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      expect.anything(),
      expect.objectContaining({ action: 'CREATE_ASSIGNMENT_OVERRIDE' }),
    );
  });

  it('rejects a target who is not a student on the roster', async () => {
    prismaMock.roster.findUnique.mockResolvedValue({ role: 'TA' });

    const res = await post({ userId: 'ta-1', dueDate: '2026-01-20' });

    expect(res.status).toBe(400);
    expect(prismaMock.assignmentOverride.create).not.toHaveBeenCalled();
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      expect.anything(),
      expect.objectContaining({
        action: 'ASSIGNMENT_OVERRIDE_TARGET_INVALID',
        severity: 'SECURITY',
      }),
    );
  });

  it('rejects a target not enrolled at all', async () => {
    prismaMock.roster.findUnique.mockResolvedValue(null);

    const res = await post({ userId: 'ghost', dueDate: '2026-01-20' });

    expect(res.status).toBe(400);
    expect(prismaMock.assignmentOverride.create).not.toHaveBeenCalled();
  });

  it('rejects an override that changes nothing', async () => {
    prismaMock.roster.findUnique.mockResolvedValue({ role: 'STUDENT' });

    const res = await post({ userId: 'stu-1' });

    expect(res.status).toBe(400);
    expect(prismaMock.assignmentOverride.create).not.toHaveBeenCalled();
  });

  it('rejects an unlockAt after the due date', async () => {
    prismaMock.roster.findUnique.mockResolvedValue({ role: 'STUDENT' });

    const res = await post({ userId: 'stu-1', unlockAt: '2026-02-01' });

    expect(res.status).toBe(400);
    expect(prismaMock.assignmentOverride.create).not.toHaveBeenCalled();
  });

  it('returns 409 when an override already exists for the student', async () => {
    prismaMock.roster.findUnique.mockResolvedValue({ role: 'STUDENT' });
    const { Prisma } = await import('@prisma/client');
    prismaMock.assignmentOverride.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dupe', { code: 'P2002', clientVersion: 'x' }),
    );

    const res = await post({ userId: 'stu-1', dueDate: '2026-01-20' });

    expect(res.status).toBe(409);
  });

  it('returns 404 when the assignment is not in the course', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(null);

    const res = await post({ userId: 'stu-1', dueDate: '2026-01-20' });

    expect(res.status).toBe(404);
  });

  it('rejects a group target on an individual assignment', async () => {
    const res = await post({ groupId: 'g1', dueDate: '2026-01-20' });

    expect(res.status).toBe(400);
    expect(prismaMock.assignmentOverride.create).not.toHaveBeenCalled();
  });

  it('rejects a student who is not assigned a specific-students assignment', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({
      ...INDIVIDUAL_ASSIGNMENT,
      assignedToEveryone: false,
    });
    prismaMock.roster.findUnique.mockResolvedValue({ role: 'STUDENT' });
    prismaMock.assignmentAssignee.findFirst.mockResolvedValue(null); // not in the audience

    const res = await post({ userId: 'stu-1', dueDate: '2026-01-20' });

    expect(res.status).toBe(400);
    expect(prismaMock.assignmentOverride.create).not.toHaveBeenCalled();
  });

  it('creates a group override on a group assignment', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(GROUP_ASSIGNMENT);
    prismaMock.studentGroup.findFirst.mockResolvedValue({ id: 'g1' });
    prismaMock.assignmentOverride.create.mockResolvedValue({
      id: 'og1',
      targetType: 'GROUP',
      userId: null,
      groupId: 'g1',
      unlockAt: null,
      dueDate: new Date('2026-01-20T23:59:00.000Z'),
      lateCutoff: null,
      allowLateSubmissions: null,
    });

    const res = await post({ groupId: 'g1', dueDate: '2026-01-20' });

    expect(res.status).toBe(201);
    expect(prismaMock.assignmentOverride.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ targetType: 'GROUP', groupId: 'g1' }),
      }),
    );
  });

  it('rejects a student target on a group assignment', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(GROUP_ASSIGNMENT);

    const res = await post({ userId: 'stu-1', dueDate: '2026-01-20' });

    expect(res.status).toBe(400);
    expect(prismaMock.assignmentOverride.create).not.toHaveBeenCalled();
  });

  it("rejects a group not in the assignment's set", async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(GROUP_ASSIGNMENT);
    prismaMock.studentGroup.findFirst.mockResolvedValue(null); // where filters by set -> no match

    const res = await post({ groupId: 'g-other', dueDate: '2026-01-20' });

    expect(res.status).toBe(400);
    expect(prismaMock.assignmentOverride.create).not.toHaveBeenCalled();
  });

  it('rejects a group that is not assigned a specific-groups assignment', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({
      ...GROUP_ASSIGNMENT,
      assignedToEveryone: false,
    });
    prismaMock.studentGroup.findFirst.mockResolvedValue({ id: 'g1' });
    prismaMock.assignmentAssignee.findFirst.mockResolvedValue(null); // group not in the audience

    const res = await post({ groupId: 'g1', dueDate: '2026-01-20' });

    expect(res.status).toBe(400);
    expect(prismaMock.assignmentOverride.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/courses/[id]/assignments/[aid]/overrides', () => {
  it('lists the assignment overrides', async () => {
    prismaMock.assignmentOverride.findMany.mockResolvedValue([{ id: 'o1', userId: 'stu-1' }]);

    const res = await GET(new NextRequest('http://localhost/x'), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 'o1', userId: 'stu-1' }]);
  });

  it('returns 404 when the assignment is not in the course', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(null);

    const res = await GET(new NextRequest('http://localhost/x'), ctx);

    expect(res.status).toBe(404);
  });
});

/**
 * The two "does this belong here" checks, which the prisma mocks cannot see.
 *
 * `withCourseAuth` proves the caller may manage the course in the URL and nothing about the
 * assignment id in the path or the group id in the body, so the queries carry those checks.
 * Both can lose them with every test in this file still passing, and an override is a
 * deadline: without them a deadline in another course could be moved from a URL scoped to
 * your own.
 */
describe('what an override is allowed to reach', () => {
  beforeEach(() => {
    authMock.mockResolvedValue({ user: { id: 'fac', isAdmin: true } });
    prismaMock.assignment.findFirst.mockResolvedValue(GROUP_ASSIGNMENT);
    prismaMock.studentGroup.findFirst.mockResolvedValue({ id: 'g1' });
    prismaMock.assignmentAssignee.findFirst.mockResolvedValue({ id: 'as1' });
    prismaMock.assignmentOverride.findMany.mockResolvedValue([]);
    prismaMock.assignmentOverride.create.mockResolvedValue({ id: 'ov1' });
    resolveTzMock.mockResolvedValue('UTC');
  });

  it('looks the assignment up only within the course named in the URL', async () => {
    await post({ targetType: 'GROUP', groupId: 'g1', dueDate: '2026-02-01T00:00:00.000Z' });

    expect(prismaMock.assignment.findFirst.mock.calls[0][0]).toMatchObject({
      where: { id: 'a1', courseId: 'c1' },
    });
  });

  it("looks the group up only within the assignment's own set", async () => {
    await post({ targetType: 'GROUP', groupId: 'g1', dueDate: '2026-02-01T00:00:00.000Z' });

    expect(prismaMock.studentGroup.findFirst.mock.calls[0][0]).toMatchObject({
      where: { id: 'g1', groupSetId: 'gs1' },
    });
  });

  /**
   * When the assignment has a named audience, the student has to be in it. That check is the
   * only thing stopping a deadline exception being written for somebody this assignment was
   * never given to, and without its `userId` any assignee row on the assignment satisfies it.
   */
  it('checks the student against the audience of this assignment', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({
      ...INDIVIDUAL_ASSIGNMENT,
      assignedToEveryone: false,
    });
    prismaMock.roster.findUnique.mockResolvedValue({ role: 'STUDENT', status: 'ENROLLED' });

    await post({
      targetType: 'STUDENT',
      userId: 'stu-1',
      dueDate: '2026-02-01T00:00:00.000Z',
    });

    expect(prismaMock.assignmentAssignee.findFirst.mock.calls[0][0]).toMatchObject({
      where: { assignmentId: 'a1', userId: 'stu-1' },
    });
  });

  /** Reading the list has its own lookup, and it is scoped the same way. */
  it('lists overrides for an assignment in this course only', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(INDIVIDUAL_ASSIGNMENT);
    prismaMock.assignmentOverride.findMany.mockResolvedValue([]);

    const res = await GET(new NextRequest('http://localhost/x'), ctx);
    expect(res.status).toBe(200);

    expect(prismaMock.assignment.findFirst.mock.calls[0][0]).toMatchObject({
      where: { id: 'a1', courseId: 'c1' },
    });
  });
});
