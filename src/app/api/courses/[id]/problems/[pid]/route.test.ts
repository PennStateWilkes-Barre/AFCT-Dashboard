import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  course: { findUnique: vi.fn() },
  problem: {
    findFirst: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  submission: {
    deleteMany: vi.fn(),
  },
  assignmentProblem: {
    findFirst: vi.fn(),
  },
  roster: { findFirst: vi.fn() },
}));

const authMock = vi.hoisted(() => vi.fn());
const activityLogMock = vi.hoisted(() => vi.fn());
const uploadLimitMock = vi.hoisted(() => vi.fn());
const validateMock = vi.hoisted(() => vi.fn());
const unlinkMock = vi.hoisted(() => vi.fn());
const writeFileMock = vi.hoisted(() => vi.fn());
const mkdirMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/activity-log-utils', () => ({ createEnhancedActivityLog: activityLogMock }));
vi.mock('@/lib/upload-limits', () => ({ getSystemUploadLimit: uploadLimitMock }));
vi.mock('@/app/utils/xmlStructureValidate', () => ({ validateStructureXML: validateMock }));
vi.mock('fs', () => {
  const api = {
    promises: { mkdir: mkdirMock, writeFile: writeFileMock, unlink: unlinkMock },
  };
  return { default: api, ...api };
});

import { PUT, DELETE } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.roster.findFirst.mockResolvedValue(null);
  prismaMock.course.findUnique.mockResolvedValue({ isArchived: false });
  uploadLimitMock.mockResolvedValue({ maxBytes: 5 * 1024 * 1024, maxMb: 5 });
  validateMock.mockReturnValue({ isValid: true });
});

const params = () => ({ params: Promise.resolve({ id: 'c1', pid: 'p1' }) });

describe('DELETE /api/courses/[id]/problems/[pid]', () => {
  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);

    const req = new Request('http://localhost/api/courses/c1/problems/p1', { method: 'DELETE' });
    const res = await DELETE(req, params());

    expect(res.status).toBe(401);
  });

  it('returns 403 when a non-staff user attempts deletion', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue(null);

    const req = new Request('http://localhost/api/courses/c1/problems/p1', { method: 'DELETE' });
    const res = await DELETE(req, params());

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('returns 404 when problem not found in the course', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN', isAdmin: true } });
    prismaMock.problem.findFirst.mockResolvedValue(null);

    const req = new Request('http://localhost/api/courses/c1/problems/p1', { method: 'DELETE' });
    const res = await DELETE(req, params());

    expect(res.status).toBe(404);
    expect(prismaMock.problem.findFirst).toHaveBeenCalledWith({
      where: { id: 'p1', courseId: 'c1' },
    });
  });

  it('refuses (400) when the problem is still linked to an assignment', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN', isAdmin: true } });
    prismaMock.problem.findFirst.mockResolvedValue({ id: 'p1', title: 'Problem', fileName: null });
    prismaMock.assignmentProblem.findFirst.mockResolvedValue({
      assignmentId: 'a1',
      problemId: 'p1',
    });

    const req = new Request('http://localhost/api/courses/c1/problems/p1', { method: 'DELETE' });
    const res = await DELETE(req, params());

    expect(res.status).toBe(400);
    expect(prismaMock.problem.delete).not.toHaveBeenCalled();
    expect(prismaMock.submission.deleteMany).not.toHaveBeenCalled();
    // The check is about THIS problem. The prisma mock answers with its fixture whatever the
    // `where` says, so without the `problemId` any link anywhere would block every delete.
    expect(prismaMock.assignmentProblem.findFirst).toHaveBeenCalledWith({
      where: { problemId: 'p1' },
    });
  });

  it('deletes an unlinked problem and logs activity', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN', isAdmin: true } });
    prismaMock.problem.findFirst.mockResolvedValue({
      id: 'p1',
      title: 'Problem',
      fileName: 'file.jff',
    });
    prismaMock.assignmentProblem.findFirst.mockResolvedValue(null);

    const req = new Request('http://localhost/api/courses/c1/problems/p1', { method: 'DELETE' });
    const res = await DELETE(req, params());

    expect(res.status).toBe(200);
    expect(prismaMock.submission.deleteMany).toHaveBeenCalledWith({ where: { problemId: 'p1' } });
    expect(prismaMock.problem.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
    expect(unlinkMock).toHaveBeenCalled();
    expect(activityLogMock).toHaveBeenCalled();
  });

  it('skips file deletion when the problem has no file', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.problem.findFirst.mockResolvedValue({ id: 'p1', title: 'Problem', fileName: null });
    prismaMock.assignmentProblem.findFirst.mockResolvedValue(null);

    const req = new Request('http://localhost/api/courses/c1/problems/p1', { method: 'DELETE' });
    const res = await DELETE(req, params());

    expect(res.status).toBe(200);
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it('tolerates a file deletion error and still succeeds', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN', isAdmin: true } });
    prismaMock.problem.findFirst.mockResolvedValue({
      id: 'p1',
      title: 'Problem',
      fileName: 'file.jff',
    });
    prismaMock.assignmentProblem.findFirst.mockResolvedValue(null);
    unlinkMock.mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });

    const req = new Request('http://localhost/api/courses/c1/problems/p1', { method: 'DELETE' });
    const res = await DELETE(req, params());

    expect(res.status).toBe(200);
    expect(activityLogMock).toHaveBeenCalled();
  });

  it('returns 500 when a delete operation fails', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN', isAdmin: true } });
    prismaMock.problem.findFirst.mockResolvedValue({ id: 'p1', title: 'Problem', fileName: null });
    prismaMock.assignmentProblem.findFirst.mockResolvedValue(null);
    prismaMock.problem.delete.mockRejectedValue(new Error('db down'));

    const req = new Request('http://localhost/api/courses/c1/problems/p1', { method: 'DELETE' });
    const res = await DELETE(req, params());

    expect(res.status).toBe(500);
    expect(activityLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        action: 'PROBLEM_DELETE_ERROR',
        severity: 'ERROR',
        courseId: 'c1',
        problemId: 'p1',
      }),
    );
  });

  it('returns 409 when the course is archived', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN', isAdmin: true } });
    prismaMock.course.findUnique.mockResolvedValue({ isArchived: true });

    const req = new Request('http://localhost/api/courses/c1/problems/p1', { method: 'DELETE' });
    const res = await DELETE(req, params());

    expect(res.status).toBe(409);
    expect(prismaMock.problem.delete).not.toHaveBeenCalled();
  });
});

describe('PUT /api/courses/[id]/problems/[pid]', () => {
  const putReq = (fields: Record<string, string>, file?: File) => {
    const formData = new FormData();
    for (const [k, v] of Object.entries(fields)) formData.set(k, v);
    if (file) formData.set('file', file);
    return new Request('http://localhost/api/courses/c1/problems/p1', {
      method: 'PUT',
      body: formData,
    });
  };

  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);

    const res = await PUT(putReq({ title: 'T', type: 'FA' }), params());

    expect(res.status).toBe(401);
  });

  it('returns 403 when a non-staff user attempts an update', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue(null);

    const res = await PUT(putReq({ title: 'T', type: 'FA' }), params());

    expect(res.status).toBe(403);
  });

  it('returns 404 when the problem is not in the course', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN', isAdmin: true } });
    prismaMock.problem.findFirst.mockResolvedValue(null);

    const res = await PUT(putReq({ title: 'T', type: 'FA' }), params());

    expect(res.status).toBe(404);
    expect(prismaMock.problem.findFirst).toHaveBeenCalledWith({
      where: { id: 'p1', courseId: 'c1' },
    });
  });

  it('returns 400 when required fields are missing', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.problem.findFirst.mockResolvedValue({ id: 'p1', fileName: null });

    const res = await PUT(putReq({ description: 'no title' }), params());

    expect(res.status).toBe(400);
  });

  it('updates the problem without a new file and logs activity', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.problem.findFirst.mockResolvedValue({
      id: 'p1',
      fileName: 'old.jff',
      originalFileName: 'old.jff',
    });
    prismaMock.problem.update.mockResolvedValue({ id: 'p1', title: 'Updated', maxPoints: 10 });

    const res = await PUT(putReq({ title: 'Updated', type: 'FA', maxPoints: '10' }), params());

    expect(res.status).toBe(200);
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(prismaMock.problem.update).toHaveBeenCalled();
    expect(activityLogMock).toHaveBeenCalled();
  });

  it('replaces the solution file when a valid one is uploaded', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.problem.findFirst.mockResolvedValue({
      id: 'p1',
      fileName: 'old.jff',
      originalFileName: 'old.jff',
    });
    prismaMock.problem.update.mockResolvedValue({ id: 'p1', title: 'Updated', maxPoints: 10 });

    const file = new File([new Uint8Array([1, 2, 3])], 'new.jff');
    const res = await PUT(putReq({ title: 'Updated', type: 'FA' }, file), params());

    expect(res.status).toBe(200);
    expect(unlinkMock).toHaveBeenCalled(); // old file removed
    expect(writeFileMock).toHaveBeenCalled(); // new file written
  });

  it('returns 400 when the uploaded file fails structure validation', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.problem.findFirst.mockResolvedValue({ id: 'p1', fileName: null });
    validateMock.mockReturnValue({ isValid: false, error: 'bad structure' });

    const file = new File([new Uint8Array([1])], 'new.jff');
    const res = await PUT(putReq({ title: 'Updated', type: 'FA' }, file), params());

    expect(res.status).toBe(400);
    expect(prismaMock.problem.update).not.toHaveBeenCalled();
    // Problem update, not a student submission: the audit event uses the PROBLEM
    // action/category.
    expect(activityLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        action: 'PROBLEM_INVALID_FILE_STRUCTURE',
        category: 'PROBLEM',
        courseId: 'c1',
        problemId: 'p1',
      }),
    );
  });

  it('returns 413 when the replacement file exceeds the upload limit', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.problem.findFirst.mockResolvedValue({ id: 'p1', fileName: 'old.jff' });
    uploadLimitMock.mockResolvedValue({ maxBytes: 0, maxMb: 0 });

    const file = new File([new Uint8Array([1, 2, 3])], 'new.jff');
    const res = await PUT(putReq({ title: 'Updated', type: 'FA' }, file), params());

    expect(res.status).toBe(413);
    expect(prismaMock.problem.update).not.toHaveBeenCalled();
  });

  it('returns 500 and logs when the update throws (non-FA type, no maxPoints)', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.problem.findFirst.mockResolvedValue({ id: 'p1', fileName: null });
    prismaMock.problem.update.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // type 'RE' (not FA/PDA) exercises the maxStates/isDeterministic null branches;
    // omitting maxPoints exercises its `undefined` side before the update rejects.
    const res = await PUT(putReq({ title: 'Updated', type: 'RE' }), params());

    expect(res.status).toBe(500);
    expect(activityLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        action: 'PROBLEM_UPDATE_ERROR',
        severity: 'ERROR',
        courseId: 'c1',
        problemId: 'p1',
      }),
    );
  });

  it('returns 409 when the course is archived', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN', isAdmin: true } });
    prismaMock.course.findUnique.mockResolvedValue({ isArchived: true });

    const res = await PUT(putReq({ title: 'Updated', type: 'FA' }), params());

    expect(res.status).toBe(409);
    expect(prismaMock.problem.update).not.toHaveBeenCalled();
  });
});
