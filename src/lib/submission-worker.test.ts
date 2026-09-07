import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

// ---- Hoisted mocks for every side-effecting dependency of the worker ----
const prismaMock = vi.hoisted(() => ({
  submission: {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  assignmentProblemGrade: { upsert: vi.fn(), updateMany: vi.fn(), createMany: vi.fn() },
  groupMembership: { findMany: vi.fn() },
  // The loop checks for a staff evaluator trial before it looks for a submission. Mocked
  // fully, not just the method the happy path calls: a missing one throws inside the loop
  // and every assertion about scheduling then measures the error path instead.
  evaluatorTrial: {
    findFirst: vi.fn(),
    count: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
  },
  // The grade fan-out runs in one transaction; the callback gets the same mock client so the
  // existing assertions on updateMany/createMany still see the calls.
  $transaction: vi.fn(),
}));
const executeMock = vi.hoisted(() => vi.fn());
const getEvaluatorConfigMock = vi.hoisted(() => vi.fn());
const getQueueSettingsMock = vi.hoisted(() => vi.fn());
const activityLogMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn());
const execSyncMock = vi.hoisted(() => vi.fn());
const readFileSyncMock = vi.hoisted(() => vi.fn());
const platformMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('../../lib/java-runner', () => ({
  default: class {
    execute = executeMock;
  },
}));
vi.mock('./eval-config', () => ({
  getEvaluatorConfig: getEvaluatorConfigMock,
  getQueueSettings: getQueueSettingsMock,
}));
vi.mock('./activity-log-utils', () => ({ createEnhancedActivityLog: activityLogMock }));
vi.mock('fs', () => ({
  default: { existsSync: existsSyncMock, readFileSync: readFileSyncMock },
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
}));
vi.mock('child_process', () => ({ execSync: execSyncMock }));
vi.mock('os', () => ({ default: { platform: platformMock }, platform: platformMock }));

import { __test__ } from '@/lib/submission-worker';

const {
  evaluateSubmission,
  runJavaEvaluator,
  reapStuckSubmissions,
  runWorkerLoop,
  idleDelayMs,
  markWorkSeen,
} = __test__;

const CONFIG = { timeoutMs: 5_000, maxMemoryMb: 256, analyzerLimit: 100 };

const makeSubmission = (over: Record<string, any> = {}): any => ({
  id: 'sub-1',
  studentId: 'stu-1',
  courseId: 'course-1',
  assignmentId: 'a-1',
  problemId: 'p-1',
  fileName: 'submission.txt',
  attempts: 0,
  status: 'PROCESSING',
  assignmentProblem: {
    assignmentId: 'a-1',
    problemId: 'p-1',
    maxPoints: 10,
    autograderEnabled: true,
    showFeedback: true,
    problem: { fileName: 'answer.txt', type: 'CFG', maxStates: null, isDeterministic: null },
  },
  ...over,
});

// Which activity-log actions were emitted (2nd positional arg of the log payload).
const loggedActions = () =>
  activityLogMock.mock.calls.map((c) => (c[2] as { action: string }).action);

beforeEach(() => {
  prismaMock.$transaction.mockImplementation(async (cb: (c: typeof prismaMock) => unknown) =>
    cb(prismaMock),
  );
  vi.clearAllMocks();
  platformMock.mockReturnValue('linux');
  existsSyncMock.mockReturnValue(true);
  executeMock.mockResolvedValue({ stdout: '{"correct":true,"feedback":"ok"}', stderr: '' });
  activityLogMock.mockResolvedValue(undefined);
  getEvaluatorConfigMock.mockResolvedValue(CONFIG);
  // No trial waiting, unless a test says otherwise.
  prismaMock.evaluatorTrial.findFirst.mockResolvedValue(null);
  prismaMock.evaluatorTrial.count.mockResolvedValue(0);
  prismaMock.evaluatorTrial.updateMany.mockResolvedValue({ count: 1 });
  delete process.env.CFGANALYZER_BINARY;
});

describe('runJavaEvaluator — guard branches', () => {
  it('fails immediately when no file was submitted', async () => {
    const result = await runJavaEvaluator(makeSubmission({ fileName: null }), CONFIG);
    expect(result).toMatchObject({
      status: 'FAILED',
      correct: false,
      feedback: 'No file submitted.',
    });
    expect(loggedActions()).toContain('SUBMISSION_EVALUATION_ERROR');
  });

  it('fails when the uploaded file is missing on disk', async () => {
    existsSyncMock.mockReturnValue(false);
    const result = await runJavaEvaluator(makeSubmission(), CONFIG);
    expect(result.status).toBe('FAILED');
    expect(result.feedback).toBe('ERROR: Uploaded file not found.');
  });

  it('fails when the problem has no configured answer file', async () => {
    const submission = makeSubmission();
    submission.assignmentProblem.problem.fileName = null;
    const result = await runJavaEvaluator(submission, CONFIG);
    expect(result.status).toBe('FAILED');
    expect(result.feedback).toBe('ERROR: No answer file configured for this problem.');
  });

  it('fails when the answer file is missing on the server', async () => {
    // Uploaded file exists, answer file does not.
    existsSyncMock.mockImplementation((p: string) => p.includes('submissions'));
    const result = await runJavaEvaluator(makeSubmission(), CONFIG);
    expect(result.status).toBe('FAILED');
    expect(result.feedback).toBe('ERROR: Answer file not found on server.');
  });
});

describe('runJavaEvaluator — Windows local dev path', () => {
  it('counts lines in-process instead of running the JAR', async () => {
    platformMock.mockReturnValue('win32');
    readFileSyncMock.mockReturnValue('one\ntwo\nthree\nfour\nfive\nsix\nseven\n');
    const result = await runJavaEvaluator(makeSubmission(), CONFIG);
    expect(result).toMatchObject({ status: 'COMPLETED', feedback: 'File has 7 lines (Windows).' });
    expect(executeMock).not.toHaveBeenCalled();
  });

  /**
   * This branch used to interpolate the file path into a PowerShell command string, the
   * one shape of process call this codebase must never contain. The stand-in must not
   * start a process at all, whatever the path holds.
   */
  it('starts no process, even for a hostile-looking path', async () => {
    platformMock.mockReturnValue('win32');
    readFileSyncMock.mockReturnValue('x\n');
    await runJavaEvaluator(makeSubmission(), CONFIG);
    expect(execSyncMock).not.toHaveBeenCalled();
  });
});

describe('runJavaEvaluator — evaluator execution', () => {
  it('parses a successful evaluation and reports correctness + feedback', async () => {
    executeMock.mockResolvedValue({
      stdout: '{"correct":true,"feedback":"Nice work"}',
      stderr: '',
    });
    const result = await runJavaEvaluator(makeSubmission(), CONFIG);
    expect(result).toMatchObject({
      status: 'COMPLETED',
      correct: true,
      feedback: 'Nice work',
    });
    expect(result.evaluationRaw).toEqual({ correct: true, feedback: 'Nice work' });
    expect(loggedActions()).toContain('SUBMISSION_EVALUATION_SUCCESS');
  });

  it('passes FA-specific args (maxStates + determinism) to the evaluator', async () => {
    const submission = makeSubmission();
    submission.assignmentProblem.problem.type = 'FA';
    submission.assignmentProblem.problem.maxStates = 5;
    submission.assignmentProblem.problem.isDeterministic = true;
    await runJavaEvaluator(submission, CONFIG);
    const [args] = executeMock.mock.calls[0];
    expect(args).toEqual([
      '--json',
      expect.stringContaining('answer.txt'),
      expect.stringContaining('submission.txt'),
      '5',
      'true',
    ]);
  });

  it('forwards the configured timeout, memory cap, and analyzer limit', async () => {
    await runJavaEvaluator(makeSubmission(), CONFIG);
    const [, options] = executeMock.mock.calls[0];
    expect(options).toMatchObject({
      timeout: 5_000,
      maxMemoryMb: 256,
      // TIMEOUT_SECONDS is the eval timeout in whole seconds (5000ms -> '5'); the jar
      // needs it to early-stop upgraded feedback, and UPGRADED_FEEDBACK is set explicitly.
      env: { CFGANALYZER_LIMIT: '100', TIMEOUT_SECONDS: '5', UPGRADED_FEEDBACK: 'true' },
    });
  });

  it('substitutes a clean message when the evaluator returns a Java stream toString', async () => {
    executeMock.mockResolvedValue({
      stdout: '{"correct":false,"feedback":"java.lang.IntStream@1a2b3c"}',
      stderr: '',
    });
    const result = await runJavaEvaluator(makeSubmission(), CONFIG);
    expect(result.feedback).toBe('Evaluation completed - correct: false');
  });

  it('logs a warning when the evaluator writes to stderr but still parses stdout', async () => {
    executeMock.mockResolvedValue({
      stdout: '{"correct":true,"feedback":"ok"}',
      stderr: 'a warning',
    });
    const result = await runJavaEvaluator(makeSubmission(), CONFIG);
    expect(result.correct).toBe(true);
    expect(loggedActions()).toContain('SUBMISSION_EVALUATION_STDERR');
  });

  it('fails on a non-object JSON payload', async () => {
    executeMock.mockResolvedValue({ stdout: '42', stderr: '' });
    const result = await runJavaEvaluator(makeSubmission(), CONFIG);
    expect(result.status).toBe('FAILED');
    expect(result.feedback).toContain('Invalid JSON response');
  });

  it('fails when stdout is not parseable JSON', async () => {
    executeMock.mockResolvedValue({ stdout: 'not json {', stderr: '' });
    const result = await runJavaEvaluator(makeSubmission(), CONFIG);
    expect(result.status).toBe('FAILED');
    expect(result.feedback).toContain('Failed to parse');
  });

  it('fails when the evaluator process throws', async () => {
    executeMock.mockRejectedValue(new Error('jvm crashed'));
    const result = await runJavaEvaluator(makeSubmission(), CONFIG);
    expect(result.status).toBe('FAILED');
    expect(result.feedback).toContain('jvm crashed');
  });
});

/**
 * The worker only ever evaluates a row it has claimed, and the claim token is what every write
 * is fenced on, so these drive it the same way the loop does.
 */
const CLAIM = 'claim-token-1';

describe('evaluateSubmission', () => {
  beforeEach(() => {
    // Happy-path defaults; individual tests override as needed.
    prismaMock.submission.updateMany.mockResolvedValue({ count: 1 }); // fenced completion write wins
    prismaMock.assignmentProblemGrade.updateMany.mockResolvedValue({ count: 0 }); // no existing auto row
    prismaMock.assignmentProblemGrade.createMany.mockResolvedValue({ count: 1 });
  });

  /**
   * The setting can be changed mid-term, so reading it back off the problem later would say
   * whatever it says today rather than what this student was under. RQ5 compares showing the
   * witness string against withholding it, and that comparison needs the condition each attempt
   * was actually graded under.
   */
  it('records whether feedback was being shown when it graded', async () => {
    prismaMock.submission.findUnique.mockResolvedValue(makeSubmission());
    executeMock.mockResolvedValue({ stdout: '{"correct":true,"feedback":"great"}', stderr: '' });

    await evaluateSubmission('sub-1', CLAIM);

    expect(prismaMock.submission.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ feedbackShown: true }) }),
    );
  });

  it('records the withheld condition just as explicitly', async () => {
    prismaMock.submission.findUnique.mockResolvedValue(
      makeSubmission({
        assignmentProblem: {
          assignmentId: 'a-1',
          problemId: 'p-1',
          maxPoints: 10,
          autograderEnabled: true,
          showFeedback: false,
          problem: { fileName: 'answer.txt', type: 'CFG', maxStates: null, isDeterministic: null },
        },
      }),
    );
    executeMock.mockResolvedValue({ stdout: '{"correct":false,"feedback":"nope"}', stderr: '' });

    await evaluateSubmission('sub-1', CLAIM);

    // False, not absent. A missing stamp would be indistinguishable from an attempt graded
    // before the setting existed.
    expect(prismaMock.submission.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ feedbackShown: false }) }),
    );
  });

  it('does nothing when the submission no longer exists', async () => {
    prismaMock.submission.findUnique.mockResolvedValue(null);
    await evaluateSubmission('missing');
    expect(prismaMock.submission.updateMany).not.toHaveBeenCalled();
  });

  it('persists the result and autogrades full points when correct', async () => {
    prismaMock.submission.findUnique.mockResolvedValue(makeSubmission());
    executeMock.mockResolvedValue({ stdout: '{"correct":true,"feedback":"great"}', stderr: '' });

    await evaluateSubmission('sub-1', CLAIM);

    expect(prismaMock.submission.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          correct: true,
          status: 'COMPLETED',
        }),
      }),
    );
    // Autograde only touches a non-manual row, and creates a non-manual row.
    expect(prismaMock.assignmentProblemGrade.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ gradedManually: false }) }),
    );
    expect(prismaMock.assignmentProblemGrade.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ grade: 10, gradedManually: false })],
        skipDuplicates: true,
      }),
    );
    /**
     * The row it overwrites may be a grade a person entered and then released. Once the
     * autograder replaces the number, that number is the autograder's, and leaving the
     * source alone would keep crediting a person for a mark they did not choose.
     */
    expect(prismaMock.assignmentProblemGrade.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ gradeSource: 'AUTOGRADER' }),
      }),
    );
    expect(prismaMock.assignmentProblemGrade.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ gradeSource: 'AUTOGRADER' })],
      }),
    );
    expect(loggedActions()).toContain('SUBMISSION_AUTOGRADED');
  });

  /**
   * The gradebook keeps the later work.
   *
   * Rerunning an old attempt refreshes that attempt's own result, which is what staff asked
   * for, and leaves the standing grade where the newer submission put it.
   */
  /**
   * A rolled-back persistence transaction is a transient failure like any other: the row is
   * still PROCESSING and still owned, so it goes back on the queue.
   */
  it('requeues the submission when persistence fails, rather than leaving it finished', async () => {
    prismaMock.submission.findUnique.mockResolvedValue(makeSubmission());
    executeMock.mockResolvedValue({ stdout: '{"correct":true,"feedback":"great"}', stderr: '' });
    prismaMock.$transaction.mockRejectedValueOnce(new Error('database went away'));

    await evaluateSubmission('sub-1', CLAIM);

    expect(prismaMock.submission.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        // Fenced on the claim, which the failed transaction left in place.
        where: { id: 'sub-1', processingToken: CLAIM },
        data: { status: 'PENDING', processingToken: null },
      }),
    );
    expect(loggedActions()).toContain('SUBMISSION_ERROR');
    expect(loggedActions()).not.toContain('SUBMISSION_AUTOGRADED');
  });

  it('names a serialization conflict as the reason, rather than burying it', async () => {
    const conflict = Object.assign(new Error('could not serialize access'), { code: 'P2034' });
    Object.setPrototypeOf(conflict, Prisma.PrismaClientKnownRequestError.prototype);
    prismaMock.submission.findUnique.mockResolvedValue(makeSubmission());
    executeMock.mockResolvedValue({ stdout: '{"correct":true,"feedback":"great"}', stderr: '' });
    prismaMock.$transaction.mockRejectedValueOnce(conflict);

    await evaluateSubmission('sub-1', CLAIM);

    const error = activityLogMock.mock.calls.find((call) => call[2]?.action === 'SUBMISSION_ERROR');
    expect(error?.[2]?.metadata?.reason).toBe('serialization conflict');
  });

  it('leaves the standing grade alone when a newer submission holds it', async () => {
    prismaMock.submission.findUnique.mockResolvedValue(makeSubmission());
    // What the authority check sees: a different, later submission for this student.
    prismaMock.submission.findFirst.mockResolvedValue({ id: 'sub-2' });
    executeMock.mockResolvedValue({ stdout: '{"correct":false,"feedback":"nope"}', stderr: '' });

    await evaluateSubmission('sub-1', CLAIM);

    // The attempt's own result is still written...
    expect(prismaMock.submission.updateMany).toHaveBeenCalled();
    // ...and nothing touches the grade.
    expect(prismaMock.assignmentProblemGrade.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.assignmentProblemGrade.createMany).not.toHaveBeenCalled();
    expect(loggedActions()).toContain('SUBMISSION_AUTOGRADE_SKIPPED');
    expect(loggedActions()).not.toContain('SUBMISSION_AUTOGRADED');
  });

  it('grades when it is itself the latest submission', async () => {
    prismaMock.submission.findUnique.mockResolvedValue(makeSubmission());
    prismaMock.submission.findFirst.mockResolvedValue({ id: 'sub-1' });
    executeMock.mockResolvedValue({ stdout: '{"correct":true,"feedback":"great"}', stderr: '' });

    await evaluateSubmission('sub-1', CLAIM);

    expect(prismaMock.assignmentProblemGrade.updateMany).toHaveBeenCalled();
    expect(loggedActions()).toContain('SUBMISSION_AUTOGRADED');
  });

  it('autogrades zero points when the submission is incorrect', async () => {
    prismaMock.submission.findUnique.mockResolvedValue(makeSubmission());
    executeMock.mockResolvedValue({ stdout: '{"correct":false,"feedback":"nope"}', stderr: '' });

    await evaluateSubmission('sub-1', CLAIM);

    expect(prismaMock.assignmentProblemGrade.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [expect.objectContaining({ grade: 0 })] }),
    );
  });

  it('updates an existing non-manual grade in place (createMany is a no-op via skipDuplicates)', async () => {
    prismaMock.submission.findUnique.mockResolvedValue(makeSubmission());
    executeMock.mockResolvedValue({ stdout: '{"correct":true,"feedback":"great"}', stderr: '' });
    prismaMock.assignmentProblemGrade.updateMany.mockResolvedValue({ count: 1 }); // a non-manual row existed

    await evaluateSubmission('sub-1', CLAIM);

    expect(prismaMock.assignmentProblemGrade.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ grade: 10 }) }),
    );
    // createMany runs but skips the existing row via skipDuplicates.
    expect(prismaMock.assignmentProblemGrade.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
  });

  it('fans a group submission grade out to every group member', async () => {
    const groupSub = { ...makeSubmission(), studentGroupId: 'grp-1' };
    prismaMock.submission.findUnique.mockResolvedValue(groupSub);
    prismaMock.groupMembership.findMany.mockResolvedValue([
      { userId: 'm1' },
      { userId: 'm2' },
      { userId: 'm3' },
    ]);
    executeMock.mockResolvedValue({ stdout: '{"correct":true,"feedback":"great"}', stderr: '' });

    await evaluateSubmission('sub-1', CLAIM);

    // Non-manual rows for all three members are updated, and createMany covers all three.
    expect(prismaMock.assignmentProblemGrade.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ studentId: { in: ['m1', 'm2', 'm3'] } }),
      }),
    );
    const createArg = prismaMock.assignmentProblemGrade.createMany.mock.calls[0]![0];
    expect(createArg.data.map((r: { studentId: string }) => r.studentId)).toEqual([
      'm1',
      'm2',
      'm3',
    ]);
  });

  /**
   * The same provenance manual group grading records. Without it a member later changed by
   * hand is indistinguishable from a group that was never graded together, so the workspace
   * cannot say a grade was adjusted away from what the group was given.
   */
  it('records which group an autograded grade came from', async () => {
    prismaMock.submission.findUnique.mockResolvedValue({
      ...makeSubmission(),
      studentGroupId: 'grp-1',
    });
    prismaMock.groupMembership.findMany.mockResolvedValue([{ userId: 'm1' }, { userId: 'm2' }]);
    executeMock.mockResolvedValue({ stdout: '{"correct":true,"feedback":"great"}', stderr: '' });

    await evaluateSubmission('sub-1', CLAIM);

    expect(prismaMock.assignmentProblemGrade.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ groupGradeGroupId: 'grp-1', groupGradeValue: 10 }),
      }),
    );
    const createArg = prismaMock.assignmentProblemGrade.createMany.mock.calls[0]![0];
    expect(createArg.data[0]).toMatchObject({ groupGradeGroupId: 'grp-1', groupGradeValue: 10 });
  });

  // An individual submission has no group to attribute the grade to, and stamping one would
  // make a solo grade read as part of a group's.
  it('records no group provenance for an individual submission', async () => {
    // Set explicitly: a previous test's group submission would otherwise still be returned.
    prismaMock.submission.findUnique.mockResolvedValue({
      ...makeSubmission(),
      studentGroupId: null,
    });
    executeMock.mockResolvedValue({ stdout: '{"correct":true,"feedback":"great"}', stderr: '' });

    await evaluateSubmission('sub-1', CLAIM);

    const createArg = prismaMock.assignmentProblemGrade.createMany.mock.calls[0]![0];
    expect(createArg.data[0]).not.toHaveProperty('groupGradeGroupId');
  });

  // A group is graded together or not at all: two statements outside a transaction could
  // leave half the members updated with nothing recording which half.
  it('writes the whole fan-out in one transaction', async () => {
    prismaMock.submission.findUnique.mockResolvedValue({
      ...makeSubmission(),
      studentGroupId: 'grp-1',
    });
    prismaMock.groupMembership.findMany.mockResolvedValue([{ userId: 'm1' }, { userId: 'm2' }]);
    executeMock.mockResolvedValue({ stdout: '{"correct":true,"feedback":"great"}', stderr: '' });

    await evaluateSubmission('sub-1', CLAIM);

    expect(prismaMock.$transaction).toHaveBeenCalled();
  });

  /**
   * On a hand-graded problem the evaluator is a feedback tool and nothing more. It still
   * runs, and its feedback still reaches the student, but it must never put a number on a
   * grade a person owns.
   */
  it('gives feedback but sets no grade when the problem has the autograder disabled', async () => {
    const submission = makeSubmission();
    submission.assignmentProblem.autograderEnabled = false;
    prismaMock.submission.findUnique.mockResolvedValue(submission);
    executeMock.mockResolvedValue({ stdout: '{"correct":true,"feedback":"great"}', stderr: '' });

    await evaluateSubmission('sub-1', CLAIM);

    expect(prismaMock.assignmentProblemGrade.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.assignmentProblemGrade.createMany).not.toHaveBeenCalled();
    // The feedback half still happens: correct answers included, which is the case where
    // silently skipping the whole write would be easiest to miss.
    expect(prismaMock.submission.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ feedback: 'great', correct: true }),
      }),
    );
  });

  it('discards a stale result (and skips autograde) when the row was reclaimed mid-evaluation', async () => {
    prismaMock.submission.findUnique.mockResolvedValue(makeSubmission());
    executeMock.mockResolvedValue({ stdout: '{"correct":true,"feedback":"great"}', stderr: '' });
    // The fenced completion write matches nothing: another worker re-claimed the row.
    prismaMock.submission.updateMany.mockResolvedValue({ count: 0 });

    await evaluateSubmission('sub-1', CLAIM);

    expect(prismaMock.assignmentProblemGrade.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.assignmentProblemGrade.createMany).not.toHaveBeenCalled();
    expect(loggedActions()).not.toContain('SUBMISSION_AUTOGRADED');
  });

  it('returns a transient failure to PENDING for retry when attempts remain', async () => {
    prismaMock.submission.findUnique.mockResolvedValue(makeSubmission({ attempts: 0 }));
    // The completion write blows up → caught as a transient error.
    prismaMock.submission.updateMany.mockRejectedValueOnce(new Error('db blip'));

    await evaluateSubmission('sub-1', CLAIM);

    // The error path requeues the row (fenced on the claim attempts).
    expect(prismaMock.submission.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { status: 'PENDING', processingToken: null } }),
    );
    expect(loggedActions()).toContain('SUBMISSION_ERROR');
  });

  it('permanently fails a submission once the attempt budget is exhausted', async () => {
    prismaMock.submission.findUnique.mockResolvedValue(makeSubmission({ attempts: 3 }));
    prismaMock.submission.updateMany.mockRejectedValueOnce(new Error('db blip'));

    await evaluateSubmission('sub-1', CLAIM);

    expect(prismaMock.submission.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
    expect(loggedActions()).toContain('SUBMISSION_FAILED_PERMANENTLY');
  });
});

describe('runWorkerLoop — claiming and prioritization', () => {
  beforeEach(() => {
    // The loop reschedules itself via setTimeout; keep the clock under control.
    vi.useFakeTimers();
    prismaMock.submission.findMany.mockResolvedValue([]); // no in-flight students
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('idles without claiming anything when the queue is empty', async () => {
    prismaMock.submission.findFirst.mockResolvedValue(null);
    await runWorkerLoop();
    expect(prismaMock.submission.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.submission.findUnique).not.toHaveBeenCalled();
  });

  /**
   * Fairness, expressed as a query. One student must not occupy several worker slots at once,
   * and the only thing enforcing that is the `notIn` on this read. The prisma mock returns the
   * same pending row either way, so every other test here passes with the filter gone and the
   * queue quietly starving everybody behind a student with a batch in flight.
   */
  it('skips students who already have work in flight', async () => {
    prismaMock.submission.findMany.mockResolvedValue([{ studentId: 's1' }, { studentId: 's2' }]);
    prismaMock.submission.findFirst.mockResolvedValue(null);

    await runWorkerLoop();

    expect(prismaMock.submission.findFirst.mock.calls[0][0]).toMatchObject({
      where: { status: 'PENDING', studentId: { notIn: ['s1', 's2'] } },
    });
  });

  it('asks for any pending work when nobody is busy', async () => {
    prismaMock.submission.findFirst.mockResolvedValue(null);

    await runWorkerLoop();

    // No ids, so no filter at all: an empty `notIn` matches nothing in Prisma.
    expect(prismaMock.submission.findFirst.mock.calls[0][0]).toMatchObject({
      where: { status: 'PENDING' },
    });
    expect(
      (prismaMock.submission.findFirst.mock.calls[0][0] as { where: Record<string, unknown> }).where,
    ).not.toHaveProperty('studentId');
  });

  it('claims a pending submission then evaluates it', async () => {
    prismaMock.submission.findFirst.mockResolvedValue({ id: 'sub-1', attempts: 0 });
    prismaMock.submission.updateMany.mockResolvedValue({ count: 1 }); // claim wins
    prismaMock.submission.findUnique.mockResolvedValue(makeSubmission());

    await runWorkerLoop();

    // The claim flips the row to PROCESSING, bumps attempts, and stamps the token every
    // later write is fenced on.
    expect(prismaMock.submission.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'PROCESSING',
          attempts: { increment: 1 },
          processingToken: expect.any(String),
        }),
      }),
    );
    // ...and evaluation runs (findUnique is only reached inside evaluateSubmission).
    expect(prismaMock.submission.findUnique).toHaveBeenCalled();
  });

  it('runs a waiting staff trial before it looks at the submission queue', async () => {
    prismaMock.evaluatorTrial.findFirst.mockResolvedValue({ id: 'trial-1' });
    prismaMock.evaluatorTrial.findUnique.mockResolvedValue({
      answerFileName: 'a.jff',
      submissionFileName: 's.jff',
      problemType: 'FA',
      maxStates: 5,
      isDeterministic: true,
    });

    await runWorkerLoop();

    expect(prismaMock.evaluatorTrial.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'trial-1', state: 'PENDING' } }),
    );
    expect(prismaMock.submission.findFirst).not.toHaveBeenCalled();
  });

  it('grades submissions as usual when the trial ceiling is already reached', async () => {
    prismaMock.evaluatorTrial.findFirst.mockResolvedValue({ id: 'trial-1' });
    prismaMock.evaluatorTrial.count.mockResolvedValue(2);
    prismaMock.submission.findFirst.mockResolvedValue({ id: 'sub-1', attempts: 0 });
    prismaMock.submission.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.submission.findUnique.mockResolvedValue(makeSubmission());

    await runWorkerLoop();

    expect(prismaMock.submission.findUnique).toHaveBeenCalled();
  });

  it('backs off without evaluating when another worker wins the claim', async () => {
    prismaMock.submission.findFirst.mockResolvedValue({ id: 'sub-1', attempts: 0 });
    prismaMock.submission.updateMany.mockResolvedValue({ count: 0 }); // lost the race

    await runWorkerLoop();

    expect(prismaMock.submission.findUnique).not.toHaveBeenCalled();
  });

  it('poison-pills a submission that exceeded the attempt budget', async () => {
    prismaMock.submission.findFirst.mockResolvedValue({ id: 'sub-1', attempts: 3 });
    prismaMock.submission.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.submission.findUnique.mockResolvedValue({
      id: 'sub-1',
      studentId: 'stu-1',
      courseId: 'c-1',
      assignmentId: 'a-1',
      problemId: 'p-1',
    });

    await runWorkerLoop();

    expect(prismaMock.submission.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
    expect(loggedActions()).toContain('SUBMISSION_FAILED_PERMANENTLY');
  });

  it('logs a queue error when the loop query throws', async () => {
    prismaMock.submission.findMany.mockRejectedValue(new Error('db down'));
    await runWorkerLoop();
    expect(loggedActions()).toContain('SUBMISSION_QUEUE_ERROR');
  });
});

describe('idle backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    prismaMock.submission.findMany.mockResolvedValue([]);
    markWorkSeen(); // start every case from "the queue just had work"
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('polls quickly right after the queue empties, then eases off', () => {
    expect(idleDelayMs()).toBe(3_000);

    vi.advanceTimersByTime(60_000);
    expect(idleDelayMs()).toBe(10_000);

    vi.advanceTimersByTime(240_000); // 5 minutes idle
    expect(idleDelayMs()).toBe(30_000);
  });

  it('caps the wait however long the queue stays empty', () => {
    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(idleDelayMs()).toBe(30_000);
  });

  it('drops back to the shortest wait as soon as a loop finds a submission', async () => {
    vi.advanceTimersByTime(600_000);
    expect(idleDelayMs()).toBe(30_000);

    prismaMock.submission.findFirst.mockResolvedValue({ id: 'sub-1', attempts: 0 });
    prismaMock.submission.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.submission.findUnique.mockResolvedValue(makeSubmission());
    await runWorkerLoop();

    expect(idleDelayMs()).toBe(3_000);
  });

  it('speeds back up when the loser of a claim race sees work', async () => {
    vi.advanceTimersByTime(600_000);

    prismaMock.submission.findFirst.mockResolvedValue({ id: 'sub-1', attempts: 0 });
    prismaMock.submission.updateMany.mockResolvedValue({ count: 0 }); // another loop won
    await runWorkerLoop();

    // It graded nothing, but a row existed, so the queue is active.
    expect(idleDelayMs()).toBe(3_000);
  });

  it('speeds back up when the reaper puts work back on the queue', async () => {
    vi.advanceTimersByTime(600_000);

    getEvaluatorConfigMock.mockResolvedValue(CONFIG);
    prismaMock.submission.updateMany.mockResolvedValue({ count: 1 });
    await reapStuckSubmissions();

    expect(idleDelayMs()).toBe(3_000);
  });

  // The cases above prove idleDelayMs computes the right number. These two prove the
  // loop actually waits it, which is the part that would silently break if someone
  // reverted the scheduleAsync call to a constant.
  it('waits the backed-off delay before the next pass when the queue is empty', async () => {
    vi.advanceTimersByTime(600_000);
    prismaMock.submission.findFirst.mockResolvedValue(null);
    const scheduled = vi.spyOn(globalThis, 'setTimeout');

    await runWorkerLoop();

    expect(scheduled).toHaveBeenCalledWith(expect.any(Function), 30_000);
    scheduled.mockRestore();
  });

  it('comes straight back after handling a submission, whatever the backoff was', async () => {
    vi.advanceTimersByTime(600_000);
    prismaMock.submission.findFirst.mockResolvedValue({ id: 'sub-1', attempts: 0 });
    prismaMock.submission.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.submission.findUnique.mockResolvedValue(makeSubmission());
    const scheduled = vi.spyOn(globalThis, 'setTimeout');

    await runWorkerLoop();

    expect(scheduled).toHaveBeenCalledWith(expect.any(Function), 100);
    scheduled.mockRestore();
  });

  it('leaves the backoff alone when the reaper finds nothing stuck', async () => {
    vi.advanceTimersByTime(600_000);

    getEvaluatorConfigMock.mockResolvedValue(CONFIG);
    prismaMock.submission.updateMany.mockResolvedValue({ count: 0 });
    await reapStuckSubmissions();

    expect(idleDelayMs()).toBe(30_000);
  });
});

describe('reapStuckSubmissions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getEvaluatorConfigMock.mockResolvedValue(CONFIG);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('requeues stuck PROCESSING rows and logs the recovery', async () => {
    prismaMock.submission.updateMany.mockResolvedValue({ count: 2 });
    await reapStuckSubmissions();
    expect(prismaMock.submission.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'PENDING', processingToken: null } }),
    );
    expect(loggedActions()).toContain('SUBMISSION_QUEUE_REAPED');
  });

  it('stays quiet when nothing was stuck', async () => {
    prismaMock.submission.updateMany.mockResolvedValue({ count: 0 });
    await reapStuckSubmissions();
    expect(loggedActions()).not.toContain('SUBMISSION_QUEUE_REAPED');
  });

  it('logs a reaper error if the sweep query fails', async () => {
    prismaMock.submission.updateMany.mockRejectedValue(new Error('db down'));
    await reapStuckSubmissions();
    expect(loggedActions()).toContain('SUBMISSION_QUEUE_REAPER_ERROR');
  });
});
