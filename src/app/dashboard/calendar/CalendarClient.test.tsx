/** @vitest-environment jsdom */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CalendarClient from './CalendarClient';

// Render with a fresh QueryClient per test (retry off, no lingering cache) so the
// assignment-range query starts clean each time.
const renderWithClient = (ui: React.ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
};

vi.mock('@/hooks/use-effective-timezone', () => ({
  useEffectiveTimezone: () => ({ timezone: 'UTC' }),
}));

vi.mock('@/components/ui/calendar', () => ({
  Calendar: ({ onMonthChange, month }: { onMonthChange?: (date: Date) => void; month: Date }) => (
    <div>
      <button
        type="button"
        onClick={() => onMonthChange?.(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
      >
        Mock Month Change
      </button>
    </div>
  ),
}));

vi.mock('@/components/dialogs/DayAssignmentsDialog', () => ({
  default: () => null,
}));

vi.mock('@/components/modules/DueDateModule', () => ({
  DueDateModule: ({ assignments }: { assignments: unknown[] }) => (
    <div data-testid="due-date-count">{assignments.length}</div>
  ),
}));

const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
const fetchMock = () => global.fetch as ReturnType<typeof vi.fn>;
// Calls the component made to the assignment-range endpoint (there's now also a
// courses fetch on mount, so total call count is no longer a clean signal).
const assignmentCalls = () =>
  fetchMock().mock.calls.filter((c) => String(c[0]).startsWith('/api/me/assignments'));

// Four courses, because the bulk controls only appear once the list is long enough to
// make them worth finding.
const fourCourses = ['c1', 'c2', 'c3', 'c4'].map((id, i) => ({
  id,
  code: `CS10${i + 1}`,
  semester: 'Spring 2026',
  isArchived: false,
}));

const fourCourseAssignments = fourCourses.map((c, i) => ({
  id: `a${i + 1}`,
  title: `A${i + 1}`,
  courseId: c.id,
  dueDate: new Date(`2026-03-1${i}T12:00:00.000Z`),
  course: { id: c.id, code: c.code, name: c.code },
}));

describe('CalendarClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    // Default: every endpoint returns an empty list. Tests override the assignment
    // behaviour where they need pending/error states.
    vi.stubGlobal('fetch', vi.fn(() => okJson([])).mockName('fetch') as unknown as typeof fetch);
  });

  it('fetches assignment range once on initial mount', async () => {
    renderWithClient(<CalendarClient />);

    await waitFor(() => {
      expect(assignmentCalls()).toHaveLength(1);
      expect(assignmentCalls()[0][0]).toBe('/api/me/assignments');
    });
  });

  it('uses server-initial assignments without fetching the range', async () => {
    const initialAssignments = [
      {
        id: 'a1',
        title: 'Assignment 1',
        courseId: 'c1',
        dueDate: new Date('2026-03-10T12:00:00.000Z'),
        course: { id: 'c1', code: 'CS101', name: 'Course 1' },
      },
    ];

    renderWithClient(
      <CalendarClient
        initialAssignments={initialAssignments}
        initialMonth={new Date('2026-03-01T00:00:00.000Z').toISOString()}
      />,
    );

    // The range query is seeded, so only the courses fetch (if any) fires.
    expect(assignmentCalls()).toHaveLength(0);
    expect(screen.getByTestId('due-date-count')).toHaveTextContent('1');
  });

  it('fetches one additional time when navigating months', async () => {
    renderWithClient(<CalendarClient />);

    await waitFor(() => expect(assignmentCalls()).toHaveLength(1));

    fireEvent.click(screen.getByLabelText('Next month'));

    await waitFor(() => expect(assignmentCalls()).toHaveLength(2));
  });

  it('shows error state and retries successfully', async () => {
    let failNextAssignments = true;
    fetchMock().mockImplementation((url: string) => {
      if (String(url).startsWith('/api/me/courses')) return okJson([]);
      if (failNextAssignments) {
        failNextAssignments = false;
        return Promise.reject(new Error('network error'));
      }
      return okJson([]);
    });

    renderWithClient(<CalendarClient />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Failed to load calendar assignments. Please try again.',
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(assignmentCalls().length).toBeGreaterThanOrEqual(2);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  it('announces the month and the outcome from one live region', async () => {
    renderWithClient(
      <CalendarClient
        initialAssignments={[
          {
            id: 'a1',
            title: 'A1',
            courseId: 'c1',
            dueDate: new Date('2026-03-10T12:00:00.000Z'),
            course: { id: 'c1', code: 'CS101', name: 'One' },
          },
        ]}
        initialMonth={new Date('2026-03-01T00:00:00.000Z').toISOString()}
      />,
    );

    // Exactly one: the month label used to be a second polite region, so a month change
    // queued two announcements and the end of the fetch was never announced at all.
    const live = document.querySelectorAll('[aria-live]');
    expect(live).toHaveLength(1);
    expect(live[0]).toHaveAttribute('role', 'status');
    // The message carries both facts, and ends with a count so "done" is audible.
    expect(live[0]).toHaveTextContent('March 2026. 1 assignment.');
  });

  it('shows loading message while request is in flight', async () => {
    let resolveAssignments: ((value: unknown) => void) | null = null;
    fetchMock().mockImplementation((url: string) => {
      if (String(url).startsWith('/api/me/courses')) return okJson([]);
      return new Promise((resolve) => {
        resolveAssignments = () => resolve({ ok: true, json: async () => [] });
      });
    });

    renderWithClient(<CalendarClient />);

    expect(screen.getByText('Loading assignments...')).toBeInTheDocument();

    (resolveAssignments as ((value: unknown) => void) | null)?.(null);

    await waitFor(() => {
      expect(screen.queryByText('Loading assignments...')).not.toBeInTheDocument();
    });
  });

  it('hides a course when its box is unchecked', async () => {
    const initialAssignments = [
      {
        id: 'a1',
        title: 'A1',
        courseId: 'c1',
        dueDate: new Date('2026-03-10T12:00:00.000Z'),
        course: { id: 'c1', code: 'CS101', name: 'One' },
      },
      {
        id: 'a2',
        title: 'A2',
        courseId: 'c2',
        dueDate: new Date('2026-03-12T12:00:00.000Z'),
        course: { id: 'c2', code: 'CS102', name: 'Two' },
      },
    ];
    fetchMock().mockImplementation((url: string) => {
      if (String(url).startsWith('/api/me/courses')) {
        return okJson([
          { id: 'c1', code: 'CS101', semester: 'Spring 2026', isArchived: false },
          { id: 'c2', code: 'CS102', semester: 'Spring 2026', isArchived: false },
        ]);
      }
      return okJson([]);
    });

    renderWithClient(
      <CalendarClient
        initialAssignments={initialAssignments}
        initialMonth={new Date('2026-03-01T00:00:00.000Z').toISOString()}
      />,
    );

    // Both assignments show, and both course boxes render, checked by default.
    expect(screen.getByTestId('due-date-count')).toHaveTextContent('2');
    const cs102 = await screen.findByRole('checkbox', { name: /Show assignments for CS102/ });
    expect(cs102).toBeChecked();

    // Uncheck CS102 -> only the CS101 assignment remains.
    fireEvent.click(cs102);
    await waitFor(() => expect(screen.getByTestId('due-date-count')).toHaveTextContent('1'));
  });

  it('goes back to the current month with Today', async () => {
    renderWithClient(<CalendarClient />);
    await waitFor(() => expect(assignmentCalls()).toHaveLength(1));

    fireEvent.click(screen.getByLabelText('Next month'));
    await waitFor(() => expect(assignmentCalls()).toHaveLength(2));

    const thisMonth = new Intl.DateTimeFormat('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date());

    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    await waitFor(() => expect(screen.getByText(thisMonth)).toBeInTheDocument());
  });

  it('hides and shows every listed course with the bulk controls', async () => {
    fetchMock().mockImplementation((url: string) => {
      if (String(url).startsWith('/api/me/courses')) return okJson(fourCourses);
      return okJson([]);
    });

    renderWithClient(
      <CalendarClient
        initialAssignments={fourCourseAssignments}
        initialMonth={new Date('2026-03-01T00:00:00.000Z').toISOString()}
      />,
    );

    expect(screen.getByTestId('due-date-count')).toHaveTextContent('4');
    const hideAll = await screen.findByRole('button', { name: 'Hide all' });

    fireEvent.click(hideAll);
    await waitFor(() => expect(screen.getByTestId('due-date-count')).toHaveTextContent('0'));
    // Every box follows, and the control that would now do nothing is disabled.
    screen
      .getAllByRole('checkbox', { name: /Show assignments for/ })
      .forEach((box) => expect(box).not.toBeChecked());
    expect(hideAll).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    await waitFor(() => expect(screen.getByTestId('due-date-count')).toHaveTextContent('4'));
  });

  it('persists a bulk hide through the same storage the checkboxes use', async () => {
    fetchMock().mockImplementation((url: string) => {
      if (String(url).startsWith('/api/me/courses')) return okJson(fourCourses);
      return okJson([]);
    });
    const props = {
      initialAssignments: fourCourseAssignments,
      initialMonth: new Date('2026-03-01T00:00:00.000Z').toISOString(),
    };

    const { unmount } = renderWithClient(<CalendarClient {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hide all' }));
    await waitFor(() => expect(screen.getByTestId('due-date-count')).toHaveTextContent('0'));
    unmount();

    renderWithClient(<CalendarClient {...props} />);
    await waitFor(() => expect(screen.getByTestId('due-date-count')).toHaveTextContent('0'));
  });

  it('lists only courses whose term overlaps the month on screen', async () => {
    fetchMock().mockImplementation((url: string) => {
      if (String(url).startsWith('/api/me/courses')) {
        return okJson([
          {
            id: 'c1',
            code: 'CS101',
            semester: 'Spring 2026',
            isArchived: false,
            startDate: '2026-01-12T00:00:00.000Z',
            endDate: '2026-05-01T00:00:00.000Z',
          },
          {
            id: 'c2',
            code: 'CS102',
            semester: 'Fall 2026',
            isArchived: false,
            startDate: '2026-08-24T00:00:00.000Z',
            endDate: '2026-12-18T00:00:00.000Z',
          },
          // No dates at all: open-ended, so it is never hidden on this basis.
          { id: 'c3', code: 'CS103', semester: 'Rolling', isArchived: false },
        ]);
      }
      return okJson([]);
    });

    renderWithClient(
      <CalendarClient initialMonth={new Date('2026-03-01T00:00:00.000Z').toISOString()} />,
    );

    await screen.findByRole('checkbox', { name: /Show assignments for CS101/ });
    expect(
      screen.getByRole('checkbox', { name: /Show assignments for CS103/ }),
    ).toBeInTheDocument();
    // The Fall course has no business in a March list.
    expect(
      screen.queryByRole('checkbox', { name: /Show assignments for CS102/ }),
    ).not.toBeInTheDocument();
  });

  it('keeps a course listed when it owns an assignment in the month, whatever its term says', async () => {
    fetchMock().mockImplementation((url: string) => {
      if (String(url).startsWith('/api/me/courses')) {
        return okJson([
          {
            id: 'c1',
            code: 'CS101',
            semester: 'Spring 2026',
            isArchived: false,
            startDate: '2026-01-12T00:00:00.000Z',
            endDate: '2026-05-01T00:00:00.000Z',
          },
          {
            id: 'c2',
            code: 'CS102',
            semester: 'Fall 2025',
            isArchived: false,
            startDate: '2025-08-24T00:00:00.000Z',
            endDate: '2025-12-18T00:00:00.000Z',
          },
        ]);
      }
      return okJson([]);
    });

    renderWithClient(
      <CalendarClient
        initialAssignments={[
          {
            id: 'a1',
            title: 'Late deadline',
            courseId: 'c2',
            dueDate: new Date('2026-03-10T12:00:00.000Z'),
            course: { id: 'c2', code: 'CS102', name: 'Two' },
          },
        ]}
        initialMonth={new Date('2026-03-01T00:00:00.000Z').toISOString()}
      />,
    );

    // Its term ended in December, but you can see its chip, so you must be able to filter it.
    expect(
      await screen.findByRole('checkbox', { name: /Show assignments for CS102/ }),
    ).toBeInTheDocument();
  });

  it('remembers unchecked courses across remounts', async () => {
    const initialAssignments = [
      {
        id: 'a1',
        title: 'A1',
        courseId: 'c1',
        dueDate: new Date('2026-03-10T12:00:00.000Z'),
        course: { id: 'c1', code: 'CS101', name: 'One' },
      },
      {
        id: 'a2',
        title: 'A2',
        courseId: 'c2',
        dueDate: new Date('2026-03-12T12:00:00.000Z'),
        course: { id: 'c2', code: 'CS102', name: 'Two' },
      },
    ];
    fetchMock().mockImplementation((url: string) => {
      if (String(url).startsWith('/api/me/courses')) {
        return okJson([
          { id: 'c1', code: 'CS101', semester: 'Spring 2026', isArchived: false },
          { id: 'c2', code: 'CS102', semester: 'Spring 2026', isArchived: false },
        ]);
      }
      return okJson([]);
    });
    const props = {
      initialAssignments,
      initialMonth: new Date('2026-03-01T00:00:00.000Z').toISOString(),
    };

    const { unmount } = renderWithClient(<CalendarClient {...props} />);
    const cs102 = await screen.findByRole('checkbox', { name: /Show assignments for CS102/ });
    fireEvent.click(cs102);
    await waitFor(() => expect(screen.getByTestId('due-date-count')).toHaveTextContent('1'));
    unmount();

    // A fresh mount restores the saved choice: CS102 stays hidden.
    renderWithClient(<CalendarClient {...props} />);
    const cs102Again = await screen.findByRole('checkbox', { name: /Show assignments for CS102/ });
    expect(cs102Again).not.toBeChecked();
    expect(screen.getByTestId('due-date-count')).toHaveTextContent('1');
  });
});

/**
 * The calendar's course filter and the sidebar read the same endpoint, so they have to read
 * it under the same key.
 *
 * This one hand-wrote `['me','courses','nav']` while the sidebar used the factory's
 * `['courses','nav']`. Two entries for one answer, which cost a duplicate fetch and, worse,
 * put the calendar's copy outside every `invalidateQueries(['courses'])` the app fires after
 * a publish, archive or duplicate. The list of courses to filter by silently kept the old
 * answer. Asserted behaviourally, through an invalidation, rather than by comparing the key
 * to the factory, which would pass just as happily if both were wrong.
 */
describe('the calendar course filter shares the sidebar cache', () => {
  const navCalls = () =>
    fetchMock().mock.calls.filter((c) => String(c[0]).includes('view=nav'));

  it('refetches its course list when courses are invalidated', async () => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(() => okJson([])).mockName('fetch') as unknown as typeof fetch);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={client}>
        <CalendarClient />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(navCalls()).toHaveLength(1));

    // What CoursesClient, CourseClient, ArchivedCoursesClient and course-handlers all fire
    // after a course changes.
    await client.invalidateQueries({ queryKey: ['courses'] });

    await waitFor(() => expect(navCalls()).toHaveLength(2));
  });
});
