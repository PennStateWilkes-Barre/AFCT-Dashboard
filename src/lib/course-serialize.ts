/**
 * Shaping a course's assignment rows for the course API response.
 *
 * Extracted from the route handler because these are the security decisions on that
 * endpoint, and inside a 350-line handler they could only be exercised by standing up
 * the whole request. Three things are decided here, and all three are the difference
 * between a correct response and a leak:
 *
 *   1. the content lock, which hides an assignment's prompt from a student until their
 *      own effective unlock time (an override can move it earlier or later);
 *   2. the `overrides` array, which names other students and is staff-only, even though
 *      a student's own overrides are loaded to resolve the lock above;
 *   3. the class-wide submission and comment counts, which are staff-only aggregates.
 *
 * Pure: no Prisma, no request, no clock of its own. `now` is passed in so a caller can
 * reason about the boundary, and so tests can sit on either side of it.
 */

import { effectiveDeadline } from '@/lib/effective-deadline';
import { groupIdsFromOverrides } from '@/lib/assignment-visibility';
import { sumProblemPoints } from '@/lib/course-format';
import { projectDescription } from './rich-description/projection';

/**
 * Both override selects the route issues land here: the staff one carries `user` for the
 * badge, the student one carries the target columns so their own unlock can be resolved.
 */
export type OverrideRowRaw = {
  unlockAt: Date | null;
  dueDate: Date | null;
  lateCutoff: Date | null;
  allowLateSubmissions: boolean | null;
  user?: { firstName: string | null; lastName: string | null; email: string };
  targetType?: 'STUDENT' | 'GROUP';
  userId?: string | null;
  groupId?: string | null;
};

export type AssignmentRow = Record<string, unknown> & {
  id: string;
  description?: string | null;
  /** The rich document. Travels with `description` and is masked with it. */
  descriptionJson?: unknown;
  dueDate?: Date;
  unlockAt?: Date | null;
  allowLateSubmissions?: boolean;
  lateCutoff?: Date | null;
  assignedToEveryone?: boolean;
  groupSetId?: string | null;
  problems?: Array<{ maxPoints?: number | null }>;
  _count?: { problems?: number };
  overrides?: OverrideRowRaw[];
};

export type SerializeAssignmentContext = {
  /** Course staff (FACULTY/TA) or a system admin. Gates every disclosure below. */
  isStaff: boolean;
  /** The viewer, used to resolve their own effective unlock time. */
  viewerId: string;
  /** Empty for a non-staff viewer, whose counts stay at zero. */
  submissionCounts: Map<string, number>;
  commentCounts: Map<string, number>;
  now: Date;
};

/** Shapes one assignment row for the response, applying the disclosure rules above. */
export function serializeAssignment(assignment: AssignmentRow, ctx: SerializeAssignmentContext) {
  const { isStaff, viewerId, submissionCounts, commentCounts, now } = ctx;

  const totalProblemPoints = sumProblemPoints(assignment.problems);
  const submissionCount = submissionCounts.get(assignment.id) ?? 0;
  const commentCount = commentCounts.get(assignment.id) ?? 0;

  // Content lock: before a student's effective unlock time they may see that the
  // assignment exists and when it opens, but not its prompt. Staff always see it.
  // The selected overrides are already scoped to this student, so any group id
  // present is one of theirs.
  const studentOverrides = (isStaff ? [] : (assignment.overrides ?? [])).map((o) => ({
    targetType: o.targetType ?? 'STUDENT',
    userId: o.userId ?? null,
    groupId: o.groupId ?? null,
    unlockAt: o.unlockAt,
    dueDate: o.dueDate,
    lateCutoff: o.lateCutoff,
    allowLateSubmissions: o.allowLateSubmissions,
  }));
  const eff =
    isStaff || !assignment.dueDate
      ? null
      : effectiveDeadline(
          {
            unlockAt: assignment.unlockAt ?? null,
            dueDate: assignment.dueDate,
            allowLateSubmissions: assignment.allowLateSubmissions ?? false,
            lateCutoff: assignment.lateCutoff ?? null,
          },
          studentOverrides,
          viewerId,
          groupIdsFromOverrides(studentOverrides),
        );
  const locked = !!eff?.unlockAt && eff.unlockAt.getTime() > now.getTime();

  return {
    id: assignment.id,
    title: assignment.title,
    // All three description columns, masked together by the one `locked` decision. Going
    // through the shared helper is what stops a future edit from reintroducing the bug where
    // this serializer sent `description` and quietly dropped `descriptionJson`.
    ...projectDescription(assignment, { locked }),
    locked,
    // The dates this viewer is actually held to. `eff` is null for staff, who keep the
    // assignment's own dates because they are the ones they set and the exceptions are listed
    // to them below. For a student it is their extension, and sending the base date instead was
    // the difference between handing work in and being late: the Grades tab resolved it and
    // this, the Assignments tab, did not.
    dueDate: eff ? eff.dueDate : assignment.dueDate,
    unlockAt: eff ? eff.unlockAt : (assignment.unlockAt ?? null),
    assignedToEveryone: assignment.assignedToEveryone ?? true,
    // Individual vs group is derived from the set link (no stored flag).
    isGroup: assignment.groupSetId != null,
    allowLateSubmissions: eff ? eff.allowLateSubmissions : assignment.allowLateSubmissions,
    lateCutoff: eff ? eff.lateCutoff : assignment.lateCutoff,
    maxPoints: totalProblemPoints,
    isPublished: assignment.isPublished,
    createdAt: assignment.createdAt,
    updatedAt: assignment.updatedAt,
    courseId: assignment.courseId,
    problemCount: assignment._count?.problems ?? 0,
    // Staff-only. Students also have overrides selected now (to resolve their own
    // unlock time above), but those must never be serialized, and they carry no
    // `user` relation, so this stays strictly gated on isStaff.
    overrides: isStaff
      ? (assignment.overrides ?? []).map((o) => ({
          studentName:
            `${o.user?.firstName ?? ''} ${o.user?.lastName ?? ''}`.trim() || (o.user?.email ?? ''),
          unlockAt: o.unlockAt,
          dueDate: o.dueDate,
          lateCutoff: o.lateCutoff,
          allowLateSubmissions: o.allowLateSubmissions,
        }))
      : [],
    submissionCount,
    commentCount,
    hasSubmissionsOrComments: submissionCount > 0 || commentCount > 0,
  };
}
