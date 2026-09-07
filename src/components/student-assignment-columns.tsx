'use client';

import { useState } from 'react';
import Link from 'next/link';
import { FileText } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';

import { RichDescription } from '@/components/rich-description/RichDescription';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CompactDate } from '@/components/ui/CompactDate';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatDateInTimeZone, formatTimeInTimeZone } from '@/lib/date-format';
import { TEXT_LINK_CLASS } from '@/lib/link-styles';
import { cn } from '@/lib/utils';
import type { AssignmentWithProblemCount } from '@/types/course';

/**
 * What the student's Assignments table says about where an assignment stands.
 *
 * Deliberately three values and not more. This is the one thing the old card list got
 * wrong: it painted every row the same unless the due date had passed, so an assignment
 * a student cannot open yet read as available. The dates here are already the ones this
 * student is held to (the API resolves their overrides before serializing), so no
 * override arithmetic happens in the table.
 */
export type StudentAssignmentStatus = 'Not open yet' | 'Overdue' | 'Open';

export function studentAssignmentStatus(
  assignment: AssignmentWithProblemCount,
  now: Date,
): StudentAssignmentStatus {
  if (assignment.locked) return 'Not open yet';
  const due = assignment.dueDate ? new Date(assignment.dueDate) : null;
  if (due && due.getTime() < now.getTime()) return 'Overdue';
  return 'Open';
}

const STATUS_VARIANT: Record<StudentAssignmentStatus, 'neutral' | 'danger' | 'info'> = {
  'Not open yet': 'neutral',
  Overdue: 'danger',
  // Info, not success: a future deadline is information, not something that has gone right.
  Open: 'info',
};

/** The late policy as one phrase, the way the card's meta line put it. */
function latePolicyText(
  assignment: AssignmentWithProblemCount,
  timeZone: string,
  hour12: boolean,
): string {
  if (!assignment.allowLateSubmissions) return 'Not accepted';
  if (!assignment.lateCutoff) return 'Accepted';
  const cutoff = new Date(assignment.lateCutoff);
  return `Until ${formatDateInTimeZone(cutoff, timeZone)} at ${formatTimeInTimeZone(cutoff, timeZone, hour12)}`;
}

/**
 * The description as its own column: one button that opens the full text in a dialog.
 *
 * A column rather than a line under the title. Descriptions here run to paragraphs, and
 * clamping them into the title cell made every row a different height while still showing
 * too little to be useful. Self-contained so each row owns its dialog state instead of the
 * column model threading it through the table.
 *
 * Nothing renders when there is no description, which is also the locked case: the API
 * masks an assignment's prompt until the student's own unlock time.
 */
function AssignmentDescriptionCell({ assignment }: { assignment: AssignmentWithProblemCount }) {
  const [open, setOpen] = useState(false);
  // Either form counts: a rich-only assignment still has something to show.
  const hasDescription = Boolean(assignment.description) || Boolean(assignment.descriptionJson);
  if (!hasDescription) return <span className="text-muted-foreground">—</span>;

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={`Read the description for ${assignment.title}`}
        title="Read description"
      >
        <FileText className="size-4" aria-hidden="true" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assignment Description</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {assignment.title}
            </DialogDescription>
          </DialogHeader>
          {/* Focusable so a long description can be scrolled without a mouse. */}
          <div
            className="max-h-[60vh] overflow-y-auto rounded-md border p-3 text-sm"
            tabIndex={0}
            role="group"
            aria-label="Description"
          >
            <RichDescription
              // The dialog title is an h2, so the description starts one level below it.
              headingBaseLevel={3}
              description={assignment.description}
              descriptionJson={assignment.descriptionJson}
              compact
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Columns for the student's Assignments table.
 *
 * Separate from `useAssignmentColumns` on purpose rather than a flag on it: every column
 * that file adds beyond these (the publish switch, the delete menu, the per-student
 * override popovers, the lazy max-points fetch) is a staff surface, and a student's rows
 * already arrive with `maxPoints` and `problemCount` filled in.
 *
 * Every header is a plain string. The stacked mobile card view uses the header as each
 * field's label and can only read a string, so a function header labels the field with
 * the column id instead.
 */
export function useStudentAssignmentColumns(
  timeZone: string,
  hour12 = true,
): ColumnDef<AssignmentWithProblemCount>[] {
  // One clock for the whole render, so two rows never land either side of the same second.
  const now = new Date();

  return [
    {
      accessorKey: 'title',
      header: 'Title',
      cell: ({ row }) => (
        <Link
          href={`/dashboard/courses/${row.original.courseId}/${row.original.id}`}
          // Roomier than the staff table's cap: six columns instead of ten leave the title
          // space, and a title is the thing a student is scanning for.
          className={cn(
            TEXT_LINK_CLASS,
            'block max-w-[12rem] truncate sm:max-w-[18rem] lg:max-w-[24rem]',
          )}
          title={row.original.title}
        >
          {row.original.title}
        </Link>
      ),
    },
    {
      id: 'description',
      header: 'Description',
      enableSorting: false,
      cell: ({ row }) => <AssignmentDescriptionCell assignment={row.original} />,
      meta: { nowrap: true },
    },
    {
      id: 'status',
      header: 'Status',
      accessorFn: (row) => studentAssignmentStatus(row, now),
      cell: ({ row }) => {
        const status = studentAssignmentStatus(row.original, now);
        return <Badge variant={STATUS_VARIANT[status]}>{status}</Badge>;
      },
      meta: { nowrap: true },
    },
    {
      id: 'type',
      header: 'Type',
      // Derived server-side from the group set link; there is no stored flag.
      accessorFn: (row) => (row.isGroup ? 'Group' : 'Individual'),
      cell: ({ row }) => <div>{row.original.isGroup ? 'Group' : 'Individual'}</div>,
      meta: { nowrap: true },
    },
    {
      accessorKey: 'dueDate',
      header: 'Due',
      cell: ({ row }) => (
        <CompactDate value={row.original.dueDate} timeZone={timeZone} hour12={hour12} />
      ),
      meta: { nowrap: true },
    },
    {
      accessorKey: 'problemCount',
      header: 'Problems',
      cell: ({ row }) => <div>{row.original.problemCount ?? 0}</div>,
      meta: { priority: 2, nowrap: true },
    },
    {
      accessorKey: 'maxPoints',
      header: 'Points',
      cell: ({ row }) => <div>{row.original.maxPoints ?? 0}</div>,
      meta: { priority: 2, nowrap: true },
    },
    {
      id: 'latePolicy',
      header: 'Late work',
      accessorFn: (row) => latePolicyText(row, timeZone, hour12),
      cell: ({ row }) => <div>{latePolicyText(row.original, timeZone, hour12)}</div>,
      meta: { priority: 3 },
    },
  ];
}
