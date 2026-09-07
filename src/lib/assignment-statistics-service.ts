import { prisma } from '@/lib/prisma';
import { ACTIVE_STUDENT_ROSTER, ANY_STUDENT_ROSTER, isEnrolled } from '@/lib/roster-status';
import { isStudentAssigned } from '@/lib/assignment-visibility';
import { effectiveDeadline } from '@/lib/effective-deadline';
import {
  buildAssignmentStatistics,
  type AssignmentStatistics,
  type CohortExclusion,
  type StatsParticipant,
  type StatsProblem,
  type StatsSubmission,
  type SubmissionQueueStatus,
} from '@/lib/assignment-statistics';

/**
 * Server-side aggregator for the assignment Statistics tab. It loads exactly what the
 * charts need in a handful of batched queries (no per-participant reads, no N+1), maps it
 * into the database-agnostic shape `buildAssignmentStatistics` expects, and lets that pure
 * core decide every number. Presentation lives in the client components.
 *
 * Unit: an INDIVIDUAL assignment (no group set) is measured in students; a GROUP
 * assignment is measured in groups. The two are never mixed. Because an autograded group
 * submission fans its grade out identically to every member (see submission-worker), a
 * group's per-problem grade is read from its members' grade rows, and its submissions are
 * the group's own (studentGroupId) submissions.
 *
 * Who is counted is a judgement, not an accident, so it is made in one place (`resolveCohort`
 * below) and reported: the figures describe students who are enrolled, whose account is
 * active, and who were assigned this work. Everybody else is counted as an exclusion with a
 * reason, because a denominator that quietly shrinks is a denominator nobody can check.
 */
export type AssignmentStatisticsPayload = AssignmentStatistics & {
  assignmentTitle: string;
  /** The assignment's base (Everyone) due date, ISO. */
  baseDueDate: string;
  /** Course timezone, so the client formats the due date the same way the rest of the app does. */
  timezone: string;
};

/** The override columns `effectiveDeadline` needs, plus who each row is aimed at. */
type OverrideRow = {
  targetType: 'STUDENT' | 'GROUP';
  userId: string | null;
  groupId: string | null;
  unlockAt: Date | null;
  dueDate: Date | null;
  lateCutoff: Date | null;
  allowLateSubmissions: boolean | null;
};

/** Latest queue status per problem, keyed by participant id. */
type LatestStatusMap = Map<string, Record<string, SubmissionQueueStatus>>;

/** One student's recorded grades: the number, and when it was last written. */
type GradeRecord = { grade: number; gradedAt: number };

/** The people (or teams) the figures describe, and everybody they leave out. */
type Cohort = { participants: StatsParticipant[]; exclusions: CohortExclusion[] };

export async function getAssignmentStatistics(
  courseId: string,
  assignmentId: string,
): Promise<AssignmentStatisticsPayload | null> {
  const assignment = await prisma.assignment.findFirst({
    where: { id: assignmentId, courseId },
    select: {
      id: true,
      title: true,
      dueDate: true,
      unlockAt: true,
      lateCutoff: true,
      allowLateSubmissions: true,
      assignedToEveryone: true,
      groupSetId: true,
      course: { select: { timezone: true } },
      assignees: { select: { userId: true, groupId: true } },
      problems: {
        select: {
          problemId: true,
          maxPoints: true,
          autograderEnabled: true,
          problem: { select: { title: true } },
        },
      },
    },
  });
  if (!assignment) return null;

  const timeZone = assignment.course?.timezone ?? 'UTC';
  const isGroupAssignment = assignment.groupSetId != null;

  // Problem order: there is no persisted per-assignment order, so use title ascending,
  // matching the Problems tab's default sort. The box plots render in this order.
  const problems: StatsProblem[] = assignment.problems
    .map((ap) => ({
      id: ap.problemId,
      title: ap.problem.title,
      maxPoints: Number(ap.maxPoints ?? 0),
      autograderEnabled: ap.autograderEnabled,
      order: 0,
    }))
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((p, i) => ({ ...p, order: i }));

  // Every column `effectiveDeadline` reads, because "has an exception" now means "is held to
  // a different date", which cannot be answered by the existence of a row.
  const overrides: OverrideRow[] = await prisma.assignmentOverride.findMany({
    where: { assignmentId },
    select: {
      targetType: true,
      userId: true,
      groupId: true,
      unlockAt: true,
      dueDate: true,
      lateCutoff: true,
      allowLateSubmissions: true,
    },
  });

  // Per-(student, problem) recorded grade. A key existing means "graded"; a value of 0 is
  // a real zero. `updatedAt` comes along so a grade overtaken by newer work can say so.
  const gradeRows = await prisma.assignmentProblemGrade.findMany({
    where: { assignmentId },
    select: { studentId: true, problemId: true, grade: true, updatedAt: true },
  });
  const gradesByStudent = new Map<string, Record<string, GradeRecord>>();
  for (const g of gradeRows) {
    const rec = gradesByStudent.get(g.studentId) ?? {};
    rec[g.problemId] = { grade: Number(g.grade), gradedAt: g.updatedAt.getTime() };
    gradesByStudent.set(g.studentId, rec);
  }

  // Every submission for the relevant scope, oldest first. One read serves three purposes:
  // the latest queue status per participant/problem (last row wins), and the attempt /
  // timeline / heatmap aggregations in the pure core.
  const submissionRows = await prisma.submission.findMany({
    where: {
      assignmentId,
      studentGroupId: isGroupAssignment ? { not: null } : null,
    },
    orderBy: { submittedAt: 'asc' },
    select: {
      studentId: true,
      studentGroupId: true,
      problemId: true,
      submittedAt: true,
      correct: true,
      status: true,
    },
  });
  const keyOf = (r: { studentId: string; studentGroupId: string | null }) =>
    isGroupAssignment ? r.studentGroupId! : r.studentId;

  const latestStatus: LatestStatusMap = new Map();
  for (const r of submissionRows) {
    const k = keyOf(r);
    const rec = latestStatus.get(k) ?? {};
    rec[r.problemId] = r.status as SubmissionQueueStatus; // asc order -> the last write is newest
    latestStatus.set(k, rec);
  }

  const base = {
    unlockAt: assignment.unlockAt,
    dueDate: assignment.dueDate,
    lateCutoff: assignment.lateCutoff,
    allowLateSubmissions: assignment.allowLateSubmissions,
  };

  const { participants, exclusions } = isGroupAssignment
    ? await buildGroupCohort(courseId, assignment.groupSetId!, assignment, {
        base,
        overrides,
        gradesByStudent,
        latestStatus,
      })
    : await buildStudentCohort(courseId, assignment, {
        base,
        overrides,
        gradesByStudent,
        latestStatus,
      });

  // Only count submissions from participants who are actually assigned this assignment.
  const assignedIds = new Set(participants.map((p) => p.id));
  const submissions: StatsSubmission[] = submissionRows
    .filter((r) => assignedIds.has(keyOf(r)))
    .map((r) => ({
      participantId: keyOf(r),
      problemId: r.problemId,
      submittedAt: r.submittedAt.getTime(),
      correct: r.correct === true,
      status: r.status as SubmissionQueueStatus,
    }));

  const stats = buildAssignmentStatistics({
    unit: isGroupAssignment ? 'group' : 'student',
    problems,
    participants,
    submissions,
    timeZone,
    exclusions,
  });

  return {
    ...stats,
    assignmentTitle: assignment.title,
    baseDueDate: assignment.dueDate.toISOString(),
    timezone: timeZone,
  };
}

type AssignmentShape = {
  id: string;
  assignedToEveryone: boolean;
  assignees: { userId: string | null; groupId: string | null }[];
  /** The assignment's group set, or null on an individual assignment. Scopes every membership
   *  lookup below: "which groups is this student in" only has one right answer per set. */
  groupSetId: string | null;
};

type CohortInput = {
  base: {
    unlockAt: Date | null;
    dueDate: Date;
    lateCutoff: Date | null;
    allowLateSubmissions: boolean;
  };
  overrides: OverrideRow[];
  gradesByStudent: Map<string, Record<string, GradeRecord>>;
  latestStatus: LatestStatusMap;
};

/** Split one student's grade record into the two shapes the pure core takes. */
function splitGrades(record: Record<string, GradeRecord> | undefined): {
  problemGrades: Record<string, number>;
  gradedAtByProblem: Record<string, number>;
} {
  const problemGrades: Record<string, number> = {};
  const gradedAtByProblem: Record<string, number> = {};
  for (const [problemId, entry] of Object.entries(record ?? {})) {
    problemGrades[problemId] = entry.grade;
    gradedAtByProblem[problemId] = entry.gradedAt;
  }
  return { problemGrades, gradedAtByProblem };
}

/** Roll a list of reasons up into one count each, in a stable order. */
function tally(reasons: CohortExclusion['reason'][]): CohortExclusion[] {
  const order: CohortExclusion['reason'][] = ['dropped', 'inactive', 'no-group', 'empty-group'];
  const counts = new Map<CohortExclusion['reason'], number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return order
    .map((reason) => ({ reason, count: counts.get(reason) ?? 0 }))
    .filter((entry) => entry.count > 0);
}

// ─── individual (student) participants ───────────────────────────────────────

async function buildStudentCohort(
  courseId: string,
  assignment: AssignmentShape,
  input: CohortInput,
): Promise<Cohort> {
  // Every student who has ever been on this roster, with the standing of each, because the
  // page reports who was left out as well as who was counted. Statistics measure the active
  // cohort (`roster-status.ts` names participation statistics as an ACTIVE_STUDENT_ROSTER
  // surface); a dropped or disabled student's work stays reviewable in the submissions views.
  const roster = await prisma.roster.findMany({
    where: { courseId, ...ANY_STUDENT_ROSTER },
    select: { userId: true, status: true, user: { select: { inactive: true } } },
  });
  if (roster.length === 0) return { participants: [], exclusions: [] };

  // Group memberships matter here only when the assignment targets groups; load them once
  // for the assigned decision (individual assignments usually target students directly).
  const groupIdsByStudent = await membershipsOf(
    assignment.groupSetId,
    assignment.assignedToEveryone || assignment.assignees.some((a) => a.groupId)
      ? roster.map((r) => r.userId)
      : [],
  );

  const participants: StatsParticipant[] = [];
  const excluded: CohortExclusion['reason'][] = [];

  for (const row of roster) {
    const groupIds = groupIdsByStudent.get(row.userId) ?? [];
    const assigned = isStudentAssigned(
      { assignedToEveryone: assignment.assignedToEveryone },
      assignment.assignees,
      row.userId,
      groupIds,
    );
    // Somebody this work never reached is not an exclusion, they are not in the picture.
    if (!assigned) continue;

    // Dropped first: a dropped student with a disabled account is reported the way the
    // roster reports them, and counting them twice would break the arithmetic.
    if (!isEnrolled(row.status)) {
      excluded.push('dropped');
      continue;
    }
    if (row.user?.inactive) {
      excluded.push('inactive');
      continue;
    }

    participants.push({
      id: row.userId,
      ...deadlineFor(input, row.userId, groupIds),
      ...splitGrades(input.gradesByStudent.get(row.userId)),
      latestStatusByProblem: input.latestStatus.get(row.userId) ?? {},
    });
  }

  return { participants, exclusions: tally(excluded) };
}

// ─── group participants ──────────────────────────────────────────────────────

async function buildGroupCohort(
  courseId: string,
  groupSetId: string,
  assignment: AssignmentShape,
  input: CohortInput,
): Promise<Cohort> {
  const groups = await prisma.studentGroup.findMany({
    where: { groupSetId },
    select: { id: true, memberships: { select: { userId: true } } },
  });

  // The active roster, used to decide whether a group still has anybody in it. Membership
  // rows survive a student dropping (by design), so a group of leavers looks staffed here.
  const active = new Set(
    (
      await prisma.roster.findMany({
        where: { courseId, ...ACTIVE_STUDENT_ROSTER, user: { inactive: false } },
        select: { userId: true },
      })
    ).map((r) => r.userId),
  );

  const namedGroupIds = new Set(
    assignment.assignees.map((a) => a.groupId).filter((g): g is string => !!g),
  );
  const assignedGroups = groups.filter(
    (g) => assignment.assignedToEveryone || namedGroupIds.has(g.id),
  );

  const participants: StatsParticipant[] = [];
  const excluded: CohortExclusion['reason'][] = [];

  for (const group of assignedGroups) {
    // Nobody left to do the work: counted as an exclusion rather than as a team that failed
    // to submit, which is what an empty group looked like before.
    if (!group.memberships.some((m) => active.has(m.userId))) {
      excluded.push('empty-group');
      continue;
    }

    /**
     * The group's grade per problem: the highest recorded among its members, read from
     * EVERY member row whatever that member's standing.
     *
     * Membership decides who is counted, not whether the work is graded. If the only member
     * holding the grade row leaves, an active-members-only rule would report the group as
     * ungraded here while the gradebook still shows the grade, and park marked work back on
     * the grader's queue. Rows differing from each other means somebody hand-edited one
     * member's grade; the gradebook is where that is visible.
     */
    const problemGrades: Record<string, number> = {};
    const gradedAtByProblem: Record<string, number> = {};
    for (const member of group.memberships) {
      const record = input.gradesByStudent.get(member.userId);
      if (!record) continue;
      for (const [problemId, entry] of Object.entries(record)) {
        const held = problemGrades[problemId];
        if (held === undefined || entry.grade > held) problemGrades[problemId] = entry.grade;
        const heldAt = gradedAtByProblem[problemId];
        if (heldAt === undefined || entry.gradedAt > heldAt) {
          gradedAtByProblem[problemId] = entry.gradedAt;
        }
      }
    }

    participants.push({
      id: group.id,
      // A group is held to whatever a GROUP override says about it. The id is passed as the
      // subject as well, where it can only fail to match a student override: an override row
      // aimed at a person says nothing about a team.
      ...deadlineFor(input, group.id, [group.id]),
      problemGrades,
      gradedAtByProblem,
      latestStatusByProblem: input.latestStatus.get(group.id) ?? {},
    });
  }

  // Assigned students who are in no group of this set cannot submit at all. They are not
  // participants (the unit is groups) and they are not missing work; they are a setup
  // problem only this page is placed to notice.
  const inAGroup = new Set(groups.flatMap((g) => g.memberships.map((m) => m.userId)));
  const strandedIds = [...active].filter((userId) => !inAGroup.has(userId));
  if (strandedIds.length > 0) {
    const groupIdsByStudent = await membershipsOf(assignment.groupSetId, strandedIds);
    for (const userId of strandedIds) {
      const assigned = isStudentAssigned(
        { assignedToEveryone: assignment.assignedToEveryone },
        assignment.assignees,
        userId,
        groupIdsByStudent.get(userId) ?? [],
      );
      if (assigned) excluded.push('no-group');
    }
  }

  return { participants, exclusions: tally(excluded) };
}

// ─── shared helpers ──────────────────────────────────────────────────────────

/**
 * Group memberships for a set of students **within one group set**, keyed by student. Empty
 * in, empty out.
 *
 * The set id is required rather than optional: this asked for every membership these students
 * hold anywhere, which is a different question and the wrong one. See `loadStudentGroupIndex`
 * for what it cost on the gradebook. A null set is an individual assignment, which has none.
 */
async function membershipsOf(
  groupSetId: string | null,
  userIds: string[],
): Promise<Map<string, string[]>> {
  const byStudent = new Map<string, string[]>();
  if (userIds.length === 0 || !groupSetId) return byStudent;
  const memberships = await prisma.groupMembership.findMany({
    where: { groupSetId, userId: { in: userIds } },
    select: { userId: true, groupId: true },
  });
  for (const m of memberships) {
    byStudent.set(m.userId, [...(byStudent.get(m.userId) ?? []), m.groupId]);
  }
  return byStudent;
}

/**
 * The due date this participant is actually held to, and whether it differs from the class's.
 *
 * Asked of the resolved date rather than of the override table: a row that moves only the
 * unlock date, or one edited until every field is empty, changes nothing about when the work
 * is due, and counting those told the reader there were exceptions to look into when there
 * were none. The same resolver the rest of the app judges lateness with, so a submission
 * this page calls late is one the submissions views call late too.
 */
function deadlineFor(
  input: CohortInput,
  subjectId: string,
  groupIds: string[],
): { dueAt: number; hasException: boolean } {
  const resolved = effectiveDeadline(input.base, input.overrides, subjectId, groupIds);
  const dueAt = resolved.dueDate.getTime();
  return { dueAt, hasException: dueAt !== input.base.dueDate.getTime() };
}
