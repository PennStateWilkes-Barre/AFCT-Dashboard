import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const prismaMock = vi.hoisted(() => ({
  assignment: { findFirst: vi.fn() },
  studentGroup: { findUnique: vi.fn() },
  course: { findUnique: vi.fn() },
  roster: { findFirst: vi.fn() },
}));
const authMock = vi.hoisted(() => vi.fn());
const resolveGroupMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/assignment-groups', () => ({
  resolveStudentSubmissionGroupId: resolveGroupMock,
}));

import { GET } from './route';

const ctx = { params: Promise.resolve({ id: 'c1', aid: 'a1', studentId: 'stu-1' }) };
const call = () => GET(new NextRequest('http://localhost/x'), ctx);

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: 'staff', role: 'FACULTY' } });
  prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
  prismaMock.course.findUnique.mockResolvedValue({ isArchived: false });
  prismaMock.assignment.findFirst.mockResolvedValue({
    id: 'a1',
    unlockAt: null,
    dueDate: new Date('2026-01-10T23:59:00.000Z'),
    lateCutoff: null,
    allowLateSubmissions: false,
    overrides: [],
  });
});

describe('GET student-group', () => {
  it('403 for a student (non-staff)', async () => {
    authMock.mockResolvedValue({ user: { id: 's', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'STUDENT' });
    expect((await call()).status).toBe(403);
  });

  it('reports individual with the base effective schedule when not group-assigned', async () => {
    resolveGroupMock.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ isGroup: false, group: null, members: [] });
    expect(body.effective).toMatchObject({
      source: 'base',
      dueDate: new Date('2026-01-10T23:59:00.000Z').toISOString(),
      allowLateSubmissions: false,
    });
    expect(prismaMock.studentGroup.findUnique).not.toHaveBeenCalled();
  });

  it('applies the student override to the effective schedule', async () => {
    resolveGroupMock.mockResolvedValue(null);
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: 'a1',
      unlockAt: null,
      dueDate: new Date('2026-01-10T23:59:00.000Z'),
      lateCutoff: null,
      allowLateSubmissions: false,
      overrides: [
        {
          targetType: 'STUDENT',
          userId: 'stu-1',
          groupId: null,
          unlockAt: null,
          dueDate: new Date('2026-01-20T23:59:00.000Z'),
          lateCutoff: null,
          allowLateSubmissions: true,
        },
      ],
    });
    const res = await call();
    const body = await res.json();
    expect(body.effective).toMatchObject({
      source: 'student-override',
      dueDate: new Date('2026-01-20T23:59:00.000Z').toISOString(),
      allowLateSubmissions: true,
    });
  });

  it('reports the group and the groupmates (excluding the selected student)', async () => {
    resolveGroupMock.mockResolvedValue('g1');
    prismaMock.studentGroup.findUnique.mockResolvedValue({
      id: 'g1',
      name: 'Team Alpha',
      memberships: [
        { roster: { user: { id: 'stu-1', firstName: 'Sel', lastName: 'Ected' } } },
        { roster: { user: { id: 'stu-2', firstName: 'Ann', lastName: 'A' } } },
        { roster: { user: { id: 'stu-3', firstName: 'Bob', lastName: 'B' } } },
      ],
    });
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isGroup).toBe(true);
    expect(body.group).toEqual({ id: 'g1', name: 'Team Alpha' });
    expect(body.members.map((m: { id: string }) => m.id)).toEqual(['stu-2', 'stu-3']);
  });

  it('404 when the assignment is not in the course', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });
});

/**
 * Which assignment this reports a group for.
 *
 * The assignment id comes from the path, so the `courseId` on this lookup is what keeps a
 * staff member of one course from reading a student's group and schedule on another course's
 * assignment. The prisma mock answers with its fixture either way.
 */
describe('which assignment the student group is read from', () => {
  it('looks the assignment up only within this course', async () => {
    resolveGroupMock.mockResolvedValue(null);

    const res = await call();
    expect(res.status).toBe(200);

    expect(prismaMock.assignment.findFirst.mock.calls[0][0]).toMatchObject({
      where: { id: 'a1', courseId: 'c1' },
    });
  });
});
