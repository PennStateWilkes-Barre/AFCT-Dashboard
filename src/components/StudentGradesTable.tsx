'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
// `Table` is the ui primitive below, so the icon of the same name is aliased rather than
// shadowing it.
import { ChevronDown, ChevronRight, CornerDownRight, Table as TableIcon } from 'lucide-react';

import LoadingSpinner from '@/components/ui/loading-spinner';
import { Table, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useEffectiveTimezone } from '@/hooks/use-effective-timezone';
import { apiPaths } from '@/lib/api-paths';
import { formatDateInTimeZone, formatTimeInTimeZone } from '@/lib/date-format';
import { TEXT_LINK_CLASS } from '@/lib/link-styles';
import { MISSING_WORK_LABEL } from '@/lib/missing-work';
import { cn } from '@/lib/utils';

type StudentGradesProblem = {
  id: string;
  title: string | null;
  /** True when the grade is a zero for work never handed in rather than one somebody marked. */
  missing?: boolean;
  maxPoints: number;
  maxSubmissions: number;
  submissionCount: number;
  grade: number | null;
  status: string;
  autograderEnabled: boolean;
};

type StudentGradesAssignment = {
  id: string;
  title: string;
  description?: string | null;
  /** Derived server-side from the assignment's group set link; there is no stored flag. */
  isGroup: boolean;
  /** Not open yet: no problems are sent, so there is nothing to expand and nothing scored. */
  locked?: boolean;
  dueDate: string | null;
  maxPoints: number;
  grade: number | null;
  problems: StudentGradesProblem[];
};

type StudentGradesResponse = { assignments: StudentGradesAssignment[] };

// Stable empty default so the value derived from the query keeps a constant
// identity between renders.
const EMPTY_ASSIGNMENTS: StudentGradesAssignment[] = [];

/** The placeholder a gradebook uses for a number that does not exist yet. */
const NONE = '—';

/**
 * How a PROBLEM name reads inside a row. Assignment titles use `TEXT_LINK_CLASS`, the same
 * conventional link the Assignments tab puts on its titles.
 *
 * A child row is quieter than its parent on purpose, and blue underlined text on every row
 * of a six-row group is what made the gradebook read as a page of links rather than a
 * table. The row is already recognisable as a destination from the arrow, the indent and
 * the "Problem 1:" label, so this stays foreground-coloured and takes its underline on
 * hover; the focus ring is what keeps it findable without a mouse.
 */
const ROW_LINK_CLASS =
  'text-foreground hover:text-primary focus-visible:ring-ring inline-block max-w-full cursor-pointer truncate rounded-sm hover:underline focus-visible:ring-2 focus-visible:outline-none';

/**
 * Which assignments are open, remembered per course in this browser.
 *
 * A student opens an assignment to see which problem cost them the marks, follows the link
 * to that problem, and comes back to a table that has forgotten what they were looking at.
 * Keyed by course, because "open" means something different in each one.
 *
 * Read after mount rather than during render: `localStorage` does not exist on the server,
 * and seeding state from it during render makes the first client HTML disagree with the
 * server's. The cost is that the table paints collapsed for one frame, which is also what
 * it does for a student who has never expanded anything.
 */
function usePersistentExpanded(courseId: string): [string[], (assignmentId: string) => void] {
  const key = `student-grades-expanded-${courseId}`;
  const [expanded, setExpanded] = useState<string[]>([]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(key);
      if (saved === null) return;
      const parsed: unknown = JSON.parse(saved);
      // Ids of assignments since deleted simply never match a row, so there is nothing to
      // prune here. Anything that is not a list of strings is ignored outright: this is
      // hand-editable storage, and a bad value must not decide what a student sees.
      if (Array.isArray(parsed)) setExpanded(parsed.filter((v) => typeof v === 'string'));
    } catch {
      // Unavailable (private window, blocked site data) or not JSON. Either way the table
      // opens collapsed, which is a fine place to start.
    }
  }, [key]);

  // Written from the handler, not from an effect on `expanded`: an effect would also run on
  // mount, and its first run would overwrite the stored value with the empty initial state
  // before the read above had a chance to replace it.
  const toggle = useCallback(
    (assignmentId: string) => {
      const next = expanded.includes(assignmentId)
        ? expanded.filter((id) => id !== assignmentId)
        : [...expanded, assignmentId];
      setExpanded(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Not being able to remember is not a reason to refuse to expand.
      }
    },
    [expanded, key],
  );

  return [expanded, toggle];
}

/**
 * How far a student is through one problem, in their words rather than the queue's.
 *
 * `status` is the latest submission's evaluator state, so "the autograder finished but
 * nobody has a grade" is a real and common combination: that is `Processed`, and it is
 * different from a problem nothing has been submitted to.
 */
export function problemStatusLabel(problem: StudentGradesProblem): string {
  const status = problem.status?.toLowerCase() ?? '';
  if (status === 'processing') return 'Evaluating';
  // Before "Graded", because a derived zero IS a grade and would otherwise read as one a
  // person gave. Same wording the assignment page uses, from the same constant.
  if (problem.missing) return MISSING_WORK_LABEL;
  if (problem.grade !== null) return 'Graded';
  if (status === 'failed' || status === 'completed') return 'Processed';
  // "Not graded" is true of a problem nobody has submitted to, but it is not the fact the
  // student needs. `Not submitted` is the wording the student guide already uses for it.
  if (problem.submissionCount === 0) return 'Not submitted';
  return 'Not graded';
}

/**
 * The assignment's status, derived from its problems rather than stored. An assignment
 * whose problems are half marked is the case a student most needs to see, because it
 * tells them the score in front of them is not final.
 */
export function assignmentStatusLabel(problems: StudentGradesProblem[], locked = false): string {
  // A locked assignment has no problems sent for it, which would otherwise read as "Not
  // graded" when the truth is that it has not opened.
  if (locked) return 'Not open yet';
  const graded = problems.filter((p) => p.grade !== null).length;
  if (graded === 0) return 'Not graded';
  // A derived zero counts toward the score, so it counts as scored here; the problem row
  // beside it is where "Not submitted" is said.
  if (graded === problems.length) return 'Graded';
  return 'Partially graded';
}

/** `35 / 50`, or `— / 50` when nothing has been marked. Spaces around the slash: this is a score, not a fraction. */
export function formatScore(grade: number | null, maxPoints: number): string {
  return `${grade === null ? NONE : grade} / ${maxPoints}`;
}

/** `70%`, or the placeholder when there is no grade or nothing to divide by. */
export function formatPercent(grade: number | null, maxPoints: number): string {
  if (grade === null || maxPoints <= 0) return NONE;
  return `${Math.round((grade / maxPoints) * 100)}%`;
}

/**
 * The student's Grades workspace: their own gradebook for one course.
 *
 * A table, not the card-per-assignment list this used to be. The question it exists to
 * answer is "I know my assignment grade, which problem caused it", and that is a
 * comparison across rows: cards put every score in a different place on the screen and
 * made the reader hold the numbers in their head.
 *
 * Two rules the layout keeps. The assignment name is a link to the assignment and the
 * chevron beside it is a button that opens the problems, so navigating and expanding
 * never compete for one click target. And each problem row is a link of its own, because
 * "which problem" is a destination, not a detail.
 *
 * Narrow screens keep the same table and the same rows; the Due, Status and Percent
 * columns fold into a second line under the name and the score. `hidden` removes an
 * element from the accessibility tree, so exactly one copy of each value is announced
 * whatever the width.
 */
export function StudentGradesTable({ courseId }: { courseId: string }) {
  const { timezone, hour12 } = useEffectiveTimezone();
  const [expanded, toggle] = usePersistentExpanded(courseId);

  const gradesQuery = useQuery({
    queryKey: ['course', courseId, 'student-grades'],
    queryFn: async () => {
      const res = await fetch(apiPaths.courseStudentGrades(courseId));
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || 'Failed to load grades');
      }
      return (await res.json()) as StudentGradesResponse;
    },
    staleTime: 30_000,
  });

  const loading = gradesQuery.isPending;
  const error = gradesQuery.isError
    ? gradesQuery.error instanceof Error
      ? gradesQuery.error.message
      : 'Unable to load grades'
    : null;
  const assignments = gradesQuery.data?.assignments ?? EMPTY_ASSIGNMENTS;

  return (
    // No outer Card: this is the page's active panel, so wrapping it would put a bounded
    // thing inside a bounded thing.
    <section className="space-y-6" aria-labelledby="student-grades-title">
      {/* The Course Menu's own icon for this section, so the rail and the panel agree.
          Decorative; the heading carries the name. */}
      <h2 id="student-grades-title" className="flex items-center gap-2 text-xl font-semibold">
        <TableIcon className="text-muted-foreground size-5 shrink-0" aria-hidden="true" />
        Grades
      </h2>

      {loading ? (
        <LoadingSpinner label="Loading grades" fullScreen={false} className="min-h-32" />
      ) : error ? (
        <div role="alert" className="text-destructive text-sm">
          {error}
        </div>
      ) : assignments.length === 0 ? (
        <p className="text-muted-foreground text-sm">No graded assignments available yet.</p>
      ) : (
        // The DataTable's own shell, verbatim: the surface belongs to the container, not to
        // the rows, so the empty and loading states never show the page through the table.
        // The Assignments tab next door is a DataTable, and this is what makes the two tabs
        // read as one interface rather than two tables that happen to sit on one page.
        <div className="overflow-hidden rounded-md border bg-[var(--table-background)]">
          <Table aria-labelledby="student-grades-title">
            {/* Deliberate proportions. Left to itself the table spreads five columns over the
                full width and the grade, which is the thing being read, ends up a screen away
                from the assignment it belongs to. A hidden column contributes no cells, so a
                width on a hidden header is simply ignored. */}
            <TableHeader>
              <TableRow
                // The same header colour every other table in the app uses, rather than a
                // muted tint that happens to look similar. An inline style, as there, because
                // the token is a CSS variable rather than a Tailwind palette entry.
                style={{
                  backgroundColor: 'var(--table-header)',
                  color: 'var(--table-header-foreground)',
                }}
              >
                {/* The DataTable's header cells, class for class: h-12, semibold, nowrap,
                    the primitive's own px-2, and the same flex wrapper it puts round the
                    label so a right-aligned header sits where a right-aligned cell does.
                    The widths are the only addition. */}
                <TableHead className="h-12 w-[38%] font-semibold whitespace-nowrap">
                  <div className="flex items-center">Assignment / Problem</div>
                </TableHead>
                {/* Type is the first to go as the table narrows: a student mostly knows
                    whether a piece of work is theirs or their group's. */}
                <TableHead className="hidden h-12 w-[10%] font-semibold whitespace-nowrap lg:table-cell">
                  <div className="flex items-center">Type</div>
                </TableHead>
                <TableHead className="hidden h-12 w-[18%] font-semibold whitespace-nowrap md:table-cell">
                  <div className="flex items-center">Due</div>
                </TableHead>
                <TableHead className="hidden h-12 w-[14%] font-semibold whitespace-nowrap sm:table-cell">
                  <div className="flex items-center">Status</div>
                </TableHead>
                <TableHead className="h-12 w-[12%] text-right font-semibold whitespace-nowrap">
                  <div className="flex items-center justify-end">Score</div>
                </TableHead>
                <TableHead className="hidden h-12 w-[8%] text-right font-semibold whitespace-nowrap sm:table-cell">
                  <div className="flex items-center justify-end">Percent</div>
                </TableHead>
              </TableRow>
            </TableHeader>

            {/* A raw tbody, not the TableBody primitive, and one for the whole table.
                Grouping here is done with borders on the rows: a border on a row group is
                ignored under the separated-borders model browsers use by default, and
                TableBody's `[&_tr:last-child]:border-0` would zero the border-t on the last
                assignment row, which is the line separating it from the group above. That
                rule out-specifies any class we could put on the row, and every assignment
                starts collapsed, so it would have shown on arrival. */}
            <tbody>
              {assignments.map((assignment, assignmentIndex) => {
                const isLocked = assignment.locked === true;
                const status = assignmentStatusLabel(assignment.problems, isLocked);
                // Nothing to open: a locked assignment's problems are withheld until it opens,
                // and the chevron used to toggle onto an empty group, announcing "expanded"
                // with nothing to show for it.
                const canExpand = !isLocked && assignment.problems.length > 0;
                const isExpanded = canExpand && expanded.includes(assignment.id);
                const type = assignment.isGroup ? 'Group' : 'Individual';
                // The date with the time beside it, because "due Friday" and "due Friday at
                // 11:59 PM" are different pieces of information to someone deciding whether
                // to hand in tonight. The placeholder is for the assignment only: a problem's
                // Due cell is left genuinely blank, having no deadline to be missing.
                const due = assignment.dueDate
                  ? `${formatDateInTimeZone(assignment.dueDate, timezone)} ${formatTimeInTimeZone(assignment.dueDate, timezone, hour12)}`
                  : NONE;

                return (
                  <Fragment key={assignment.id}>
                    <TableRow
                      className={cn(
                        // Same surface as its problems, on purpose. The hierarchy is carried
                        // by weight, by the border above each group and by the indent under
                        // it, not by a tint: with the header already muted, a third shade in
                        // the body made the table read as three greys rather than as groups.
                        // Vertical padding is set here, on the row, so every cell in it gets
                        // the same: setting it per cell is what put the problem titles a few
                        // pixels above the values beside them.
                        'hover:bg-muted/50 border-b-0 sm:h-11 [&>td]:py-2',
                        // The strongest line in the body, and the only one at full border
                        // colour: it is where one assignment's group ends and the next begins.
                        assignmentIndex > 0 && 'border-t',
                        isExpanded && 'border-b',
                      )}
                    >
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {canExpand ? (
                            <button
                              type="button"
                              onClick={() => toggle(assignment.id)}
                              // aria-expanded and no aria-controls: the problems are several
                              // sibling rows with no element of their own to name, and pointing
                              // at the group would name a region containing this button. The
                              // rows follow it in reading order, which is what a disclosure
                              // needs.
                              aria-expanded={isExpanded}
                              // The icon stays small; the target does not. 32px square, which is
                              // reachable on a phone without making every row that tall.
                              // No background at rest; the hover is the neutral muted grey,
                              // which reads against the row's primary tint where a lighter
                              // wash of the same hue would have disappeared into it.
                              className="hover:bg-muted focus-visible:ring-ring text-muted-foreground hover:text-foreground -ml-1 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none"
                              aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${assignment.title} problems`}
                            >
                              {isExpanded ? (
                                <ChevronDown className="size-4" aria-hidden="true" />
                              ) : (
                                <ChevronRight className="size-4" aria-hidden="true" />
                              )}
                            </button>
                          ) : (
                            // The same 32px the button occupies, so titles stay in one column
                            // whether or not a row can be opened.
                            <span className="-ml-1 block size-8 shrink-0" aria-hidden="true" />
                          )}
                          <div className="min-w-0">
                            <Link
                              href={`/dashboard/courses/${courseId}/${assignment.id}`}
                              // The Assignments tab's title link, class for class, plus the
                              // weight this row carries as a group header. The underline at
                              // rest is the point of that class and is a WCAG 1.4.1 fix, not
                              // decoration: see the note on TEXT_LINK_CLASS.
                              className={cn(
                                TEXT_LINK_CLASS,
                                'block truncate leading-5 font-semibold',
                              )}
                            >
                              {assignment.title}
                            </Link>
                            {/* Due and Status folded under the title at the widths where
                                their columns are gone. `hidden` takes an element out of the
                                accessibility tree, so each value is announced exactly once
                                whatever the width. */}
                            {/* Type, Due and Status folded under the title, each appearing
                                at the width where its own column has gone. `hidden` takes an
                                element out of the accessibility tree, so every value is
                                announced exactly once whatever the width. */}
                            <p className="text-muted-foreground text-xs lg:hidden">
                              {type}
                              <span className="md:hidden"> • {due}</span>
                              <span className="sm:hidden"> • {status}</span>
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell nowrap className="text-muted-foreground hidden lg:table-cell">
                        {type}
                      </TableCell>
                      <TableCell nowrap className="text-muted-foreground hidden md:table-cell">
                        {due}
                      </TableCell>
                      <TableCell nowrap className="text-muted-foreground hidden sm:table-cell">
                        {status}
                      </TableCell>
                      <TableCell nowrap className="text-right font-semibold tabular-nums">
                        {formatScore(assignment.grade, assignment.maxPoints)}
                        <span className="text-muted-foreground block text-xs font-normal sm:hidden">
                          {formatPercent(assignment.grade, assignment.maxPoints)}
                        </span>
                      </TableCell>
                      <TableCell
                        nowrap
                        className="hidden text-right font-semibold tabular-nums sm:table-cell"
                      >
                        {formatPercent(assignment.grade, assignment.maxPoints)}
                      </TableCell>
                    </TableRow>

                    {isExpanded
                      ? assignment.problems.map((problem, index) => {
                          const problemStatus = problemStatusLabel(problem);
                          const isLastProblem = index === assignment.problems.length - 1;
                          return (
                            <TableRow
                              key={problem.id}
                              className={cn(
                                // No background of its own, so a problem row is the card
                                // surface. Its divider is deliberately fainter than the line
                                // above an assignment: that is the hierarchy, in borders.
                                'hover:bg-muted/50 border-border/40 sm:h-9 [&>td]:py-1.5',
                                // The last problem's edge is the next assignment's top
                                // border, and two borders there would read as a double rule.
                                isLastProblem && 'border-b-0',
                              )}
                            >
                              <TableCell>
                                {/* Indented, and marked with a corner arrow so the row reads
                                    as belonging to the assignment above it. The rows share a
                                    surface with their assignment, so this and the indent are
                                    what carry the nesting. Decorative: "Problem 1:" already
                                    says the same thing in words. */}
                                <div className="ml-7 flex items-center gap-2">
                                  <CornerDownRight
                                    className="text-muted-foreground size-4 shrink-0"
                                    aria-hidden="true"
                                  />
                                  <div className="min-w-0">
                                    <Link
                                      href={`/dashboard/courses/${courseId}/${assignment.id}?problem=${encodeURIComponent(problem.id)}`}
                                      className={cn(ROW_LINK_CLASS, 'text-[0.8125rem] leading-5')}
                                    >
                                      Problem {index + 1}: {problem.title ?? 'Untitled'}
                                    </Link>
                                    <p className="text-muted-foreground text-xs sm:hidden">
                                      {problemStatus}
                                    </p>
                                  </div>
                                </div>
                              </TableCell>
                              {/* Left empty on purpose. A problem has neither a type nor a
                                  deadline of its own, and repeating the assignment's would
                                  read as if it did. */}
                              <TableCell className="hidden lg:table-cell" />
                              <TableCell className="hidden md:table-cell" />
                              <TableCell
                                nowrap
                                className="text-muted-foreground hidden text-[0.8125rem] leading-5 sm:table-cell"
                              >
                                {problemStatus}
                              </TableCell>
                              <TableCell
                                nowrap
                                className="text-right text-[0.8125rem] leading-5 tabular-nums"
                              >
                                {formatScore(problem.grade, problem.maxPoints)}
                                <span className="text-muted-foreground block text-xs sm:hidden">
                                  {formatPercent(problem.grade, problem.maxPoints)}
                                </span>
                              </TableCell>
                              <TableCell
                                nowrap
                                className="hidden text-right text-[0.8125rem] leading-5 tabular-nums sm:table-cell"
                              >
                                {formatPercent(problem.grade, problem.maxPoints)}
                              </TableCell>
                            </TableRow>
                          );
                        })
                      : null}
                  </Fragment>
                );
              })}
            </tbody>
          </Table>
        </div>
      )}
    </section>
  );
}
