import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * Direct coverage for the submission pipeline.
 *
 * This module had none: its only test consumer (the client submissions route) mocks
 * `createSubmission` out entirely and asserts delegation, so every gate below - the
 * enrollment check, the unpublished/not-assigned masking, the cap, the cooldown, the
 * deadline window, the orphan-file cleanup - was running unexercised in tests.
 *
 * The pure collaborators (`effective-deadline`, `submission-window`,
 * `assignment-visibility`) are deliberately NOT mocked. They are the interesting part
 * of several of these decisions, and stubbing them would turn "the late window is
 * enforced" into "we called a function".
 */

const prismaMock = vi.hoisted(() => ({
  assignmentProblem: { findUnique: vi.fn() },
  assignment: { findUnique: vi.fn() },
  submission: { count: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  submissionGrant: { findMany: vi.fn() },
  $transaction: vi.fn(),
}));
const auditMock = vi.hoisted(() => vi.fn());
const uploadLimitMock = vi.hoisted(() => vi.fn());
const queueSettingsMock = vi.hoisted(() => vi.fn());
const validateXmlMock = vi.hoisted(() => vi.fn());
const canAccessMock = vi.hoisted(() => vi.fn());
const canManageMock = vi.hoisted(() => vi.fn());
const isArchivedMock = vi.hoisted(() => vi.fn());
const lockGroupSetMock = vi.hoisted(() => vi.fn());
const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/activity-log-utils', () => ({ createEnhancedActivityLog: auditMock }));
vi.mock('@/lib/upload-limits', () => ({ getSystemUploadLimit: uploadLimitMock }));
vi.mock('@/lib/eval-config', () => ({ getQueueSettings: queueSettingsMock }));
vi.mock('@/app/utils/xmlStructureValidate', () => ({ validateStructureXML: validateXmlMock }));
vi.mock('@/lib/permissions', () => ({
  canAccessCourse: canAccessMock,
  canManageCourse: canManageMock,
  isCourseArchived: isArchivedMock,
}));
vi.mock('@/lib/group-set-service', () => ({ lockGroupSetIfUsed: lockGroupSetMock }));
vi.mock('@/lib/safe-upload', () => ({
  safeStoredFilename: () => 'stored-uuid.jff',
  resolveInsideDir: (dir: string, name: string) => `${dir}/${name}`,
}));
vi.mock('fs', () => ({ default: fsMock, ...fsMock }));

import { createSubmission } from './create-submission';

const STUDENT = { id: 'student-1', isAdmin: false };
const HOUR = 60 * 60 * 1000;
const future = (ms = 24 * HOUR) => new Date(Date.now() + ms);
const past = (ms = 24 * HOUR) => new Date(Date.now() - ms);

/**
 * The transaction client the real code sees inside `$transaction`.
 *
 * `findFirst` is here because the cooldown is re-read inside the transaction: the check before
 * it is a courtesy, and two requests can both pass that one.
 */
function txClient(created: unknown, countInTx = 0, lastInTx: { submittedAt: Date } | null = null) {
  return {
    submission: {
      count: vi.fn().mockResolvedValue(countInTx),
      create: vi.fn().mockResolvedValue(created),
      findFirst: vi.fn().mockResolvedValue(lastInTx),
    },
  };
}

type Overrides = {
  /** What the cooldown re-read inside the transaction finds, when it differs from before. */
  lastInTx?: { submittedAt: Date } | null;
  link?: Record<string, unknown> | null;
  assignment?: Record<string, unknown> | null;
  staff?: boolean;
  enrolled?: boolean;
  archived?: boolean;
  priorCount?: number;
  lastSubmittedAt?: Date | null;
  cooldownMs?: number;
  countInTx?: number;
  grants?: Array<Record<string, unknown>>;
};

/** Happy path by default; each test overrides only the thing it is about. */
function setup(o: Overrides = {}) {
  const created = { id: 'sub-1', status: 'PENDING' };

  prismaMock.assignmentProblem.findUnique.mockResolvedValue(
    o.link === undefined
      ? {
          maxSubmissions: 3,
          problem: { fileName: 'p.jff', type: 'FA', maxStates: null, isDeterministic: null },
        }
      : o.link,
  );

  prismaMock.assignment.findUnique.mockResolvedValue(
    o.assignment === undefined
      ? {
          id: 'a-1',
          courseId: 'course-1',
          unlockAt: null,
          dueDate: future(),
          allowLateSubmissions: false,
          lateCutoff: null,
          isPublished: true,
          assignedToEveryone: true,
          groupSetId: null,
          assignees: [],
          overrides: [],
        }
      : o.assignment,
  );

  canAccessMock.mockResolvedValue(o.enrolled ?? true);
  canManageMock.mockResolvedValue(o.staff ?? false);
  isArchivedMock.mockResolvedValue(o.archived ?? false);
  uploadLimitMock.mockResolvedValue({ maxBytes: 1024 * 1024, maxMb: 1 });
  queueSettingsMock.mockResolvedValue({ resubmitCooldownMs: o.cooldownMs ?? 0 });
  validateXmlMock.mockReturnValue({ isValid: true });
  prismaMock.submission.count.mockResolvedValue(o.priorCount ?? 0);
  prismaMock.submission.findFirst.mockResolvedValue(
    o.lastSubmittedAt ? { submittedAt: o.lastSubmittedAt } : null,
  );
  prismaMock.submissionGrant.findMany.mockResolvedValue(o.grants ?? []);

  const tx = txClient(created, o.countInTx ?? 0, o.lastInTx ?? null);
  prismaMock.$transaction.mockImplementation(async (cb: (c: typeof tx) => unknown) => cb(tx));
  fsMock.existsSync.mockReturnValue(true);

  return { created, tx };
}

const call = (extra: Partial<Parameters<typeof createSubmission>[0]> = {}) =>
  createSubmission({
    user: STUDENT,
    assignmentId: 'a-1',
    problemId: 'p-1',
    file: null,
    req: new Request('http://localhost/api/submissions'),
    source: 'web',
    ...extra,
  });

/** The action names passed to the audit logger during this call. */
const auditActions = () => auditMock.mock.calls.map((c) => c[2].action);
/** The whole entries, for the cases that care what was recorded and not only that it was. */
const auditEntries = () =>
  auditMock.mock.calls.map((c) => c[2] as { action: string; metadata?: Record<string, unknown> });

beforeEach(() => {
  // resetAllMocks, NOT clearAllMocks: clear only wipes recorded calls and leaves
  // implementations in place, so a stub like the "disk full" writeFileSync below would
  // leak into every later test and make results depend on file order.
  vi.resetAllMocks();
  auditMock.mockResolvedValue(undefined);
  lockGroupSetMock.mockResolvedValue(undefined);
});

describe('createSubmission', () => {
  describe('request shape', () => {
    it.each([
      ['assignmentId missing', { assignmentId: undefined }],
      ['problemId missing', { problemId: undefined }],
    ])('rejects when %s', async (_label, extra) => {
      setup();
      const res = await call(extra);
      expect(res).toMatchObject({ ok: false, status: 400, error: 'Missing required fields' });
      expect(auditActions()).toContain('SUBMISSION_INVALID_REQUEST');
    });

    it('rejects a problem that is not linked to the assignment', async () => {
      setup({ link: null });
      const res = await call();
      expect(res).toMatchObject({ ok: false, status: 400 });
      expect((res as { error: string }).error).toMatch(/not linked/i);
    });

    it('404s when the assignment does not exist', async () => {
      setup({ assignment: null });
      expect(await call()).toMatchObject({
        ok: false,
        status: 404,
        error: 'Assignment not found.',
      });
    });
  });

  describe('authorization', () => {
    it('forbids a user who is not on the course roster', async () => {
      setup({ enrolled: false });
      const res = await call();
      expect(res).toMatchObject({ ok: false, status: 403, error: 'Forbidden' });
      expect(auditActions()).toContain('SUBMISSION_FORBIDDEN');
    });

    it('trusts the assignment course, not the client-supplied courseId', async () => {
      setup();
      await call({ courseId: 'attacker-supplied-course' });
      // Authorization must be evaluated against the course the assignment really
      // belongs to; otherwise a caller could name a course they happen to be in.
      expect(canAccessMock).toHaveBeenCalledWith(STUDENT, 'course-1');
    });

    it('hides an unpublished assignment from a student as a 404, not a 403', async () => {
      // A 403 would confirm the assignment exists. Masking is the point.
      setup({ assignment: { ...baseAssignment(), isPublished: false } });
      const res = await call();
      expect(res).toMatchObject({ ok: false, status: 404, error: 'Assignment not found.' });
      expect(auditActions()).toContain('SUBMISSION_UNPUBLISHED_ASSIGNMENT');
    });

    it('lets staff test-submit an unpublished assignment', async () => {
      setup({ assignment: { ...baseAssignment(), isPublished: false }, staff: true });
      expect(await call()).toMatchObject({ ok: true });
    });

    it('hides an assignment the student is not assigned as a 404', async () => {
      setup({
        assignment: { ...baseAssignment(), assignedToEveryone: false, assignees: [] },
      });
      const res = await call();
      expect(res).toMatchObject({ ok: false, status: 404, error: 'Assignment not found.' });
      expect(auditActions()).toContain('SUBMISSION_NOT_ASSIGNED');
    });

    it('accepts a student who is individually assigned', async () => {
      setup({
        assignment: {
          ...baseAssignment(),
          assignedToEveryone: false,
          assignees: [{ targetType: 'STUDENT', userId: STUDENT.id, groupId: null }],
        },
      });
      expect(await call()).toMatchObject({ ok: true });
    });

    it('rejects submissions to an archived course even from staff', async () => {
      // Archived is a freeze for everyone, which is easy to regress into "staff bypass".
      setup({ archived: true, staff: true });
      const res = await call();
      expect(res).toMatchObject({ ok: false, status: 409 });
      expect((res as { error: string }).error).toMatch(/archived/i);
    });
  });

  describe('submission cap', () => {
    it('rejects once the per-problem cap is met', async () => {
      setup({ priorCount: 3 });
      const res = await call();
      expect(res).toMatchObject({ ok: false, status: 409 });
      expect((res as { error: string }).error).toMatch(/limit reached \(3\)/);
      expect(auditActions()).toContain('SUBMISSION_LIMIT_REACHED');
    });

    it('exempts staff from the cap', async () => {
      setup({ priorCount: 99, staff: true });
      expect(await call()).toMatchObject({ ok: true });
    });

    it('treats maxSubmissions <= 0 as unlimited', async () => {
      setup({
        link: { maxSubmissions: -1, problem: { fileName: 'p.jff', type: 'FA' } },
        priorCount: 500,
      });
      expect(await call()).toMatchObject({ ok: true });
    });

    it('an extra-submission grant raises the cap for its target', async () => {
      // Base cap 3 already used; a +1 grant for this student lets a 4th through.
      setup({
        priorCount: 3,
        grants: [{ targetType: 'STUDENT', userId: STUDENT.id, groupId: null, extraSubmissions: 1 }],
      });
      expect(await call()).toMatchObject({ ok: true });
    });

    it('the raised cap is enforced too, and the error names the effective limit', async () => {
      setup({
        priorCount: 4,
        grants: [{ targetType: 'STUDENT', userId: STUDENT.id, groupId: null, extraSubmissions: 1 }],
      });
      const res = await call();
      expect(res).toMatchObject({ ok: false, status: 409 });
      expect((res as { error: string }).error).toMatch(/limit reached \(4\)/);
    });

    it("someone else's grant does not raise this student's cap", async () => {
      setup({
        priorCount: 3,
        grants: [{ targetType: 'STUDENT', userId: 'other-1', groupId: null, extraSubmissions: 5 }],
      });
      expect(await call()).toMatchObject({ ok: false, status: 409 });
    });

    it("a GROUP grant raises the cap for the group's members", async () => {
      setup({
        assignment: {
          ...baseAssignment(),
          groupSetId: 'gs-1',
          assignees: [{ targetType: 'GROUP', userId: null, groupId: 'grp-1' }],
        },
        priorCount: 3,
        grants: [{ targetType: 'GROUP', userId: null, groupId: 'grp-1', extraSubmissions: 1 }],
      });
      expect(await call()).toMatchObject({ ok: true });
    });

    it('re-checks the cap inside the transaction and rejects a racing submit', async () => {
      // The pre-check passes, but a concurrent submit filled the last slot before this
      // one committed. Without the in-transaction re-check both would be accepted.
      setup({ priorCount: 2, countInTx: 3 });
      const res = await call();
      expect(res).toMatchObject({ ok: false, status: 409 });
      expect((res as { error: string }).error).toMatch(/limit reached/i);
    });

    it('logs the racing refusal, which used to leave no trace at all', async () => {
      // The cooldown's concurrent case has always been logged; the cap's was not, so a
      // student stopped by a race looked in the record like someone who never tried. RQ5
      // makes submission limits a study variable, so the log is the measurement.
      setup({ priorCount: 2, countInTx: 3 });
      await call();

      expect(auditActions()).toContain('SUBMISSION_LIMIT_REACHED');
      const entry = auditEntries().find((e) => e.action === 'SUBMISSION_LIMIT_REACHED');
      // The same fields the pre-transaction check writes, plus the flag that tells them apart.
      expect(entry?.metadata).toMatchObject({ priorCount: 3, concurrent: true });
    });

    it('maps a serialization failure (P2034) to a retryable conflict', async () => {
      setup();
      prismaMock.$transaction.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('write conflict', {
          code: 'P2034',
          clientVersion: 'test',
        }),
      );
      const res = await call();
      expect(res).toMatchObject({ ok: false, status: 409 });
      expect((res as { error: string }).error).toMatch(/concurrent submission conflicted/i);
    });
  });

  describe('cooldown', () => {
    it('rate-limits a resubmit inside the cooldown and reports Retry-After', async () => {
      setup({ cooldownMs: 60_000, lastSubmittedAt: new Date(Date.now() - 10_000) });
      const res = await call();
      expect(res).toMatchObject({ ok: false, status: 429 });
      // ~50s left; allow a second of slop for clock movement during the test.
      const retry = Number((res as { headers: Record<string, string> }).headers['Retry-After']);
      expect(retry).toBeGreaterThan(45);
      expect(retry).toBeLessThanOrEqual(51);
      expect(auditActions()).toContain('SUBMISSION_RATE_LIMITED');
    });

    it('allows a resubmit once the cooldown has elapsed', async () => {
      setup({ cooldownMs: 60_000, lastSubmittedAt: new Date(Date.now() - 120_000) });
      expect(await call()).toMatchObject({ ok: true });
    });

    /**
     * The check before the transaction is a courtesy; this is the rule.
     *
     * Two requests a millisecond apart both saw an empty cooldown and both submitted, which is
     * the rule defeated by pressing the button twice. The authoritative read happens inside the
     * same serializable transaction as the insert.
     */
    it('refuses a second submission that only the transaction can see', async () => {
      setup({
        cooldownMs: 60_000,
        // Nothing to see before the transaction: the racing request had not landed yet.
        lastSubmittedAt: null,
        // By the time this one inserts, the other has committed.
        lastInTx: { submittedAt: new Date(Date.now() - 1_000) },
      });

      const res = await call();

      expect(res).toMatchObject({ ok: false, status: 429 });
      // Answered the same way the fast check answers, so a student cannot tell which caught
      // them and does not need to.
      expect((res as { headers: Record<string, string> }).headers['Retry-After']).toBe('59');
      expect(auditActions()).toContain('SUBMISSION_RATE_LIMITED');
    });

    it('lets it through when the transaction agrees the cooldown has passed', async () => {
      setup({
        cooldownMs: 60_000,
        lastSubmittedAt: new Date(Date.now() - 120_000),
        lastInTx: { submittedAt: new Date(Date.now() - 120_000) },
      });

      expect(await call()).toMatchObject({ ok: true });
    });

    it('skips the cooldown check entirely when it is disabled', async () => {
      setup({ cooldownMs: 0, lastSubmittedAt: new Date() });
      expect(await call()).toMatchObject({ ok: true });
      expect(prismaMock.submission.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('availability and late policy', () => {
    it('rejects a student before the assignment unlocks', async () => {
      setup({ assignment: { ...baseAssignment(), unlockAt: future(HOUR) } });
      const res = await call();
      expect(res).toMatchObject({ ok: false, status: 403 });
      expect((res as { error: string }).error).toMatch(/not open/i);
      expect(auditActions()).toContain('SUBMISSION_REJECTED_NOT_OPEN');
    });

    it('lets staff test-submit before unlock', async () => {
      setup({ assignment: { ...baseAssignment(), unlockAt: future(HOUR) }, staff: true });
      expect(await call()).toMatchObject({ ok: true });
    });

    it('rejects a late submission when late is not allowed', async () => {
      setup({
        assignment: { ...baseAssignment(), dueDate: past(HOUR), allowLateSubmissions: false },
      });
      const res = await call();
      expect(res).toMatchObject({ ok: false, status: 403 });
      expect(auditActions()).toContain('SUBMISSION_REJECTED_LATE');
    });

    it('accepts a late submission inside the cutoff', async () => {
      setup({
        assignment: {
          ...baseAssignment(),
          dueDate: past(HOUR),
          allowLateSubmissions: true,
          lateCutoff: future(HOUR),
        },
      });
      expect(await call()).toMatchObject({ ok: true });
    });

    it('rejects a late submission past the cutoff', async () => {
      setup({
        assignment: {
          ...baseAssignment(),
          dueDate: past(48 * HOUR),
          allowLateSubmissions: true,
          lateCutoff: past(HOUR),
        },
      });
      const res = await call();
      expect(res).toMatchObject({ ok: false, status: 403 });
      expect(auditActions()).toContain('SUBMISSION_REJECTED_LATE_CUTOFF');
    });

    it('honors a per-student override that extends the deadline past the base due date', async () => {
      // The base assignment is closed; only the override makes this acceptable, so this
      // proves the resolver is actually consulted rather than the base dates.
      setup({
        assignment: {
          ...baseAssignment(),
          dueDate: past(HOUR),
          allowLateSubmissions: false,
          overrides: [
            {
              targetType: 'STUDENT',
              userId: STUDENT.id,
              groupId: null,
              unlockAt: null,
              dueDate: future(HOUR),
              lateCutoff: null,
              allowLateSubmissions: null,
            },
          ],
        },
      });
      expect(await call()).toMatchObject({ ok: true });
    });
  });

  describe('group assignments', () => {
    /**
     * A group assignment the submitter is a member of.
     *
     * Membership is what makes it a group submission, not the audience rows: `groupSet.groups`
     * is the submitter's group in the assignment's set, which is what the query selects.
     */
    const groupAssignment = (over: Record<string, unknown> = {}) => ({
      ...baseAssignment(),
      groupSetId: 'gs-1',
      assignedToEveryone: false,
      assignees: [{ targetType: 'GROUP', userId: null, groupId: 'group-9' }],
      groupSet: { groups: [{ id: 'group-9' }] },
      ...over,
    });

    it('files the submission against the group and scopes the cap group-wide', async () => {
      const { tx } = setup({ assignment: groupAssignment() });
      const res = await call();

      expect(res).toMatchObject({ ok: true });
      expect(tx.submission.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ studentGroupId: 'group-9', studentId: STUDENT.id }),
        }),
      );
      // The cap counts the group's submissions, not just this student's, or each member
      // would get their own full allowance.
      expect(prismaMock.submission.count).toHaveBeenCalledWith({
        where: { assignmentId: 'a-1', problemId: 'p-1', studentGroupId: 'group-9' },
      });
    });

    /**
     * The mirror of the case above, and the one that was unguarded: a student can be in a
     * group in the course while the assignment they are submitting to is not group work.
     * Filing that against the group would pool their cap with people they are not working
     * with, and put one student's submission in front of the others.
     */
    it('files an individual assignment against the student, even when they are in a group', async () => {
      const { tx } = setup({
        // Not a group assignment, but the submitter is still a member of group-9.
        assignment: { ...groupAssignment(), groupSetId: null },
      });

      const res = await call();

      expect(res).toMatchObject({ ok: true });
      expect(tx.submission.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ studentGroupId: null, studentId: STUDENT.id }),
        }),
      );
      // And the cap counts only this student's attempts.
      expect(prismaMock.submission.count).toHaveBeenCalledWith({
        where: { assignmentId: 'a-1', problemId: 'p-1', studentId: STUDENT.id },
      });
    });

    it('locks the group set as part of the same transaction', async () => {
      setup({ assignment: groupAssignment() });
      await call();
      expect(lockGroupSetMock).toHaveBeenCalledWith(expect.anything(), 'gs-1');
    });

    /**
     * The ordinary group assignment: "assigned to everyone", which carries NO assignee rows.
     *
     * This is the default every group assignment is created with, and it used to submit as
     * individuals, because the group was read off the audience rows rather than off
     * membership. Each member quietly got their own submission set and their own full cap.
     */
    it('shares the group set and the cap when the assignment is simply assigned to everyone', async () => {
      const { tx } = setup({
        assignment: groupAssignment({ assignedToEveryone: true, assignees: [] }),
      });
      const res = await call();

      expect(res).toMatchObject({ ok: true });
      expect(tx.submission.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ studentGroupId: 'group-9', studentId: STUDENT.id }),
        }),
      );
      expect(prismaMock.submission.count).toHaveBeenCalledWith({
        where: { assignmentId: 'a-1', problemId: 'p-1', studentGroupId: 'group-9' },
      });
    });

    it('submits individually when the student is in none of the set’s groups', async () => {
      const { tx } = setup({
        assignment: groupAssignment({
          assignedToEveryone: true,
          assignees: [],
          groupSet: { groups: [] },
        }),
      });
      await call();

      expect(tx.submission.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ studentGroupId: null }) }),
      );
      expect(prismaMock.submission.count).toHaveBeenCalledWith({
        where: { assignmentId: 'a-1', problemId: 'p-1', studentId: STUDENT.id },
      });
    });

    it('keeps an individual assignment individual even if a GROUP override names a group', async () => {
      // groupSetId is what makes an assignment a group assignment. A stray GROUP override
      // must move the deadline, never the submission set.
      const { tx } = setup({
        assignment: {
          ...baseAssignment(),
          overrides: [
            {
              targetType: 'GROUP',
              userId: null,
              groupId: 'group-9',
              unlockAt: null,
              dueDate: future(HOUR),
              lateCutoff: null,
              allowLateSubmissions: null,
            },
          ],
        },
      });
      await call();

      expect(tx.submission.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ studentGroupId: null }) }),
      );
    });

    it('leaves an individual submission ungrouped and student-scoped', async () => {
      const { tx } = setup();
      await call();
      expect(tx.submission.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ studentGroupId: null }) }),
      );
      expect(prismaMock.submission.count).toHaveBeenCalledWith({
        where: { assignmentId: 'a-1', problemId: 'p-1', studentId: STUDENT.id },
      });
    });
  });

  describe('file handling', () => {
    const file = (content = '<structure></structure>', name = 'answer.jff') =>
      new File([content], name, { type: 'text/xml' });

    it('rejects a file over the configured upload limit', async () => {
      setup();
      uploadLimitMock.mockResolvedValue({ maxBytes: 5, maxMb: 0.000005 });
      const res = await call({ file: file('way too much content for five bytes') });
      expect(res).toMatchObject({ ok: false, status: 413 });
      expect(auditActions()).toContain('SUBMISSION_FILE_TOO_LARGE');
    });

    it('rejects a file that fails structure validation', async () => {
      setup();
      validateXmlMock.mockReturnValue({ isValid: false, error: 'Malformed automaton.' });
      const res = await call({ file: file() });
      expect(res).toMatchObject({ ok: false, status: 400, error: 'Malformed automaton.' });
      expect(auditActions()).toContain('SUBMISSION_INVALID_FILE_STRUCTURE');
      // Nothing may be written for a file we rejected.
      expect(fsMock.writeFileSync).not.toHaveBeenCalled();
    });

    it('fingerprints the file it stores, so matching never depends on the client', async () => {
      const { tx } = setup();

      await call({ file: file('<structure><type>fa</type></structure>') });

      const [{ data }] = tx.submission.create.mock.calls[0] as [
        { data: { contentHash: string; byteHash: string } },
      ];
      expect(data.contentHash).toMatch(/^[0-9a-f]{64}$/);
      // The raw bytes as well, so the tab can say "the same file" without a qualifier. (For
      // this fixture the two agree: it is already exactly its own canonical form.)
      expect(data.byteHash).toMatch(/^[0-9a-f]{64}$/);
      // Same content, second submission: the whole point is that these agree.
      const second = setup();
      await call({ file: file('<structure><type>fa</type></structure>', 'other-name.jff') });
      const [{ data: secondData }] = second.tx.submission.create.mock.calls[0] as [
        { data: { contentHash: string; byteHash: string } },
      ];
      expect(secondData.contentHash).toBe(data.contentHash);
      expect(secondData.byteHash).toBe(data.byteHash);
    });

    it('describes the artifact it stores, for the check that survives an edit', async () => {
      const { tx } = setup();

      await call({
        file: file(
          '<structure><type>fa</type><automaton>' +
            '<state id="0" name="q0"><x>10</x><y>10</y><initial/></state>' +
            '<state id="1" name="q1"><x>90</x><y>10</y><final/></state>' +
            '<transition><from>0</from><to>1</to><read>a</read></transition>' +
            '</automaton></structure>',
        ),
      });

      const [{ data }] = tx.submission.create.mock.calls[0] as [
        { data: { provenanceFeatures: { version: number; features: string[] } } },
      ];
      expect(data.provenanceFeatures.version).toBe(1);
      expect(data.provenanceFeatures.features.length).toBeGreaterThan(0);
    });

    it('records no fingerprint for a submission with no file', async () => {
      const { tx } = setup();

      await call({ file: null });

      const [{ data }] = tx.submission.create.mock.calls[0] as [
        { data: { contentHash: null; byteHash: null; provenanceFeatures: unknown } },
      ];
      expect(data.contentHash).toBeNull();
      expect(data.byteHash).toBeNull();
      // Prisma's JSON null, not a description of nothing.
      expect(data.provenanceFeatures).toBeDefined();
    });

    it('stores an accepted file under a generated name, never the client-supplied one', async () => {
      const { tx } = setup();
      const res = await call({ file: file('<structure></structure>', '../../etc/passwd') });

      expect(res).toMatchObject({ ok: true });
      expect(fsMock.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('stored-uuid.jff'),
        expect.any(Buffer),
        { mode: 0o644 },
      );
      // The original name survives as display metadata only.
      expect(tx.submission.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            fileName: 'stored-uuid.jff',
            originalFileName: '../../etc/passwd',
          }),
        }),
      );
    });

    it('deletes the stored file when the transaction fails, leaving no orphan', async () => {
      setup();
      prismaMock.$transaction.mockRejectedValue(new Error('db exploded'));
      const res = await call({ file: file() });

      expect(res).toMatchObject({ ok: false, status: 500 });
      expect(fsMock.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('stored-uuid.jff'));
      expect(auditActions()).toContain('SUBMISSION_ERROR');
    });

    it('deletes the stored file when the in-transaction cap check rejects', async () => {
      // The cap path returns rather than throws, so it needs its own cleanup and is easy
      // to miss when refactoring.
      setup({ priorCount: 2, countInTx: 3 });
      await call({ file: file() });
      expect(fsMock.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('stored-uuid.jff'));
    });

    it('creates no submission row when the file write itself fails', async () => {
      const { tx } = setup();
      fsMock.writeFileSync.mockImplementation(() => {
        throw new Error('disk full');
      });
      const res = await call({ file: file() });

      expect(res).toMatchObject({ ok: false, status: 500 });
      expect(tx.submission.create).not.toHaveBeenCalled();
    });

    it('accepts a submission with no file at all', async () => {
      setup();
      const res = await call({ file: null });
      expect(res).toMatchObject({ ok: true });
      expect(fsMock.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('success', () => {
    it('creates a PENDING row and audits the creation', async () => {
      const { created, tx } = setup();
      const res = await call();

      expect(res).toEqual({ ok: true, submission: created });
      expect(tx.submission.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            courseId: 'course-1',
            assignmentId: 'a-1',
            problemId: 'p-1',
            studentId: STUDENT.id,
          }),
        }),
      );
      expect(auditActions()).toContain('SUBMISSION_CREATED');
    });

    // Most students submit from the native client, so an entry that does not say which
    // front end it came from cannot answer "how did this student actually submit".
    it('records which front end submitted on every audit entry', async () => {
      setup();
      await call({ source: 'client' });

      const created = auditMock.mock.calls.find((c) => c[2].action === 'SUBMISSION_CREATED');
      expect(created?.[2].metadata).toMatchObject({ source: 'client' });
    });

    it('runs the insert at serializable isolation', async () => {
      setup();
      await call();
      expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    });
  });
});

/** The default assignment row, so overriding tests can spread and change one field. */
function baseAssignment() {
  return {
    id: 'a-1',
    courseId: 'course-1',
    unlockAt: null,
    dueDate: future(),
    allowLateSubmissions: false,
    lateCutoff: null,
    isPublished: true,
    assignedToEveryone: true,
    groupSetId: null,
    assignees: [],
    overrides: [],
  };
}

describe('once the transaction has committed', () => {
  const anyFile = () => new File(['<structure></structure>'], 'a.jff');

  it('still reports success when a post-commit audit write fails', async () => {
    const { created, tx } = setup();
    auditMock.mockImplementation(async (_p, _r, opts: { action: string }) => {
      if (opts.action === 'SUBMISSION_CREATED') throw new Error('activity log down');
    });

    const res = await call({ file: anyFile() });

    // The row committed, so the submission genuinely exists. Reporting 500 would make
    // the caller retry and burn another slot against the cap for a submission that was
    // already accepted.
    expect(tx.submission.create).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: true, submission: created });
  });

  it('does not delete the stored file when a post-commit audit write fails', async () => {
    // The committed row references this file; deleting it leaves the worker a queued
    // submission with nothing to evaluate.
    setup();
    auditMock.mockImplementation(async (_p, _r, opts: { action: string }) => {
      if (opts.action === 'SUBMISSION_CREATED') throw new Error('activity log down');
    });

    await call({ file: anyFile() });

    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  it('survives a failure in the earlier SUBMISSION_FILE_STORED audit too', async () => {
    const { created } = setup();
    auditMock.mockImplementation(async (_p, _r, opts: { action: string }) => {
      if (opts.action === 'SUBMISSION_FILE_STORED') throw new Error('activity log down');
    });

    const res = await call({ file: anyFile() });

    expect(res).toEqual({ ok: true, submission: created });
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });
});

describe('partial file writes', () => {
  it('cleans up a file whose write threw partway through', async () => {
    // writeFileSync can create the file and then fail. The path is recorded before the
    // write precisely so this partial file still gets removed.
    setup();
    fsMock.writeFileSync.mockImplementation(() => {
      throw new Error('disk full mid-write');
    });

    const res = await call({ file: new File(['<structure></structure>'], 'a.jff') });

    expect(res).toMatchObject({ ok: false, status: 500 });
    expect(fsMock.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('stored-uuid.jff'));
  });
});

/**
 * What the grant read is scoped to.
 *
 * The extra attempts a submitter is working against are read here and nowhere else, so this
 * `where` alone decides the cap. The prisma mock returns whatever grants a test installed
 * regardless of the query, so nothing above notices a key going missing: without the
 * `problemId` a grant for one problem raises the cap on every problem in the assignment, and
 * without the group arm scoped to the submitter's own groups it would pick up grants written
 * for somebody else's group.
 */
describe('what the grant read is scoped to', () => {
  const whereOf = () =>
    (prismaMock.submissionGrant.findMany.mock.calls[0][0] as { where: unknown }).where;

  it('asks for this problem, on this assignment, for this student', async () => {
    setup();

    await call();

    expect(whereOf()).toEqual({
      assignmentId: 'a-1',
      problemId: 'p-1',
      OR: [{ userId: 'student-1' }, { groupId: { in: [] } }],
    });
  });

  it('adds only the groups this submitter is actually in', async () => {
    setup({
      assignment: {
        id: 'a-1',
        courseId: 'course-1',
        unlockAt: null,
        dueDate: future(),
        allowLateSubmissions: false,
        lateCutoff: null,
        isPublished: true,
        assignedToEveryone: false,
        groupSetId: 'gs-1',
        assignees: [{ targetType: 'GROUP', userId: null, groupId: 'group-9' }],
        overrides: [],
        groupSet: { groups: [{ id: 'group-9' }] },
      },
    });

    await call();

    expect(whereOf()).toEqual({
      assignmentId: 'a-1',
      problemId: 'p-1',
      OR: [{ userId: 'student-1' }, { groupId: { in: ['group-9'] } }],
    });
  });
});
