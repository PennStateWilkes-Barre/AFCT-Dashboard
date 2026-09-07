import { prisma } from '@/lib/prisma';
import { isStudentAssigned } from '@/lib/assignment-visibility';
import { loadStudentGroupIndex, type StudentGroupIndex } from '@/lib/assignment-groups';
import { effectiveDeadline, type OverrideRow } from '@/lib/effective-deadline';
import { isMissingZero, submittedKey } from '@/lib/missing-work';
import {
  computeActivityHeatmap,
  computeSubmissionTimeline,
  gradingStateOf,
  spanKey,
  GRADING_ORDER,
  type ActivityHeatmap,
  type StatsParticipant,
  type StatsSubmission,
  type SubmissionSpan,
  type TimelinePoint,
} from '@/lib/assignment-statistics';
import {
  atRisk,
  attemptsByProblemType,
  compareAssignments,
  turnInByAssignment,
  compareProblemTypes,
  courseAverages,
  problemTypeKey,
  type AssignmentComparison,
  type AtRisk,
  type CourseAssignment,
  type CourseDistribution,
  type AttemptsByType,
  type CourseGradeCell,
  type GradingWorkload,
  type ProblemTypeKey,
  type TurnInByAssignment,
  type TurnInInput,
  type TypedGrade,
  type TypePerformance,
} from '@/lib/course-statistics';

/**
 * Server-side aggregator for the course Statistics tab.
 *
 * Same split as the assignment one: batched reads here, every number in the pure core, only
 * drawing in the components. What is different is the scale, so the reads are chosen for it.
 * Scores come from `AssignmentProblemGrade`, which is one compact row per (student,
 * assignment, problem) and covers the distribution, the comparison and the problem-type card
 * between them. Timing comes from `submittedAt` and nothing else, bucketed by the same pure
 * functions the assignment page uses, because a second copy of the course-timezone logic in
 * SQL would be free to drift from the first.
 *
 * Two units live side by side here, on purpose:
 *   - a STUDENT's course percentage, which is what the gradebook shows and what the
 *     distribution and the at-risk counts are about. Group work reaches it through the
 *     per-member grade rows the worker fans out, so no group logic is needed.
 *   - an ASSIGNMENT's own unit for the comparison and the problem-type card, teams on group
 *     work and people otherwise, because a distribution built per student turns one team of
 *     four into four identical points.
 */
export type CourseStatisticsPayload = {
  courseTitle: string;
  timezone: string;
  /** Students counted: enrolled, with an active account. */
  studentCount: number;
  /** How many were left out, and why. Same vocabulary as the assignment page. */
  exclusions: { reason: 'dropped' | 'inactive'; count: number }[];
  /** The gradebook's reading, and the graded-work-only one. */
  distribution: CourseDistribution;
  distributionGradedOnly: CourseDistribution;
  assignments: AssignmentComparison[];
  problemTypes: TypePerformance[];
  /** How many tries each kind of problem takes before it comes right. */
  attemptsByType: AttemptsByType[];
  workload: GradingWorkload[];
  /** On time, revised late, late or missing, per assignment, on each participant's own date. */
  turnIn: TurnInByAssignment[];
  atRisk: AtRisk;
  timeline: TimelinePoint[];
  heatmap: ActivityHeatmap;
  /** Due dates to mark on the timeline, oldest first. */
  dueDates: { id: string; title: string; dueAt: number }[];
};

/** Below this, a student is worth a second look. A starting point, not a policy. */

const AT_RISK_THRESHOLD = 60;

export async function getCourseStatistics(
  courseId: string,
): Promise<CourseStatisticsPayload | null> {
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: { id: true, name: true, timezone: true, isArchived: true },
  });
  if (!course) return null;
  const timeZone = course.timezone ?? 'UTC';

  // Every student who has ever been on this roster, so the page can report who it left out
  // as well as who it counted. Same rule as the assignment page: the figures describe
  // students who are enrolled and whose account still works.
  const roster = await prisma.roster.findMany({
    where: { courseId, role: 'STUDENT' },
    select: { userId: true, status: true, user: { select: { inactive: true } } },
  });
  const activeIds = roster
    .filter((r) => r.status === 'ENROLLED' && !r.user?.inactive)
    .map((r) => r.userId);
  const active = new Set(activeIds);
  const exclusions = [
    { reason: 'dropped' as const, count: roster.filter((r) => r.status !== 'ENROLLED').length },
    {
      reason: 'inactive' as const,
      count: roster.filter((r) => r.status === 'ENROLLED' && r.user?.inactive).length,
    },
  ].filter((e) => e.count > 0);

  const assignmentRows = await prisma.assignment.findMany({
    where: { courseId },
    select: {
      id: true,
      title: true,
      dueDate: true,
      unlockAt: true,
      lateCutoff: true,
      allowLateSubmissions: true,
      isPublished: true,
      assignedToEveryone: true,
      groupSetId: true,
      // Whether unsubmitted work counts as zero on this assignment, and when each problem was
      // attached, both for `lib/missing-work`.
      missingWorkIsZero: true,
      assignees: { select: { userId: true, groupId: true } },
      problems: {
        select: {
          problemId: true,
          maxPoints: true,
          createdAt: true,
          problem: { select: { type: true } },
        },
      },
    },
    orderBy: { dueDate: 'asc' },
  });

  // Memberships, once. They answer three questions: who is assigned group work, which team a
  // grade row belongs to, and which students are in no group at all.
  //
  // Scoped to this course's own group sets. The query had no `where` at all, so a course's
  // statistics page read every membership row in the installation: wrong for the first
  // question (a student's groups in another course are not their groups here) and, with five
  // universities on one deployment, a table scan for the other two.
  const courseGroupSetIds = [
    ...new Set(assignmentRows.map((a) => a.groupSetId).filter((id): id is string => !!id)),
  ];
  const memberships =
    courseGroupSetIds.length > 0
      ? await prisma.groupMembership.findMany({
          where: { groupSetId: { in: courseGroupSetIds } },
          select: { userId: true, groupId: true, group: { select: { groupSetId: true } } },
        })
      : [];
  const membersByGroup = new Map<string, string[]>();
  const groupsBySet = new Map<string, string[]>();
  for (const m of memberships) {
    membersByGroup.set(m.groupId, [...(membersByGroup.get(m.groupId) ?? []), m.userId]);
    const setId = m.group?.groupSetId;
    if (setId && !(groupsBySet.get(setId) ?? []).includes(m.groupId)) {
      groupsBySet.set(setId, [...(groupsBySet.get(setId) ?? []), m.groupId]);
    }
  }
  // The student-side question goes through the shared index, which makes naming the set
  // unavoidable. "Which groups is this student in" is only answerable per set.
  const studentGroups = await loadStudentGroupIndex(
    assignmentRows.map((a) => a.groupSetId),
    [...new Set(memberships.map((m) => m.userId))],
  );

  const assignmentIds = assignmentRows.map((a) => a.id);
  // Every exception in the course, in one read. Which participant each one applies to is the
  // resolver's business, not a query's.
  const overrideRows =
    assignmentIds.length > 0
      ? await prisma.assignmentOverride.findMany({
          where: { assignmentId: { in: assignmentIds } },
          select: {
            assignmentId: true,
            targetType: true,
            userId: true,
            groupId: true,
            unlockAt: true,
            dueDate: true,
            lateCutoff: true,
            allowLateSubmissions: true,
          },
        })
      : [];
  const overridesByAssignment = new Map<string, OverrideRow[]>();
  for (const row of overrideRows) {
    overridesByAssignment.set(row.assignmentId, [
      ...(overridesByAssignment.get(row.assignmentId) ?? []),
      row,
    ]);
  }
  const gradeRows =
    assignmentIds.length > 0
      ? await prisma.assignmentProblemGrade.findMany({
          where: { assignmentId: { in: assignmentIds } },
          select: {
            studentId: true,
            assignmentId: true,
            problemId: true,
            grade: true,
            updatedAt: true,
          },
        })
      : [];

  // grades[assignmentId][studentId][problemId]
  const grades = new Map<string, Map<string, Map<string, { grade: number; at: number }>>>();
  for (const row of gradeRows) {
    const byStudent = grades.get(row.assignmentId) ?? new Map();
    const byProblem = byStudent.get(row.studentId) ?? new Map();
    byProblem.set(row.problemId, { grade: Number(row.grade), at: row.updatedAt.getTime() });
    byStudent.set(row.studentId, byProblem);
    grades.set(row.assignmentId, byStudent);
  }

  const assignments: CourseAssignment[] = [];
  /** Who each assignment counts, in that assignment's own unit. */
  const participantsByAssignment = new Map<string, string[]>();
  const studentCells: CourseGradeCell[] = [];
  const comparisonCells: CourseGradeCell[] = [];
  const typed: TypedGrade[] = [];

  for (const assignment of assignmentRows) {
    const possible = assignment.problems.reduce((sum, p) => sum + Number(p.maxPoints ?? 0), 0);
    const byStudent = grades.get(assignment.id) ?? new Map();
    const isGroup = assignment.groupSetId != null;

    // Who this assignment was set for, in students. The distribution is per student whatever
    // the assignment's own unit is, because a student's course grade includes their group work.
    const assignedStudents = activeIds.filter((userId) =>
      isStudentAssigned(
        { assignedToEveryone: assignment.assignedToEveryone },
        assignment.assignees,
        userId,
        studentGroups.for(assignment.groupSetId, userId),
      ),
    );
    for (const userId of assignedStudents) {
      studentCells.push({
        participantId: userId,
        assignmentId: assignment.id,
        earned: sumOf(byStudent.get(userId), assignment.problems),
        possible,
      });
    }

    // The comparison's own unit: teams where the work was set to teams.
    const groupIds = isGroup
      ? (groupsBySet.get(assignment.groupSetId!) ?? []).filter(
          (groupId) =>
            (assignment.assignedToEveryone ||
              assignment.assignees.some((a) => a.groupId === groupId)) &&
            (membersByGroup.get(groupId) ?? []).some((userId) => active.has(userId)),
        )
      : [];

    if (isGroup) {
      for (const groupId of groupIds) {
        const members = membersByGroup.get(groupId) ?? [];
        comparisonCells.push({
          participantId: groupId,
          assignmentId: assignment.id,
          earned: sumOfGroup(byStudent, members, assignment.problems),
          possible,
        });
        pushTyped(typed, assignment.problems, (problemId) => bestOf(byStudent, members, problemId));
      }
    } else {
      for (const userId of assignedStudents) {
        comparisonCells.push({
          participantId: userId,
          assignmentId: assignment.id,
          earned: sumOf(byStudent.get(userId), assignment.problems),
          possible,
        });
        pushTyped(typed, assignment.problems, (problemId) => byStudent.get(userId)?.get(problemId));
      }
    }

    participantsByAssignment.set(assignment.id, isGroup ? groupIds : assignedStudents);

    assignments.push({
      id: assignment.id,
      title: assignment.title,
      dueAt: assignment.dueDate.getTime(),
      maxPoints: possible,
      isPublished: assignment.isPublished,
      unit: isGroup ? 'group' : 'student',
      participantCount: isGroup ? groupIds.length : assignedStudents.length,
    });
  }

  // Every submission in the course. Slim, but not as slim as the timing charts alone would
  // need: the attempts card asks what the evaluator made of each try, so the verdict and the
  // queue state come along. Still no files, no feedback, no evaluation payloads.
  //
  // Loaded before the averages, not after, because the denominator now depends on what was
  // handed in: work nobody submitted counts toward it and work awaiting a grade does not.
  const submissionRows = await prisma.submission.findMany({
    where: { courseId },
    select: {
      studentId: true,
      studentGroupId: true,
      assignmentId: true,
      problemId: true,
      submittedAt: true,
      correct: true,
      status: true,
    },
    orderBy: { submittedAt: 'asc' },
  });
  /**
   * What each student is accountable for, per assignment.
   *
   * The same rule the gradebook applies, so the number on this page and the number on the Grades
   * tab are the same one. Marked work counts; work nobody handed in counts where the assignment
   * says so; work still waiting to be marked counts toward neither half.
   */
  const submittedIndex = {
    byStudent: new Set(
      submissionRows.filter((r) => r.studentId).map((r) => submittedKey(r.studentId, r.problemId)),
    ),
    byGroup: new Set(
      submissionRows
        .filter((r) => r.studentGroupId)
        .map((r) => submittedKey(r.studentGroupId as string, r.problemId)),
    ),
  };
  const missingNow = new Date();
  for (const cell of studentCells) {
    const assignment = assignmentRows.find((a) => a.id === cell.assignmentId);
    if (!assignment) continue;
    const byStudent = grades.get(assignment.id) ?? new Map();
    const marked = byStudent.get(cell.participantId) ?? new Map();
    // This assignment's set. An over-broad list here is the missing-work exemption failing:
    // empty means "in no group, so no way to submit", which is the case that must not be zeroed.
    const groupIds = studentGroups.for(assignment.groupSetId, cell.participantId);

    let accountable = 0;
    for (const p of assignment.problems) {
      const hasGrade = marked.has(p.problemId);
      const missing =
        assignment.dueDate &&
        isMissingZero(
          {
            missingWorkIsZero: assignment.missingWorkIsZero,
            isPublished: assignment.isPublished,
            groupSetId: assignment.groupSetId,
            courseIsArchived: course.isArchived,
            dueDate: assignment.dueDate,
            unlockAt: assignment.unlockAt,
            lateCutoff: assignment.lateCutoff,
            allowLateSubmissions: assignment.allowLateSubmissions,
          },
          {
            problemId: p.problemId,
            maxPoints: Number(p.maxPoints ?? 0),
            createdAt: p.createdAt,
          },
          {
            studentId: cell.participantId,
            isAssigned: true,
            isActive: active.has(cell.participantId),
            groupIds,
          },
          overrideRows.filter((o) => o.assignmentId === assignment.id),
          submittedIndex,
          hasGrade,
          missingNow,
        ).missing;
      if (hasGrade || missing) accountable += Number(p.maxPoints ?? 0);
    }
    cell.accountable = accountable;
  }

  const { everythingAssigned, gradedOnly } = courseAverages(assignments, studentCells);

  const events: StatsSubmission[] = submissionRows
    .filter((row) => active.has(row.studentId))
    .map((row) => ({
      participantId: row.studentId,
      problemId: row.problemId,
      submittedAt: row.submittedAt.getTime(),
      correct: row.correct === true,
      status: row.status as StatsSubmission['status'],
    }));

  /**
   * The same submissions, re-keyed for the attempts-by-topic card.
   *
   * The series is one participant's run at one problem ON ONE ASSIGNMENT, so meeting the same
   * problem again later starts a new run rather than extending the old one; the bucket it
   * lands in is the problem's kind. Group work is keyed by the team, matching every other
   * card that measures a group assignment.
   */
  const typeOfProblem = new Map<string, ProblemTypeKey>();
  const groupScoped = new Set<string>();
  for (const assignment of assignmentRows) {
    if (assignment.groupSetId != null) groupScoped.add(assignment.id);
    for (const p of assignment.problems) {
      typeOfProblem.set(`${assignment.id}:${p.problemId}`, problemTypeKey(p.problem?.type));
    }
  }
  const typedEvents: StatsSubmission[] = submissionRows
    .filter((row) => active.has(row.studentId))
    .flatMap((row) => {
      const type = typeOfProblem.get(`${row.assignmentId}:${row.problemId}`);
      if (!type) return [];
      const who = groupScoped.has(row.assignmentId)
        ? (row.studentGroupId ?? row.studentId)
        : row.studentId;
      return [
        {
          participantId: `${row.assignmentId}:${row.problemId}:${who}`,
          problemId: type,
          submittedAt: row.submittedAt.getTime(),
          correct: row.correct === true,
          status: row.status as StatsSubmission['status'],
        },
      ];
    });

  const workload = buildWorkload(assignmentRows, grades, submissionRows, active, {
    groupsBySet,
    membersByGroup,
    assignees: (id) => assignmentRows.find((a) => a.id === id)?.assignees ?? [],
  });

  const turnIn = turnInByAssignment(
    assignments,
    buildTurnInInputs(assignmentRows, participantsByAssignment, submissionRows, {
      overridesByAssignment,
      studentGroups,
    }),
  );

  const percentages = new Map<string, number>();
  for (const [participantId, pct] of participantPercentages(assignments, studentCells)) {
    percentages.set(participantId, pct);
  }

  return {
    courseTitle: course.name,
    timezone: timeZone,
    studentCount: activeIds.length,
    exclusions,
    distribution: everythingAssigned,
    distributionGradedOnly: gradedOnly,
    assignments: compareAssignments(assignments, comparisonCells),
    problemTypes: compareProblemTypes(typed),
    attemptsByType: attemptsByProblemType(typedEvents),
    workload,
    turnIn,
    atRisk: atRisk(assignments, studentCells, percentages, AT_RISK_THRESHOLD),
    timeline: computeSubmissionTimeline(events, timeZone),
    heatmap: computeActivityHeatmap(events, timeZone),
    dueDates: assignments
      .filter((a) => a.isPublished)
      .map((a) => ({ id: a.id, title: a.title, dueAt: a.dueAt })),
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

type ProblemRow = { problemId: string; maxPoints: number | null; problem: { type: string | null } };
type GradeEntry = { grade: number; at: number };

/** One participant's total for an assignment, or null when nothing of theirs is graded. */
function sumOf(
  byProblem: Map<string, GradeEntry> | undefined,
  problems: ProblemRow[],
): number | null {
  if (!byProblem) return null;
  let total = 0;
  let found = 0;
  for (const p of problems) {
    const entry = byProblem.get(p.problemId);
    if (!entry) continue;
    total += entry.grade;
    found += 1;
  }
  return found === 0 ? null : total;
}

/**
 * A team's total: the best recorded among its members, problem by problem.
 *
 * The same rule the assignment page uses. An autograded group submission writes an identical
 * row to every member, so "best" is simply "the value", and where a member's grade was
 * adjusted by hand the higher one is the team's.
 */
function sumOfGroup(
  byStudent: Map<string, Map<string, GradeEntry>>,
  members: string[],
  problems: ProblemRow[],
): number | null {
  let total = 0;
  let found = 0;
  for (const p of problems) {
    const entry = bestOf(byStudent, members, p.problemId);
    if (!entry) continue;
    total += entry.grade;
    found += 1;
  }
  return found === 0 ? null : total;
}

function bestOf(
  byStudent: Map<string, Map<string, GradeEntry>>,
  members: string[],
  problemId: string,
): GradeEntry | undefined {
  let best: GradeEntry | undefined;
  for (const member of members) {
    const entry = byStudent.get(member)?.get(problemId);
    if (entry && (!best || entry.grade > best.grade)) best = entry;
  }
  return best;
}

/**
 * One entry per participant per problem, for the problem-type card.
 *
 * A problem set on two assignments produces two entries, one per occasion. Meeting a topic
 * again on a midterm is a second performance, and merging the two would report neither.
 */
function pushTyped(
  into: TypedGrade[],
  problems: ProblemRow[],
  lookup: (problemId: string) => GradeEntry | undefined,
): void {
  for (const p of problems) {
    const max = Number(p.maxPoints ?? 0);
    const entry = lookup(p.problemId);
    into.push({
      type: problemTypeKey(p.problem?.type),
      percent: entry && max > 0 ? (entry.grade / max) * 100 : 0,
      graded: entry !== undefined && max > 0,
    });
  }
}

/** Each participant's course percentage under the gradebook's reading. */
function participantPercentages(
  assignments: CourseAssignment[],
  cells: CourseGradeCell[],
): Map<string, number> {
  const published = new Set(assignments.filter((a) => a.isPublished).map((a) => a.id));
  const totals = new Map<string, { earned: number; possible: number; graded: number }>();
  for (const cell of cells) {
    if (!published.has(cell.assignmentId)) continue;
    const held = totals.get(cell.participantId) ?? { earned: 0, possible: 0, graded: 0 };
    held.possible += cell.possible;
    if (cell.earned !== null) {
      held.earned += cell.earned;
      held.graded += 1;
    }
    totals.set(cell.participantId, held);
  }
  const out = new Map<string, number>();
  for (const [id, t] of totals) {
    if (t.graded === 0 || t.possible <= 0) continue;
    out.set(id, (t.earned / t.possible) * 100);
  }
  return out;
}

/**
 * Every participant's relationship with every deadline they are held to.
 *
 * The whole assignment is one span: the first thing they submitted for it and the last,
 * across all its problems. At assignment scope that is the same question the per-problem card
 * answers, because the latest submission for the assignment IS the latest of the per-problem
 * latests, so the two pages cannot disagree about who was late.
 */
function buildTurnInInputs(
  assignmentRows: {
    id: string;
    dueDate: Date;
    unlockAt: Date | null;
    lateCutoff: Date | null;
    allowLateSubmissions: boolean;
    groupSetId: string | null;
  }[],
  participantsByAssignment: Map<string, string[]>,
  submissions: {
    studentId: string;
    studentGroupId: string | null;
    assignmentId: string;
    submittedAt: Date;
  }[],
  lookups: {
    overridesByAssignment: Map<string, OverrideRow[]>;
    studentGroups: StudentGroupIndex;
  },
): TurnInInput[] {
  // The span of each participant's attempts at each assignment, in both units at once: a
  // submission names a student and may also name the team it was sent for.
  const spans = new Map<string, { first: number; latest: number }>();
  for (const row of submissions) {
    const at = row.submittedAt.getTime();
    for (const participantId of [row.studentId, row.studentGroupId].filter(
      (id): id is string => id !== null,
    )) {
      const key = `${row.assignmentId}:${participantId}`;
      const held = spans.get(key);
      if (!held) spans.set(key, { first: at, latest: at });
      else {
        if (at < held.first) held.first = at;
        if (at > held.latest) held.latest = at;
      }
    }
  }

  const inputs: TurnInInput[] = [];
  for (const assignment of assignmentRows) {
    const base = {
      unlockAt: assignment.unlockAt,
      dueDate: assignment.dueDate,
      lateCutoff: assignment.lateCutoff,
      allowLateSubmissions: assignment.allowLateSubmissions,
    };
    const overrides = lookups.overridesByAssignment.get(assignment.id) ?? [];
    const baseDue = assignment.dueDate.getTime();

    for (const participantId of participantsByAssignment.get(assignment.id) ?? []) {
      // A group is held to whatever a GROUP override says about it; a student to their own
      // override, else one aimed at a group they are in, else the class's date.
      // On group work the participant IS the group, so it is its own id. Otherwise the index
      // answers, and for an individual assignment (a null set) that is an empty list by
      // definition. It used to hand over every group the student was in anywhere, which is not
      // a thing an individual assignment has.
      const groupIds =
        assignment.groupSetId != null
          ? [participantId]
          : lookups.studentGroups.for(assignment.groupSetId, participantId);
      const resolved = effectiveDeadline(base, overrides, participantId, groupIds);
      const dueAt = resolved.dueDate.getTime();
      inputs.push({
        assignmentId: assignment.id,
        participantId,
        dueAt,
        hasException: dueAt !== baseDue,
        span: spans.get(`${assignment.id}:${participantId}`),
      });
    }
  }
  return inputs;
}

/**
 * What is waiting on a grader, assignment by assignment, counted in pieces of work.
 *
 * A piece of work is one participant's one problem, which is what somebody marking actually
 * works through: "3 awaiting grading" meaning three students hides the four problems each of
 * them handed in. The states are the assignment page's, decided by the same function, so a
 * grade overtaken by a later submission is reported as needing another look here too.
 */
function buildWorkload(
  assignmentRows: {
    id: string;
    title: string;
    dueDate: Date;
    assignedToEveryone: boolean;
    groupSetId: string | null;
    assignees: { userId: string | null; groupId: string | null }[];
    problems: ProblemRow[];
  }[],
  grades: Map<string, Map<string, Map<string, GradeEntry>>>,
  submissions: {
    studentId: string;
    studentGroupId: string | null;
    assignmentId: string;
    problemId: string;
    submittedAt: Date;
  }[],
  active: Set<string>,
  lookups: {
    groupsBySet: Map<string, string[]>;
    membersByGroup: Map<string, string[]>;
    assignees: (assignmentId: string) => { userId: string | null; groupId: string | null }[];
  },
): GradingWorkload[] {
  // The latest submission per (assignment, participant, problem), in both units.
  const spansByAssignment = new Map<string, Map<string, SubmissionSpan>>();
  for (const row of submissions) {
    const key = row.studentGroupId ?? row.studentId;
    const spans = spansByAssignment.get(row.assignmentId) ?? new Map<string, SubmissionSpan>();
    const at = row.submittedAt.getTime();
    const mapKey = spanKey(key, row.problemId);
    const held = spans.get(mapKey);
    if (!held) spans.set(mapKey, { first: at, latest: at });
    else if (at > held.latest) held.latest = at;
    spansByAssignment.set(row.assignmentId, spans);
  }

  return assignmentRows.map((assignment) => {
    const byStudent = grades.get(assignment.id) ?? new Map<string, Map<string, GradeEntry>>();
    const spans = spansByAssignment.get(assignment.id) ?? new Map<string, SubmissionSpan>();
    const isGroup = assignment.groupSetId != null;

    const participants: StatsParticipant[] = isGroup
      ? (lookups.groupsBySet.get(assignment.groupSetId!) ?? [])
          .filter(
            (groupId) =>
              (assignment.assignedToEveryone ||
                lookups.assignees(assignment.id).some((a) => a.groupId === groupId)) &&
              (lookups.membersByGroup.get(groupId) ?? []).some((userId) => active.has(userId)),
          )
          .map((groupId) => {
            const members = lookups.membersByGroup.get(groupId) ?? [];
            return asParticipant(groupId, assignment.problems, (problemId) =>
              bestOf(byStudent, members, problemId),
            );
          })
      : [...active]
          .filter((userId) =>
            isStudentAssigned(
              { assignedToEveryone: assignment.assignedToEveryone },
              assignment.assignees,
              userId,
              [],
            ),
          )
          .map((userId) =>
            asParticipant(userId, assignment.problems, (problemId) =>
              byStudent.get(userId)?.get(problemId),
            ),
          );

    const counts = new Map(GRADING_ORDER.map((key) => [key, 0]));
    for (const participant of participants) {
      for (const problem of assignment.problems) {
        const key = gradingStateOf(participant, problem.problemId, spans);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }

    return {
      assignmentId: assignment.id,
      title: assignment.title,
      dueAt: assignment.dueDate.getTime(),
      states: GRADING_ORDER.map((key) => ({ key, count: counts.get(key) ?? 0 })),
      total: participants.length * assignment.problems.length,
    };
  });
}

/**
 * Shape one participant the way the shared grading rule expects to be asked.
 *
 * Plainly, over the problems this assignment actually has: the rule only ever asks about
 * those, and a flat object is something the next person can read in a debugger.
 */
function asParticipant(
  id: string,
  problems: ProblemRow[],
  lookup: (problemId: string) => GradeEntry | undefined,
): StatsParticipant {
  const problemGrades: Record<string, number> = {};
  const gradedAtByProblem: Record<string, number> = {};
  for (const p of problems) {
    const entry = lookup(p.problemId);
    if (!entry) continue;
    problemGrades[p.problemId] = entry.grade;
    gradedAtByProblem[p.problemId] = entry.at;
  }
  return {
    id,
    // Neither field means anything here: this participant exists to be asked one question,
    // and the deadline it would be measured against is the turn-in card's job, not this one.
    hasException: false,
    dueAt: 0,
    problemGrades,
    gradedAtByProblem,
    latestStatusByProblem: {},
  };
}
