/** @vitest-environment jsdom */

import React from 'react';
import { render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AccessorFnColumnDef } from '@tanstack/react-table';

import { studentAssignmentStatus, useStudentAssignmentColumns } from './student-assignment-columns';
import type { AssignmentWithProblemCount } from '@/types/course';

// Fixed points either side of the real clock, so the hook's own `new Date()` lands
// between them without the test having to fake time (fake timers deadlock userEvent).
const NOW = new Date('2027-03-10T12:00:00Z');
const LONG_PAST = new Date('2000-01-01T00:00:00Z');
const FAR_FUTURE = new Date('2099-01-01T00:00:00Z');

const assignment = (overrides: Partial<AssignmentWithProblemCount> = {}) =>
  ({
    id: 'a1',
    courseId: 'c1',
    title: 'Regular Expressions',
    description: null,
    dueDate: FAR_FUTURE,
    problemCount: 3,
    maxPoints: 30,
    allowLateSubmissions: false,
    lateCutoff: null,
    isPublished: true,
    ...overrides,
  }) as unknown as AssignmentWithProblemCount;

const columns = () => renderHook(() => useStudentAssignmentColumns('UTC', true)).result.current;

const cellFor = (id: string, row: AssignmentWithProblemCount) => {
  const col = columns().find(
    (c) => c.id === id || (c as { accessorKey?: string }).accessorKey === id,
  );
  if (!col?.cell || typeof col.cell !== 'function') throw new Error(`no cell for ${id}`);
  return (col.cell as (ctx: { row: { original: AssignmentWithProblemCount } }) => React.ReactNode)({
    row: { original: row },
  });
};

/** The value the table sorts and filters on, which is not always what the cell draws. */
const accessorFor = (id: string, row: AssignmentWithProblemCount) => {
  const col = columns().find((c) => c.id === id) as
    AccessorFnColumnDef<AssignmentWithProblemCount> | undefined;
  if (!col?.accessorFn) throw new Error(`no accessor for ${id}`);
  return col.accessorFn(row, 0);
};

describe('studentAssignmentStatus', () => {
  it('reports a locked assignment as not open yet, even once its due date has passed', () => {
    const row = assignment({ locked: true, dueDate: LONG_PAST });
    expect(studentAssignmentStatus(row, NOW)).toBe('Not open yet');
  });

  it('reports a past due date as overdue', () => {
    expect(studentAssignmentStatus(assignment({ dueDate: LONG_PAST }), NOW)).toBe('Overdue');
  });

  it('reports a future due date as open', () => {
    expect(studentAssignmentStatus(assignment(), NOW)).toBe('Open');
  });
});

describe('useStudentAssignmentColumns', () => {
  it('links the title to the assignment', () => {
    render(<>{cellFor('title', assignment())}</>);

    expect(screen.getByRole('link', { name: 'Regular Expressions' })).toHaveAttribute(
      'href',
      '/dashboard/courses/c1/a1',
    );
  });

  it('opens the description in a dialog from its own column', async () => {
    const user = userEvent.setup();
    render(<>{cellFor('description', assignment({ description: 'Build a DFA' }))}</>);

    await user.click(
      screen.getByRole('button', { name: 'Read the description for Regular Expressions' }),
    );
    expect(await screen.findByText('Build a DFA')).toBeInTheDocument();
  });

  it('offers no description button when the assignment has none (which includes a locked one)', () => {
    render(<>{cellFor('description', assignment({ description: null, locked: true }))}</>);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('names the assignment type', () => {
    expect(accessorFor('type', assignment({ isGroup: true }))).toBe('Group');
    expect(accessorFor('type', assignment({ isGroup: false }))).toBe('Individual');
  });

  it('draws the status badge and exposes the same value for sorting and filtering', () => {
    render(<>{cellFor('status', assignment({ dueDate: LONG_PAST }))}</>);

    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(accessorFor('status', assignment())).toBe('Open');
  });

  it('spells out the late policy in all three cases', () => {
    expect(accessorFor('latePolicy', assignment({ allowLateSubmissions: false }))).toBe(
      'Not accepted',
    );
    expect(
      accessorFor('latePolicy', assignment({ allowLateSubmissions: true, lateCutoff: null })),
    ).toBe('Accepted');
    expect(
      accessorFor(
        'latePolicy',
        assignment({
          allowLateSubmissions: true,
          lateCutoff: new Date('2027-03-25T18:30:00Z'),
        }),
      ),
    ).toBe('Until 03/25/27 at 06:30 PM');
  });

  it('labels every column with a plain string, which the mobile card view needs', () => {
    for (const col of columns()) {
      expect(typeof col.header).toBe('string');
    }
  });
});
