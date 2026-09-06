import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const prismaMock = vi.hoisted(() => ({
  course: { findUnique: vi.fn() },
  roster: { findFirst: vi.fn() },
  submissionGrant: { findFirst: vi.fn(), delete: vi.fn() },
}));
const authMock = vi.hoisted(() => vi.fn());
const activityLogMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/activity-log-utils', () => ({ createEnhancedActivityLog: activityLogMock }));

import { DELETE } from './route';

const ctx = { params: Promise.resolve({ id: 'c1', aid: 'a1', pid: 'p1', gid: 'g1' }) };
const del = () =>
  DELETE(
    new NextRequest('http://localhost/api/courses/c1/assignments/a1/problems/p1/grants/g1', {
      method: 'DELETE',
    }),
    ctx,
  );

const GRANT = {
  id: 'g1',
  targetType: 'STUDENT',
  userId: 'stu-1',
  groupId: null,
  extraSubmissions: 2,
  reason: 'wrong file',
};

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: 'staff-1', role: 'FACULTY' } });
  prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
  prismaMock.course.findUnique.mockResolvedValue({ isArchived: false, deletedAt: null });
  prismaMock.submissionGrant.findFirst.mockResolvedValue(GRANT);
});

describe('DELETE grant', () => {
  it('deletes the grant and audits the revocation', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(prismaMock.submissionGrant.delete).toHaveBeenCalledWith({ where: { id: 'g1' } });
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      expect.anything(),
      expect.objectContaining({
        action: 'REVOKE_EXTRA_SUBMISSIONS',
        severity: 'INFO',
        metadata: expect.objectContaining({ grantId: 'g1', targetUserId: 'stu-1' }),
      }),
    );
  });

  it('404s for a grant that is not in this course/problem scope', async () => {
    prismaMock.submissionGrant.findFirst.mockResolvedValue(null);
    const res = await del();
    expect(res.status).toBe(404);
    expect(prismaMock.submissionGrant.delete).not.toHaveBeenCalled();
  });
});

/**
 * Which grant this can revoke.
 *
 * The grant id comes from the path, and the delete that follows goes by id alone, so this
 * lookup is the only thing confirming the grant belongs to this problem, this assignment and
 * this course. The prisma mock returns `GRANT` whatever the `where` says, so the test above
 * passes just as happily with the course check gone.
 */
describe('which grant this can revoke', () => {
  it('resolves the grant through this problem, assignment and course', async () => {
    const res = await del();
    expect(res.status).toBe(200);

    expect(prismaMock.submissionGrant.findFirst.mock.calls[0][0]).toMatchObject({
      where: {
        id: 'g1',
        assignmentId: 'a1',
        problemId: 'p1',
        assignmentProblem: { assignment: { courseId: 'c1' } },
      },
    });
  });
});
