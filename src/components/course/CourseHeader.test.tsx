/** @vitest-environment jsdom */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CourseHeaderContent } from './CourseHeader';
import type { FullCourse } from '@/types/course';

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ showToast: toastMock }));

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/use-effective-timezone', () => ({
  useEffectiveTimezone: () => ({ timezone: 'America/New_York' }),
}));

vi.mock('@/lib/date-format', () => ({
  formatDateTimeInTimeZone: (value: Date | string) =>
    typeof value === 'string' ? value : value.toISOString(),
}));

const mockCourse: FullCourse = {
  id: 'course-1',
  code: 'CMPSC 431',
  name: 'Software Engineering',
  semester: 'Fall 2025',
  credits: 3,
  startDate: new Date('2025-08-20T13:00:00Z'),
  endDate: new Date('2025-12-10T13:00:00Z'),
  registrationOpenAt: new Date('2025-06-01T13:00:00Z'),
  registrationCloseAt: new Date('2025-08-15T13:00:00Z'),
  isPublished: true,
  isArchived: false,
  deletedAt: null,
  timezone: 'America/New_York',
  emptyStringNotation: 'EPSILON',
  regCode: 'abcd2345',
  createdAt: new Date('2025-06-01T13:00:00Z'),
  updatedAt: new Date('2025-06-01T13:00:00Z'),
  problems: [],
  assignments: [],
  // Course staff only. Students never reach this payload: the roster tab pages through
  // GET /api/courses/[id]/roster.
  staff: [
    {
      id: 'faculty-1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      role: 'FACULTY',
      courseRole: 'FACULTY',
    },
  ],
};

describe('CourseHeaderContent', () => {
  it('renders course metadata, status, and staff info for instructors', () => {
    render(<CourseHeaderContent course={mockCourse} isStudent={false} />);

    // One heading, one string: the code and the name are the same title now, not a muted
    // code beside a foreground name.
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('CMPSC 431: Software Engineering');
    expect(heading).toHaveAttribute('id', 'course-page-title');
    expect(screen.getByText('Fall 2025')).toBeInTheDocument();
    expect(screen.getByText('3 credits')).toBeInTheDocument();
    // Course status badge lives next to the metadata badges.
    expect(screen.getByText(/^(Open|Upcoming|Closed)$/)).toBeInTheDocument();
    // Faculty/TA line is instructor-only.
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('names the faculty and TAs to a student, but never the registration code', () => {
    const withTa: FullCourse = {
      ...mockCourse,
      staff: [
        ...(mockCourse.staff ?? []),
        { id: 'ta-1', firstName: 'Alan', lastName: 'Turing', role: 'STUDENT', courseRole: 'TA' },
      ],
    };
    render(<CourseHeaderContent course={withTa} isStudent />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'CMPSC 431: Software Engineering',
    );
    // Who teaches the course is the first thing a student looks for on it.
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Alan Turing')).toBeInTheDocument();
  });

  it('withholds the registration code from a student even when the payload carries one', () => {
    // A student is never sent a regCode, so this is the second of two guards: it fails if
    // someone widens the payload without noticing the header renders whatever it is given.
    render(<CourseHeaderContent course={mockCourse} isStudent />);

    expect(screen.queryByText('ABCD-2345')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /copy registration code/i }),
    ).not.toBeInTheDocument();
  });

  it('omits the TAs label when the course has no TAs', () => {
    render(<CourseHeaderContent course={mockCourse} isStudent={false} />);
    expect(screen.queryByText('TAs:')).not.toBeInTheDocument();
  });

  it('lists TAs when the course has some', () => {
    const withTa: FullCourse = {
      ...mockCourse,
      staff: [
        ...(mockCourse.staff ?? []),
        { id: 'ta-1', firstName: 'Alan', lastName: 'Turing', role: 'STUDENT', courseRole: 'TA' },
      ],
    };
    render(<CourseHeaderContent course={withTa} isStudent={false} />);
    expect(screen.getByText('TAs:')).toBeInTheDocument();
    expect(screen.getByText('Alan Turing')).toBeInTheDocument();
  });

  it('shows the registration code formatted and copies the plain code', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<CourseHeaderContent course={mockCourse} isStudent={false} />);

    // Displayed grouped as ABCD-2345 for readability.
    expect(screen.getByText('ABCD-2345')).toBeInTheDocument();

    // Copies the plain 8-character code the join endpoint expects.
    fireEvent.click(screen.getByRole('button', { name: /copy registration code/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('ABCD2345'));
    expect(toastMock.success).toHaveBeenCalled();
  });

  it('is a single page-level heading, whichever view renders it', () => {
    const { unmount } = render(<CourseHeaderContent course={mockCourse} isStudent={false} />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    unmount();

    render(<CourseHeaderContent course={mockCourse} isStudent />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('keeps the decorative banner out of the accessibility tree', () => {
    const { container } = render(<CourseHeaderContent course={mockCourse} isStudent={false} />);
    // The network carries no meaning, so it must not be reachable or clickable. One decoration
    // now, not two: the navy wash that used to sit over it is gone, because it and the SVG's
    // own fade were two mechanisms multiplying to hide the left of the mesh entirely.
    const decorations = container.querySelectorAll('[aria-hidden="true"].pointer-events-none');
    expect(decorations.length).toBeGreaterThanOrEqual(1);
    // The banner is a named region, so the heading names it rather than the ground doing so.
    const banner = container.querySelector('section[aria-labelledby="course-page-title"]');
    expect(banner).not.toBeNull();
  });

  it('draws the network inside the banner, hidden and unfocusable', () => {
    const { container } = render(<CourseHeaderContent course={mockCourse} isStudent={false} />);
    const svg = container.querySelector('svg[aria-hidden="true"]');
    expect(svg).not.toBeNull();
    // Decoration only: no name, no focus, no pointer events, and clipped to the banner.
    expect(svg).toHaveAttribute('focusable', 'false');
    expect(svg?.getAttribute('class')).toContain('pointer-events-none');
    expect(svg?.querySelectorAll('circle').length).toBeGreaterThan(40);
    expect(svg?.querySelectorAll('line').length).toBeGreaterThan(60);
    // A few edges are drawn as directed transitions, which is the one nod to what the app is
    // for. A marker that stopped resolving would drop them silently back to plain lines.
    const marker = svg?.querySelector('marker');
    expect(marker).not.toBeNull();
    const arrowGroup = svg?.querySelector('g[marker-end]');
    expect(arrowGroup?.getAttribute('marker-end')).toBe(`url(#${marker?.id})`);
    expect(arrowGroup?.querySelectorAll('line').length).toBeGreaterThan(3);
    const banner = container.querySelector('section[aria-labelledby="course-page-title"]');
    expect(banner?.className).toContain('overflow-hidden');
  });

  it('puts no page-theme colour inside the banner', () => {
    // The banner is dark in every theme, so a page token or a `dark:` utility in here is a
    // value that follows the page instead: near-black text on navy in light mode, and no way
    // to see it from the markup. Every colour comes from the --course-banner-* family.
    const { container } = render(<CourseHeaderContent course={mockCourse} isStudent={false} />);
    const banner = container.querySelector('section[aria-labelledby="course-page-title"]');
    const classes = Array.from(banner?.querySelectorAll<HTMLElement>('[class]') ?? [])
      .map((el) => el.getAttribute('class') ?? '')
      .join(' ')
      .split(/\s+/)
      // The badge and button primitives carry `[a&]:hover:...` rules for the anchor form of
      // themselves. Nothing in the banner is an anchor, so those never apply and are not
      // worth overriding one by one.
      .filter((c) => !c.includes('[a&]:'));
    const themed = classes.filter((c) =>
      /(^|:)(text|bg|border)-(foreground|background|card|muted|accent|secondary|primary|popover)(\b|-|\/)/.test(
        c,
      ),
    );
    expect(themed).toEqual([]);
  });

  it('never truncates the course title', () => {
    const longCourse = {
      ...mockCourse,
      name: 'Advanced Topics in Programming Languages and Software Engineering',
    };
    render(<CourseHeaderContent course={longCourse} isStudent={false} />);
    const heading = screen.getByRole('heading', { level: 1 });
    // This is the one place the whole name belongs: it wraps rather than clipping.
    expect(heading.className).not.toContain('truncate');
    expect(heading).toHaveTextContent(longCourse.name);
  });
});
