import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const prismaMock = vi.hoisted(() => {
  const mock = {
    course: { findUnique: vi.fn() },
    assignment: { findFirst: vi.fn(), update: vi.fn() },
    assignmentAssignee: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    assignmentOverride: { deleteMany: vi.fn() },
    studentGroup: { findMany: vi.fn() },
    roster: { findFirst: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
  };
  mock.$transaction.mockImplementation(async (cb: (tx: typeof mock) => unknown) => cb(mock));
  return mock;
});

const authMock = vi.hoisted(() => vi.fn());
const activityLogMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/activity-log-utils', () => ({ createEnhancedActivityLog: activityLogMock }));

import { GET, PUT } from './route';

const ctx = { params: Promise.resolve({ id: 'c1', aid: 'a1' }) };
const put = (body: unknown) =>
  PUT(
    new NextRequest('http://localhost/api/courses/c1/assignments/a1/assignees', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
    ctx,
  );

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: 'staff-1', role: 'FACULTY' } });
  prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
  prismaMock.course.findUnique.mockResolvedValue({ isArchived: false });
  prismaMock.assignment.findFirst.mockResolvedValue({ id: 'a1', groupSetId: null });
  prismaMock.assignment.update.mockResolvedValue({ id: 'a1' });
  prismaMock.$transaction.mockImplementation(async (cb: (tx: typeof prismaMock) => unknown) =>
    cb(prismaMock),
  );
});

describe('GET assignees', () => {
  it('lists the assignment assignees', async () => {
    prismaMock.assignmentAssignee.findMany.mockResolvedValue([{ id: 'x1', userId: 's1' }]);
    const res = await GET(new NextRequest('http://localhost/x'), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 'x1', userId: 's1' }]);
  });
});

describe('PUT assignees', () => {
  it('clears the audience when assigned to everyone', async () => {
    const res = await put({ assignedToEveryone: true });

    expect(res.status).toBe(200);
    expect(prismaMock.assignmentAssignee.deleteMany).toHaveBeenCalledWith({
      where: { assignmentId: 'a1' },
    });
    expect(prismaMock.assignmentAssignee.createMany).not.toHaveBeenCalled();
    expect(prismaMock.assignment.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { assignedToEveryone: true },
    });
  });

  it('sets a specific-students audience and drops orphaned overrides', async () => {
    prismaMock.roster.findMany.mockResolvedValue([{ userId: 's1' }]);

    const res = await put({ assignedToEveryone: false, assignees: [{ userId: 's1' }] });

    expect(res.status).toBe(200);
    expect(prismaMock.assignmentAssignee.createMany).toHaveBeenCalledWith({
      data: [{ assignmentId: 'a1', targetType: 'STUDENT', userId: 's1' }],
    });
    expect(prismaMock.assignmentOverride.deleteMany).toHaveBeenCalledWith({
      where: { assignmentId: 'a1', userId: { notIn: ['s1'] } },
    });
  });

  it('rejects a non-enrolled student target', async () => {
    prismaMock.roster.findMany.mockResolvedValue([]); // s1 not found as a STUDENT

    const res = await put({ assignedToEveryone: false, assignees: [{ userId: 's1' }] });

    expect(res.status).toBe(400);
    expect(prismaMock.assignment.update).not.toHaveBeenCalled();
  });

  it('rejects a group target on an individual assignment', async () => {
    const res = await put({ assignedToEveryone: false, assignees: [{ groupId: 'g1' }] });

    expect(res.status).toBe(400);
    expect(prismaMock.assignment.update).not.toHaveBeenCalled();
  });

  it('sets a specific-groups audience on a group assignment', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({ id: 'a1', groupSetId: 'gs1' });
    prismaMock.studentGroup.findMany.mockResolvedValue([{ id: 'g1' }]);

    const res = await put({ assignedToEveryone: false, assignees: [{ groupId: 'g1' }] });

    expect(res.status).toBe(200);
    expect(prismaMock.assignmentAssignee.createMany).toHaveBeenCalledWith({
      data: [{ assignmentId: 'a1', targetType: 'GROUP', groupId: 'g1' }],
    });
  });

  it('rejects an empty specific audience', async () => {
    const res = await put({ assignedToEveryone: false, assignees: [] });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the assignment is not in the course', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(null);
    const res = await put({ assignedToEveryone: true });
    expect(res.status).toBe(404);
  });
});

/**
 * The three "does this belong here" checks on the audience routes.
 *
 * `withCourseAuth` proves the caller may manage the course in the URL and nothing about the
 * assignment id in the path or the ids in the body, so the queries carry those checks. Audience
 * is who an assignment is for, so reaching across a course boundary here means assigning
 * somebody else's work, or assigning yours to somebody else's students.
 */
describe('what an audience change is allowed to reach', () => {
  const whereOf = (fn: { mock: { calls: unknown[][] } }) =>
    (fn.mock.calls[0][0] as { where: Record<string, unknown> }).where;

  it('looks the assignment up only within the course named in the URL', async () => {
    await put({ assignedToEveryone: true, assignees: [] });

    expect(whereOf(prismaMock.assignment.findFirst)).toMatchObject({ id: 'a1', courseId: 'c1' });
  });

  it("looks groups up only within the assignment's own set", async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({ id: 'a1', groupSetId: 'gs1' });
    prismaMock.studentGroup.findMany.mockResolvedValue([{ id: 'g1' }]);

    await put({ assignedToEveryone: false, assignees: [{ groupId: 'g1' }] });

    expect(whereOf(prismaMock.studentGroup.findMany)).toMatchObject({ groupSetId: 'gs1' });
  });

  it('looks students up only on this course roster, and only the ones named', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({ id: 'a1', groupSetId: null });
    prismaMock.roster.findMany.mockResolvedValue([{ userId: 'u1' }]);

    await put({ assignedToEveryone: false, assignees: [{ userId: 'u1' }] });

    expect(whereOf(prismaMock.roster.findMany)).toMatchObject({
      courseId: 'c1',
      userId: { in: ['u1'] },
    });
  });

  /**
   * Reading the audience is scoped too. GET has its own lookup, and it is the one that
   * decides whether this assignment belongs to the course in the URL at all.
   */
  it('reads the audience for this assignment, in this course', async () => {
    prismaMock.assignmentAssignee.findMany.mockResolvedValue([]);

    const res = await GET(new NextRequest('http://localhost/x'), ctx);
    expect(res.status).toBe(200);

    expect(whereOf(prismaMock.assignment.findFirst)).toEqual({ id: 'a1', courseId: 'c1' });
    expect(whereOf(prismaMock.assignmentAssignee.findMany)).toEqual({ assignmentId: 'a1' });
  });

  /**
   * Trimming the now-unassigned overrides is a delete, so its scope matters more than most:
   * without the `assignmentId` it clears date exceptions on every assignment in the
   * installation, and without the target clause it clears the ones still assigned here.
   */
  it('drops date exceptions only for targets dropped from this assignment', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({ id: 'a1', groupSetId: 'gs1' });
    prismaMock.studentGroup.findMany.mockResolvedValue([{ id: 'g1' }]);

    await put({ assignedToEveryone: false, assignees: [{ groupId: 'g1' }] });

    expect(prismaMock.assignmentOverride.deleteMany).toHaveBeenCalledWith({
      where: { assignmentId: 'a1', groupId: { notIn: ['g1'] } },
    });
  });

  it('drops date exceptions only for students dropped from this assignment', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue({ id: 'a1', groupSetId: null });
    prismaMock.roster.findMany.mockResolvedValue([{ userId: 'u1' }]);

    await put({ assignedToEveryone: false, assignees: [{ userId: 'u1' }] });

    expect(prismaMock.assignmentOverride.deleteMany).toHaveBeenCalledWith({
      where: { assignmentId: 'a1', userId: { notIn: ['u1'] } },
    });
  });
});
