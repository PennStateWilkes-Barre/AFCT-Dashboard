/** @vitest-environment jsdom */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { StudentAssignmentsTable } from './StudentAssignmentsTable';
import type { FullCourse } from '@/types/course';

vi.mock('@/hooks/use-effective-timezone', () => ({
  useEffectiveTimezone: () => ({ timezone: 'UTC', hour12: true }),
}));

// The real DataTable, not a stub: its empty state and its row rendering are most of what
// this change is, and a mocked table cannot see either.
const course = (assignments: unknown[]) => ({ id: 'c1', assignments }) as unknown as FullCourse;

const row = (over: Record<string, unknown>) => ({
  courseId: 'c1',
  description: null,
  problemCount: 2,
  maxPoints: 20,
  allowLateSubmissions: false,
  lateCutoff: null,
  isPublished: true,
  ...over,
});

describe('StudentAssignmentsTable', () => {
  it('renders one row per published assignment', () => {
    render(
      <StudentAssignmentsTable
        course={course([
          row({ id: 'a1', title: 'Finite Automata', dueDate: '2027-04-01T23:59:00Z' }),
          row({ id: 'a2', title: 'Pushdown Automata', dueDate: '2027-04-08T23:59:00Z' }),
        ])}
      />,
    );

    const table = screen.getByRole('table');
    expect(within(table).getByRole('link', { name: 'Finite Automata' })).toHaveAttribute(
      'href',
      '/dashboard/courses/c1/a1',
    );
    expect(within(table).getByRole('link', { name: 'Pushdown Automata' })).toBeInTheDocument();
  });

  it('leaves out assignments that are not published', () => {
    render(
      <StudentAssignmentsTable
        course={course([
          row({ id: 'a1', title: 'Visible', dueDate: '2027-04-01T23:59:00Z' }),
          row({ id: 'a2', title: 'Hidden', dueDate: '2027-04-08T23:59:00Z', isPublished: false }),
        ])}
      />,
    );

    expect(screen.getByRole('link', { name: 'Visible' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Hidden' })).not.toBeInTheDocument();
  });

  it('drops the toolbar: nothing here to search, filter, hide or export', () => {
    render(
      <StudentAssignmentsTable
        course={course([
          row({ id: 'a1', title: 'Finite Automata', dueDate: '2027-04-01T23:59:00Z' }),
        ])}
      />,
    );

    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Columns' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /export/i })).not.toBeInTheDocument();
  });

  it('starts at 20 rows a page, so a normal course fits on one', () => {
    render(
      <StudentAssignmentsTable
        course={course([
          row({ id: 'a1', title: 'Finite Automata', dueDate: '2027-04-01T23:59:00Z' }),
        ])}
      />,
    );

    expect(screen.getByRole('combobox', { name: 'Rows per page' })).toHaveTextContent('20');
  });

  it('shows the student empty state when the course has nothing published', () => {
    render(<StudentAssignmentsTable course={course([])} />);

    expect(screen.getByText('No assignments yet')).toBeInTheDocument();
    expect(
      screen.getByText('Your instructor has not published any assignments for this course.'),
    ).toBeInTheDocument();
  });
});
