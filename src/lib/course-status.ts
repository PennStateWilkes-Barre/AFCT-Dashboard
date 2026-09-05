export type CourseDateBucket = 'upcoming' | 'current' | 'past';

/**
 * Has the course opened to its students yet?
 *
 * The single definition of "started", so the access gate, the course page's own message and
 * the queries that list a student's work all draw the line at the same instant. Staff are not
 * subject to it: they set the date, and they have to be able to build the course before it
 * opens.
 *
 * A course with no start date has started. The column is required today, so this is a guard
 * for partial selects and older rows rather than a real state, and defaulting the other way
 * would lock a course nobody had dated.
 */
export function courseHasStarted(
  startDate: string | Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!startDate) return true;
  const start = new Date(startDate);
  if (!Number.isFinite(start.getTime())) return true;
  return start.getTime() <= now.getTime();
}

/**
 * Bucket a course purely by its date range (publish/archive state ignored),
 * using the same boundaries as {@link getCourseStatusTag}: "upcoming" before it
 * starts, "past" once its end has passed, "current" in between.
 */
export function getCourseDateBucket(
  course: { startDate: string | Date; endDate: string | Date },
  now: Date = new Date(),
): CourseDateBucket {
  const start = new Date(course.startDate);
  const end = new Date(course.endDate);
  if (start > now) return 'upcoming';
  if (end <= now) return 'past';
  return 'current';
}

export function getCourseStatusTag(course: {
  isArchived: boolean;
  isPublished: boolean;
  startDate: string | Date;
  endDate: string | Date;
}) {
  const now = new Date();
  const start = new Date(course.startDate);
  const end = new Date(course.endDate);

  if (course.isArchived) return { status: 'Archived', variant: 'neutral' } as const;
  if (!course.isPublished) return { status: 'Not Published', variant: 'warning' } as const;
  if (start > now) return { status: 'Upcoming', variant: 'info' } as const;
  if (end <= now) return { status: 'Ended', variant: 'danger' } as const;
  return { status: 'Active', variant: 'success' } as const;
}
