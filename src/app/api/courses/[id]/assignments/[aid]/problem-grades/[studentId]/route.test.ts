import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const prismaMock = vi.hoisted(() => ({
  assignment: { findFirst: vi.fn() },
  assignmentProblem: { findMany: vi.fn() },
  assignmentProblemGrade: {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
    upsert: vi.fn(),
  },
  course: { findUnique: vi.fn() },
  roster: { findFirst: vi.fn() },
  $transaction: vi.fn(),
}));

const authMock = vi.hoisted(() => vi.fn());
const canManageCourseMock = vi.hoisted(() => vi.fn());
const canAccessCourseMock = vi.hoisted(() => vi.fn());
const activityLogMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/permissions', () => ({
  canManageCourse: canManageCourseMock,
  canAccessCourse: canAccessCourseMock,
  isCourseArchived: async (courseId: string) => {
    const course = await prismaMock.course.findUnique({
      where: { id: courseId },
      select: { isArchived: true },
    });
    return Boolean(course?.isArchived);
  },
}));
vi.mock('@/lib/activity-log-utils', () => ({ createEnhancedActivityLog: activityLogMock }));

import { GET, POST } from './route';

const defaultParams = { id: 'course-1', aid: 'assignment-1', studentId: 'student-1' };

describe('GET /api/courses/[id]/[aid]/problem-grades/[studentId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The route reads the per-problem feedback setting. Default it to shown, so the tests that
    // are not about visibility keep asserting what they always did.
    prismaMock.assignmentProblem.findMany.mockResolvedValue([
      { problemId: 'p1', showFeedback: true },
      { problemId: 'p2', showFeedback: true },
    ]);
    canManageCourseMock.mockResolvedValue(true);
    canAccessCourseMock.mockResolvedValue(true);
    authMock.mockResolvedValue({ user: { id: 'staff-1', role: 'FACULTY' } });
    prismaMock.assignment.findFirst.mockResolvedValue({ id: defaultParams.aid, isPublished: true });
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);
  });

  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);

    const res = await GET(new Request('http://localhost'), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(401);
  });

  it('returns 403 when student tries to view someone else', async () => {
    authMock.mockResolvedValue({ user: { id: 'other-student', role: 'STUDENT' } });
    canManageCourseMock.mockResolvedValue(false);

    const res = await GET(new Request('http://localhost'), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(403);
    expect(prismaMock.assignment.findFirst).not.toHaveBeenCalled();
  });

  it('returns 404 when assignment does not exist', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(null);

    const res = await GET(new Request('http://localhost'), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(404);
  });

  it('404-masks an unpublished assignment for the owning student', async () => {
    authMock.mockResolvedValue({ user: { id: defaultParams.studentId, role: 'STUDENT' } });
    canManageCourseMock.mockResolvedValue(false);
    prismaMock.assignment.findFirst.mockResolvedValue({
      id: defaultParams.aid,
      isPublished: false,
    });

    const res = await GET(new Request('http://localhost'), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(404);
    expect(prismaMock.assignmentProblemGrade.findMany).not.toHaveBeenCalled();
  });

  // Staff opening a student's grade breakdown discloses an education record, so the
  // audit log has to name who looked and whose record it was.
  it('logs a staff read of another student as a disclosure', async () => {
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([
      { problemId: 'p1', grade: 9, feedback: 'nice', updatedAt: new Date('2026-01-01') },
    ]);

    const res = await GET(new Request('http://localhost'), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(200);
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      expect.anything(),
      expect.objectContaining({
        userId: 'staff-1',
        action: 'VIEW_STUDENT_PROBLEM_GRADES',
        category: 'GRADE',
        metadata: expect.objectContaining({ viewedStudentId: 'student-1' }),
      }),
    );
  });

  it('does not log a student reading their own grades', async () => {
    authMock.mockResolvedValue({ user: { id: defaultParams.studentId, role: 'STUDENT' } });
    canManageCourseMock.mockResolvedValue(false);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([
      { problemId: 'p1', grade: 9, feedback: 'nice', updatedAt: new Date('2026-01-01') },
    ]);

    const res = await GET(new Request('http://localhost'), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(200);
    expect(activityLogMock).not.toHaveBeenCalled();
  });

  it('returns 204 when no grades are present', async () => {
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);

    const res = await GET(new Request('http://localhost'), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(204);
    await expect(res.text()).resolves.toBe('');
  });

  it('returns grade map with timestamps when data exists', async () => {
    const updatedAt = new Date('2026-02-15T12:00:00.000Z');
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([
      { problemId: 'prob-1', grade: 10, feedback: 'Nice work', updatedAt, gradedManually: true },
      { problemId: 'prob-2', grade: null, feedback: null, updatedAt, gradedManually: false },
    ]);

    const res = await GET(new Request('http://localhost'), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      'prob-1': {
        grade: 10,
        feedback: 'Nice work',
        feedbackVisible: true,
        updatedAt: updatedAt.toISOString(),
        gradedManually: true,
      },
      'prob-2': {
        grade: null,
        feedback: null,
        feedbackVisible: true,
        updatedAt: updatedAt.toISOString(),
        gradedManually: false,
      },
    });
  });

  /**
   * Without this field the gradebook can only read the problem's autograder setting, which
   * says how the problem is graded and not who graded it. That is how a hand-entered grade
   * came to be labeled "Autograded".
   */
  it('says where each grade came from', async () => {
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([
      {
        problemId: 'prob-1',
        grade: 10,
        feedback: null,
        updatedAt: new Date('2026-02-15T12:00:00.000Z'),
        gradedManually: true,
      },
    ]);

    await GET(new Request('http://localhost'), { params: Promise.resolve(defaultParams) });

    expect(prismaMock.assignmentProblemGrade.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ gradedManually: true }),
      }),
    );
  });

  it('returns 500 when the grade lookup throws', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.assignmentProblemGrade.findMany.mockRejectedValueOnce(new Error('db down'));

    const res = await GET(new Request('http://localhost'), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(500);
    consoleSpy.mockRestore();
  });
});

describe('POST /api/courses/[id]/[aid]/problem-grades/[studentId]', () => {
  const buildRequest = (body: unknown) =>
    new NextRequest('http://localhost', {
      method: 'POST',
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    vi.clearAllMocks();
    canManageCourseMock.mockResolvedValue(true);
    canAccessCourseMock.mockResolvedValue(true);
    authMock.mockResolvedValue({ user: { id: 'staff-1', role: 'FACULTY' } });
    prismaMock.course.findUnique.mockResolvedValue({ isArchived: false });
    prismaMock.assignment.findFirst.mockResolvedValue({ id: defaultParams.aid, isPublished: true });
    // The grade target is enrolled in the course by default.
    prismaMock.roster.findFirst.mockResolvedValue({ id: 'roster-1' });
    prismaMock.assignmentProblem.findMany.mockResolvedValue([
      { problemId: 'prob-1', maxPoints: 10 },
      { problemId: 'prob-2', maxPoints: 20 },
      { problemId: 'prob-3', maxPoints: 30 },
    ]);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);
    // $transaction receives an array of prisma promises; resolve it and let the
    // individual upsert/deleteMany mocks record their own calls.
    prismaMock.$transaction.mockImplementation(async (ops: unknown[]) => {
      await Promise.all(ops as Promise<unknown>[]);
      return [];
    });
    prismaMock.assignmentProblemGrade.upsert.mockResolvedValue({});
    prismaMock.assignmentProblemGrade.deleteMany.mockResolvedValue({ count: 1 });
    activityLogMock.mockResolvedValue(undefined);
  });

  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(buildRequest({ grades: { 'prob-1': 5 } }), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(401);
  });

  it('returns 404 when the grade target is not enrolled in the course', async () => {
    prismaMock.roster.findFirst.mockResolvedValue(null);

    const res = await POST(buildRequest({ grades: { 'prob-1': 5 } }), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(404);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('returns 403 and audits the denial when the caller cannot manage the course', async () => {
    canManageCourseMock.mockResolvedValue(false);

    const res = await POST(buildRequest({ grades: { 'prob-1': 5 } }), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(403);
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      expect.anything(),
      expect.objectContaining({ action: 'PROBLEM_GRADE_UPDATE_DENIED', severity: 'SECURITY' }),
    );
    expect(prismaMock.assignment.findFirst).not.toHaveBeenCalled();
  });

  it('returns 404 when the assignment is not in the course', async () => {
    prismaMock.assignment.findFirst.mockResolvedValue(null);

    const res = await POST(buildRequest({ grades: { 'prob-1': 5 } }), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(404);
  });

  it('returns 400 when grades is missing or not an object', async () => {
    const missing = await POST(buildRequest({}), {
      params: Promise.resolve(defaultParams),
    });
    expect(missing.status).toBe(400);

    const notObject = await POST(buildRequest({ grades: [1, 2, 3] }), {
      params: Promise.resolve(defaultParams),
    });
    expect(notObject.status).toBe(400);
  });

  it('returns 400 for an unknown problem id', async () => {
    const res = await POST(buildRequest({ grades: { nope: 5 } }), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(400);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('returns 400 for an out-of-range grade', async () => {
    const res = await POST(buildRequest({ grades: { 'prob-1': 999 } }), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(400);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('returns 400 when a grade value is not a number', async () => {
    const res = await POST(buildRequest({ grades: { 'prob-1': 'ten' } }), {
      params: Promise.resolve(defaultParams),
    });

    // The readJson/Zod schema rejects a non-number grade value with a 400 and no write.
    expect(res.status).toBe(400);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('upserts a grade for a problem with no existing record', async () => {
    // No existing rows -> existingByProblem is empty, exercising the null fallback
    // when looking up the previous grade for a brand new grade.
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);

    const res = await POST(buildRequest({ grades: { 'prob-1': 7 } }), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, changed: 1 });
    expect(prismaMock.assignmentProblemGrade.upsert).toHaveBeenCalledTimes(1);
  });

  it('reads existing grades that are stored as null', async () => {
    // Existing row with a null grade -> `r.grade ?? null` maps to null; setting a
    // number is therefore a change.
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([
      { problemId: 'prob-1', grade: null },
    ]);

    const res = await POST(buildRequest({ grades: { 'prob-1': 4 } }), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, changed: 1 });
  });

  it('still returns 200 when auditing the batch fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);
    activityLogMock.mockRejectedValueOnce(new Error('log down'));

    const res = await POST(buildRequest({ grades: { 'prob-1': 7 } }), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, changed: 1 });
    consoleSpy.mockRestore();
  });

  it('returns 500 when the transaction throws', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);
    prismaMock.$transaction.mockRejectedValueOnce(new Error('db down'));

    const res = await POST(buildRequest({ grades: { 'prob-1': 7 } }), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(500);
    consoleSpy.mockRestore();
  });

  it('returns 500 when a non-Error value is thrown', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);
    prismaMock.$transaction.mockRejectedValueOnce('boom');

    const res = await POST(buildRequest({ grades: { 'prob-1': 7 } }), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(500);
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      expect.anything(),
      expect.objectContaining({
        action: 'PROBLEM_GRADE_UPDATE_ERROR',
        metadata: { error: 'unknown error' },
      }),
    );
    consoleSpy.mockRestore();
  });

  it('applies only the changed problems, preserving feedback and unchanged grades', async () => {
    // Existing: prob-1=5, prob-2=8, prob-3=12.
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([
      { problemId: 'prob-1', grade: 5 },
      { problemId: 'prob-2', grade: 8 },
      { problemId: 'prob-3', grade: 12 },
    ]);

    // Change prob-1 → 9 (upsert), clear prob-2 (null → delete), leave prob-3 at 12.
    const res = await POST(
      buildRequest({ grades: { 'prob-1': 9, 'prob-2': null, 'prob-3': 12 } }),
      { params: Promise.resolve(defaultParams) },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, changed: 2 });

    // Exactly one upsert (prob-1) and one deleteMany (prob-2).
    expect(prismaMock.assignmentProblemGrade.upsert).toHaveBeenCalledTimes(1);
    expect(prismaMock.assignmentProblemGrade.deleteMany).toHaveBeenCalledTimes(1);

    // $transaction received exactly the two changed ops.
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    const txnOps = prismaMock.$transaction.mock.calls[0][0] as unknown[];
    expect(txnOps).toHaveLength(2);

    // Upsert targets prob-1 and its `update` sets only grade (no feedback).
    const upsertArg = prismaMock.assignmentProblemGrade.upsert.mock.calls[0][0];
    expect(upsertArg).toMatchObject({
      where: {
        assignmentId_problemId_studentId: {
          assignmentId: defaultParams.aid,
          problemId: 'prob-1',
          studentId: defaultParams.studentId,
        },
      },
      update: { grade: 9 },
    });
    expect(upsertArg.update).not.toHaveProperty('feedback');

    // deleteMany clears prob-2.
    expect(prismaMock.assignmentProblemGrade.deleteMany).toHaveBeenCalledWith({
      where: {
        assignmentId: defaultParams.aid,
        problemId: 'prob-2',
        studentId: defaultParams.studentId,
      },
    });
  });

  it('returns changed: 0 and writes nothing when the payload matches existing grades', async () => {
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([
      { problemId: 'prob-1', grade: 5 },
      { problemId: 'prob-2', grade: 8 },
    ]);

    const res = await POST(buildRequest({ grades: { 'prob-1': 5, 'prob-2': 8 } }), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, changed: 0 });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.assignmentProblemGrade.upsert).not.toHaveBeenCalled();
    expect(prismaMock.assignmentProblemGrade.deleteMany).not.toHaveBeenCalled();
  });

  it('returns 409 and writes nothing when the course is archived', async () => {
    prismaMock.course.findUnique.mockResolvedValue({ isArchived: true });

    const res = await POST(buildRequest({ grades: { 'prob-1': 7 } }), {
      params: Promise.resolve(defaultParams),
    });

    expect(res.status).toBe(409);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.assignmentProblemGrade.upsert).not.toHaveBeenCalled();
    expect(prismaMock.assignmentProblemGrade.deleteMany).not.toHaveBeenCalled();
  });
});

/**
 * A grade row's comment is not always the evaluator's: sometimes a person typed it. The switch
 * withholds the autograder's copy and never a comment somebody wrote to the student.
 */
describe('GET problem grades, feedback visibility', () => {
  const readAs = async (
    role: 'STUDENT' | 'FACULTY',
    showFeedback: boolean,
    gradeSource: 'AUTOGRADER' | 'MANUAL',
  ) => {
    const staff = role === 'FACULTY';
    authMock.mockResolvedValue({ user: { id: 'u1', role, isAdmin: false } });
    canManageCourseMock.mockResolvedValue(staff);
    prismaMock.roster.findFirst.mockResolvedValue({ id: 'r1', role });
    prismaMock.assignment.findFirst.mockResolvedValue({ id: 'a1', isPublished: true });
    prismaMock.assignmentProblem.findMany.mockResolvedValue([{ problemId: 'p1', showFeedback }]);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([
      {
        problemId: 'p1',
        grade: 7,
        feedback: 'accepts aab but should reject it',
        updatedAt: new Date('2026-03-01T12:00:00.000Z'),
        gradedManually: gradeSource === 'MANUAL',
        gradeSource,
      },
    ]);

    const res = await GET(
      new NextRequest('http://localhost/api/courses/c1/assignments/a1/problem-grades/u1'),
      { params: Promise.resolve({ id: 'c1', aid: 'a1', studentId: 'u1' }) },
    );
    expect(res.status).toBe(200);
    return (await res.json())['p1'];
  };

  it('withholds the autograder comment when the problem hides feedback', async () => {
    expect(await readAs('STUDENT', false, 'AUTOGRADER')).toMatchObject({
      feedback: null,
      feedbackVisible: false,
    });
    // The number is not the feedback: the student still sees what they scored.
    expect((await readAs('STUDENT', false, 'AUTOGRADER')).grade).toBe(7);
  });

  it('always shows a comment a person wrote', async () => {
    expect(await readAs('STUDENT', false, 'MANUAL')).toMatchObject({
      feedback: 'accepts aab but should reject it',
      feedbackVisible: true,
    });
  });

  it('keeps everything for staff', async () => {
    expect(await readAs('FACULTY', false, 'AUTOGRADER')).toMatchObject({
      feedback: 'accepts aab but should reject it',
      feedbackVisible: true,
    });
  });
});

/**
 * Whose grade this can write.
 *
 * `withCourseAuth` proves the caller manages the course in the URL, but the student comes from
 * the path, and this roster lookup is the only thing tying them to that course. Without the
 * `courseId` any user enrolled anywhere passes the enrollment check, and grade rows get written
 * for somebody who is not in the course at all. The prisma mock answers the same either way, so
 * nothing else in this file notices.
 */
describe('who a problem grade can be written for', () => {
  it('looks the student up on this course roster', async () => {
    vi.clearAllMocks();
    canManageCourseMock.mockResolvedValue(true);
    canAccessCourseMock.mockResolvedValue(true);
    authMock.mockResolvedValue({ user: { id: 'staff-1', role: 'FACULTY' } });
    prismaMock.course.findUnique.mockResolvedValue({ isArchived: false });
    prismaMock.assignment.findFirst.mockResolvedValue({ id: 'assignment-1', isPublished: true });
    prismaMock.roster.findFirst.mockResolvedValue({ id: 'roster-1' });
    prismaMock.assignmentProblem.findMany.mockResolvedValue([{ problemId: 'prob-1', maxPoints: 10 }]);
    prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);
    prismaMock.$transaction.mockImplementation(async (ops: unknown[]) => {
      await Promise.all(ops as Promise<unknown>[]);
      return [];
    });
    prismaMock.assignmentProblemGrade.upsert.mockResolvedValue({});
    activityLogMock.mockResolvedValue(undefined);

    const res = await POST(
      new NextRequest('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ grades: { 'prob-1': 5 } }),
      }),
      { params: Promise.resolve({ id: 'course-1', aid: 'assignment-1', studentId: 'student-1' }) },
    );
    expect(res.status).toBe(200);

    expect(prismaMock.roster.findFirst.mock.calls[0][0]).toMatchObject({
      where: { courseId: 'course-1', userId: 'student-1' },
    });
  });
});
