import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveMock = vi.hoisted(() => vi.fn());
const createSubmissionMock = vi.hoisted(() => vi.fn());
const canAccessMock = vi.hoisted(() => vi.fn());
const canManageMock = vi.hoisted(() => vi.fn());
const feedbackViewedMock = vi.hoisted(() => vi.fn());
const prismaMock = vi.hoisted(() => ({
  submission: { findMany: vi.fn() },
  assignment: { findUnique: vi.fn() },
  assignmentProblem: { findUnique: vi.fn() },
}));

const resolveGroupMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/client-auth', () => ({
  resolveClientToken: resolveMock,
  // withClientAuth wants the reason; derive it so these tests keep using resolveMock.
  resolveClientTokenDetailed: async (t: string) => {
    const r = await resolveMock(t);
    return r ? { ok: true, token: r } : { ok: false, reason: 'unknown token' };
  },
}));
vi.mock('@/lib/create-submission', () => ({ createSubmission: createSubmissionMock }));
vi.mock('@/lib/permissions', () => ({
  canAccessCourse: canAccessMock,
  canManageCourse: canManageMock,
}));
vi.mock('@/lib/assignment-groups', () => ({
  resolveStudentSubmissionGroupId: resolveGroupMock,
}));
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/api/activity', () => ({
  logStudentFeedbackViewed: feedbackViewedMock,
  logError: vi.fn(),
}));

import { GET, POST } from './route';

const validUser = {
  tokenId: 't1',
  user: { id: 'u1', isAdmin: false, email: 'a@b.c', firstName: null, lastName: null },
};

function makeReq(authHeader?: string) {
  const form = new FormData();
  form.set('assignmentId', 'a1');
  form.set('problemId', 'p1');
  return new Request('http://localhost/api/client/v1/submissions', {
    method: 'POST',
    headers: authHeader ? { authorization: authHeader } : {},
    body: form,
  });
}
const ctx = { params: Promise.resolve({}) };

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults: enrolled caller, published assignment, linked problem.
  canAccessMock.mockResolvedValue(true);
  canManageMock.mockResolvedValue(false);
  prismaMock.assignment.findUnique.mockResolvedValue({ courseId: 'c1', isPublished: true });
  prismaMock.assignmentProblem.findUnique.mockResolvedValue({
    assignmentId: 'a1',
    showFeedback: true,
  });
  // Individual caller by default; the group-aware test overrides this.
  resolveGroupMock.mockResolvedValue(null);
});

describe('POST /api/client/v1/submissions', () => {
  it('401 without a token', async () => {
    const res = await POST(makeReq(), ctx);
    expect(res.status).toBe(401);
    expect(createSubmissionMock).not.toHaveBeenCalled();
  });

  it('delegates to createSubmission and returns 202 with the id + status', async () => {
    resolveMock.mockResolvedValue({
      tokenId: 't1',
      user: { id: 'u1', isAdmin: false, email: 'a@b.c', firstName: null, lastName: null },
    });
    createSubmissionMock.mockResolvedValue({
      ok: true,
      submission: { id: 's1', status: 'PENDING' },
    });

    const res = await POST(makeReq('Bearer good'), ctx);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ submissionId: 's1', status: 'PENDING' });
    expect(createSubmissionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.objectContaining({ id: 'u1' }),
        assignmentId: 'a1',
        problemId: 'p1',
      }),
    );
  });

  it('maps a failed createSubmission result onto the response', async () => {
    resolveMock.mockResolvedValue({
      tokenId: 't1',
      user: { id: 'u1', isAdmin: false, email: 'a@b.c', firstName: null, lastName: null },
    });
    createSubmissionMock.mockResolvedValue({
      ok: false,
      status: 409,
      error: 'Submission limit reached (3).',
    });

    const res = await POST(makeReq('Bearer good'), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('Submission limit reached (3).');
  });
});

describe('GET /api/client/v1/submissions (history)', () => {
  const makeGet = (query: string, authHeader = 'Bearer good') =>
    new Request(`http://localhost/api/client/v1/submissions?${query}`, {
      headers: authHeader ? { authorization: authHeader } : {},
    });

  it('401 without a token', async () => {
    const res = await GET(makeGet('assignmentId=a1&problemId=p1', ''), ctx);
    expect(res.status).toBe(401);
  });

  it('400 when assignmentId or problemId is missing', async () => {
    resolveMock.mockResolvedValue(validUser);
    expect((await GET(makeGet('assignmentId=a1'), ctx)).status).toBe(400);
    expect((await GET(makeGet('problemId=p1'), ctx)).status).toBe(400);
    expect(prismaMock.submission.findMany).not.toHaveBeenCalled();
  });

  it("returns the caller's own attempts, newest first", async () => {
    resolveMock.mockResolvedValue(validUser);
    prismaMock.submission.findMany.mockResolvedValue([
      {
        id: 's2',
        status: 'COMPLETED',
        correct: true,
        submittedAt: new Date('2026-01-02T00:00:00Z'),
        originalFileName: 'answer2.jff',
        feedback: 'accepts "01"',
        student: { firstName: 'Ada', lastName: 'Lovelace' },
      },
      {
        id: 's1',
        status: 'FAILED',
        correct: false,
        submittedAt: new Date('2026-01-01T00:00:00Z'),
        originalFileName: 'answer1.jff',
        feedback: null,
      },
    ]);

    const res = await GET(makeGet('assignmentId=a1&problemId=p1'), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Scoped to the caller, never someone else's studentId.
    expect(prismaMock.submission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { assignmentId: 'a1', problemId: 'p1', studentId: 'u1' },
        orderBy: { submittedAt: 'desc' },
      }),
    );
    expect(body.submissions.map((s: { id: string }) => s.id)).toEqual(['s2', 's1']);
    // History fields: uploaded file name, evaluator feedback, and the submitting member.
    expect(body.submissions[0].fileName).toBe('answer2.jff');
    expect(body.submissions[0].feedback).toBe('accepts "01"');
    expect(body.submissions[0].submittedBy).toBe('Ada Lovelace');
  });

  it("widens the caller's attempt list to the group set when group-assigned", async () => {
    resolveGroupMock.mockResolvedValue('group-1');
    prismaMock.submission.findMany.mockResolvedValue([
      {
        id: 'g1',
        status: 'COMPLETED',
        correct: true,
        submittedAt: new Date('2026-01-02T00:00:00Z'),
      },
    ]);

    const res = await GET(makeGet('assignmentId=a1&problemId=p1'), ctx);
    expect(res.status).toBe(200);
    expect(resolveGroupMock).toHaveBeenCalledWith('a1', 'u1');
    expect(prismaMock.submission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          assignmentId: 'a1',
          problemId: 'p1',
          OR: [{ studentId: 'u1' }, { studentGroupId: 'group-1' }],
        },
      }),
    );
    const body = await res.json();
    expect(body.submissions.map((s: { id: string }) => s.id)).toEqual(['g1']);
  });

  it('404 for an unknown assignment', async () => {
    resolveMock.mockResolvedValue(validUser);
    prismaMock.assignment.findUnique.mockResolvedValue(null);

    const res = await GET(makeGet('assignmentId=a1&problemId=p1'), ctx);
    expect(res.status).toBe(404);
    expect(prismaMock.submission.findMany).not.toHaveBeenCalled();
  });

  it('403 once the caller loses course access (mirrors the web)', async () => {
    resolveMock.mockResolvedValue(validUser);
    canAccessMock.mockResolvedValue(false); // removed from the roster

    const res = await GET(makeGet('assignmentId=a1&problemId=p1'), ctx);
    expect(res.status).toBe(403);
    expect(prismaMock.submission.findMany).not.toHaveBeenCalled();
  });

  it('404 (masked) when the assignment is unpublished and the caller is not staff', async () => {
    resolveMock.mockResolvedValue(validUser);
    prismaMock.assignment.findUnique.mockResolvedValue({ courseId: 'c1', isPublished: false });

    const res = await GET(makeGet('assignmentId=a1&problemId=p1'), ctx);
    expect(res.status).toBe(404);
    expect(prismaMock.submission.findMany).not.toHaveBeenCalled();
  });

  it('404 when the problem is no longer linked to the assignment', async () => {
    resolveMock.mockResolvedValue(validUser);
    prismaMock.assignmentProblem.findUnique.mockResolvedValue(null);

    const res = await GET(makeGet('assignmentId=a1&problemId=p1'), ctx);
    expect(res.status).toBe(404);
    expect(prismaMock.submission.findMany).not.toHaveBeenCalled();
  });
});

/** The attempt history the client shows beside the problem. Same rule as the poll route. */
describe('GET /api/client/v1/submissions (history), feedback visibility', () => {
  const makeGet = (query: string) =>
    new Request(`http://localhost/api/client/v1/submissions?${query}`, {
      headers: { authorization: 'Bearer good' },
    });

  const history = async (showFeedback: boolean, over: Record<string, unknown> = {}) => {
    prismaMock.assignmentProblem.findUnique.mockResolvedValue({
      assignmentId: 'a1',
      showFeedback,
    });
    prismaMock.submission.findMany.mockResolvedValue([
      {
        id: 's1',
        status: 'COMPLETED',
        correct: false,
        submittedAt: new Date('2026-03-01T10:00:00.000Z'),
        originalFileName: 'mine.jff',
        feedback: 'accepts "01" but should reject it',
        student: { firstName: 'Ada', lastName: 'Lovelace' },
        ...over,
      },
    ]);

    const res = await GET(makeGet('assignmentId=a1&problemId=p1'), ctx);
    expect(res.status).toBe(200);
    return (await res.json()).submissions[0];
  };

  it('sends the witness string when the problem shows feedback', async () => {
    expect(await history(true)).toMatchObject({
      feedback: 'accepts "01" but should reject it',
      feedbackVisible: true,
    });
  });

  it('withholds it when the problem does not', async () => {
    const row = await history(false);

    expect(row).toMatchObject({ feedback: null, feedbackVisible: false });
    // Everything else about the attempt still arrives.
    expect(row.correct).toBe(false);
    expect(row.fileName).toBe('mine.jff');
  });

  it('still reports why a run failed', async () => {
    const row = await history(false, {
      status: 'FAILED',
      feedback: 'The file could not be parsed.',
    });

    expect(row).toMatchObject({
      feedback: 'The file could not be parsed.',
      feedbackVisible: true,
    });
  });
});

/**
 * The client is where most students read their feedback, and it never calls the web routes,
 * so without this the study would only ever see the browser.
 */
describe('recording that the client showed a student their feedback', () => {
  const makeGet = (query: string) =>
    new Request(`http://localhost/api/client/v1/submissions?${query}`, {
      headers: { authorization: 'Bearer good' },
    });

  const listOnce = async (showFeedback: boolean, over: Record<string, unknown> = {}) => {
    prismaMock.assignmentProblem.findUnique.mockResolvedValue({
      assignmentId: 'a1',
      showFeedback,
    });
    prismaMock.submission.findMany.mockResolvedValue([
      {
        id: 's1',
        status: 'COMPLETED',
        correct: false,
        submittedAt: new Date('2026-03-01T10:00:00.000Z'),
        originalFileName: 'mine.jff',
        feedback: 'accepts "01" but should reject it',
        student: { firstName: 'Ada', lastName: 'Lovelace' },
        ...over,
      },
    ]);
    const res = await GET(makeGet('assignmentId=a1&problemId=p1'), ctx);
    expect(res.status).toBe(200);
  };

  it('records the view, keyed to the one problem it asked about', async () => {
    await listOnce(true);

    expect(feedbackViewedMock).toHaveBeenCalledTimes(1);
    expect(feedbackViewedMock.mock.calls[0][1]).toMatchObject({
      userId: 'u1',
      surface: 'client',
      withFeedback: 1,
      problemId: 'p1',
    });
  });

  it('records nothing when the instructor has turned feedback off', async () => {
    await listOnce(false);

    expect(feedbackViewedMock).not.toHaveBeenCalled();
  });

  it('records nothing while the evaluator has not answered yet', async () => {
    await listOnce(true, { status: 'PENDING', feedback: null });

    expect(feedbackViewedMock).not.toHaveBeenCalled();
  });
});
