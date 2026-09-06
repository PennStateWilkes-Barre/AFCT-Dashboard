'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import type { Problem, Course } from '@prisma/client';

import { showToast } from '@/lib/toast';
import type { EnrollableUser } from '@/types/course';
import {
  useCourseData,
  useTabNavigation,
  useDialogStates,
  useEnrollment,
} from '@/hooks/use-course';
import { useCourseHandlers } from '@/lib/course-handlers';
import { useEffectiveTimezone } from '@/hooks/use-effective-timezone';
import { StudentCourseView } from '@/components/course/StudentCourseView';
import { AdminCourseView } from '@/components/course/AdminCourseView';
import LoadingSpinner from '@/components/ui/loading-spinner';
import { CourseDialogs } from '@/components/course/CourseDialogs';
import type { FullCourse } from '@/types/course';
import type { TabType } from '@/types/course';
import { queryKeys } from '@/lib/query-keys';

export default function CourseClient({ initialCourse }: { initialCourse?: FullCourse | null }) {
  const { id } = useParams();
  const courseId = Array.isArray(id) ? id[0] : id;
  const queryClient = useQueryClient();
  // A viewer is a (non-privileged) student when they are NOT a global admin AND
  // their per-course role is not staff (FACULTY/TA). Derive from the initial
  // course payload so the data hook can request the correct view up front.
  const initialIsStudent =
    !initialCourse?.viewerIsAdmin &&
    initialCourse?.viewerRole !== 'FACULTY' &&
    initialCourse?.viewerRole !== 'TA';
  const { course, setCourse, refetchCourse, loadTabData, loadingSections } = useCourseData(
    courseId || '',
    {
      initialCourse: initialCourse ?? null,
      isStudent: initialIsStudent,
    },
  );
  const isStudent =
    !course?.viewerIsAdmin && course?.viewerRole !== 'FACULTY' && course?.viewerRole !== 'TA';
  const { tab, handleTabChange } = useTabNavigation();
  const dialogStates = useDialogStates();
  const { allUsers, enrollableTotal, fetchAvailableUsers, handleEnrollUser } =
    useEnrollment(course);
  const handlers = useCourseHandlers(course, setCourse);
  const [bulkEnrollOpen, setBulkEnrollOpen] = useState(false);
  const { timezone } = useEffectiveTimezone();

  const openEnrollDialog = useCallback(async () => {
    const users = await fetchAvailableUsers();
    dialogStates.setAllUsers(users);
    dialogStates.setEnrollOpen(true);
  }, [fetchAvailableUsers, dialogStates]);

  // The dialog searches server-side, so each debounced term is a fresh (cached) request.
  const handleEnrollSearchChange = useCallback(
    (q: string) => {
      void fetchAvailableUsers(q);
    },
    [fetchAvailableUsers],
  );

  const openBulkEnrollDialog = useCallback(() => {
    setBulkEnrollOpen(true);
  }, []);

  // After a bulk enroll, refresh the course (summary counts) and re-pull the
  // roster section so the newly enrolled students appear in the roster table.
  const handleBulkEnrollComplete = useCallback(async () => {
    await refetchCourse();
    await loadTabData('roster');
  }, [refetchCourse, loadTabData]);

  const handleProblemEditClick = useCallback(
    (problem: Problem) => {
      dialogStates.setSelectedProblem(problem);
      dialogStates.setEditProblemOpen(true);
    },
    [dialogStates],
  );

  const handleProblemDeleteClick = useCallback(
    (problemId: string) => {
      dialogStates.setPendingDelete({ id: problemId, type: 'problem' });
      dialogStates.setConfirmOpen(true);
    },
    [dialogStates],
  );

  const handleAssignmentDeleteClick = useCallback(
    (assignmentId: string) => {
      dialogStates.setPendingDelete({ id: assignmentId, type: 'assignment' });
      dialogStates.setConfirmOpen(true);
    },
    [dialogStates],
  );

  const handleConfirm = useCallback(() => {
    if (dialogStates.pendingDelete) {
      void handlers.handleDelete(dialogStates.pendingDelete);
    }
    dialogStates.setConfirmOpen(false);
    dialogStates.setPendingDelete(null);
  }, [dialogStates, handlers]);

  const handleCancel = useCallback(() => {
    dialogStates.setConfirmOpen(false);
    dialogStates.setPendingDelete(null);
  }, [dialogStates]);

  const handlePublishToggle = useCallback(
    (checked: boolean) => {
      dialogStates.setPendingPublish(checked);
      dialogStates.setPublishConfirmOpen(true);
    },
    [dialogStates],
  );

  const handlePublishConfirm = useCallback(async () => {
    if (dialogStates.pendingPublish !== null) {
      await handlers.handleCoursePublishToggle(dialogStates.pendingPublish);
    }
    dialogStates.setPublishConfirmOpen(false);
    dialogStates.setPendingPublish(null);
  }, [dialogStates, handlers]);

  const handlePublishCancel = useCallback(() => {
    dialogStates.setPublishConfirmOpen(false);
    dialogStates.setPendingPublish(null);
  }, [dialogStates]);

  const handleEnrollUserWrapper = useCallback(
    async (user: EnrollableUser) => {
      if (!courseId) return;
      await handleEnrollUser(user, courseId, () => void refetchCourse());
    },
    [handleEnrollUser, courseId, refetchCourse],
  );

  // The Settings tab's inline form has already persisted the change and hands us
  // the server's updated course; just merge it into local state and confirm.
  const handleCourseSaved = useCallback(
    (updated: Partial<Course>) => {
      setCourse((prev) => (prev ? { ...prev, ...updated } : prev));
      // Saving course settings changes fields the Courses list and the sidebar nav
      // render (name, code, dates, timezone, published/archived state), so invalidate
      // the whole ['courses'] prefix. Without this the list keeps its cached row until
      // its 30s staleTime elapses, forcing a manual refresh.
      void queryClient.invalidateQueries({ queryKey: queryKeys.courses.all() });
      showToast.updated('Course');
    },
    [setCourse, queryClient],
  );

  useEffect(() => {
    if (!isStudent) {
      void loadTabData(tab as TabType);
    }
  }, [isStudent, loadTabData, tab]);

  if (!course)
    return <LoadingSpinner label="Loading" fullScreen={false} className="min-h-[70vh]" />;

  return (
    // No sr-only <h1> here. CourseHeaderContent's title already carries
    // role="heading" aria-level={1}, so this one made every course page announce two
    // level-one headings with the same text. Both views render that header now.
    <div className="space-y-6">
      {isStudent ? (
        <StudentCourseView course={course} tab={tab as TabType} onTabChange={handleTabChange} />
      ) : (
        <AdminCourseView
          course={course}
          tab={tab}
          isAssignmentsLoading={tab === 'assignments' && !isStudent && loadingSections.assignments}
          isProblemsLoading={tab === 'problems' && !isStudent && loadingSections.problems}
          onTabChange={(value) => {
            handleTabChange(value);
          }}
          onCreateAssignment={() => dialogStates.setCreateAssignmentOpen(true)}
          onCreateProblem={() => dialogStates.setProblemOpen(true)}
          onEnrollUser={openEnrollDialog}
          onBulkEnroll={openBulkEnrollDialog}
          onAssignmentDelete={handleAssignmentDeleteClick}
          onAssignmentPublishToggle={handlers.handleAssignmentPublishToggle}
          onProblemEdit={handleProblemEditClick}
          onProblemDelete={handleProblemDeleteClick}
          onRefreshCourse={refetchCourse}
          onCourseSaved={handleCourseSaved}
          onPublishToggle={handlePublishToggle}
        />
      )}

      {!isStudent && (
        <CourseDialogs
          course={course}
          timeZone={timezone}
          problemOpen={dialogStates.problemOpen}
          setProblemOpen={dialogStates.setProblemOpen}
          editProblemOpen={dialogStates.editProblemOpen}
          setEditProblemOpen={dialogStates.setEditProblemOpen}
          selectedProblem={dialogStates.selectedProblem}
          setSelectedProblem={dialogStates.setSelectedProblem}
          onProblemCreated={handlers.handleProblemCreated}
          onProblemSaved={handlers.handleProblemSaved}
          createAssignmentOpen={dialogStates.createAssignmentOpen}
          setCreateAssignmentOpen={dialogStates.setCreateAssignmentOpen}
          onAssignmentCreate={handlers.handleAssignmentCreate}
          confirmOpen={dialogStates.confirmOpen}
          pendingDelete={dialogStates.pendingDelete}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
          publishConfirmOpen={dialogStates.publishConfirmOpen}
          pendingPublish={dialogStates.pendingPublish}
          onPublishConfirm={handlePublishConfirm}
          onPublishCancel={handlePublishCancel}
          enrollOpen={dialogStates.enrollOpen}
          setEnrollOpen={dialogStates.setEnrollOpen}
          allUsers={allUsers}
          enrollableTotal={enrollableTotal}
          onEnrollSearchChange={handleEnrollSearchChange}
          onEnrollUser={handleEnrollUserWrapper}
          bulkEnrollOpen={bulkEnrollOpen}
          setBulkEnrollOpen={setBulkEnrollOpen}
          onBulkEnrollComplete={handleBulkEnrollComplete}
        />
      )}
    </div>
  );
}
