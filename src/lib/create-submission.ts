// src/lib/create-submission.ts
//
// The whole submission-creation pipeline, extracted so the browser route
// (`/api/submissions`) and the native-client route (`/api/client/v1/submissions`)
// create submissions through identical code: same validation, caps, cooldown, late
// window, storage, serializable insert, audit logging, and the same PENDING → worker
// queue. Callers do their own authentication first and pass the resolved user.
import fs from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createEnhancedActivityLog, type LogSeverity } from '@/lib/activity-log-utils';
import { getSystemUploadLimit } from '@/lib/upload-limits';
import { getQueueSettings } from '@/lib/eval-config';
import { validateStructureXML } from '@/app/utils/xmlStructureValidate';
import { canAccessCourse, canManageCourse, isCourseArchived } from '@/lib/permissions';
import { safeStoredFilename, resolveInsideDir } from '@/lib/safe-upload';
import { errMessage } from '@/lib/errors';
import { evaluateSubmissionWindow } from '@/lib/submission-window';
import { effectiveDeadline } from '@/lib/effective-deadline';
import { effectiveMaxSubmissions } from '@/lib/submission-limits';
import { isStudentAssigned } from '@/lib/assignment-visibility';
import { lockGroupSetIfUsed } from '@/lib/group-set-service';
import {
  submissionByteHash,
  submissionContentHash,
  submissionShapeHash,
} from '@/lib/similarity/content-hash';
import { extractProvenanceFeatures, type ProvenanceFeatures } from '@/lib/similarity/provenance';

/** Thrown inside the create transaction when the per-problem cap is already met. */
/**
 * Thrown inside the create transaction when the cap is already met.
 *
 * Carries the count it saw so the refusal can be logged with the same fields the
 * pre-transaction check logs. RQ5 makes submission limits a study variable, so "the cap
 * stopped someone" has to look the same in `ActivityLog` whichever check caught them; a row
 * missing `priorCount` would read as a different kind of event to anyone analysing it.
 */
class SubmissionCapReachedError extends Error {
  constructor(readonly priorCount: number) {
    super('submission cap reached');
  }
}

/**
 * Thrown inside the create transaction when the cooldown has not elapsed.
 *
 * Carries the wait so the caller can answer with the same `Retry-After` the pre-transaction
 * check would have given, rather than a bare refusal.
 */
class ResubmitTooSoonError extends Error {
  constructor(readonly retryAfterSec: number) {
    super('resubmit cooldown');
  }
}

const SUBMISSION_UPLOAD_DIR = path.join('/private', 'uploads', 'submissions');

type SubmissionUser = { id: string; isAdmin?: boolean | null };

export type CreateSubmissionInput = {
  /** The authenticated submitter (session user or client token user). */
  user: SubmissionUser;
  /** Client-supplied course hint; ignored once the assignment is resolved. */
  courseId?: string;
  assignmentId?: string;
  problemId?: string;
  file: File | null;
  /** The originating request, used only for audit-log IP/UA context. */
  req: Request;
  /**
   * Which front end submitted. Recorded on every audit entry this service writes,
   * because most students submit from the native client rather than the browser and
   * the two are otherwise indistinguishable in the log (the user agent is stored, but
   * inferring the channel from it is guesswork that breaks when the client changes).
   */
  source: 'web' | 'client';
};

export type CreateSubmissionResult =
  | { ok: true; submission: Prisma.SubmissionGetPayload<object> }
  | { ok: false; status: number; error: string; headers?: Record<string, string> };

/** Best-effort delete of an orphaned upload; never throws. */
function cleanupFile(filePath: string | null, onError?: (err: unknown) => void): void {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    onError?.(err);
  }
}

/**
 * Persist an uploaded submission file at an already-resolved path.
 *
 * The caller resolves the path first and records it, so that a write which fails partway
 * through still leaves a path for the cleanup handler to unlink. Returning the path from
 * here instead would mean a partial file had no recorded location and leaked.
 */
function storeSubmissionFile(filePath: string, buffer: Buffer): void {
  if (!fs.existsSync(SUBMISSION_UPLOAD_DIR)) {
    fs.mkdirSync(SUBMISSION_UPLOAD_DIR, { recursive: true });
  }
  fs.writeFileSync(filePath, buffer, { mode: 0o644 });
}

/**
 * Validate + persist a submission. Returns a discriminated result (never a Response),
 * so each caller maps it to its own transport. The row is created `PENDING`; the
 * background worker picks it up.
 */
export async function createSubmission(
  input: CreateSubmissionInput,
): Promise<CreateSubmissionResult> {
  const { user, assignmentId, problemId, file, req, source } = input;
  const { maxBytes, maxMb } = await getSystemUploadLimit();

  // Every submission audit entry shares the same actor + course/assignment/problem/
  // submission identity, recorded both as foreign keys and inside `metadata`. Bind it
  // once here so each call site passes only its distinguishing fields. The context is
  // mutable: `courseId` is filled from the resolved assignment, and `submissionId`
  // once the row exists.
  const ctx = {
    userId: user.id,
    courseId: input.courseId,
    assignmentId,
    problemId,
    submissionId: undefined as string | undefined,
  };
  const audit = (action: string, severity: LogSeverity, meta: Record<string, unknown> = {}) =>
    createEnhancedActivityLog(prisma, req, {
      userId: ctx.userId,
      action,
      severity,
      category: 'SUBMISSION',
      courseId: ctx.courseId,
      assignmentId: ctx.assignmentId,
      problemId: ctx.problemId,
      submissionId: ctx.submissionId ?? null,
      metadata: {
        userId: ctx.userId,
        courseId: ctx.courseId,
        assignmentId: ctx.assignmentId,
        problemId: ctx.problemId,
        ...(ctx.submissionId ? { submissionId: ctx.submissionId } : {}),
        source,
        ...meta,
      },
    });

  if (!assignmentId || !problemId) {
    await audit('SUBMISSION_INVALID_REQUEST', 'WARNING', { error: 'Missing required fields' });
    return { ok: false, status: 400, error: 'Missing required fields' };
  }

  // The problem must be linked to the assignment.
  const link = await prisma.assignmentProblem.findUnique({
    where: { assignmentId_problemId: { assignmentId, problemId } },
    include: {
      problem: {
        select: {
          fileName: true,
          maxStates: true,
          isDeterministic: true,
          type: true,
        },
      },
    },
  });

  if (!link) {
    await audit('SUBMISSION_INVALID_REQUEST', 'WARNING', {
      error: 'Problem is not linked to this assignment.',
    });
    return { ok: false, status: 400, error: 'Problem is not linked to this assignment.' };
  }

  const assignment = await prisma.assignment.findUnique({
    where: { id: assignmentId },
    select: {
      id: true,
      courseId: true,
      unlockAt: true,
      dueDate: true,
      allowLateSubmissions: true,
      lateCutoff: true,
      isPublished: true,
      assignedToEveryone: true,
      groupSetId: true,
      // The submitter's group within this assignment's set, if any. Unique on
      // (groupSetId, userId), so this is at most one row.
      groupSet: {
        select: {
          groups: {
            where: { memberships: { some: { userId: user.id } } },
            select: { id: true },
          },
        },
      },
      // The assignee rows that cover this submitter: their own STUDENT row and/or the
      // GROUP row for a group they belong to. Drives "is this student assigned" and, for a
      // group target, the group submission set.
      assignees: {
        where: {
          OR: [
            { userId: user.id },
            { studentGroup: { memberships: { some: { userId: user.id } } } },
          ],
        },
        select: { targetType: true, userId: true, groupId: true },
      },
      // The date/late overrides that apply to this submitter: their own STUDENT override
      // and/or the GROUP override for a group they belong to (at most one of each).
      // Drives only the effective window.
      overrides: {
        where: {
          OR: [
            { userId: user.id },
            { studentGroup: { memberships: { some: { userId: user.id } } } },
          ],
        },
        select: {
          targetType: true,
          userId: true,
          groupId: true,
          unlockAt: true,
          dueDate: true,
          lateCutoff: true,
          allowLateSubmissions: true,
        },
      },
    },
  });

  if (!assignment) {
    await audit('SUBMISSION_INVALID_REQUEST', 'WARNING', { error: 'Assignment not found.' });
    return { ok: false, status: 404, error: 'Assignment not found.' };
  }

  // Trust the assignment's course, not the client-supplied courseId.
  const courseId = assignment.courseId;
  ctx.courseId = courseId;

  // The submitter's group for this assignment: their group in the assignment's group set.
  // Membership decides it, not the audience rows, so an ordinary group assignment (the
  // default, `assignedToEveryone`, which carries no assignee rows) still behaves as a group.
  // See resolveStudentAssignmentGroupIds, which is the same rule for every read path.
  const membershipGroupId = assignment.groupSet?.groups[0]?.id ?? null;
  // Group ids that can match a GROUP assignee or override row. The membership group first,
  // then anything the audience/override rows name, so a group targeted by an override the
  // student is somehow no longer a member of still resolves its dates.
  const studentGroupIds = [
    ...new Set(
      [
        membershipGroupId,
        ...(assignment.assignees ?? []).filter((a) => a.groupId != null).map((a) => a.groupId),
        ...(assignment.overrides ?? [])
          .filter((o) => o.targetType === 'GROUP' && o.groupId != null)
          .map((o) => o.groupId),
      ].filter((id): id is string => id != null),
    ),
  ];
  // A group assignment writes into the group's shared submission set: any member submits,
  // all members see it, and the cap and cooldown count group-wide. An individual assignment
  // never does, even if a stray GROUP override names a group the submitter is in.
  const submissionGroupId = assignment.groupSetId ? membershipGroupId : null;
  // Count scope for the per-problem cap + cooldown: the whole group, or just this student.
  const countScope = submissionGroupId
    ? { assignmentId, problemId, studentGroupId: submissionGroupId }
    : { assignmentId, problemId, studentId: user.id };

  // The extra-submission grants that apply to this submitter: their own STUDENT grant
  // and/or a GROUP grant for a group of theirs on this assignment. Resolved into the
  // effective cap by lib/submission-limits (unlimited stays unlimited).
  const grants = await prisma.submissionGrant.findMany({
    where: {
      assignmentId,
      problemId,
      OR: [{ userId: user.id }, { groupId: { in: [...studentGroupIds] } }],
    },
    select: { targetType: true, userId: true, groupId: true, extraSubmissions: true },
  });
  const limit = effectiveMaxSubmissions(link.maxSubmissions, grants, user.id, studentGroupIds);

  // Authorization: admins may submit anywhere; everyone else must be on the roster.
  if (!(await canAccessCourse(user, courseId))) {
    await audit('SUBMISSION_FORBIDDEN', 'SECURITY', {
      error: 'User is not enrolled in or assigned to this course.',
    });
    return { ok: false, status: 403, error: 'Forbidden' };
  }

  const submitterIsStaff = await canManageCourse(user, courseId);

  // Students may only submit to a published assignment; staff may test unpublished
  // ones. Mask as 404 so an unpublished assignment stays invisible to a student.
  if (!assignment.isPublished && !submitterIsStaff) {
    await audit('SUBMISSION_UNPUBLISHED_ASSIGNMENT', 'SECURITY', {
      error: 'Submission to an unpublished assignment by a non-staff user.',
    });
    return { ok: false, status: 404, error: 'Assignment not found.' };
  }

  // "Assign to specific students": a student not assigned this work can't submit to it.
  // Mask as 404, same as unpublished. Staff may always test-submit.
  const submitterAssigned = isStudentAssigned(
    assignment,
    assignment.assignees ?? [],
    user.id,
    studentGroupIds,
  );
  if (!submitterAssigned && !submitterIsStaff) {
    await audit('SUBMISSION_NOT_ASSIGNED', 'SECURITY', {
      error: 'Submission to an assignment the student is not assigned.',
    });
    return { ok: false, status: 404, error: 'Assignment not found.' };
  }

  // An archived course is frozen (read-only) for everyone, including staff/admin;
  // it accepts no new submissions.
  if (await isCourseArchived(courseId)) {
    await audit('SUBMISSION_REJECTED_ARCHIVED', 'WARNING', { reason: 'Course is archived.' });
    return {
      ok: false,
      status: 409,
      error: 'This course is archived and no longer accepts submissions.',
    };
  }

  // Per-problem cap: the base maxSubmissions plus any per-target grants (staff exempt;
  // base `<= 0` is unlimited). Fast path; the authoritative check runs again inside the
  // serializable transaction below.
  const isCourseStaff = submitterIsStaff;
  if (!isCourseStaff && limit.max != null) {
    const priorCount = await prisma.submission.count({ where: countScope });
    if (priorCount >= limit.max) {
      await audit('SUBMISSION_LIMIT_REACHED', 'WARNING', {
        maxSubmissions: limit.max,
        grantedExtra: limit.granted,
        priorCount,
      });
      return { ok: false, status: 409, error: `Submission limit reached (${limit.max}).` };
    }
  }

  /**
   * Resubmit cooldown, checked twice on purpose.
   *
   * This one is the fast answer: it costs a single query and gives a student a `Retry-After`
   * before a file is uploaded or written. It is not the rule, though, because two requests
   * can both pass it; the authoritative check is inside the transaction that inserts.
   */
  const { resubmitCooldownMs } = await getQueueSettings();
  if (resubmitCooldownMs > 0) {
    const lastSubmission = await prisma.submission.findFirst({
      where: countScope,
      orderBy: { submittedAt: 'desc' },
      select: { submittedAt: true },
    });
    if (lastSubmission) {
      const elapsedMs = Date.now() - lastSubmission.submittedAt.getTime();
      if (elapsedMs < resubmitCooldownMs) {
        const retryAfterSec = Math.ceil((resubmitCooldownMs - elapsedMs) / 1000);
        await audit('SUBMISSION_RATE_LIMITED', 'WARNING', {
          cooldownMs: resubmitCooldownMs,
          elapsedMs,
        });
        return {
          ok: false,
          status: 429,
          error: `Please wait ${retryAfterSec}s before resubmitting to this problem.`,
          headers: { 'Retry-After': String(retryAfterSec) },
        };
      }
    }
  }

  // Availability + late policy, resolved for this submitter (a per-student override can
  // move any of these). One resolver drives submit, the calendar, and the student views.
  const now = new Date();
  const deadline = effectiveDeadline(
    {
      unlockAt: assignment.unlockAt,
      dueDate: assignment.dueDate,
      allowLateSubmissions: assignment.allowLateSubmissions,
      lateCutoff: assignment.lateCutoff,
    },
    assignment.overrides ?? [],
    user.id,
    studentGroupIds,
  );
  const window = evaluateSubmissionWindow(deadline, now);
  // Course staff (and admins) may test-submit before an assignment unlocks; the
  // not-open gate applies to students only. Staff are still subject to the late window,
  // matching existing behavior.
  if (!window.accepted && !(window.reason === 'not-open' && isCourseStaff)) {
    const meta = {
      unlockAt: deadline.unlockAt ? deadline.unlockAt.toISOString() : null,
      dueDate: deadline.dueDate.toISOString(),
      allowLateSubmissions: deadline.allowLateSubmissions,
      lateCutoff: deadline.lateCutoff ? deadline.lateCutoff.toISOString() : null,
      submittedAt: now.toISOString(),
      overrideSource: deadline.source,
    };
    if (window.reason === 'not-open') {
      await audit('SUBMISSION_REJECTED_NOT_OPEN', 'WARNING', {
        ...meta,
        reason: 'Assignment is not open for submissions yet.',
      });
      return { ok: false, status: 403, error: 'This assignment is not open for submissions yet.' };
    }
    if (window.reason === 'late-not-allowed') {
      await audit('SUBMISSION_REJECTED_LATE', 'WARNING', {
        ...meta,
        reason: 'Late submissions are not allowed for this assignment.',
      });
      return {
        ok: false,
        status: 403,
        error: 'Late submissions are not allowed for this assignment.',
      };
    }
    await audit('SUBMISSION_REJECTED_LATE_CUTOFF', 'WARNING', {
      ...meta,
      reason: 'Late submission cutoff has passed for this assignment.',
    });
    return {
      ok: false,
      status: 403,
      error: 'Late submission cutoff has passed for this assignment.',
    };
  }

  let fileName: string | null = null;
  let originalFileName: string | null = null;
  let contentHash: string | null = null;
  let shapeHash: string | null = null;
  let byteHash: string | null = null;
  let provenanceFeatures: ProvenanceFeatures | null = null;

  if (file) {
    if (file.size > maxBytes) {
      await audit('SUBMISSION_FILE_TOO_LARGE', 'WARNING', {
        fileName: file.name,
        fileSizeBytes: file.size,
        maxBytes,
      });
      return { ok: false, status: 413, error: `File exceeds max upload size (${maxMb} MB).` };
    }

    const xml = await file.text();
    const validation = validateStructureXML(xml, link.problem.type);
    if (!validation.isValid) {
      await audit('SUBMISSION_INVALID_FILE_STRUCTURE', 'WARNING', { error: validation.error });
      return { ok: false, status: 400, error: validation.error ?? 'Invalid file structure.' };
    }
  }

  let uploadedFilePath: string | null = null;

  try {
    if (file) {
      await audit('SUBMISSION_FILE_RECEIVED', 'INFO', {
        fileName: file.name,
        fileSizeBytes: file.size,
        fileType: file.type,
      });
      originalFileName = file.name;
      // Random UUID + whitelisted extension; never a client-controlled path.
      fileName = safeStoredFilename(originalFileName);
      const buffer = Buffer.from(await file.arrayBuffer());
      // Fingerprint the file here, not during grading: this way it covers both submission
      // paths, a problem with autograding off still gets one, and nothing about matching
      // sits in the code path that decides a grade. A hash that cannot be computed is a
      // submission that simply never matches, never a failed submission.
      try {
        contentHash = submissionContentHash(buffer);
        shapeHash = submissionShapeHash(buffer);
        byteHash = submissionByteHash(buffer);
        provenanceFeatures = extractProvenanceFeatures(buffer);
      } catch (hashError) {
        console.error('[createSubmission] Could not fingerprint the upload:', hashError);
      }
      // Record the destination BEFORE writing: a write that throws partway through has
      // still created the file, and the cleanup handler can only remove a path it knows.
      uploadedFilePath = resolveInsideDir(SUBMISSION_UPLOAD_DIR, fileName);
      storeSubmissionFile(uploadedFilePath, buffer);
    }

    // Re-check the cap and the cooldown inside a serializable transaction so concurrent
    // submits cannot both slip past the earlier reads.
    let submission: Prisma.SubmissionGetPayload<object>;
    try {
      submission = await prisma.$transaction(
        async (tx) => {
          if (!isCourseStaff && limit.max != null) {
            const priorCount = await tx.submission.count({ where: countScope });
            if (priorCount >= limit.max) {
              throw new SubmissionCapReachedError(priorCount);
            }
          }

          /**
           * The cooldown, re-read here because the check before the transaction is only a
           * courtesy.
           *
           * Two requests a millisecond apart both saw an empty cooldown and both submitted,
           * which is the whole point of the rule defeated by pressing the button twice. Read
           * inside the same serializable transaction as the insert, over the same scope as the
           * cap (the group's submissions on a group assignment, the student's own otherwise),
           * so Postgres makes the pair conflict instead of letting both through.
           *
           * Staff are exempt here as they are above: rerunning and testing a problem is not
           * resubmitting to it.
           */
          if (!isCourseStaff && resubmitCooldownMs > 0) {
            const last = await tx.submission.findFirst({
              where: countScope,
              orderBy: { submittedAt: 'desc' },
              select: { submittedAt: true },
            });
            if (last) {
              // Measured from the same clock the pre-check used, so the number a student is
              // told and the rule they are held to are the same rule.
              const elapsedMs = Date.now() - last.submittedAt.getTime();
              if (elapsedMs < resubmitCooldownMs) {
                throw new ResubmitTooSoonError(Math.ceil((resubmitCooldownMs - elapsedMs) / 1000));
              }
            }
          }
          const created = await tx.submission.create({
            data: {
              courseId: assignment.courseId,
              assignmentId,
              problemId,
              studentId: user.id,
              // The group that owns this submission set (null for individual submissions).
              studentGroupId: submissionGroupId,
              fileName,
              originalFileName,
              contentHash,
              shapeHash,
              byteHash,
              provenanceFeatures: provenanceFeatures ?? Prisma.JsonNull,
              feedback: null,
              correct: undefined,
              evaluationRaw: Prisma.JsonNull,
            },
          });
          // A submission for a group assignment locks its set (sticky, atomic with the
          // submission write). No-op for individual assignments.
          await lockGroupSetIfUsed(tx, assignment.groupSetId);
          return created;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (err) {
      cleanupFile(uploadedFilePath);
      if (err instanceof SubmissionCapReachedError) {
        // Logged, like the pre-transaction check and like the cooldown's own concurrent case
        // beside it. This path wrote nothing at all, so a student stopped by the cap under a
        // race left no trace: the log said they never tried. `concurrent` is what tells the
        // two apart when reading the record back.
        await audit('SUBMISSION_LIMIT_REACHED', 'WARNING', {
          maxSubmissions: limit.max,
          grantedExtra: limit.granted,
          priorCount: err.priorCount,
          concurrent: true,
        });
        return { ok: false, status: 409, error: `Submission limit reached (${limit.max}).` };
      }
      if (err instanceof ResubmitTooSoonError) {
        // The same answer the pre-check gives, so a student cannot tell which check caught
        // them and does not need to.
        await audit('SUBMISSION_RATE_LIMITED', 'WARNING', {
          cooldownMs: resubmitCooldownMs,
          concurrent: true,
        });
        return {
          ok: false,
          status: 429,
          error: `Please wait ${err.retryAfterSec}s before resubmitting to this problem.`,
          headers: { 'Retry-After': String(err.retryAfterSec) },
        };
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
        return {
          ok: false,
          status: 409,
          error: 'A concurrent submission conflicted; please retry.',
        };
      }
      throw err;
    }

    ctx.submissionId = submission.id;

    // ---- Past this point the transaction has COMMITTED. ----
    //
    // The submission exists and cannot be rolled back, so nothing after it may report
    // failure or touch the stored file. Audit writes are ordinary database writes and
    // can fail on their own (a logging outage, a constraint problem); letting one
    // escape used to mean the shared catch below deleted the file out from under a
    // committed row AND returned 500, so the caller would retry and burn another slot
    // against the submission cap. The student ended up with a queued submission whose
    // file was gone and a wasted attempt.
    //
    // A missing audit entry is a real but lesser problem than a corrupted submission,
    // so record it to the console and still report success.
    try {
      if (fileName) {
        await audit('SUBMISSION_FILE_STORED', 'INFO', { fileName, originalFileName });
      }
      await audit('SUBMISSION_CREATED', 'INFO', { fileName, status: 'PENDING' });
    } catch (auditError) {
      console.error(
        `[createSubmission] Submission ${submission.id} was created, but writing its audit log failed:`,
        auditError,
      );
    }

    return { ok: true, submission };
  } catch (error: unknown) {
    cleanupFile(uploadedFilePath, (cleanupError) =>
      console.error('Failed to clean up orphaned submission file:', cleanupError),
    );
    await audit('SUBMISSION_ERROR', 'ERROR', { error: errMessage(error), status: 'FAILED' });
    return { ok: false, status: 500, error: 'Failed to create submission' };
  }
}
