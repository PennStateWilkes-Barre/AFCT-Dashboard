import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  submission: { findFirst: vi.fn() },
  problem: { findFirst: vi.fn() },
}));
const canManageCourseMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/permissions', () => ({ canManageCourse: canManageCourseMock }));

import { canOpenViewerFile } from './viewer-access';

const STAFF = { id: 'staff-1', isAdmin: false };
const STUDENT = { id: 'student-1', isAdmin: false };

beforeEach(() => {
  prismaMock.submission.findFirst.mockReset();
  prismaMock.problem.findFirst.mockReset();
  canManageCourseMock.mockReset();
});

/**
 * The standalone viewer window is a marking tool. A student reading their own work gets the
 * preview in the assignment page, and this is what makes that a rule rather than a button that
 * happens not to be offered: the window's URL is guessable, bookmarkable and shareable.
 */
describe('who may open a file in the standalone viewer', () => {
  it('lets course staff open a submission', async () => {
    prismaMock.submission.findFirst.mockResolvedValue({ courseId: 'course-1' });
    canManageCourseMock.mockResolvedValue(true);

    expect(await canOpenViewerFile('submissions', 'a.jff', STAFF)).toBe(true);
    expect(canManageCourseMock).toHaveBeenCalledWith(STAFF, 'course-1');
  });

  it('refuses the student whose submission it is', async () => {
    // They may still read the file itself, which is what the preview does. This is about the
    // window around it.
    prismaMock.submission.findFirst.mockResolvedValue({ courseId: 'course-1' });
    canManageCourseMock.mockResolvedValue(false);

    expect(await canOpenViewerFile('submissions', 'a.jff', STUDENT)).toBe(false);
  });

  it('asks about the course the file belongs to, not the account in general', async () => {
    // Somebody can be faculty in one course and a student in another, so the answer has to be
    // per file rather than a role read off the session.
    prismaMock.submission.findFirst.mockResolvedValue({ courseId: 'course-2' });
    canManageCourseMock.mockResolvedValue(false);

    expect(await canOpenViewerFile('submissions', 'a.jff', STAFF)).toBe(false);
    expect(canManageCourseMock).toHaveBeenCalledWith(STAFF, 'course-2');
  });

  it('answers the same way for a file that does not exist', async () => {
    // "No such file" and "not yours" are the same answer, so the window cannot be used to
    // probe for which files exist.
    prismaMock.submission.findFirst.mockResolvedValue(null);
    canManageCourseMock.mockResolvedValue(true);

    expect(await canOpenViewerFile('submissions', 'missing.jff', STAFF)).toBe(false);
  });

  it('states the rule for a problem file and a solution rather than inferring it', async () => {
    prismaMock.problem.findFirst.mockResolvedValue({ courseId: 'course-1' });
    canManageCourseMock.mockResolvedValue(true);
    expect(await canOpenViewerFile('solutions', 'answer.jff', STAFF)).toBe(true);

    canManageCourseMock.mockResolvedValue(false);
    expect(await canOpenViewerFile('problems', 'start.jff', STUDENT)).toBe(false);
  });

  it('refuses a request with no signed-in account at all', async () => {
    expect(await canOpenViewerFile('submissions', 'a.jff', null)).toBe(false);
    expect(prismaMock.submission.findFirst).not.toHaveBeenCalled();
  });
});
