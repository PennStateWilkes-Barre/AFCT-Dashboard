import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { MISSING_WORK_LABEL } from '@/lib/missing-work';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';

export type ProblemListItem = {
  id: string;
  title: string;
  grade?: number | null;
  maxGrade?: number | null;
  /**
   * True when this grade is a zero for work never handed in rather than one that was marked.
   * The two are the same number and only one of them is something the student can still act on.
   */
  missing?: boolean;
  submissionsCount?: number;
  maxSubmissions?: number | null;
};

export type ProblemListCardProps = {
  problems: ProblemListItem[];
  selectedProblemId: string | null;
  onSelect: (id: string) => void;
  getBadgeContent?: (problemId: string) => ReactNode;
  title?: string;
  description?: string;
  className?: string;
  scrollAreaClassName?: string;
  /** When set, the leading number for the first 9 problems is announced as a 1-9 keyboard shortcut. */
  numberShortcuts?: boolean;
  /** Show the "submissions used / allowed" badge next to the grade. Default true; the staff
   * submissions view hides it since attempts aren't relevant when grading. */
  showSubmissionUsage?: boolean;
  /** Show the "grade / max points" badge on each row. Default true. The student assignment
   *  view turns it off: the grade for the problem being read is a card of its own there, and
   *  repeating every problem's score in the picker made the list a scoreboard to scan rather
   *  than a list to choose from. */
  showGrade?: boolean;
  /** Show a footer badge totalling earned / max points across all problems. Default false. */
  showTotal?: boolean;
};

export function ProblemListCard({
  problems,
  selectedProblemId,
  onSelect,
  getBadgeContent,
  title = 'Problems',
  description,
  className = '',
  scrollAreaClassName = 'h-[520px]',
  numberShortcuts = false,
  showSubmissionUsage = true,
  showGrade = true,
  showTotal = false,
}: ProblemListCardProps) {
  // Earned (ungraded counts as 0) and max points summed across every problem.
  const totals = problems.reduce(
    (acc, p) => ({
      earned:
        acc.earned +
        (typeof p.grade === 'number' && Number.isFinite(p.grade) ? Math.max(0, p.grade) : 0),
      available:
        acc.available +
        (typeof p.maxGrade === 'number' && Number.isFinite(p.maxGrade)
          ? Math.max(0, p.maxGrade)
          : 0),
    }),
    { earned: 0, available: 0 },
  );

  // Size every grade/total bubble to the widest label so they line up. Using the character
  // count in tabular (equal-width) digits keeps it font-agnostic.
  const gradeLabels = problems
    .filter((p) => p.maxGrade !== undefined && p.maxGrade !== null)
    .map((p) => `${p.grade !== null && p.grade !== undefined ? p.grade : '-'}/${p.maxGrade}`);
  const totalLabel = `${totals.earned}/${totals.available}`;
  const badgeChars = Math.max(
    0,
    ...gradeLabels.map((s) => s.length),
    ...(showTotal ? [totalLabel.length] : []),
  );
  const badgeClass =
    'justify-center border border-border bg-background text-xs font-medium tabular-nums text-foreground';
  const badgeStyle = badgeChars > 0 ? { minWidth: `${badgeChars}ch` } : undefined;

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
        {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
      </CardHeader>
      <CardContent className={showTotal ? 'flex min-h-0 flex-1 flex-col p-0' : 'p-0'}>
        <ScrollArea className={showTotal ? 'min-h-0 flex-1' : scrollAreaClassName}>
          <ul className="divide-border divide-y">
            {problems.map((problem, index) => {
              const isActive = selectedProblemId === problem.id;
              const badgeContent = getBadgeContent ? getBadgeContent(problem.id) : null;
              const gradeBadge =
                showGrade && problem.maxGrade !== undefined && problem.maxGrade !== null ? (
                  <Badge
                    key="grade"
                    variant="secondary"
                    title="Grade Earned / Max Points"
                    className={badgeClass}
                    style={badgeStyle}
                  >
                    {/* `title` is the only thing telling these two fractions apart, and a
                        title on a non-interactive span is not a reliable description: the
                        list read as "8/10, 2/3" with nothing saying which was which. */}
                    <span className="sr-only">Grade </span>
                    {problem.grade !== null && problem.grade !== undefined ? problem.grade : '-'}/
                    {problem.maxGrade}
                    {problem.missing ? (
                      <span className="sr-only">, {MISSING_WORK_LABEL.toLowerCase()}</span>
                    ) : null}
                  </Badge>
                ) : null;
              const missingBadge = problem.missing ? (
                <Badge key="missing" variant="secondary" className="font-normal">
                  {MISSING_WORK_LABEL}
                </Badge>
              ) : null;
              const submissionsCount = problem.submissionsCount ?? 0;
              const hasMaxSubmissions =
                problem.maxSubmissions !== undefined && problem.maxSubmissions !== null;
              const unlimited = !hasMaxSubmissions || problem.maxSubmissions === -1;
              const submissionLabel = unlimited
                ? `${submissionsCount}/∞`
                : `${submissionsCount}/${problem.maxSubmissions}`;
              /**
               * The same fact in words, for assistive tech. This badge is the web app's only
               * view of the attempt limit, and "∞" is read inconsistently: some screen readers
               * say "infinity", some say nothing at all.
               */
              const submissionSpoken = unlimited
                ? `${submissionsCount} attempts used, unlimited allowed`
                : `${submissionsCount} of ${problem.maxSubmissions} attempts used`;
              const usageBadge =
                showSubmissionUsage && (hasMaxSubmissions || submissionsCount > 0) ? (
                  <Badge
                    key="usage"
                    variant="secondary"
                    title="Submissions Used / Submissions Allowed"
                    className="border-border bg-background text-foreground border text-xs font-medium"
                  >
                    <span className="sr-only">{submissionSpoken}</span>
                    <span aria-hidden="true">{submissionLabel}</span>
                  </Badge>
                ) : null;

              // Null rather than an empty flex box when every badge is switched off, so a
              // row with nothing to show does not reserve a column for it.
              const badges = [gradeBadge, missingBadge, usageBadge].filter(Boolean);
              const content =
                badgeContent ??
                (badges.length > 0 ? (
                  <div className="flex items-center gap-1">{badges}</div>
                ) : null);

              const shortcut = numberShortcuts && index < 9 ? String(index + 1) : undefined;

              return (
                <li key={problem.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(problem.id)}
                    aria-current={isActive ? 'true' : undefined}
                    aria-keyshortcuts={shortcut}
                    title={shortcut ? `Press ${shortcut} to select` : undefined}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition ${
                      isActive ? 'bg-secondary text-secondary-foreground' : 'hover:bg-accent'
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="text-muted-foreground shrink-0 tabular-nums">
                        {index + 1}.
                      </span>
                      <span className="truncate">{problem.title}</span>
                    </span>
                    {content}
                  </button>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
        {showTotal ? (
          <div className="flex justify-end border-t px-3 py-2">
            <Badge
              variant="secondary"
              title="Total Earned / Total Points"
              className={badgeClass}
              style={badgeStyle}
            >
              {totals.earned}/{totals.available}
            </Badge>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
