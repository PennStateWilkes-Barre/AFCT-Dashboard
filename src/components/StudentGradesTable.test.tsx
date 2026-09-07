/** @vitest-environment jsdom */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import {
  StudentGradesTable,
  assignmentStatusLabel,
  formatPercent,
  formatScore,
  problemStatusLabel,
} from './StudentGradesTable';

// Render with a fresh QueryClient per test (retry off, no lingering cache) so the
// grades query starts clean each time.
const renderWithClient = (ui: React.ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
};

vi.mock('@/hooks/use-effective-timezone', () => ({
  useEffectiveTimezone: () => ({ timezone: 'UTC' }),
}));

const problem = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  title: 'DFA Design',
  maxPoints: 5,
  maxSubmissions: 3,
  submissionCount: 1,
  grade: 4,
  status: 'COMPLETED',
  autograderEnabled: true,
  ...over,
});

const gradesResponse = {
  assignments: [
    {
      id: 'a1',
      title: 'Regular Languages',
      description: null,
      dueDate: '2027-09-04T12:00:00Z',
      isGroup: false,
      maxPoints: 10,
      grade: 8,
      problems: [
        problem({ id: 'p1', title: 'DFA Design', maxPoints: 5, grade: 4 }),
        problem({ id: 'p2', title: 'NFA Design', maxPoints: 5, grade: 4 }),
      ],
    },
  ],
};

const mockFetch = (value: unknown, ok = true) =>
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok, json: async () => value });

/** The assignment's own row, which is the first row of its group. */
const assignmentRow = (title: string) => screen.getByRole('link', { name: title }).closest('tr')!;

describe('StudentGradesTable derivations', () => {
  it('derives the assignment status from how many of its problems are graded', () => {
    expect(assignmentStatusLabel([problem({ grade: 5 }), problem({ grade: 3 })])).toBe('Graded');
    expect(assignmentStatusLabel([problem({ grade: 5 }), problem({ grade: null })])).toBe(
      'Partially graded',
    );
    expect(assignmentStatusLabel([problem({ grade: null })])).toBe('Not graded');
    expect(assignmentStatusLabel([])).toBe('Not graded');
  });

  it('keeps the problem status in a student vocabulary', () => {
    expect(problemStatusLabel(problem({ grade: 4 }))).toBe('Graded');
    expect(problemStatusLabel(problem({ grade: null, status: 'PROCESSING' }))).toBe('Evaluating');
    expect(problemStatusLabel(problem({ grade: null, status: 'COMPLETED' }))).toBe('Processed');
    expect(problemStatusLabel(problem({ grade: null, status: 'FAILED' }))).toBe('Processed');
    expect(problemStatusLabel(problem({ grade: null, status: 'PENDING' }))).toBe('Not graded');
    // A derived zero is a grade, so it would read as "Graded" without its own branch.
    expect(problemStatusLabel(problem({ grade: 0, missing: true }))).toBe('Not submitted');
    // Nothing handed in is a different fact from nothing marked, and it is the one the
    // student guide already words this way.
    expect(problemStatusLabel(problem({ grade: null, status: '', submissionCount: 0 }))).toBe(
      'Not submitted',
    );
  });

  it('spaces the score and blanks a missing one', () => {
    expect(formatScore(35, 50)).toBe('35 / 50');
    expect(formatScore(null, 60)).toBe('— / 60');
  });

  it('rounds the percentage and refuses to divide by zero points', () => {
    expect(formatPercent(35, 50)).toBe('70%');
    expect(formatPercent(1, 3)).toBe('33%');
    expect(formatPercent(null, 60)).toBe('—');
    expect(formatPercent(0, 0)).toBe('—');
  });
});

describe('StudentGradesTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    // The expanded state persists per course, so one test's expansion would otherwise
    // decide the next test's opening state.
    localStorage.clear();
  });

  it('fetches the student grades on mount and renders an assignment row', async () => {
    mockFetch(gradesResponse);

    renderWithClient(<StudentGradesTable courseId="c1" />);

    await waitFor(() => expect(screen.getByText('Regular Languages')).toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledWith('/api/courses/c1/student-grades');

    const row = assignmentRow('Regular Languages');
    expect(within(row).getAllByText('8 / 10').length).toBeGreaterThan(0);
    expect(within(row).getAllByText('80%').length).toBeGreaterThan(0);
    expect(within(row).getAllByText('Graded').length).toBeGreaterThan(0);
  });

  it('names the assignment type and shows the due time beside the date', async () => {
    mockFetch({
      assignments: [
        {
          ...gradesResponse.assignments[0],
          id: 'a4',
          title: 'Group Lab',
          isGroup: true,
          dueDate: '2027-09-18T15:30:00Z',
        },
      ],
    });

    renderWithClient(<StudentGradesTable courseId="c1" />);
    await waitFor(() => expect(screen.getByText('Group Lab')).toBeInTheDocument());

    const row = assignmentRow('Group Lab');
    expect(within(row).getAllByText('Group').length).toBeGreaterThan(0);
    // The date and the time together: "due Friday" and "due Friday at 3:30 PM" answer
    // different questions for someone deciding whether to hand in tonight.
    expect(within(row).getAllByText('09/18/27 03:30 PM').length).toBeGreaterThan(0);
  });

  it('links the assignment title to the assignment page', async () => {
    mockFetch(gradesResponse);

    renderWithClient(<StudentGradesTable courseId="c1" />);

    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Regular Languages' })).toHaveAttribute(
        'href',
        '/dashboard/courses/c1/a1',
      ),
    );
  });

  it('reveals the problems on expand and hides them again on collapse', async () => {
    const user = userEvent.setup();
    mockFetch(gradesResponse);

    renderWithClient(<StudentGradesTable courseId="c1" />);
    await waitFor(() => expect(screen.getByText('Regular Languages')).toBeInTheDocument());

    expect(screen.queryByText('Problem 1: DFA Design')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Expand Regular Languages problems' }));
    expect(screen.getByText('Problem 1: DFA Design')).toBeInTheDocument();
    expect(screen.getByText('Problem 2: NFA Design')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Collapse Regular Languages problems' }));
    expect(screen.queryByText('Problem 1: DFA Design')).not.toBeInTheDocument();
  });

  it('marks the expand control with aria-expanded', async () => {
    const user = userEvent.setup();
    mockFetch(gradesResponse);

    renderWithClient(<StudentGradesTable courseId="c1" />);
    await waitFor(() => expect(screen.getByText('Regular Languages')).toBeInTheDocument());

    const toggle = screen.getByRole('button', { name: 'Expand Regular Languages problems' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(
      screen.getByRole('button', { name: 'Collapse Regular Languages problems' }),
    ).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens a problem through its own link, and scores it out of its own points', async () => {
    const user = userEvent.setup();
    mockFetch(gradesResponse);

    renderWithClient(<StudentGradesTable courseId="c1" />);
    await waitFor(() => expect(screen.getByText('Regular Languages')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Expand Regular Languages problems' }));

    const link = screen.getByRole('link', { name: 'Problem 1: DFA Design' });
    expect(link).toHaveAttribute('href', '/dashboard/courses/c1/a1?problem=p1');

    const row = link.closest('tr')!;
    expect(within(row).getAllByText('4 / 5').length).toBeGreaterThan(0);
    expect(within(row).getAllByText('80%').length).toBeGreaterThan(0);
  });

  it('blanks the score and percentage of an ungraded assignment', async () => {
    mockFetch({
      assignments: [
        {
          id: 'a2',
          title: 'Real Life Examples',
          description: null,
          dueDate: null,
          maxPoints: 60,
          grade: null,
          problems: [problem({ id: 'p9', grade: null, maxPoints: 60, status: 'PENDING' })],
        },
      ],
    });

    renderWithClient(<StudentGradesTable courseId="c1" />);
    await waitFor(() => expect(screen.getByText('Real Life Examples')).toBeInTheDocument());

    const row = assignmentRow('Real Life Examples');
    expect(within(row).getAllByText('— / 60').length).toBeGreaterThan(0);
    expect(within(row).getAllByText('—').length).toBeGreaterThan(0);
    expect(within(row).getAllByText('Not graded').length).toBeGreaterThan(0);
  });

  it('calls an assignment with some problems marked partially graded', async () => {
    mockFetch({
      assignments: [
        {
          id: 'a3',
          title: 'State Machines',
          description: null,
          dueDate: '2027-09-18T12:00:00Z',
          maxPoints: 50,
          grade: 35,
          problems: [
            problem({ id: 'p1', title: 'DFA Design', maxPoints: 20, grade: 20 }),
            problem({ id: 'p2', title: 'NFA Design', maxPoints: 20, grade: 15 }),
            problem({
              id: 'p3',
              title: 'Conversion',
              maxPoints: 10,
              grade: null,
              status: 'PENDING',
            }),
          ],
        },
      ],
    });

    renderWithClient(<StudentGradesTable courseId="c1" />);
    await waitFor(() => expect(screen.getByText('State Machines')).toBeInTheDocument());

    const row = assignmentRow('State Machines');
    expect(within(row).getAllByText('Partially graded').length).toBeGreaterThan(0);
    expect(within(row).getAllByText('35 / 50').length).toBeGreaterThan(0);
    expect(within(row).getAllByText('70%').length).toBeGreaterThan(0);
  });

  it('remembers which assignments were open, per course, across a remount', async () => {
    const user = userEvent.setup();
    mockFetch(gradesResponse);

    const first = renderWithClient(<StudentGradesTable courseId="c1" />);
    await waitFor(() => expect(screen.getByText('Regular Languages')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Expand Regular Languages problems' }));
    expect(screen.getByText('Problem 1: DFA Design')).toBeInTheDocument();

    // A remount is what a refresh looks like to the component: fresh state, same storage.
    first.unmount();
    renderWithClient(<StudentGradesTable courseId="c1" />);
    await waitFor(() => expect(screen.getByText('Problem 1: DFA Design')).toBeInTheDocument());
    expect(
      screen.getByRole('button', { name: 'Collapse Regular Languages problems' }),
    ).toBeInTheDocument();
  });

  it("does not carry one course's open assignments into another", async () => {
    const user = userEvent.setup();
    mockFetch(gradesResponse);

    const first = renderWithClient(<StudentGradesTable courseId="c1" />);
    await waitFor(() => expect(screen.getByText('Regular Languages')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Expand Regular Languages problems' }));
    first.unmount();

    renderWithClient(<StudentGradesTable courseId="c2" />);
    await waitFor(() => expect(screen.getByText('Regular Languages')).toBeInTheDocument());
    expect(screen.queryByText('Problem 1: DFA Design')).not.toBeInTheDocument();
  });

  it('opens collapsed when the stored value is not a list of ids', async () => {
    localStorage.setItem('student-grades-expanded-c1', '{"nope":true}');
    mockFetch(gradesResponse);

    renderWithClient(<StudentGradesTable courseId="c1" />);
    await waitFor(() => expect(screen.getByText('Regular Languages')).toBeInTheDocument());

    expect(screen.queryByText('Problem 1: DFA Design')).not.toBeInTheDocument();
  });

  /**
   * A zero for work never handed in and a zero somebody marked are the same number, and the
   * whole point of the missing-work design is that a student can tell them apart. The
   * assignment page already says so; the grades page called it "Graded".
   */
  it('says Not submitted rather than Graded for a zero nobody marked', async () => {
    mockFetch({
      assignments: [
        {
          id: 'a5',
          title: 'Missed Lab',
          description: null,
          dueDate: '2027-01-01T12:00:00Z',
          isGroup: false,
          maxPoints: 10,
          grade: 0,
          problems: [problem({ id: 'p1', title: 'DFA', maxPoints: 10, grade: 0, missing: true })],
        },
      ],
    });

    renderWithClient(<StudentGradesTable courseId="c1" />);
    await waitFor(() => expect(screen.getByText('Missed Lab')).toBeInTheDocument());
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Expand Missed Lab problems' }));

    const row = screen.getByRole('link', { name: 'Problem 1: DFA' }).closest('tr')!;
    expect(within(row).getAllByText('Not submitted').length).toBeGreaterThan(0);
    expect(within(row).queryByText('Graded')).not.toBeInTheDocument();
  });

  /**
   * A locked assignment carries no problems, so summing them reported it as worth 0 points and
   * left a chevron that opened onto nothing.
   */
  describe('an assignment that has not opened yet', () => {
    const locked = {
      assignments: [
        {
          id: 'a6',
          title: 'Future Lab',
          description: null,
          dueDate: '2099-01-01T12:00:00Z',
          isGroup: false,
          locked: true,
          maxPoints: 60,
          grade: null,
          problems: [],
        },
      ],
    };

    it('keeps the points it is really worth', async () => {
      mockFetch(locked);
      renderWithClient(<StudentGradesTable courseId="c1" />);
      await waitFor(() => expect(screen.getByText('Future Lab')).toBeInTheDocument());

      const row = assignmentRow('Future Lab');
      expect(within(row).getAllByText('— / 60').length).toBeGreaterThan(0);
      expect(within(row).queryByText('— / 0')).not.toBeInTheDocument();
    });

    it('says it is not open rather than not graded', async () => {
      mockFetch(locked);
      renderWithClient(<StudentGradesTable courseId="c1" />);
      await waitFor(() => expect(screen.getByText('Future Lab')).toBeInTheDocument());

      expect(
        within(assignmentRow('Future Lab')).getAllByText('Not open yet').length,
      ).toBeGreaterThan(0);
    });

    it('offers no expander, because there is nothing behind it', async () => {
      mockFetch(locked);
      renderWithClient(<StudentGradesTable courseId="c1" />);
      await waitFor(() => expect(screen.getByText('Future Lab')).toBeInTheDocument());

      expect(screen.queryByRole('button', { name: /Future Lab problems/ })).not.toBeInTheDocument();
    });
  });

  it('shows a loading state while the query is pending', () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

    renderWithClient(<StudentGradesTable courseId="c1" />);

    // The shared spinner announces through a live region, so this checks the thing a screen
    // reader is actually given rather than the bare string.
    expect(screen.getByRole('status')).toHaveTextContent('Loading grades');
  });

  it('surfaces an error message when the fetch fails', async () => {
    mockFetch({ error: 'Nope' }, false);

    renderWithClient(<StudentGradesTable courseId="c1" />);

    await waitFor(() => expect(screen.getByText('Nope')).toBeInTheDocument());
  });

  it('keeps the empty state when there is nothing to grade', async () => {
    mockFetch({ assignments: [] });

    renderWithClient(<StudentGradesTable courseId="c1" />);

    await waitFor(() =>
      expect(screen.getByText('No graded assignments available yet.')).toBeInTheDocument(),
    );
  });
});
