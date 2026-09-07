import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { showToast } from '@/lib/toast';
import type { FullCourse, DeleteTarget } from '@/types/course';
import type { Assignment, Problem, Course } from '@prisma/client';
import { queryKeys } from '@/lib/query-keys';
import {
  deleteItem,
  updateCourseAfterDelete,
  updateCourseAfterAssignmentSave,
  updateCourseAfterAssignmentPublish,
  updateCourseAfterProblemSave,
  updateCourseAfterAssignmentCreate,
  updateCourseAfterProblemCreate,
  updateAssignmentPublishStatus,
  updateCoursePublishStatus,
  saveCourse,
} from '@/lib/course-mutations';

export function useCourseHandlers(
  course: FullCourse | null,
  setCourse: React.Dispatch<React.SetStateAction<FullCourse | null>>,
) {
  const queryClient = useQueryClient();

  // Assignment handlers
  const handleAssignmentEditClick = useCallback((assignment: Assignment) => {
    return assignment;
  }, []);

  const handleAssignmentDeleteClick = useCallback((assignmentId: string) => {
    return assignmentId;
  }, []);

  const handleAssignmentSave = useCallback(
    async (updatedAssignment: Assignment) => {
      if (!course) return;
      setCourse(updateCourseAfterAssignmentSave(course, updatedAssignment));
      showToast.updated('Assignment', { name: updatedAssignment.title });
    },
    [course, setCourse],
  );

  const handleAssignmentPublishToggle = useCallback(
    async (assignmentId: string, newValue: boolean) => {
      if (!course) return;

      try {
        await updateAssignmentPublishStatus(course.id, assignmentId, newValue);
        setCourse(updateCourseAfterAssignmentPublish(course, assignmentId, newValue));
        showToast.success(`Assignment ${newValue ? 'published' : 'unpublished'}`);
      } catch (error) {
        const msg =
          (error instanceof Error && error.message) ||
          'Could not change whether the assignment is published. Check your connection and try again.';
        showToast.error(msg);
        console.error('Error updating assignment:', error);
      }
    },
    [course, setCourse],
  );

  // These three take no toast on purpose. The dialog that performed the write already reported
  // it, and it is the only place that knows whether the write fully succeeded; a second message
  // here is what produced two toasts for one created assignment. Callbacks update state.
  const handleAssignmentCreate = useCallback(
    (newAssignment: Assignment) => {
      if (!course) return;
      setCourse(updateCourseAfterAssignmentCreate(course, newAssignment));
    },
    [course, setCourse],
  );

  // Problem handlers
  const handleProblemEditClick = useCallback((problem: Problem) => {
    return problem;
  }, []);

  const handleProblemDeleteClick = useCallback((problemId: string) => {
    return problemId;
  }, []);

  const handleProblemCreated = useCallback(
    (newProblem?: Problem) => {
      if (!course || !newProblem) return;
      setCourse(updateCourseAfterProblemCreate(course, newProblem));
    },
    [course, setCourse],
  );

  const handleProblemSaved = useCallback(
    (updatedProblem?: Problem) => {
      if (!course || !updatedProblem) return;
      setCourse(updateCourseAfterProblemSave(course, updatedProblem));
    },
    [course, setCourse],
  );

  // Delete handler
  const handleDelete = useCallback(
    async (target: DeleteTarget) => {
      if (!course) return;

      try {
        // Read the title before the delete removes the row from local state, so the toast can
        // say which one went. Working down a list, "Problem deleted" alone is not an answer.
        const name =
          target.type === 'assignment'
            ? course.assignments.find((a) => a.id === target.id)?.title
            : course.problems.find((p) => p.id === target.id)?.title;
        await deleteItem(target, course.id);
        setCourse(updateCourseAfterDelete(course, target));
        showToast.deleted(target.type === 'assignment' ? 'Assignment' : 'Problem', { name });
      } catch (err) {
        showToast.error(
          `Could not delete the ${target.type}. Check your connection and try again.`,
        );
        console.error(err);
      }
    },
    [course, setCourse],
  );

  // Course save handler
  const handleCourseSave = useCallback(
    async (updatedCourse: Partial<Course>) => {
      if (!course) return;
      try {
        const fullCourse = { ...course, ...updatedCourse };
        const updated = await saveCourse(fullCourse);
        setCourse((prev) => (prev ? { ...prev, ...updated } : prev));
        showToast.updated('Course');
      } catch {
        showToast.error('Could not save the course. Check your connection and try again.');
      }
    },
    [course, setCourse],
  );

  // Course publish handler
  const handleCoursePublishToggle = useCallback(
    async (isPublished: boolean) => {
      if (!course) return;

      try {
        const updated = await updateCoursePublishStatus(course.id, isPublished);
        setCourse((prev) => (prev ? { ...prev, isPublished: updated.isPublished } : prev));
        // Published state drives the Courses list and the sidebar nav, so invalidate the
        // whole ['courses'] prefix; otherwise the list keeps its stale row until staleTime.
        void queryClient.invalidateQueries({ queryKey: queryKeys.courses.all() });
        showToast.success(isPublished ? 'Course published' : 'Course unpublished');
      } catch (error) {
        const msg =
          (error instanceof Error && error.message) ||
          'Could not change whether the course is published. Check your connection and try again.';
        showToast.error(msg);
      }
    },
    [course, setCourse, queryClient],
  );

  return {
    handleAssignmentEditClick,
    handleAssignmentDeleteClick,
    handleAssignmentSave,
    handleAssignmentPublishToggle,
    handleAssignmentCreate,

    handleProblemEditClick,
    handleProblemDeleteClick,
    handleProblemCreated,
    handleProblemSaved,

    handleDelete,
    handleCourseSave,
    handleCoursePublishToggle,
  };
}
