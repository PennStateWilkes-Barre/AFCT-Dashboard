/** @vitest-environment jsdom */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentCourseView } from './StudentCourseView';
import type { FullCourse } from '@/types/course';

// The panels fetch and format on their own; this is about the page's shape.
vi.mock('@/components/StudentGradesTable', () => ({
  StudentGradesTable: () => <div data-testid="grades-panel" />,
}));
vi.mock('@/components/StudentAssignmentsTable', () => ({
  StudentAssignmentsTable: () => <div data-testid="assignments-panel" />,
}));
vi.mock('@/hooks/use-effective-timezone', () => ({
  useEffectiveTimezone: () => ({ timezone: 'UTC' }),
}));

// useIsDesktopNav reads matchMedia; jsdom has none, so it reports false (the strip) unless
// a test installs one. Both branches matter: only one tablist may exist at a time.
const setViewport = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: width >= Number(/(\d+)px/.exec(query)?.[1] ?? 0),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
};

const course = {
  id: 'c1',
  code: 'CMPEN 271',
  name: 'Introduction to Digital Systems',
  semester: 'Spring 2027',
  credits: 4,
  isArchived: false,
  isPublished: true,
  assignments: [
    { id: 'a1', title: 'One', isPublished: true },
    { id: 'a2', title: 'Two', isPublished: true },
    { id: 'a3', title: 'Draft', isPublished: false },
  ],
  staff: [],
} as unknown as FullCourse;

const renderView = (tab: 'assignments' | 'grades' = 'assignments') =>
  render(<StudentCourseView course={course} tab={tab} onTabChange={vi.fn()} />);

describe('StudentCourseView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setViewport(1440);
  });

  it('offers only the two sections a student may see', () => {
    renderView();
    const list = screen.getByRole('tablist', { name: 'Course sections' });
    expect(
      within(list)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Assignments2', 'Grades']);
  });

  it('counts only published assignments', () => {
    renderView();
    // Three assignments, one still a draft: a student is told about two.
    expect(screen.getByRole('tab', { name: 'Assignments, 2' })).toBeInTheDocument();
  });

  it('uses the shared collapsible rail on a wide screen', () => {
    renderView();
    // The rail's own header, which the strip does not have.
    expect(screen.getByText('Course Menu')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse course menu' })).toBeInTheDocument();
    // Exactly one tablist: the rail and the strip emit the same tab-* ids.
    expect(screen.getAllByRole('tablist', { name: 'Course sections' })).toHaveLength(1);
    expect(document.querySelectorAll('#tab-assignments')).toHaveLength(1);
  });

  it('falls back to the shared strip and its select below the rail breakpoint', () => {
    setViewport(800);
    renderView();
    // The select is the below-md control and only the strip branch renders one.
    expect(screen.getByRole('combobox', { name: 'Course sections' })).toBeInTheDocument();
    expect(screen.queryByText('Course Menu')).toBeNull();
    expect(screen.getAllByRole('tablist', { name: 'Course sections' })).toHaveLength(1);
  });

  it('renders the course header on the workspace, with one level-one heading', () => {
    renderView();
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent('CMPEN 271');
    expect(h1s[0]).toHaveTextContent('Introduction to Digital Systems');
  });

  it('names the faculty but keeps the registration code out of the student view', () => {
    renderView();
    // Who teaches the course is for everyone. The join code is the one thing the header
    // still gates, and a student is never sent one in the first place.
    expect(screen.getByText(/Faculty:/)).toBeInTheDocument();
    expect(screen.queryByText(/Registration Code/i)).toBeNull();
  });

  it('mounts only the active panel', () => {
    const { unmount } = renderView('assignments');
    expect(screen.getByTestId('assignments-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('grades-panel')).toBeNull();
    unmount();

    renderView('grades');
    expect(screen.getByTestId('grades-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('assignments-panel')).toBeNull();
  });
});
