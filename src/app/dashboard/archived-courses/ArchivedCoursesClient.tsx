'use client';

import React, { useMemo, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { columns } from '../courses/course-columns';
import { DataTable } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { WorkspaceSurface } from '@/components/WorkspaceSurface';
import { Archive, Library } from 'lucide-react';
import { useEffectiveTimezone } from '@/hooks/use-effective-timezone';
import { apiPaths } from '@/lib/api-paths';
import type { CourseListItem } from '@/lib/courses-list';
import { PAGE_HEADER_ICON_CLASS } from '@/lib/page-header';
import { queryKeys } from '@/lib/query-keys';

/** Cache key for the archived-courses list; distinct from the active list. */
export const archivedCoursesQueryKey = ['courses', 'archived'] as const;

/**
 * The Archived Courses list: the same DataTable + columns as the admin Courses
 * page, but scoped to archived courses only. Visibility is decided server-side
 * (admins see every archived course; everyone else only those they're on the
 * roster of), so this just renders and keeps the list fresh after row actions.
 */
export default function ArchivedCoursesClient({
  initialCourses,
  isAdmin,
}: {
  initialCourses: CourseListItem[];
  isAdmin: boolean;
}) {
  const { timezone } = useEffectiveTimezone();

  const queryClient = useQueryClient();
  const {
    data: courses = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: archivedCoursesQueryKey,
    queryFn: async () => {
      const res = await fetch(apiPaths.myCourses(), { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to fetch courses');
      const all = (await res.json()) as CourseListItem[];
      // The shared list mixes active courses in; this page is archived-only.
      return all.filter((c) => c.isArchived);
    },
    initialData: initialCourses,
    staleTime: 30_000,
  });

  // Restoring or deleting moves a course between this list, the active list and the
  // sidebar nav, so invalidate the whole ['courses'] prefix rather than only this query.
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.courses.all() });
  }, [queryClient]);

  const columnsMemo = useMemo(() => {
    const cols = columns(refresh, refresh, timezone);
    // The row actions (duplicate / archive / restore / delete) are admin-only here.
    return isAdmin ? cols : cols.filter((col) => col.id !== 'actions');
  }, [refresh, timezone, isAdmin]);

  return (
    // Same shape as the Courses page it is the counterpart to: a work page on the white
    // surface, no outer card around a table that already has a border, and a real <h1> in
    // place of the CardTitle that was carrying role="heading" aria-level={1}.
    <WorkspaceSurface>
      <section className="space-y-6" aria-labelledby="archived-courses-title">
        <h1
          id="archived-courses-title"
          className="flex items-center gap-3 text-2xl font-semibold tracking-tight"
        >
          {/* Decorative: the heading beside it already says what this is. Library, the icon
              the sidebar already uses for the archive, in the neutral muted surface: this
              is where courses go to rest, not a place to draw the eye. */}
          <Library className={PAGE_HEADER_ICON_CLASS} aria-hidden="true" />
          <span>Archived Courses</span>
        </h1>

        {isError && (
          <div className="border-status-danger-border bg-status-danger-bg text-status-danger flex items-center justify-between rounded-md border p-3 text-sm">
            <span>Failed to refresh courses. Please try again.</span>
            <Button size="sm" variant="outline" onClick={refresh}>
              Retry
            </Button>
          </div>
        )}

        <DataTable
          columns={columnsMemo}
          data={courses}
          loading={isLoading}
          tableLabel="Archived courses table"
          emptyTitle="No archived courses"
          emptyDescription="Courses you archive will appear here."
          emptyIcon={Archive}
          loadingMessage="Loading archived courses, please wait..."
        />
      </section>
    </WorkspaceSurface>
  );
}
