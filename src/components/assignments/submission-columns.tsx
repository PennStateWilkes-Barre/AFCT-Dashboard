'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { Download, MoreHorizontal, RotateCcw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatDateInTimeZone, formatTimeInTimeZone } from '@/lib/date-format';
import { FEEDBACK_WITHHELD_MESSAGE } from '@/lib/feedback-visibility';
import { getTimingStatusChip, getReviewStatusChip, type StatusChip } from '@/lib/submission-status';
import { TEXT_LINK_CLASS } from '@/lib/link-styles';
import { cn } from '@/lib/utils';
import type { ProblemSubmission } from '@/lib/problem-submission';

/**
 * Columns for the attempts table on a problem: the same table for a student reading their own
 * work and for a grader reading theirs, which is why the differences are props rather than two
 * column sets.
 *
 * Split out of `ProblemWorkspace`, where it was 196 lines of the file, following the
 * `*-columns.tsx` convention the course and assignment tables already use. Nothing about the
 * columns changed in the move.
 *
 * Built per render rather than memoised: every action cell closes over the current handlers and
 * flags, and a stale `onRerunSubmission` is a button that reruns the wrong thing.
 *
 * `build`, not `use`, unlike the `useAssignmentColumns` next door. It calls no hooks, and its
 * caller returns early while a problem is still loading, so a `use` name would put a hook after
 * a conditional return: a rule React enforces and this function has no need of.
 */
export type SubmissionColumnOptions = {
  /** The viewer's timezone and clock preference, for the Submitted column. */
  timeZone: string;
  hour12: boolean;
  /** The deadline this viewer is held to, for the on-time/late chip. Null when there is none. */
  dueDate: Date | null;
  hasValidDueDate: boolean;
  /** Attempt numbers by submission id, counted oldest first so #1 is the first try. */
  attemptNumbers: Map<string, number>;
  /** Staff see the rerun action; a student does not. */
  isPrivilegedUser: boolean;
  /** Name whoever sent each attempt. Group assignments only; see ProblemWorkspace. */
  showSubmitter: boolean;
  onViewSubmission: (submission: ProblemSubmission) => void;
  onDownload: (submission: ProblemSubmission) => void;
  onRerunSubmission?: (submission: ProblemSubmission) => void;
};

export function buildSubmissionColumns({
  timeZone,
  hour12,
  dueDate,
  hasValidDueDate,
  attemptNumbers,
  isPrivilegedUser,
  showSubmitter,
  onViewSubmission,
  onDownload,
  onRerunSubmission,
}: SubmissionColumnOptions): ColumnDef<ProblemSubmission>[] {
  // Status (timing) and Result (evaluator verdict) each render one of these. StatusBadge takes
  // its colour from the chip's own variant, so the label and its colour are decided in
  // lib/submission-status rather than per table, and a dot conveying meaning by colour alone is
  // replaced by a badge whose text carries it.
  const renderStatusChip = (chip: StatusChip) => <StatusBadge chip={chip} />;

  return [
    {
      id: 'attempt',
      header: 'Attempt',
      accessorFn: (s) => attemptNumbers.get(s.id) ?? 0,
      cell: ({ row }) => (
        <span className="tabular-nums">{attemptNumbers.get(row.original.id) ?? '—'}</span>
      ),
      meta: { align: 'center' },
    },
    {
      id: 'submitted',
      header: 'Submitted',
      accessorFn: (s) => new Date(s.submittedAt).getTime(),
      cell: ({ row }) => {
        const submission = row.original;
        const submittedAt = new Date(submission.submittedAt);
        const isLate =
          submission.status?.toLowerCase() === 'late' ||
          (hasValidDueDate && submittedAt.getTime() > dueDate!.getTime());
        return (
          <div className="flex flex-col gap-1">
            <span>{formatDateInTimeZone(submittedAt, timeZone)}</span>
            <span className="text-muted-foreground text-xs">
              {formatTimeInTimeZone(submittedAt, timeZone, hour12)}
            </span>
            {isLate ? (
              <Badge variant="warning" className="mt-1">
                Late
              </Badge>
            ) : null}
          </div>
        );
      },
      meta: { priority: 1 },
    },
    ...(showSubmitter
      ? [
          {
            id: 'submittedBy',
            header: 'Submitted by',
            accessorFn: (s: ProblemSubmission) =>
              typeof s.submittedBy === 'string' ? s.submittedBy : '',
            cell: ({ row }: { row: { original: ProblemSubmission } }) =>
              typeof row.original.submittedBy === 'string' ? row.original.submittedBy : '—',
            meta: { priority: 2 },
          } as ColumnDef<ProblemSubmission>,
        ]
      : []),
    {
      id: 'status',
      header: 'Status',
      accessorFn: (s) => getTimingStatusChip(s, hasValidDueDate, dueDate).label,
      enableSorting: false,
      cell: ({ row }) =>
        renderStatusChip(getTimingStatusChip(row.original, hasValidDueDate, dueDate)),
      meta: {
        priority: 1,
        filterVariant: 'multiselect',
        filterLabel: 'Status',
        filterOptions: [
          { label: 'On time', value: 'On time' },
          { label: 'Late', value: 'Late' },
        ],
      },
    },
    {
      id: 'result',
      header: 'Result',
      accessorFn: (s) => getReviewStatusChip(s).label,
      enableSorting: false,
      cell: ({ row }) => renderStatusChip(getReviewStatusChip(row.original)),
      meta: {
        priority: 1,
        filterVariant: 'multiselect',
        filterLabel: 'Result',
        filterOptions: [
          { label: 'Pending', value: 'Pending' },
          { label: 'Processing', value: 'Processing' },
          { label: 'Failed', value: 'Failed' },
          { label: 'Correct', value: 'Correct' },
          { label: 'Incorrect', value: 'Incorrect' },
        ],
      },
    },
    {
      id: 'feedback',
      header: 'Feedback',
      enableSorting: false,
      cell: ({ row }) => {
        const feedback = row.original.feedback;
        // Withheld and empty are different things, and the dash alone says the wrong one: a
        // student would read it as the evaluator having had nothing to tell them.
        if (row.original.feedbackVisible === false)
          return <span className="text-muted-foreground text-xs">{FEEDBACK_WITHHELD_MESSAGE}</span>;
        if (!feedback)
          return (
            <span className="text-muted-foreground">
              <span aria-hidden="true">—</span>
              <span className="sr-only">No feedback</span>
            </span>
          );
        // TableCell bakes in whitespace-nowrap; override it here so long evaluator
        // output wraps (and keeps its own line breaks) inside a bounded width.
        return (
          <div className="max-w-[28rem] text-xs break-words whitespace-pre-wrap">
            {String(feedback)}
          </div>
        );
      },
      /*
       * Priority 1, not 2.
       * Priority 2 hides a column below 768px, and this table becomes cards below 640px, so
       * between those two widths the cell was removed from the page altogether with no card
       * to fall back on. A student in a half-width window lost the counterexample and the link
       * to their own submission, with nothing saying either existed. This table carries a
       * handful of attempts for one problem, so it has the room.
       */
      meta: { priority: 1 },
    },
    {
      id: 'file',
      header: 'File',
      enableSorting: false,
      cell: ({ row }) => {
        const submission = row.original;
        if (!submission.fileName)
          return (
            <span className="text-muted-foreground">
              <span aria-hidden="true">—</span>
              <span className="sr-only">No file</span>
            </span>
          );
        return (
          // The name previews; everything else lives in the row's menu.
          <button
            type="button"
            onClick={() => onViewSubmission(submission)}
            className={cn(TEXT_LINK_CLASS, 'break-all')}
            title={`Preview ${submission.originalFileName || 'submission'}`}
          >
            {submission.originalFileName || submission.fileName}
          </button>
        );
      },
      /*
       * Priority 1, not 2.
       * Priority 2 hides a column below 768px, and this table becomes cards below 640px, so
       * between those two widths the cell was removed from the page altogether with no card
       * to fall back on. A student in a half-width window lost the counterexample and the link
       * to their own submission, with nothing saying either existed. This table carries a
       * handful of attempts for one problem, so it has the room.
       */
      meta: { priority: 1 },
    },
    {
      id: 'actions',
      header: '',
      enableSorting: false,
      cell: ({ row }) => {
        const submission = row.original;
        if (!submission.fileName) return null;
        // A re-run while one is already queued or running would do nothing useful, so the
        // item is disabled rather than hidden: the action still reads as available in
        // general, just not right now.
        const pendingOrProcessing =
          submission.status?.toLowerCase() === 'pending' ||
          submission.status?.toLowerCase() === 'processing';
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Attempt actions">
                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onDownload(submission)}>
                <Download className="h-4 w-4" aria-hidden="true" />
                Download file
              </DropdownMenuItem>
              {isPrivilegedUser ? (
                <DropdownMenuItem
                  disabled={pendingOrProcessing}
                  onClick={() => onRerunSubmission?.(submission)}
                >
                  <RotateCcw className="h-4 w-4" aria-hidden="true" />
                  Rerun the autograder
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
      meta: { align: 'right' },
    },
  ];
}
