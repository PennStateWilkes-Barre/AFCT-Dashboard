'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { showToast } from '@/lib/toast';
import type { FullCourse, DeleteTarget, EnrollableUser, TabType } from '@/types/course';
import { apiPaths } from '@/lib/api-paths';
import { queryKeys } from '@/lib/query-keys';
import { fetchJson } from '@/lib/query-fetch';
import type { Assignment, Problem } from '@prisma/client';

type CourseSectionView = 'summary' | 'full' | 'assignments' | 'problems' | 'roster';
type SectionKey = 'assignments' | 'problems' | 'roster';

/** Cache key for a course view; shared so callers can invalidate consistently. */
export const courseQueryKey = (courseId: string, view: CourseSectionView) =>
  ['course', courseId, view] as const;

/** Ensure the lazily-merged section arrays are always present on a course payload. */
const normalizeCourse = (data: FullCourse): FullCourse => ({
  ...data,
  staff: data.staff || [],
  assignments: data.assignments || [],
  problems: data.problems || [],
});

/**
 * Course data hook backed by the TanStack Query cache. The base view is a real
 * `useQuery`, so mounting, deduping, warm back-navigation, error/loading state,
 * and retries are all handled by Query; there is no mirrored `useState`. The
 * base cache entry IS the rendered course: `setCourse` writes to it via
 * `setQueryData`, so optimistic updates re-render through the query, and the
 * lazily-loaded section tabs (assignments/problems/roster) merge into the same
 * entry. Because that entry accumulates merged sections, its `staleTime` is
 * `Infinity`: a background refetch would clobber the merge; the course is
 * refreshed only explicitly via `refetchCourse` (or optimistic `setCourse`).
 */
export function useCourseData(
  courseId: string,
  options?: { initialCourse?: FullCourse | null; isStudent?: boolean },
) {
  const queryClient = useQueryClient();
  const isStudent = !!options?.isStudent;
  const baseView: CourseSectionView = isStudent ? 'full' : 'summary';

  const {
    data: course = null,
    isError,
    refetch,
  } = useQuery({
    queryKey: courseQueryKey(courseId, baseView),
    queryFn: () =>
      fetchJson<FullCourse>(apiPaths.course(courseId, { view: baseView })).then(normalizeCourse),
    enabled: !!courseId,
    staleTime: Infinity,
    initialData: options?.initialCourse ? normalizeCourse(options.initialCourse) : undefined,
  });

  const [loadingSections, setLoadingSections] = useState<Record<SectionKey, boolean>>({
    assignments: false,
    problems: false,
    roster: false,
  });

  // Surface the load failure once (Query owns the fetch; there is no onError in v5).
  useEffect(() => {
    if (isError) showToast.error('Could not load the course. Refresh the page to try again.');
  }, [isError]);

  // Optimistic updates write straight to the base cache entry; `useQuery` then
  // re-renders `course` from it. Same Dispatch signature as the old useState
  // setter, so `course-handlers` and its `updateCourseAfter*` helpers are unchanged.
  const setCourse = useCallback<Dispatch<SetStateAction<FullCourse | null>>>(
    (updater) => {
      if (!courseId) return;
      queryClient.setQueryData<FullCourse | null>(courseQueryKey(courseId, baseView), (prev) => {
        const current = (prev ?? null) as FullCourse | null;
        return typeof updater === 'function'
          ? (updater as (p: FullCourse | null) => FullCourse | null)(current)
          : updater;
      });
    },
    [courseId, baseView, queryClient],
  );

  const fetchCourseByView = useCallback(
    async (view: CourseSectionView): Promise<FullCourse | null> => {
      if (!courseId) return null;
      return queryClient.fetchQuery({
        queryKey: courseQueryKey(courseId, view),
        queryFn: () => fetchJson<FullCourse>(apiPaths.course(courseId, { view })),
      });
    },
    [courseId, queryClient],
  );

  const loadTabData = useCallback(
    async (tab: TabType) => {
      if (!courseId || isStudent) return;
      const section = tab as SectionKey;
      if (section !== 'assignments' && section !== 'problems' && section !== 'roster') return;
      // Only show the section spinner on a COLD cache. When the entry is already
      // cached, switching to the tab renders instantly (fetchQuery returns the
      // cached data within staleTime with no refetch), so flipping the loading
      // flag would just flash a needless spinner on every tab switch.
      const hasCached = queryClient.getQueryData(courseQueryKey(courseId, section)) !== undefined;
      try {
        if (!hasCached) setLoadingSections((prev) => ({ ...prev, [section]: true }));
        // Served from the query cache when fresh; refetched when stale/invalidated.
        const data = await fetchCourseByView(section);
        if (!hasCached) setLoadingSections((prev) => ({ ...prev, [section]: false }));
        if (!data) return;
        setCourse((prev) =>
          prev
            ? {
                ...prev,
                ...(section === 'assignments'
                  ? { assignments: data.assignments ?? prev.assignments ?? [] }
                  : {}),
                ...(section === 'problems'
                  ? { problems: data.problems ?? prev.problems ?? [] }
                  : {}),
                ...(section === 'roster' ? { staff: data.staff ?? prev.staff ?? [] } : {}),
              }
            : {
                ...data,
                assignments: data.assignments ?? [],
                problems: data.problems ?? [],
                staff: data.staff ?? [],
              },
        );
      } catch (error) {
        setLoadingSections((prev) => ({ ...prev, [section]: false }));
        showToast.error('Could not load this tab. Refresh the page to try again.');
        console.error('Error loading tab data:', error);
      }
    },
    [courseId, isStudent, fetchCourseByView, setCourse, queryClient],
  );

  // Invalidate the whole course (all views); the active base query refetches
  // itself, and section tabs re-pull lazily on next visit (their entries are now
  // stale). Awaiting settles once the base refetch completes.
  const refetchCourse = useCallback(async () => {
    if (courseId) await queryClient.invalidateQueries({ queryKey: queryKeys.course.all(courseId) });
  }, [courseId, queryClient]);

  // A student whose SSR payload was summary-shaped (no assignments) needs the full
  // view. staleTime:Infinity won't auto-refetch, so force it once; the ref stops
  // a genuinely empty course from looping.
  const forcedStudentFull = useRef(false);
  useEffect(() => {
    if (isStudent && course && course.assignments.length === 0 && !forcedStudentFull.current) {
      forcedStudentFull.current = true;
      void refetch();
    }
  }, [isStudent, course, refetch]);

  return {
    course,
    setCourse,
    refetchCourse,
    loadTabData,
    loadingSections,
  };
}

export function useTabNavigation() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [tab, setTab] = useState<TabType>((searchParams.get('tab') as TabType) || 'assignments');

  const handleTabChange = useCallback(
    (value: string) => {
      setTab(value as TabType);
      const params = new URLSearchParams(searchParams.toString());
      params.set('tab', value);
      router.replace(`?${params.toString()}`);
    },
    [searchParams, router],
  );

  return { tab, handleTabChange };
}

export function useDialogStates() {
  // Edit course dialog
  const [editOpen, setEditOpen] = useState(false);

  // Problem dialogs
  const [problemOpen, setProblemOpen] = useState(false);
  const [editProblemOpen, setEditProblemOpen] = useState(false);
  const [selectedProblem, setSelectedProblem] = useState<Problem | null>(null);

  // Assignment dialogs
  const [editAssignmentOpen, setEditAssignmentOpen] = useState(false);
  const [selectedAssignment, setSelectedAssignment] = useState<Assignment | null>(null);
  const [createAssignmentOpen, setCreateAssignmentOpen] = useState(false);

  // Delete confirm
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);

  // Publish confirm
  const [publishConfirmOpen, setPublishConfirmOpen] = useState(false);
  const [pendingPublish, setPendingPublish] = useState<boolean | null>(null);

  // Enroll user
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [allUsers, setAllUsers] = useState<EnrollableUser[]>([]);

  return {
    editOpen,
    setEditOpen,

    problemOpen,
    setProblemOpen,
    editProblemOpen,
    setEditProblemOpen,
    selectedProblem,
    setSelectedProblem,

    editAssignmentOpen,
    setEditAssignmentOpen,
    selectedAssignment,
    setSelectedAssignment,
    createAssignmentOpen,
    setCreateAssignmentOpen,
    confirmOpen,
    setConfirmOpen,
    pendingDelete,
    setPendingDelete,

    publishConfirmOpen,
    setPublishConfirmOpen,
    pendingPublish,
    setPendingPublish,

    enrollOpen,
    setEnrollOpen,
    allUsers,
    setAllUsers,
  };
}

/** Matches the dialog's visible cap, so "showing the first N" is the truth. */
const ENROLLABLE_PAGE_SIZE = 50;

export function useEnrollment(course: FullCourse | null) {
  const queryClient = useQueryClient();
  const [allUsers, setAllUsers] = useState<EnrollableUser[]>([]);
  const [enrollableTotal, setEnrollableTotal] = useState(0);

  /**
   * Accounts that can be enrolled, matching `search`.
   *
   * The server decides who is eligible. This used to fetch every account in the
   * installation and subtract the course's roster in the browser, which needed the whole
   * roster in memory to be correct and did not survive either list growing.
   */
  const courseId = course?.id;
  const fetchAvailableUsers = useCallback(
    async (search = '') => {
      if (!courseId) return [] as EnrollableUser[];
      try {
        const q = search.trim();
        const data = await queryClient.fetchQuery({
          queryKey: queryKeys.course.enrollableUsers(courseId, q),
          queryFn: async () => {
            const res = await fetch(
              apiPaths.courseEnrollableUsers(courseId, { q, pageSize: ENROLLABLE_PAGE_SIZE }),
            );
            if (!res.ok) throw new Error('Failed to fetch users');
            return (await res.json()) as { rows: EnrollableUser[]; total: number };
          },
          staleTime: 30_000,
        });
        setAllUsers(data.rows);
        setEnrollableTotal(data.total);
        return data.rows;
      } catch (error) {
        showToast.error('Could not load the user list. Refresh the page to try again.');
        console.error('Error fetching users:', error);
        return [] as EnrollableUser[];
      }
    },
    [courseId, queryClient],
  );

  const handleEnrollUser = useCallback(
    async (user: EnrollableUser, courseId: string, refetchCourse: () => void) => {
      try {
        const res = await fetch(apiPaths.courseRoster(courseId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: user.id }),
        });
        if (!res.ok) throw new Error('Failed to enroll user');
        showToast.success('User enrolled');
        refetchCourse();
      } catch (error) {
        showToast.error('Could not enroll the user. Check your connection and try again.');
        console.error('Error enrolling user:', error);
      }
    },
    [],
  );

  return {
    allUsers,
    enrollableTotal,
    fetchAvailableUsers,
    handleEnrollUser,
  };
}
