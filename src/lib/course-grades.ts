import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { isMissingZero, submittedKey } from '@/lib/missing-work';
import { isStudentAssigned } from '@/lib/assignment-visibility';
import { loadStudentGroupIndex, type StudentGroupIndex } from '@/lib/assignment-groups';

export type GradeMatrixStudent = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  avatar: string | null;
  // Avatar framing (applied as a CSS transform at render); null falls back to default.
  cropX: number | null;
  cropY: number | null;
  zoom: number | null;
  // Enrollment standing, so the gradebook can badge a dropped student. Dropped students
  // stay in the matrix (their grades are retained and still editable by staff).
  enrollmentStatus: string;
};

export type GradeMatrixAssignment = {
  id: string;
  title: string;
  dueDate: Date | null;
  maxPoints: number;
  /**
   * Whether students can see it.
   *
   * A draft stays a column, because staff set it up and grade it here, but it is kept out of
   * the Average: work nobody can see is not work a student failed to do, and counting it made
   * every average in a course with a draft in it read low.
   */
  isPublished: boolean;
};

// The table structure: who is in the gradebook and which assignments are the columns,
// plus who is assigned what. This is the fast part (no per-problem grade aggregation),
// so the UI can render columns and rows while the grade values are still loading.
export type CourseGradeStructure = {
  students: GradeMatrixStudent[];
  assignments: GradeMatrixAssignment[];
  // assigned[studentId][assignmentId] = whether the student is actually assigned that
  // assignment (assigned to everyone, an individual override, or a group override on a
  // group they belong to). Cells where this is false render as "not assigned".
  assigned: Record<string, Record<string, boolean>>;
  /**
   * The groups each student belongs to, per group set, from the same lookup that built
   * `assigned`.
   *
   * Carried rather than re-queried because the missing-work rule needs them too, and a group
   * assignment's "did anybody hand this in" question is answered per group. An index rather
   * than a plain map so the set id has to be named at every use: see `loadStudentGroupIndex`
   * for what asking without it cost.
   */
  groups: StudentGroupIndex;
};

// The cell values only: grades[studentId][assignmentId] = summed points earned (problem
// grades collapsed), or null. This is the slower part (the grouped aggregation).
export type CourseGradeValues = {
  grades: Record<string, Record<string, number | null>>;
};

export type CourseGradeMatrix = CourseGradeStructure & CourseGradeValues;

/**
 * The gradebook structure for a course: enrolled students, assignments (with the summed
 * max points), and the assigned map. No grade aggregation, so it returns quickly and the
 * UI can paint the columns while `getCourseGradeValues` is still in flight.
 */
export async function getCourseGradeStructure(courseId: string): Promise<CourseGradeStructure> {
  // Every student, dropped included: the gradebook keeps dropped students (labeled) so
  // their retained grades stay visible and editable.
  const roster = await prisma.roster.findMany({
    where: { courseId, role: 'STUDENT' },
    select: { userId: true, status: true },
    orderBy: { createdAt: 'asc' },
  });
  const rosterUserIds = roster.map((r) => r.userId);
  const statusByUser = new Map(roster.map((r) => [r.userId, r.status]));

  const users = rosterUserIds.length
    ? await prisma.user.findMany({
        where: { id: { in: rosterUserIds } },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          avatar: true,
          cropX: true,
          cropY: true,
          zoom: true,
        },
      })
    : [];

  const userMap = new Map(users.map((u) => [u.id, u]));
  const students: GradeMatrixStudent[] = rosterUserIds
    .map((userId) => userMap.get(userId))
    .filter((u): u is NonNullable<typeof u> => !!u)
    .map((u) => ({
      id: u.id,
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      avatar: u.avatar,
      cropX: u.cropX,
      cropY: u.cropY,
      zoom: u.zoom,
      enrollmentStatus: statusByUser.get(u.id) ?? 'ENROLLED',
    }));

  const assignmentRows = await loadAssignmentRows(courseId);
  const assignments = toColumns(assignmentRows);
  const studentIds = students.map((s) => s.id);
  // Groups come back with the map: the missing-work rule in `getCourseGradeMatrix` needs the
  // same ones, and asking again would be the same rows twice.
  const { assigned, groups } = await buildAssignedMapWithGroups(assignmentRows, studentIds);

  return { students, assignments, assigned, groups };
}

/**
 * The grade values for a course gradebook: each student's summed grade per assignment
 * (null when ungraded). This is the slower half of the matrix, split out so it can be
 * fetched after the structure and merged in as the cells arrive.
 */
export async function getCourseGradeValues(courseId: string): Promise<CourseGradeValues> {
  const roster = await prisma.roster.findMany({
    where: { courseId, role: 'STUDENT' },
    select: { userId: true },
  });
  const studentIds = roster.map((r) => r.userId);
  const assignmentRows = await prisma.assignment.findMany({
    where: { courseId },
    select: { id: true },
  });
  const assignmentIds = assignmentRows.map((a) => a.id);

  const grades: Record<string, Record<string, number | null>> = {};
  for (const s of studentIds) {
    grades[s] = {};
    for (const a of assignmentIds) grades[s][a] = null;
  }

  if (assignmentIds.length === 0 || studentIds.length === 0) {
    return { grades };
  }

  // Sum the per-problem grades into one assignment total per student.
  const gradeRows = await prisma.assignmentProblemGrade.groupBy({
    by: ['studentId', 'assignmentId'],
    where: { assignmentId: { in: assignmentIds }, studentId: { in: studentIds } },
    _sum: { grade: true },
  });

  gradeRows.forEach((g) => {
    const studentGrades = grades[g.studentId];
    if (studentGrades) studentGrades[g.assignmentId] = g._sum.grade ?? 0;
  });

  return { grades };
}

/**
 * The full gradebook matrix (structure + values) for a course.
 *
 * Deliberately unpaginated: the LMS export is its only caller and must cover every student
 * (see `api/courses/[id]/grades/export/route.ts`). The gradebook table does NOT use this;
 * it reads `getCourseGradeColumns` once and then `getCourseGradePage` per page.
 */
export async function getCourseGradeMatrix(courseId: string): Promise<CourseGradeMatrix> {
  const [structure, values] = await Promise.all([
    getCourseGradeStructure(courseId),
    getCourseGradeValues(courseId),
  ]);

  /**
   * Work nobody handed in, as a zero rather than a blank.
   *
   * This matters more here than anywhere else the rule applies: the export is how grades leave
   * AFCT for a spreadsheet or another gradebook, and a blank where the screen shows a zero is a
   * disagreement somebody resolves by hand in whichever direction they happen to guess.
   *
   * Only assignments a student handed nothing in for. Where they submitted some problems and
   * missed others, the assignment sum already counts the missed ones as nothing, and calling the
   * whole assignment zero would say the same about work still waiting to be marked.
   *
   * Done here rather than inside `getCourseGradeValues` so the assigned map and the membership
   * lookup the structure already did are reused instead of repeated.
   */
  const studentIds = structure.students.map((s) => s.id);
  const assignmentRows = await loadAssignmentRows(courseId);
  const roster = await prisma.roster.findMany({
    where: { courseId, userId: { in: studentIds } },
    select: { userId: true, status: true, user: { select: { inactive: true } } },
  });
  const activeById = new Map(
    roster.map((r) => [r.userId, r.status === 'ENROLLED' && !r.user?.inactive]),
  );
  const { allMissing } = await buildAccountability(
    assignmentRows,
    studentIds,
    structure.assigned,
    activeById,
    structure.groups,
  );
  for (const studentId of studentIds) {
    for (const assignmentId of allMissing[studentId] ?? []) {
      const studentGrades = values.grades[studentId];
      if (studentGrades && studentGrades[assignmentId] === null) {
        studentGrades[assignmentId] = 0;
      }
    }
  }

  return { ...structure, ...values };
}

// --- Paged gradebook -------------------------------------------------------------
//
// The table reads the course's columns once and then one page of students at a time. The
// functions above stay whole-course because the LMS export needs the entire matrix.

/** The gradebook's columns, plus how many students the course has in total. */
export type CourseGradeColumns = {
  assignments: GradeMatrixAssignment[];
  totalStudents: number;
};

/** One student, with their assigned flags and grades already attached. */
export type GradePageRow = GradeMatrixStudent & {
  assigned: Record<string, boolean>;
  grades: Record<string, number | null>;
  /**
   * Assignment ids the student handed nothing in for, past their own deadline, on an assignment
   * set to score missing work zero. The cell shows zero for these and says why: a bare zero would
   * be indistinguishable from one they earned by getting it wrong.
   */
  missing: string[];
  /**
   * Points this student is accountable for per assignment: marked work plus work nobody handed
   * in. The Average's denominator, sent rather than recomputed because the client draws the
   * column and the server orders by it, and the two must not disagree.
   */
  accountable: Record<string, number>;
};

export type GradePageParams = {
  courseId: string;
  skip: number;
  take: number;
  q?: string;
  /**
   * A student field ('lastName' | 'firstName' | 'email'), the derived 'totalGrade', or an
   * assignment id. Anything else falls back to surname order.
   */
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
};

/** The assignment rows the assigned-map and the columns are both built from. */
type AssignmentRow = {
  id: string;
  title: string;
  dueDate: Date | null;
  isPublished: boolean;
  assignedToEveryone: boolean;
  // The missing-work rule's inputs. See `buildAccountability`.
  missingWorkIsZero: boolean;
  groupSetId: string | null;
  unlockAt: Date | null;
  lateCutoff: Date | null;
  allowLateSubmissions: boolean;
  course: { isArchived: boolean } | null;
  overrides: {
    targetType: 'STUDENT' | 'GROUP';
    userId: string | null;
    groupId: string | null;
    unlockAt: Date | null;
    dueDate: Date | null;
    lateCutoff: Date | null;
    allowLateSubmissions: boolean | null;
  }[];
  problems: { problemId: string; maxPoints: number | null; createdAt: Date }[];
  assignees: { userId: string | null; groupId: string | null }[];
};

async function loadAssignmentRows(courseId: string): Promise<AssignmentRow[]> {
  return prisma.assignment.findMany({
    where: { courseId },
    select: {
      id: true,
      title: true,
      dueDate: true,
      isPublished: true,
      assignedToEveryone: true,
      // Everything `lib/missing-work` needs to decide whether unsubmitted work counts as zero.
      // Loaded here rather than per cell: this is one query for the course either way.
      missingWorkIsZero: true,
      groupSetId: true,
      unlockAt: true,
      lateCutoff: true,
      allowLateSubmissions: true,
      course: { select: { isArchived: true } },
      overrides: {
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
      problems: { select: { problemId: true, maxPoints: true, createdAt: true } },
      assignees: { select: { userId: true, groupId: true } },
    },
    orderBy: { dueDate: 'asc' },
  });
}

function toColumns(rows: AssignmentRow[]): GradeMatrixAssignment[] {
  return rows.map((a) => ({
    id: a.id,
    title: a.title,
    dueDate: a.dueDate,
    isPublished: a.isPublished,
    maxPoints: a.problems.reduce((sum, p) => sum + Number(p.maxPoints ?? 0), 0),
  }));
}

/**
 * assigned[studentId][assignmentId] for the given students, from already-loaded assignee
 * rows and group memberships. One membership query for the whole set; no per-cell queries.
 *
 * Shared with `getCourseGradeStructure` so "who is assigned what" keeps one definition.
 *
 * The groups it looked up come back with it. The missing-work rule needs the same ones, and a
 * second query for them would be the same rows again.
 */
async function buildAssignedMapWithGroups(
  assignmentRows: AssignmentRow[],
  studentIds: string[],
): Promise<{ assigned: Record<string, Record<string, boolean>>; groups: StudentGroupIndex }> {
  const assigned: Record<string, Record<string, boolean>> = {};
  for (const s of studentIds) {
    assigned[s] = {};
    for (const a of assignmentRows) assigned[s][a.id] = true;
  }
  if (assignmentRows.length === 0 || studentIds.length === 0) {
    return { assigned, groups: await loadStudentGroupIndex([], []) };
  }

  // Scoped to each assignment's own group set. This used to ask for every membership these
  // students hold anywhere, which made the missing-work exemption fail for anyone who happened
  // to be in a group in another course. See loadStudentGroupIndex.
  const groups = await loadStudentGroupIndex(
    assignmentRows.map((a) => a.groupSetId),
    studentIds,
  );

  for (const a of assignmentRows) {
    for (const s of studentIds) {
      const studentAssigned = assigned[s];
      if (studentAssigned) {
        studentAssigned[a.id] = isStudentAssigned(
          { assignedToEveryone: a.assignedToEveryone },
          a.assignees ?? [],
          s,
          groups.for(a.groupSetId, s),
        );
      }
    }
  }
  return { assigned, groups };
}

/** The map alone, for the callers that do not need the groups. */
async function buildAssignedMap(
  assignmentRows: AssignmentRow[],
  studentIds: string[],
): Promise<Record<string, Record<string, boolean>>> {
  return (await buildAssignedMapWithGroups(assignmentRows, studentIds)).assigned;
}

/** Dense grades[studentId][assignmentId] for the given students, nulls where ungraded. */
async function loadGradeSums(
  assignmentIds: string[],
  studentIds: string[],
): Promise<Record<string, Record<string, number | null>>> {
  const grades: Record<string, Record<string, number | null>> = {};
  for (const s of studentIds) {
    grades[s] = {};
    for (const a of assignmentIds) grades[s][a] = null;
  }
  if (assignmentIds.length === 0 || studentIds.length === 0) return grades;

  const gradeRows = await prisma.assignmentProblemGrade.groupBy({
    by: ['studentId', 'assignmentId'],
    where: { assignmentId: { in: assignmentIds }, studentId: { in: studentIds } },
    _sum: { grade: true },
  });
  gradeRows.forEach((g) => {
    const studentGrades = grades[g.studentId];
    if (studentGrades) studentGrades[g.assignmentId] = g._sum.grade ?? 0;
  });
  return grades;
}

/**
 * How many points each student is actually accountable for on each assignment, and where a cell
 * is a zero for work nobody handed in.
 *
 * This is what makes the Average honest. Its denominator used to be every published, assigned
 * assignment's full points regardless of grading, so work still sitting in a marking queue read as
 * a zero, and a week-eight average mostly measured how much term was left. Now a problem counts
 * toward the denominator when it has been marked, or when `lib/missing-work` says nobody handed it
 * in; work awaiting a grade counts toward neither half.
 *
 * One extra query for grades per problem and one for submissions, both batched over the whole set
 * of students being considered. No per-cell reads.
 */
async function buildAccountability(
  assignmentRows: AssignmentRow[],
  studentIds: string[],
  assigned: Record<string, Record<string, boolean>>,
  activeById: Map<string, boolean>,
  groups: StudentGroupIndex,
  now = new Date(),
): Promise<{
  /** Points that count toward this student's denominator on this assignment. */
  points: Record<string, Record<string, number>>;
  /** Assignments where the student handed in nothing at all and it is past due. */
  allMissing: Record<string, Set<string>>;
  /**
   * Assignments where the student has at least one problem scored zero for not handing it in,
   * whether or not they handed in the rest. `allMissing` answers "did they do nothing", which is
   * what the gradebook cell needs; this answers "are they accountable for anything they did not
   * do", which is what deciding to send a score to the LMS needs.
   */
  anyMissing: Record<string, Set<string>>;
}> {
  const points: Record<string, Record<string, number>> = {};
  const allMissing: Record<string, Set<string>> = {};
  const anyMissing: Record<string, Set<string>> = {};
  for (const id of studentIds) {
    points[id] = {};
    allMissing[id] = new Set();
    anyMissing[id] = new Set();
  }
  if (assignmentRows.length === 0 || studentIds.length === 0) {
    return { points, allMissing, anyMissing };
  }

  const assignmentIds = assignmentRows.map((a) => a.id);
  const groupIds = groups.all();

  const [gradeRows, submissionRows] = await Promise.all([
    prisma.assignmentProblemGrade.findMany({
      where: { assignmentId: { in: assignmentIds }, studentId: { in: studentIds } },
      select: { studentId: true, assignmentId: true, problemId: true },
    }),
    prisma.submission.findMany({
      where: {
        assignmentId: { in: assignmentIds },
        OR: [
          { studentId: { in: studentIds } },
          ...(groupIds.length > 0 ? [{ studentGroupId: { in: groupIds } }] : []),
        ],
      },
      select: { studentId: true, studentGroupId: true, assignmentId: true, problemId: true },
      distinct: ['studentId', 'studentGroupId', 'assignmentId', 'problemId'],
    }),
  ]);

  const graded = new Set(gradeRows.map((g) => `${g.studentId} ${g.assignmentId} ${g.problemId}`));
  const submitted = {
    byStudent: new Set(
      submissionRows.filter((r) => r.studentId).map((r) => submittedKey(r.studentId, r.problemId)),
    ),
    byGroup: new Set(
      submissionRows
        .filter((r) => r.studentGroupId)
        .map((r) => submittedKey(r.studentGroupId as string, r.problemId)),
    ),
  };

  for (const a of assignmentRows) {
    const shape = a.dueDate && {
      missingWorkIsZero: a.missingWorkIsZero,
      isPublished: a.isPublished,
      groupSetId: a.groupSetId,
      courseIsArchived: a.course?.isArchived ?? false,
      dueDate: a.dueDate,
      unlockAt: a.unlockAt,
      lateCutoff: a.lateCutoff,
      allowLateSubmissions: a.allowLateSubmissions,
    };

    for (const studentId of studentIds) {
      if (assigned[studentId]?.[a.id] === false) continue;
      const who = {
        studentId,
        isAssigned: true,
        isActive: activeById.get(studentId) ?? true,
        // This assignment's set, not every group the student is in. The empty case is the
        // exemption missing-work relies on, so an over-broad list scores a zero.
        groupIds: groups.for(a.groupSetId, studentId),
      };

      let accountable = 0;
      let missingCount = 0;
      let handedInSomething = false;

      for (const p of a.problems) {
        const hasGrade = graded.has(`${studentId} ${a.id} ${p.problemId}`);
        /**
         * Only the missing question needs a deadline. Marked work counts toward what the student
         * is accountable for whether or not the assignment has a due date, and an earlier version
         * of this skipped the whole assignment when it had none, which quietly emptied the
         * denominator for every course that leaves dates off.
         */
        const verdict = shape
          ? isMissingZero(
              shape,
              {
                problemId: p.problemId,
                maxPoints: Number(p.maxPoints ?? 0),
                createdAt: p.createdAt,
              },
              who,
              a.overrides,
              submitted,
              hasGrade,
              now,
            )
          : ({ missing: false, reason: 'not-due-yet' } as const);
        if (hasGrade || verdict.missing) accountable += Number(p.maxPoints ?? 0);
        if (verdict.missing) missingCount += 1;
        if (!verdict.missing && verdict.reason === 'submitted') handedInSomething = true;
      }

      points[studentId]![a.id] = accountable;
      if (missingCount > 0) anyMissing[studentId]!.add(a.id);
      // Marked only when they handed in nothing at all: a partly-submitted assignment showing
      // "not submitted" would be a false statement about the half they did.
      if (missingCount > 0 && missingCount === a.problems.length && !handedInSomething) {
        allMissing[studentId]!.add(a.id);
      }
    }
  }

  return { points, allMissing, anyMissing };
}

/**
 * Students on one assignment who have at least one problem scored zero for not handing it in.
 *
 * The LMS sync needs this, and the gradebook already works it out, so it comes from the same
 * place rather than a second assembly of the missing-work inputs. Two ways of deciding who is
 * missing is how a student ends up with different answers in two places, which is the same
 * reasoning as the comment on the grade total in `queueChangedGrades`.
 */
export async function studentsWithDerivedZeros(
  assignmentId: string,
  now = new Date(),
): Promise<Set<string>> {
  const assignment = await prisma.assignment.findUnique({
    where: { id: assignmentId },
    select: { courseId: true, missingWorkIsZero: true },
  });
  // Callers gate on this as well, to avoid the loads below. A helper that answers honestly on
  // its own is still worth more than one that trusts every caller to have checked.
  if (!assignment || !assignment.missingWorkIsZero) return new Set();

  const roster = await prisma.roster.findMany({
    where: { courseId: assignment.courseId, role: 'STUDENT' },
    select: { userId: true, status: true, user: { select: { inactive: true } } },
  });
  const studentIds = roster.map((r) => r.userId);
  if (studentIds.length === 0) return new Set();

  const rows = (await loadAssignmentRows(assignment.courseId)).filter((a) => a.id === assignmentId);
  if (rows.length === 0) return new Set();

  const { assigned, groups } = await buildAssignedMapWithGroups(rows, studentIds);
  const activeById = new Map(
    roster.map((r) => [r.userId, r.status === 'ENROLLED' && !r.user?.inactive]),
  );

  const { anyMissing } = await buildAccountability(
    rows,
    studentIds,
    assigned,
    activeById,
    groups,
    now,
  );

  const out = new Set<string>();
  for (const studentId of studentIds) {
    if (anyMissing[studentId]?.has(assignmentId)) out.add(studentId);
  }
  return out;
}

/**
 * A student's average across their graded work, as a percentage, or undefined when they
 * have none. The server-side twin of the gradebook's Average column: only assignments the
 * student is actually assigned count toward the denominator, so someone who is not assigned
 * everything is not measured against the full course total.
 *
 * Unpublished assignments are out of it too. A draft is a column here because staff build and
 * grade one here, but a student cannot do work they cannot see, and counting it dragged every
 * average in the course down by however much of the term was still in preparation.
 */
function averagePct(
  assignments: GradeMatrixAssignment[],
  assignedFlags: Record<string, boolean> | undefined,
  studentGrades: Record<string, number | null> | undefined,
  accountable?: Record<string, number>,
): number | undefined {
  let earned = 0;
  let available = 0;
  let gradeCount = 0;
  for (const a of assignments) {
    if (!a.isPublished) continue;
    if (assignedFlags?.[a.id] === false) continue;
    /**
     * What the student is accountable for, not the assignment's full value.
     *
     * Without the map this falls back to the whole assignment, which is what this column did
     * for its entire history: every published assignment counted in full whether or not anybody
     * had marked it, so work sitting in a TA's queue read as a zero and a mid-term average
     * mostly measured how much term was left. With it, a problem counts once it has been marked
     * or once nobody handed it in; work awaiting a grade counts toward neither half.
     */
    available += accountable ? (accountable[a.id] ?? 0) : (a.maxPoints ?? 0);
    const val = studentGrades?.[a.id];
    if (val !== null && val !== undefined) {
      earned += Number(val);
      gradeCount++;
    }
  }
  if (gradeCount === 0 || available === 0) return undefined;
  return (earned / available) * 100;
}

/** The gradebook's columns and its student total. Cached per course by the client. */
export async function getCourseGradeColumns(courseId: string): Promise<CourseGradeColumns> {
  const [assignmentRows, totalStudents] = await Promise.all([
    loadAssignmentRows(courseId),
    prisma.roster.count({ where: { courseId, role: 'STUDENT' } }),
  ]);
  return { assignments: toColumns(assignmentRows), totalStudents };
}

/**
 * One page of the gradebook: students plus their assigned flags and grades.
 *
 * Ordering is resolved here rather than by Prisma, because two of the table's sorts cannot
 * be an `orderBy`: grades live in another table, and Average is derived from them. Three
 * tiers, cheapest first:
 *
 *   - a student field: a real database order with skip/take, so only the page is touched.
 *   - an assignment column: one grouped query scoped to that assignment, one row per
 *     student, sorted here and sliced.
 *   - 'totalGrade': the same, but it needs every student's assigned flags and grades to
 *     compute the average.
 *
 * The last two are O(students) work that stays on the server; the browser still receives
 * one page either way. Candidates are pre-ordered by surname so the JS sort (which is
 * stable) falls back to name order when two students tie.
 */
export async function getCourseGradePage(
  params: GradePageParams,
): Promise<{ rows: GradePageRow[]; total: number }> {
  const { courseId, skip, take, q, sortBy, sortDir } = params;
  const dir: 'asc' | 'desc' = sortDir === 'desc' ? 'desc' : 'asc';

  // Every student, dropped included: the gradebook keeps dropped students (labeled) so
  // their retained grades stay visible and editable.
  const where: Prisma.RosterWhereInput = {
    courseId,
    role: 'STUDENT',
    ...(q
      ? {
          user: {
            OR: [
              { firstName: { contains: q, mode: 'insensitive' } },
              { lastName: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
            ],
          },
        }
      : {}),
  };

  const assignmentRows = await loadAssignmentRows(courseId);
  const assignments = toColumns(assignmentRows);
  const assignmentIds = assignments.map((a) => a.id);
  const isAssignmentSort = !!sortBy && assignmentIds.includes(sortBy);
  const isDerivedSort = sortBy === 'totalGrade' || isAssignmentSort;

  const total = await prisma.roster.count({ where });

  const nameOrder: Prisma.RosterOrderByWithRelationInput[] = [
    { user: { lastName: dir } },
    { user: { firstName: dir } },
    { userId: 'asc' },
  ];

  let pageIds: string[];
  let statusById: Map<string, string>;
  // Reused when a derived sort has already computed them for every candidate.
  let assignedAll: Record<string, Record<string, boolean>> | null = null;
  let gradesAll: Record<string, Record<string, number | null>> | null = null;

  if (!isDerivedSort) {
    const STUDENT_ORDER: Record<string, Prisma.RosterOrderByWithRelationInput[]> = {
      lastName: nameOrder,
      firstName: [{ user: { firstName: dir } }, { user: { lastName: dir } }, { userId: 'asc' }],
      email: [{ user: { email: dir } }, { userId: 'asc' }],
    };
    const rows = await prisma.roster.findMany({
      where,
      orderBy: STUDENT_ORDER[sortBy ?? ''] ?? nameOrder,
      skip,
      take,
      select: { userId: true, status: true },
    });
    pageIds = rows.map((r) => r.userId);
    statusById = new Map(rows.map((r) => [r.userId, r.status]));
  } else {
    // Surname order first, so the stable sort below tie-breaks by name.
    const candidates = await prisma.roster.findMany({
      where,
      orderBy: [{ user: { lastName: 'asc' } }, { user: { firstName: 'asc' } }, { userId: 'asc' }],
      select: { userId: true, status: true },
    });
    const candidateIds = candidates.map((c) => c.userId);
    statusById = new Map(candidates.map((c) => [c.userId, c.status]));

    let keyOf: (id: string) => number | undefined;
    if (isAssignmentSort) {
      // Only the one column's totals are needed, so this stays one row per student.
      const sums = await loadGradeSums([sortBy as string], candidateIds);
      keyOf = (id) => sums[id]?.[sortBy as string] ?? undefined;
    } else {
      assignedAll = await buildAssignedMap(assignmentRows, candidateIds);
      gradesAll = await loadGradeSums(assignmentIds, candidateIds);
      // Ordering by a number the page would not show is its own kind of wrong, so the sort key
      // is built from the same accountability the cells are.
      const [rosterAll, groupsAll] = await Promise.all([
        prisma.roster.findMany({
          where: { courseId, userId: { in: candidateIds } },
          select: { userId: true, status: true, user: { select: { inactive: true } } },
        }),
        // Course-scoped was closer than the gradebook's version but still not the rule: a
        // course can hold several group sets, and only the assignment's own set decides this.
        loadStudentGroupIndex(
          assignmentRows.map((a) => a.groupSetId),
          candidateIds,
        ),
      ]);
      const activeAll = new Map(
        rosterAll.map((r) => [r.userId, r.status === 'ENROLLED' && !r.user?.inactive]),
      );
      const accountableAll = await buildAccountability(
        assignmentRows,
        candidateIds,
        assignedAll,
        activeAll,
        groupsAll,
      );
      keyOf = (id) =>
        averagePct(assignments, assignedAll?.[id], gradesAll?.[id], accountableAll.points[id]);
    }

    const ordered = [...candidateIds].sort((a, b) => {
      const ka = keyOf(a);
      const kb = keyOf(b);
      // Students with nothing to compare sort last whichever way the column points,
      // matching the table's `sortUndefined: 'last'`.
      if (ka === undefined && kb === undefined) return 0;
      if (ka === undefined) return 1;
      if (kb === undefined) return -1;
      return dir === 'asc' ? ka - kb : kb - ka;
    });
    pageIds = ordered.slice(skip, skip + take);
  }

  if (pageIds.length === 0) return { rows: [], total };

  const users = await prisma.user.findMany({
    where: { id: { in: pageIds } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      avatar: true,
      cropX: true,
      cropY: true,
      zoom: true,
    },
  });
  const userMap = new Map(users.map((u) => [u.id, u]));

  const assigned = assignedAll ?? (await buildAssignedMap(assignmentRows, pageIds));
  const grades = gradesAll ?? (await loadGradeSums(assignmentIds, pageIds));

  // Who is still active, and which groups they are in: both decide whether unsubmitted work is
  // this student's to be missing. Dropped students stay in the gradebook by design, so their
  // standing has to be read rather than assumed.
  const [rosterRows, groupsByStudent] = await Promise.all([
    prisma.roster.findMany({
      where: { courseId, userId: { in: pageIds } },
      select: { userId: true, status: true, user: { select: { inactive: true } } },
    }),
    loadStudentGroupIndex(
      assignmentRows.map((a) => a.groupSetId),
      pageIds,
    ),
  ]);
  const activeById = new Map(
    rosterRows.map((r) => [r.userId, r.status === 'ENROLLED' && !r.user?.inactive]),
  );

  const accountability = await buildAccountability(
    assignmentRows,
    pageIds,
    assigned,
    activeById,
    groupsByStudent,
  );

  const rows: GradePageRow[] = pageIds
    .map((id) => userMap.get(id))
    .filter((u): u is NonNullable<typeof u> => !!u)
    .map((u) => ({
      id: u.id,
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      avatar: u.avatar,
      cropX: u.cropX,
      cropY: u.cropY,
      zoom: u.zoom,
      enrollmentStatus: statusById.get(u.id) ?? 'ENROLLED',
      assigned: assigned[u.id] ?? {},
      grades: grades[u.id] ?? {},
      missing: [...(accountability.allMissing[u.id] ?? [])],
      accountable: accountability.points[u.id] ?? {},
    }));

  return { rows, total };
}
