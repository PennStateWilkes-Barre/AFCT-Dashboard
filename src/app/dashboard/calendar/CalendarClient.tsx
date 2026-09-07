'use client';
import React from 'react';
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { CalendarDay, Modifiers } from 'react-day-picker';
import { useQuery } from '@tanstack/react-query';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import { addMonths, subMonths } from 'date-fns';
import DayAssignmentsDialog from '@/components/dialogs/DayAssignmentsDialog';
import { DueDateModule } from '@/components/modules/DueDateModule';
import { useEffectiveTimezone } from '@/hooks/use-effective-timezone';
import { Button } from '@/components/ui/button';
import { CalendarDays, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { courseColor } from './course-colors';
import type { CalendarAssignment } from '@/lib/calendar-shared';
import {
  getDateKeyInTimeZone,
  getMonthRangeIso,
  visibleAssignmentsForWidth,
} from '@/lib/calendar-shared';
import { apiPaths } from '@/lib/api-paths';
import { queryKeys } from '@/lib/query-keys';
import { CalendarCourseFilter, type FilterCourse } from './CalendarCourseFilter';
import { PAGE_HEADER_ICON_CLASS } from '@/lib/page-header';

// Compact course shape from /api/me/courses?view=nav (student: published only;
// faculty/TA: their courses even when unpublished; admin: all their enrolments).
type NavCourse = FilterCourse & {
  isArchived: boolean;
  startDate?: string | Date | null;
  endDate?: string | Date | null;
};

// Fetch assignments for courses the current user is enrolled in between given ISO start/end
async function fetchAssignmentsInRange(startIso: string, endIso: string, signal?: AbortSignal) {
  const res = await fetch(apiPaths.myAssignments(), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start: startIso, end: endIso }),
    signal,
  });
  if (!res.ok) throw new Error('Failed to fetch assignments');
  return (await res.json()) as Promise<CalendarAssignment[]>;
}

// Per-day data the custom DayButton needs, delivered by context so the component
// itself can live at module scope with a stable identity (see CalendarDayButton).
type CalendarDayContextValue = {
  assignmentsByDate: Record<string, CalendarAssignment[]>;
  timezone: string;
  visibleAssignmentLimit: number;
  localDateKey: (date: Date | string) => string;
  openDayDialog: (date: Date, dayAssignments: CalendarAssignment[]) => void;
};

const CalendarDayContext = React.createContext<CalendarDayContextValue | null>(null);

type DayButtonProps = {
  day: CalendarDay;
  modifiers: Modifiers;
} & React.ButtonHTMLAttributes<HTMLButtonElement>;

/**
 * The calendar's day cell. Defined at module scope — NOT inline in the `components`
 * prop — so its component identity is stable across CalendarClient renders. An inline
 * definition would be a new component type every render, which makes react-day-picker
 * unmount and remount every day cell on each render (dropping focus and re-running the
 * roving-focus effect). The per-render data comes through CalendarDayContext instead.
 */
function CalendarDayButton(props: DayButtonProps) {
  const ctx = React.useContext(CalendarDayContext);
  if (!ctx) {
    throw new Error('CalendarDayButton must be rendered within a CalendarDayContext provider');
  }
  const { assignmentsByDate, timezone, visibleAssignmentLimit, localDateKey, openDayDialog } = ctx;

  const {
    day,
    modifiers,
    onClick: rdpOnClick,
    onKeyDown: rdpOnKeyDown,
    onFocus: rdpOnFocus,
    onBlur: rdpOnBlur,
    tabIndex: rdpTabIndex,
  } = props;
  // react-day-picker owns keyboard navigation: it hands each day a
  // roving tabIndex (only the active day is 0), an arrow-key onKeyDown,
  // and it flags the day to focus via modifiers.focused. Forward all of
  // that so the grid is one tab stop with working arrow keys, instead of
  // ~40 tab stops and dead arrows.
  const dayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (modifiers.focused) dayRef.current?.focus();
  }, [modifiers.focused]);
  const dateStr = localDateKey(day.date);
  const dayAssignments = (assignmentsByDate[dateStr] || [])
    .slice()
    .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());

  const visibleCount = visibleAssignmentLimit;

  const todayDate = new Date();
  const dayDate = day.date;
  const isToday =
    dayDate.getFullYear() === todayDate.getFullYear() &&
    dayDate.getMonth() === todayDate.getMonth() &&
    dayDate.getDate() === todayDate.getDate();
  const isWeekend = dayDate.getDay() === 0 || dayDate.getDay() === 6;
  const hiddenAssignmentCount = Math.max(0, dayAssignments.length - visibleCount);
  const formattedDayLabel = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: timezone,
  }).format(dayDate);
  const openCurrentDay = () => {
    const dayOnly = new Date(day.date.getFullYear(), day.date.getMonth(), day.date.getDate());
    openDayDialog(dayOnly, dayAssignments);
  };

  return (
    <div
      ref={dayRef}
      role="button"
      tabIndex={rdpTabIndex ?? -1}
      aria-current={isToday ? 'date' : undefined}
      aria-keyshortcuts="Enter Space"
      aria-label={`${formattedDayLabel}${isToday ? ', today' : ''}. ${dayAssignments.length} assignment${dayAssignments.length === 1 ? '' : 's'}. Press Enter to open assignments for this day.`}
      onFocus={rdpOnFocus as React.FocusEventHandler<HTMLDivElement> | undefined}
      onBlur={rdpOnBlur as React.FocusEventHandler<HTMLDivElement> | undefined}
      onClick={(e) => {
        openCurrentDay();
        rdpOnClick?.(e as unknown as React.MouseEvent<HTMLButtonElement>);
      }}
      onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
        // Let react-day-picker handle arrow/Home/End/PageUp/Down navigation first.
        rdpOnKeyDown?.(e as unknown as React.KeyboardEvent<HTMLButtonElement>);

        // Do not hijack keyboard events from nested interactive elements (e.g., assignment links).
        if (e.target !== e.currentTarget) return;

        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          openCurrentDay();
          rdpOnClick?.(e as unknown as React.MouseEvent<HTMLButtonElement>);
        }
      }}
      className={cn(
        'focus-visible:ring-ring box-border grid h-full w-full min-w-0 grid-rows-[auto_1fr] overflow-hidden focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none',
        // Explicit heights rather than aspect-ratio: 1/1. A square cell takes its height
        // from its width, so on a wide desktop one week row was ~150px tall and the last
        // week of the month fell below the fold. These are sized to the chips instead
        // (about 28px of chrome plus 22px a chip), which is what the cell is actually
        // for. visibleAssignmentsForWidth mirrors these tiers; change them together.
        'min-h-14 sm:min-h-20 md:min-h-24 lg:min-h-26 xl:min-h-28',
        // Today is the date badge plus a faint wash, not a ring around the whole cell:
        // a 2px cobalt border outshouted the events it was meant to frame. Semantic
        // tokens throughout, so the cells follow the theme like everything else.
        isToday ? 'bg-primary/5' : 'bg-card',
        !isToday && isWeekend && 'bg-muted/40',
      )}
    >
      <span
        className={cn(
          'self-start justify-self-start p-1 text-left text-xs select-none',
          isToday &&
            'bg-primary text-primary-foreground m-0.5 flex size-5 items-center justify-center rounded-full p-0 font-semibold',
        )}
      >
        {day.date.getDate()}
      </span>
      {/* Layout only: a click here bubbles to the day cell's own onClick, so a handler
          on this div would open the day twice. */}
      <div className="grid min-h-0 w-full min-w-0 cursor-default content-start gap-1 overflow-hidden p-1">
        {dayAssignments.slice(0, visibleCount).map((a) => {
          const isDraft = a.isPublished === false;
          // Visual-only summary chips. They are intentionally NOT links: an
          // interactive element must not be nested inside the day's button role.
          // The day button summarizes the count for assistive tech (so these are
          // aria-hidden), and the real navigable links live in the day dialog
          // (opened with Enter/click) and the Upcoming Assignments list.
          return (
            <div
              key={a.id}
              aria-hidden="true"
              className={cn(
                'assignment-link box-border block min-h-[1rem] w-full min-w-0 truncate overflow-hidden rounded-md border py-0.5 pl-1 text-left text-xs leading-tight whitespace-nowrap',
                // Tinted by course, matching the dot beside that course in the filter
                // list. A draft keeps its own warning tint: which course it belongs to
                // matters less than the fact that nobody can see it yet.
                isDraft
                  ? 'border-status-warning-border bg-status-warning-bg text-status-warning'
                  : courseColor(a.course.id).chip,
                a.crossedOut && 'line-through opacity-80',
              )}
              title={`${isDraft ? 'Draft: ' : ''}${a.course.code} - ${a.title}`}
            >
              {isDraft && <span>✎ </span>}
              {`${a.course.code} - ${a.title}`}
            </div>
          );
        })}
        {dayAssignments.length > visibleCount && (
          <>
            {/* On a phone the cell shows no chips at all, so "+N more" would be counting from a
                number nobody was given: a marker is the honest version there. Everywhere else
                the count is the useful thing, and it reads without a legend. Text, not a
                control: the day cell itself is the button that opens the list. */}
            {visibleCount === 0 ? (
              <div
                aria-hidden={true}
                className="bg-primary size-1.5 self-center justify-self-center rounded-full"
              />
            ) : (
              <div
                aria-hidden={true}
                className="text-muted-foreground text-2xs truncate pl-1 leading-tight"
              >
                {`+${hiddenAssignmentCount} more`}
              </div>
            )}
            <span className="sr-only">
              {visibleCount === 0
                ? 'Open day to view assignments.'
                : `${hiddenAssignmentCount} more assignment${hiddenAssignmentCount === 1 ? '' : 's'} not shown in cell. Open day to view all assignments.`}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// Stable `components` object for react-day-picker (module scope so its identity
// never changes between renders).
const CALENDAR_DAY_COMPONENTS = { DayButton: CalendarDayButton };

// Where the per-browser course filter is remembered. Stores the ids of the courses the
// viewer has turned OFF, so the choice survives leaving and returning to the calendar.
const HIDDEN_COURSES_KEY = 'afct:calendar:hidden-courses';

export default function CalendarClient({
  initialAssignments,
  initialMonth,
}: {
  initialAssignments?: CalendarAssignment[];
  initialMonth?: string;
}) {
  const { timezone } = useEffectiveTimezone();
  const [selected, setSelected] = useState<Date | undefined>(undefined);
  const [currentMonth, setCurrentMonth] = useState(
    initialMonth ? new Date(initialMonth) : new Date(),
  );
  const [visibleAssignmentLimit, setVisibleAssignmentLimit] = useState(2);

  // Dialog state
  const [dayDialogOpen, setDayDialogOpen] = useState(false);
  const [dialogDate, setDialogDate] = useState<Date | null>(null);
  const [dialogAssignments, setDialogAssignments] = useState<CalendarAssignment[]>([]);

  // ISO range for the visible month, in the user's timezone. This drives the cache
  // key, so each month is fetched once and served warm on revisit / back-and-forth
  // month navigation (no refetch within the staleTime window).
  const { startIso, endIso } = useMemo(
    () => getMonthRangeIso(currentMonth, timezone),
    [currentMonth, timezone],
  );

  // The SSR-provided range, captured once, so `initialAssignments` seed only the
  // month they belong to, not every month the user later navigates to.
  const [initialRange] = useState(() =>
    getMonthRangeIso(initialMonth ? new Date(initialMonth) : new Date(), timezone),
  );
  const isInitialRange = startIso === initialRange.startIso && endIso === initialRange.endIso;

  const {
    data: assignments = [],
    isFetching: loading,
    isError,
    refetch,
  } = useQuery({
    queryKey: queryKeys.assignmentsRange(startIso, endIso),
    queryFn: ({ signal }) => fetchAssignmentsInRange(startIso, endIso, signal),
    initialData:
      isInitialRange && Array.isArray(initialAssignments) ? initialAssignments : undefined,
    staleTime: 30_000,
  });

  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  // The viewer's courses, for the filter box. Role scoping (published-only for
  // students, drafts included for staff) is done server-side; we only drop archived
  // ones here, since the calendar never shows archived-course assignments anyway.
  const { data: navCourses = [] } = useQuery({
    // The same key the sidebar uses, so the two dedupe onto one read and, more importantly,
    // so `invalidateQueries(['courses'])` after a publish/archive/duplicate reaches this copy
    // too. Hand-writing it as ['me','courses','nav'] made this a second, private entry that
    // every one of those invalidations missed.
    queryKey: queryKeys.courses.nav(),
    queryFn: async () => {
      const res = await fetch(apiPaths.myCourses({ view: 'nav' }), { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to fetch courses');
      return (await res.json()) as NavCourse[];
    },
    staleTime: 60_000,
  });
  // Courses with an assignment in the month currently on screen. A course whose term
  // dates say it is over can still own an assignment here (a late deadline, a term date
  // nobody updated), and a course you can see chips for must stay filterable.
  const courseIdsWithAssignments = useMemo(
    () => new Set(assignments.map((a) => a.course.id)),
    [assignments],
  );

  const filterCourses = useMemo<FilterCourse[]>(() => {
    const ms = (v: string | Date | null | undefined, fallback: number) => {
      const t = v ? new Date(v).getTime() : NaN;
      return Number.isNaN(t) ? fallback : t;
    };
    // The month on screen, in plain local terms. This only decides which courses are
    // worth listing, so it does not need the timezone precision the assignment range does.
    const monthStart = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1).getTime();
    const monthEnd = new Date(
      currentMonth.getFullYear(),
      currentMonth.getMonth() + 1,
      0,
      23,
      59,
      59,
      999,
    ).getTime();

    // Show a course whose term overlaps the visible month, so a Spring course does not sit
    // in the list all August. A missing date is treated as open-ended rather than as a
    // reason to hide: the nav payload carries startDate/endDate but neither is required.
    const overlapsVisibleMonth = (c: NavCourse) =>
      ms(c.startDate, -Infinity) <= monthEnd && ms(c.endDate, Infinity) >= monthStart;

    return navCourses
      .filter((c) => !c.isArchived)
      .filter((c) => overlapsVisibleMonth(c) || courseIdsWithAssignments.has(c.id))
      .slice()
      .sort((a, b) => ms(a.startDate, Infinity) - ms(b.startDate, Infinity)) // undated last
      .map((c) => ({ id: c.id, code: c.code, semester: c.semester }));
  }, [navCourses, currentMonth, courseIdsWithAssignments]);

  // Courses the viewer has turned OFF. Empty = everything shown, so all boxes start
  // checked and a course we haven't seen yet defaults to visible. Persists across
  // month navigation (it's plain component state).
  const [uncheckedCourseIds, setUncheckedCourseIds] = useState<Set<string>>(() => new Set());

  // Restore the saved filter once, on the client. Done in an effect (not a lazy state
  // initializer) so the server-rendered markup, which has no localStorage, matches the
  // first client render and nothing hydration-mismatches.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(HIDDEN_COURSES_KEY);
      const ids: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(ids) && ids.length > 0) {
        setUncheckedCourseIds(new Set(ids.filter((x): x is string => typeof x === 'string')));
      }
    } catch {
      // Blocked or malformed storage: just show everything.
    }
  }, []);

  // One place that writes the preference, so the single toggle and the bulk controls can
  // never drift into two storage formats.
  const persistUnchecked = (ids: Set<string>) => {
    try {
      window.localStorage.setItem(HIDDEN_COURSES_KEY, JSON.stringify([...ids]));
    } catch {
      // Non-fatal: the choice still works this session, it just won't persist.
    }
    return ids;
  };

  const toggleCourse = useCallback((courseId: string) => {
    setUncheckedCourseIds((prev) => {
      const next = new Set(prev);
      if (next.has(courseId)) next.delete(courseId);
      else next.add(courseId);
      return persistUnchecked(next);
    });
  }, []);

  // Bulk controls work on the same set the checkboxes do, and only on the courses
  // currently listed: a course hidden because its term is not on screen keeps whatever
  // the viewer last chose for it, so navigating months does not quietly re-show it.
  const showAllCourses = useCallback(() => {
    setUncheckedCourseIds((prev) => {
      const next = new Set(prev);
      filterCourses.forEach((c) => next.delete(c.id));
      return persistUnchecked(next);
    });
  }, [filterCourses]);

  const hideAllCourses = useCallback(() => {
    setUncheckedCourseIds((prev) => {
      const next = new Set(prev);
      filterCourses.forEach((c) => next.add(c.id));
      return persistUnchecked(next);
    });
  }, [filterCourses]);

  // Assignments the calendar and the Upcoming list actually render, after the course
  // filter. When nothing is unchecked this is the full list (no needless copy).
  const visibleAssignments = useMemo(
    () =>
      uncheckedCourseIds.size === 0
        ? assignments
        : assignments.filter((a) => !uncheckedCourseIds.has(a.course.id)),
    [assignments, uncheckedCourseIds],
  );

  const openDayDialog = useCallback((date: Date, dayAssignments: CalendarAssignment[]) => {
    setDialogDate(date);
    setDialogAssignments(dayAssignments);
    setDayDialogOpen(true);
  }, []);

  const closeDayDialog = () => {
    setDayDialogOpen(false);
    setDialogDate(null);
    setDialogAssignments([]);
  };

  useEffect(() => {
    const updateLimit = () => {
      setVisibleAssignmentLimit(visibleAssignmentsForWidth(window.innerWidth));
    };

    updateLimit();
    window.addEventListener('resize', updateLimit);
    return () => window.removeEventListener('resize', updateLimit);
  }, []);

  const monthLabel = useMemo(() => {
    return new Intl.DateTimeFormat('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: timezone,
    }).format(currentMonth);
  }, [currentMonth, timezone]);

  // What the single live region says. Both facts in one string so a month change and the
  // fetch that follows it are one announcement rather than two, and so the end of the
  // fetch is announced at all.
  const calendarStatus = loading
    ? `${monthLabel}. Loading assignments.`
    : `${monthLabel}. ${visibleAssignments.length} assignment${visibleAssignments.length === 1 ? '' : 's'}.`;

  const goToPreviousMonth = () => {
    const nextMonth = subMonths(currentMonth, 1);
    setCurrentMonth(nextMonth);
  };

  const goToNextMonth = () => {
    const nextMonth = addMonths(currentMonth, 1);
    setCurrentMonth(nextMonth);
  };

  // Back to the month containing today. Same state setter as the arrows, so nothing about
  // navigation or timezone handling differs.
  const goToToday = () => {
    setCurrentMonth(new Date());
  };

  // Helper to get a YYYY-MM-DD key in the user's timezone
  const localDateKey = useCallback(
    (date: Date | string) => getDateKeyInTimeZone(date, timezone),
    [timezone],
  );

  // Group assignments by date string (YYYY-MM-DD) using local dates. Built from the
  // course-filtered list so unchecking a course hides its assignments in the grid too.
  const assignmentsByDate = useMemo(() => {
    const grouped: Record<string, CalendarAssignment[]> = {};
    visibleAssignments.forEach((a) => {
      const dateStr = localDateKey(a.dueDate);
      if (!grouped[dateStr]) grouped[dateStr] = [];
      grouped[dateStr].push(a);
    });
    return grouped;
  }, [visibleAssignments, localDateKey]);

  // The data the (module-scope) day cells read via context. Memoized so cells only
  // re-render when the data actually changes, never just because the parent did.
  const dayContextValue = useMemo<CalendarDayContextValue>(
    () => ({ assignmentsByDate, timezone, visibleAssignmentLimit, localDateKey, openDayDialog }),
    [assignmentsByDate, timezone, visibleAssignmentLimit, localDateKey, openDayDialog],
  );

  // Navigate to a different day in the dialog (previous/next)
  const navigateDay = (date: Date) => {
    const key = localDateKey(date);
    const dayAssignments = assignmentsByDate[key] || [];
    setDialogDate(date);
    setDialogAssignments(dayAssignments);
    setDayDialogOpen(true);
  };

  return (
    <div className="space-y-6">
      <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight">
        {/* Decorative: the heading beside it already says what this is. */}
        <CalendarDays className={PAGE_HEADER_ICON_CLASS} aria-hidden="true" />
        <span>Calendar</span>
      </h1>

      {/* Same rail widths as the dashboard, so the two pages read as one system. */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_21rem] xl:grid-cols-[minmax(0,1fr)_23rem]">
        {/* No Card. The calendar IS the page's work surface (the page itself is the white
            WorkspaceSurface), so wrapping it in a card put a bounded object inside a
            bounded object and spent 48px of width and 48px of height on the card's own
            padding. The one boundary that earns its place is around the month grid
            below. */}
        <div className="relative flex min-w-0 flex-col gap-3">
          {isError ? (
            <div className="border-status-danger-border bg-status-danger-bg flex items-center justify-between gap-3 rounded-md border px-3 py-2">
              <p role="alert" className="text-status-danger text-sm">
                Failed to load calendar assignments. Please try again.
              </p>
              <Button variant="outline" size="sm" onClick={refresh}>
                Retry
              </Button>
            </div>
          ) : null}
          {/* The ONLY live region on this page, and it carries the whole state: which month
              is on screen, and whether its assignments have arrived.

              There used to be two polite regions, this one and the month label in the
              toolbar. Pressing Next fired both, so the month and "Loading assignments"
              queued as separate announcements, and nothing at all was said when the fetch
              finished: the region simply emptied. One region, one message per change, and
              it ends with a count so "done" is audible.

              Mounted whether or not it is loading. Created together with its message, a
              live region is not reliably announced. Positioned against this column (hence
              its `relative`) and floated over the top of the month grid, clear of the
              toolbar's controls. */}
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className={
              loading
                ? 'border-border bg-card pointer-events-none absolute inset-x-0 top-24 z-10 mx-auto w-fit rounded-md border px-2 py-1 shadow-sm'
                : 'sr-only'
            }
          >
            {/* aria-hidden so the visible chip is not announced a second time; the
                sr-only line below is the announcement. */}
            {loading ? (
              <p aria-hidden="true" className="text-muted-foreground text-xs italic">
                Loading assignments...
              </p>
            ) : null}
            <span className="sr-only">{calendarStatus}</span>
          </div>
          {/* A control bar, not three stacked CTAs: month navigation is a utility, so
              the buttons are outline rather than the filled primaries they were.
              Three zones rather than a flex row: the left side carries two controls and
              the right side one, so a plain row put the month label off-centre. The
              1fr/auto/1fr grid centres it on the column regardless. */}
          <div className="mx-auto grid w-full max-w-6xl grid-cols-[1fr_auto_1fr] items-center gap-2 px-1">
            <div className="flex items-center gap-2 justify-self-start">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 w-8 shrink-0 p-0"
                onClick={goToPreviousMonth}
                aria-label="Previous month"
              >
                <ChevronLeftIcon className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 shrink-0"
                onClick={goToToday}
              >
                Today
              </Button>
            </div>
            {/* Plain text now. The status region above announces the month change, so a
                second live region here only produced a competing announcement. */}
            <div className="min-w-0 truncate px-1 text-center text-base font-semibold sm:px-4 sm:text-lg">
              {monthLabel}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 w-8 shrink-0 justify-self-end p-0"
              onClick={goToNextMonth}
              aria-label="Next month"
            >
              <ChevronRightIcon className="h-4 w-4" />
            </Button>
          </div>
          {/* The single boundary: it wraps the weekday header and the day grid, and
              nothing else. overflow-hidden matters as well as rounding the corners: day
              cells carry -m-px, so their outer 1px of border overhangs and is clipped
              here rather than doubling up against this edge. The width cap lives here
              rather than on the Calendar inside it, so the border hugs the grid instead
              of leaving a margin of empty card inside itself on a wide display. */}
          <div className="border-border mx-auto w-full max-w-6xl overflow-hidden rounded-lg border">
            <p id="calendar-keyboard-help" className="sr-only">
              Use arrow keys to move between calendar days. Press Enter or Space to open assignments
              for the focused day.
            </p>
            <div aria-describedby="calendar-keyboard-help">
              <CalendarDayContext.Provider value={dayContextValue}>
                <Calendar
                  mode="single"
                  selected={selected}
                  onSelect={setSelected}
                  formatters={{
                    formatWeekdayName: (date) =>
                      new Intl.DateTimeFormat('en-US', {
                        weekday: 'short',
                        timeZone: timezone,
                      }).format(date),
                  }}
                  month={currentMonth}
                  onMonthChange={(month: Date) => {
                    setCurrentMonth(month);
                  }}
                  // Always six rows, so the page does not jump height between a
                  // five-week month and a six-week one. getMonthRangeIso fetches the
                  // same six weeks; see the note there.
                  fixedWeeks
                  className="text-foreground bg-card w-full p-0 [--cell-size:2.25rem] sm:[--cell-size:3.25rem] md:[--cell-size:3.5rem]"
                  timeZone={timezone}
                  classNames={{
                    nav: 'hidden',
                    month_caption: 'hidden',
                    caption_label: 'hidden',
                    dropdowns: 'hidden',
                    // A header row rather than seven labels floating above the grid:
                    // the faint fill and the shared border tie it to the first week.
                    weekdays: 'flex gap-0 border-b border-border/60 bg-muted/30 py-2',
                    weekday:
                      'text-muted-foreground flex-1 font-semibold text-xs select-none text-center',
                    day: 'relative box-border -m-px w-full p-0 text-center [&:first-child[data-selected=true]_button]:rounded-l-md [&:last-child[data-selected=true]_button]:rounded-r-md group/day select-none border border-border/60',
                    today: 'rounded-none bg-transparent text-inherit',
                  }}
                  components={CALENDAR_DAY_COMPONENTS}
                />
              </CalendarDayContext.Provider>
            </div>
          </div>
        </div>

        <div className="w-full space-y-4">
          <CalendarCourseFilter
            courses={filterCourses}
            uncheckedCourseIds={uncheckedCourseIds}
            onToggle={toggleCourse}
            onShowAll={showAllCourses}
            onHideAll={hideAllCourses}
          />
          <DueDateModule assignments={visibleAssignments} />
        </div>
      </div>
      <DayAssignmentsDialog
        open={dayDialogOpen}
        onOpenChange={(open) => {
          if (!open) closeDayDialog();
          setDayDialogOpen(open);
        }}
        date={dialogDate}
        assignments={dialogAssignments}
        onClose={closeDayDialog}
        onNavigate={navigateDay}
      />
    </div>
  );
}
