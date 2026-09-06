import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const prismaMock = vi.hoisted(() => ({
  course: { findUnique: vi.fn() },
  assignment: { update: vi.fn() },
  assignmentOverride: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
  roster: { findFirst: vi.fn() },
  $transaction: vi.fn(),
}));

const authMock = vi.hoisted(() => vi.fn());
const activityLogMock = vi.hoisted(() => vi.fn());
const resolveTzMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/activity-log-utils', () => ({ createEnhancedActivityLog: activityLogMock }));
vi.mock('@/lib/course-timezone', () => ({ resolveCourseTimezone: resolveTzMock }));

import { PATCH, DELETE } from './route';

const EXISTING = {
  id: 'o1',
  targetType: 'STUDENT',
  userId: 'stu-1',
  groupId: null,
  unlockAt: null,
  dueDate: new Date('2026-01-20T23:59:00.000Z'),
  lateCutoff: null,
  allowLateSubmissions: null,
  assignment: {
    unlockAt: null,
    dueDate: new Date('2026-01-10T23:59:00.000Z'),
    lateCutoff: null,
    allowLateSubmissions: false,
  },
};

const ctx = { params: Promise.resolve({ id: 'c1', aid: 'a1', oid: 'o1' }) };

const patch = (body: unknown) =>
  PATCH(
    new NextRequest('http://localhost/x', { method: 'PATCH', body: JSON.stringify(body) }),
    ctx,
  );

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: 'staff-1', role: 'FACULTY' } });
  prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
  prismaMock.course.findUnique.mockResolvedValue({ isArchived: false });
  prismaMock.assignmentOverride.findFirst.mockResolvedValue(EXISTING);
  prismaMock.assignmentOverride.count.mockResolvedValue(0);
  resolveTzMock.mockResolvedValue('UTC');
  prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn(prismaMock),
  );
});

describe('PATCH override', () => {
  it('updates the override and logs old->new due date', async () => {
    prismaMock.assignmentOverride.update.mockResolvedValue({
      ...EXISTING,
      dueDate: new Date('2026-01-25T23:59:00.000Z'),
    });

    const res = await patch({ dueDate: '2026-01-25' });

    expect(res.status).toBe(200);
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      expect.anything(),
      expect.objectContaining({
        action: 'UPDATE_ASSIGNMENT_OVERRIDE',
        metadata: expect.objectContaining({ previousDueDate: EXISTING.dueDate.toISOString() }),
      }),
    );
  });

  it('returns 404 when the override is not found', async () => {
    prismaMock.assignmentOverride.findFirst.mockResolvedValue(null);

    const res = await patch({ dueDate: '2026-01-25' });

    expect(res.status).toBe(404);
    expect(prismaMock.assignmentOverride.update).not.toHaveBeenCalled();
  });

  it('rejects a due date before an inherited-effective unlock', async () => {
    // Base unlock is Jan 15; moving the override due to Jan 12 would invert the window.
    prismaMock.assignmentOverride.findFirst.mockResolvedValue({
      ...EXISTING,
      assignment: { ...EXISTING.assignment, unlockAt: new Date('2026-01-15T00:00:00.000Z') },
    });

    const res = await patch({ dueDate: '2026-01-12' });

    expect(res.status).toBe(400);
    expect(prismaMock.assignmentOverride.update).not.toHaveBeenCalled();
  });
});

describe('DELETE override', () => {
  it('deletes the override and logs it', async () => {
    prismaMock.assignmentOverride.delete.mockResolvedValue(EXISTING);

    const res = await DELETE(new NextRequest('http://localhost/x', { method: 'DELETE' }), ctx);

    expect(res.status).toBe(200);
    expect(prismaMock.assignmentOverride.delete).toHaveBeenCalledWith({ where: { id: 'o1' } });
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      expect.anything(),
      expect.objectContaining({ action: 'DELETE_ASSIGNMENT_OVERRIDE' }),
    );
  });

  it('returns 404 when the override is not found', async () => {
    prismaMock.assignmentOverride.findFirst.mockResolvedValue(null);

    const res = await DELETE(new NextRequest('http://localhost/x', { method: 'DELETE' }), ctx);

    expect(res.status).toBe(404);
    expect(prismaMock.assignmentOverride.delete).not.toHaveBeenCalled();
  });

  it('deleting a group override never touches the assignment type/audience', async () => {
    // An override is only a date exception; deleting it must not change groupSetId or
    // otherwise re-type the assignment (that regressed once and is now guarded).
    prismaMock.assignmentOverride.findFirst.mockResolvedValue({
      ...EXISTING,
      targetType: 'GROUP',
      userId: null,
      groupId: 'g1',
    });

    const res = await DELETE(new NextRequest('http://localhost/x', { method: 'DELETE' }), ctx);

    expect(res.status).toBe(200);
    expect(prismaMock.assignmentOverride.delete).toHaveBeenCalledWith({ where: { id: 'o1' } });
    expect(prismaMock.assignment.update).not.toHaveBeenCalled();
  });
});

/**
 * Which override this can change.
 *
 * The override id comes from the path, so this lookup is the only thing tying it to the
 * assignment and the course. The prisma mock returns its fixture either way, so without the
 * nested `assignment: { courseId }` a deadline exception in another course could be edited or
 * deleted from a URL scoped to your own.
 */
describe('which override this can reach', () => {
  it('resolves the override through this assignment and this course', async () => {
    prismaMock.assignmentOverride.update.mockResolvedValue({
      ...EXISTING,
      dueDate: new Date('2026-01-25T23:59:00.000Z'),
    });

    const res = await patch({ dueDate: '2026-01-25' });
    expect(res.status).toBe(200);

    expect(prismaMock.assignmentOverride.findFirst.mock.calls[0][0]).toMatchObject({
      where: { id: 'o1', assignmentId: 'a1', assignment: { courseId: 'c1' } },
    });
  });
});
