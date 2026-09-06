import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveMock = vi.hoisted(() => vi.fn());
const canAccessMock = vi.hoisted(() => vi.fn());
const canManageMock = vi.hoisted(() => vi.fn());
const isAdminMock = vi.hoisted(() => vi.fn());
const getAssignmentsMock = vi.hoisted(() => vi.fn());
const prismaMock = vi.hoisted(() => ({
  course: { findUnique: vi.fn() },
  groupMembership: { findMany: vi.fn() },
}));

vi.mock('@/lib/client-auth', () => ({
  resolveClientToken: resolveMock,
  // withClientAuth wants the reason; derive it so these tests keep using resolveMock.
  resolveClientTokenDetailed: async (t: string) => {
    const r = await resolveMock(t);
    return r ? { ok: true, token: r } : { ok: false, reason: 'unknown token' };
  },
}));
vi.mock('@/lib/permissions', () => ({
  canAccessCourse: canAccessMock,
  canManageCourse: canManageMock,
  isAdmin: isAdminMock,
}));
vi.mock('@/lib/student-assignments', () => ({ getStudentCourseAssignments: getAssignmentsMock }));
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

import { GET } from './route';

const makeReq = (authHeader?: string) =>
  new Request('http://localhost/api/client/v1/courses/c1/assignments', {
    headers: authHeader ? { authorization: authHeader } : {},
  });
const ctx = { params: Promise.resolve({ courseId: 'c1' }) };

const validUser = {
  tokenId: 't1',
  user: { id: 'u1', isAdmin: false, email: 'a@b.c', firstName: null, lastName: null },
};

const assignment = (over: Record<string, unknown>) => ({
  id: 'a1',
  title: 'HW1',
  groupSetId: null,
  description: null,
  unlockAt: null,
  dueDate: new Date('2026-01-01T00:00:00Z'),
  allowLateSubmissions: false,
  lateCutoff: null,
  locked: false,
  problems: [],
  ...over,
});

const titlesOf = async (res: Response) =>
  (await res.json()).assignments.map((a: { id: string }) => a.id);

beforeEach(() => {
  vi.clearAllMocks();
  resolveMock.mockResolvedValue(validUser);
  canAccessMock.mockResolvedValue(true);
  canManageMock.mockResolvedValue(false);
  isAdminMock.mockReturnValue(false);
  prismaMock.course.findUnique.mockResolvedValue({ timezone: 'America/New_York' });
  prismaMock.groupMembership.findMany.mockResolvedValue([]);
});

describe('GET /api/client/v1/courses/[courseId]/assignments', () => {
  it('401 without a token', async () => {
    resolveMock.mockResolvedValue(null);
    const res = await GET(makeReq(), ctx);
    expect(res.status).toBe(401);
  });

  it('404 when the caller cannot access the course', async () => {
    canAccessMock.mockResolvedValue(false);
    const res = await GET(makeReq('Bearer good'), ctx);
    expect(res.status).toBe(404);
    expect(getAssignmentsMock).not.toHaveBeenCalled();
  });

  it('for a student: published+assigned only, and drops pre-unlock (locked) assignments', async () => {
    getAssignmentsMock.mockResolvedValue([
      assignment({ id: 'open', locked: false }),
      assignment({ id: 'notYetOpen', locked: true }),
    ]);
    const res = await GET(makeReq('Bearer good'), ctx);
    expect(res.status).toBe(200);
    // Student view: no widening options passed.
    expect(getAssignmentsMock).toHaveBeenCalledWith('u1', 'c1', {});
    expect(await titlesOf(res)).toEqual(['open']);
  });

  it('for staff: requests all assignments and keeps even locked/unpublished ones', async () => {
    canManageMock.mockResolvedValue(true);
    getAssignmentsMock.mockResolvedValue([
      assignment({ id: 'open', locked: false }),
      assignment({ id: 'lockedDraft', locked: true }),
    ]);
    const res = await GET(makeReq('Bearer good'), ctx);
    expect(getAssignmentsMock).toHaveBeenCalledWith('u1', 'c1', {
      includeUnpublished: true,
      includeUnassigned: true,
    });
    expect((await titlesOf(res)).sort()).toEqual(['lockedDraft', 'open']);
  });

  it('reports individual vs group and the caller group name; withholds the answer file', async () => {
    getAssignmentsMock.mockResolvedValue([
      assignment({
        id: 'indiv',
        problems: [
          {
            id: 'p1',
            title: 'P1',
            description: 'Build a DFA',
            type: 'FA',
            maxStates: 5,
            isDeterministic: true,
            autograderEnabled: true,
            maxPoints: 10,
            maxSubmissions: 3,
            grade: null,
            submissionCount: 0,
            status: '',
          },
        ],
      }),
      assignment({ id: 'grp', groupSetId: 'gs1', allowLateSubmissions: true }),
    ]);
    prismaMock.groupMembership.findMany.mockResolvedValue([
      { groupSetId: 'gs1', group: { name: 'Group 1' } },
    ]);

    const res = await GET(makeReq('Bearer good'), ctx);
    const body = await res.json();

    const indiv = body.assignments.find((a: { id: string }) => a.id === 'indiv');
    expect(indiv.isGroup).toBe(false);
    expect(indiv.groupName).toBeNull();
    expect(indiv.problems[0].description).toBe('Build a DFA');
    expect(indiv.problems[0].maxStates).toBe(5);
    expect(indiv.problems[0].isDeterministic).toBe(true);
    expect(indiv.problems[0]).not.toHaveProperty('fileName');

    const grp = body.assignments.find((a: { id: string }) => a.id === 'grp');
    expect(grp.isGroup).toBe(true);
    expect(grp.groupName).toBe('Group 1');
    expect(grp.allowLateSubmissions).toBe(true);
  });
});

/**
 * The group-name lookup, scoped to the caller.
 *
 * The client shows a student which of their groups an assignment belongs to. That query is
 * scoped by `userId`, and dropping it returns every membership in those group sets, so the
 * client would label a student's assignment with somebody else's group. The prisma mock
 * returns the same fixture either way, so nothing else in this file notices.
 */
describe('whose group memberships the client is told about', () => {
  it('asks only about the signed-in student', async () => {
    getAssignmentsMock.mockResolvedValue([assignment({ id: 'grp', groupSetId: 'gs1' })]);
    prismaMock.groupMembership.findMany.mockResolvedValue([]);

    await GET(makeReq('Bearer good'), ctx);

    expect(prismaMock.groupMembership.findMany.mock.calls[0][0]).toMatchObject({
      where: { userId: 'u1' },
    });
  });
});
