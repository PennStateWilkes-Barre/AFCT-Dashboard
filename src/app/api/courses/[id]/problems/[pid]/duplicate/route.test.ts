import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  course: { findUnique: vi.fn() },
  roster: { findFirst: vi.fn() },
  problem: { findFirst: vi.fn(), create: vi.fn() },
}));

const authMock = vi.hoisted(() => vi.fn());
const activityLogMock = vi.hoisted(() => vi.fn());
const logErrorMock = vi.hoisted(() => vi.fn());
const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  copyFile: vi.fn(() => Promise.resolve()),
  unlink: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/activity-log-utils', () => ({ createEnhancedActivityLog: activityLogMock }));
vi.mock('@/lib/api/activity', () => ({ logError: logErrorMock }));
vi.mock('fs', () => ({
  default: {
    existsSync: fsMock.existsSync,
    promises: { copyFile: fsMock.copyFile, unlink: fsMock.unlink },
  },
}));
vi.mock('@/lib/safe-upload', () => ({
  safeStoredFilename: () => 'copied-uuid.jff',
  resolveInsideDir: (dir: string, name: string) => `${dir}/${name}`,
}));

import { POST } from './route';

const source = {
  id: 'p1',
  courseId: 'c1',
  title: 'Pipelining Lab',
  description: 'Original description',
  type: 'FA',
  maxStates: 5,
  isDeterministic: true,
  fileName: 'stored-p1.jff',
  originalFileName: 'pipelining.jff',
};

const call = (body: unknown) =>
  POST(
    new Request('http://localhost/api/courses/c1/problems/p1/duplicate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'c1', pid: 'p1' }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: 'admin-1', isAdmin: true } });
  prismaMock.roster.findFirst.mockResolvedValue(null);
  prismaMock.course.findUnique.mockResolvedValue({ isArchived: false });
  prismaMock.problem.findFirst.mockResolvedValue(source);
  prismaMock.problem.create.mockResolvedValue({ id: 'p2', title: 'Copy' });
  fsMock.existsSync.mockReturnValue(true);
});

describe('POST /api/courses/[id]/problems/[pid]/duplicate', () => {
  it('rejects a non-staff caller with 403', async () => {
    authMock.mockResolvedValue({ user: { id: 's1', isAdmin: false } });
    const res = await call({ title: 'Copy of Lab' });
    expect(res.status).toBe(403);
    expect(prismaMock.problem.create).not.toHaveBeenCalled();
  });

  it('copies the solution file and creates a new problem with the source settings', async () => {
    const res = await call({ title: 'Pipelining Lab (Copy)', description: 'Edited' });
    expect(res.status).toBe(201);

    expect(fsMock.copyFile).toHaveBeenCalledTimes(1);
    expect(prismaMock.problem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: 'Pipelining Lab (Copy)',
          description: 'Edited',
          type: 'FA',
          maxStates: 5,
          isDeterministic: true,
          fileName: 'copied-uuid.jff',
          originalFileName: 'pipelining.jff',
          courseId: 'c1',
        }),
      }),
    );
  });

  it('leaves the copy file-less when the source has no solution file', async () => {
    prismaMock.problem.findFirst.mockResolvedValue({ ...source, fileName: null, originalFileName: null });
    const res = await call({ title: 'No File Copy' });
    expect(res.status).toBe(201);
    expect(fsMock.copyFile).not.toHaveBeenCalled();
    expect(prismaMock.problem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fileName: null, originalFileName: null }),
      }),
    );
  });

  it('rolls back the copied file when the create fails', async () => {
    prismaMock.problem.create.mockRejectedValue(new Error('db boom'));
    const res = await call({ title: 'Copy of Lab' });
    expect(res.status).toBe(500);
    expect(fsMock.copyFile).toHaveBeenCalledTimes(1);
    expect(fsMock.unlink).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when the source problem is not in this course', async () => {
    prismaMock.problem.findFirst.mockResolvedValue(null);
    const res = await call({ title: 'Copy of Lab' });
    expect(res.status).toBe(404);
  });

  it('rejects a too-short title', async () => {
    const res = await call({ title: 'ab' });
    expect(res.status).toBe(400);
    expect(prismaMock.problem.create).not.toHaveBeenCalled();
  });
});

/**
 * Which problem gets duplicated.
 *
 * The problem id comes from the path, so this lookup is the only thing tying it to the course
 * the caller was proven staff of. The prisma mock returns the source either way, so without
 * the `courseId` a faculty member could copy another course's problem, solution file and all,
 * into their own bank.
 */
describe('which problem a duplicate copies', () => {
  it('reads the source only from this course', async () => {
    const res = await call({ title: 'Copy of Lab' });
    expect(res.status).toBe(201);

    expect(prismaMock.problem.findFirst.mock.calls[0][0]).toMatchObject({
      where: { id: 'p1', courseId: 'c1' },
    });
  });
});
