import { CalendarClock } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { formatDateInTimeZone, formatTimeInTimeZone } from '@/lib/date-format';

/**
 * What a student sees for a course they belong to that has not opened yet.
 *
 * The course is real, they are on its roster, and it is listed for them under Upcoming
 * Courses, so a 404 here would be a lie that also looks like a bug. `canAccessCourse` closes
 * every API the real page would call; this states the reason and the date instead of leaving
 * a page that fails to load.
 *
 * A server component with no interactivity: it is rendered instead of the course page, not
 * inside it, so it carries the page's h1.
 */
export function CourseNotStarted({
  name,
  code,
  startDate,
  timezone,
}: {
  name: string;
  code: string | null;
  startDate: Date | string | null;
  /** The course's own timezone, which is the one its dates were set in. */
  timezone?: string | null;
}) {
  const zone = timezone || 'UTC';
  const opens = startDate
    ? `${formatDateInTimeZone(startDate, zone)} at ${formatTimeInTimeZone(startDate, zone, true)}`
    : null;

  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
        <CalendarClock className="text-muted-foreground size-7" aria-hidden="true" />
        <h1 className="text-xl font-semibold">
          {code ? `${code}: ${name}` : name} has not started yet
        </h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          {opens
            ? `This course opens on ${opens}. Its assignments and materials become available then.`
            : 'Its assignments and materials are not available yet.'}
        </p>
      </CardContent>
    </Card>
  );
}
