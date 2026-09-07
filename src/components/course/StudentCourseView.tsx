'use client';

import { BookOpen, Table } from 'lucide-react';

import { Tabs } from '@/components/ui/tabs';
import { CourseHeaderContent } from '@/components/course/CourseHeader';
import { CourseTabPanel, TabBar, TabRail } from '@/components/course/course-tabs';
import { LocalNavLayout } from '@/components/local-nav';
import { useIsDesktopNav } from '@/hooks/use-desktop-nav';
import { StudentGradesTable } from '@/components/StudentGradesTable';
import { StudentAssignmentsTable } from '@/components/StudentAssignmentsTable';
import type { FullCourse, TabType } from '@/types/course';

interface StudentCourseViewProps {
  course: FullCourse;
  tab: TabType;
  onTabChange: (value: string) => void;
}

/**
 * The student's course page.
 *
 * Structurally the same page as {@link AdminCourseView}: the header sits on the workspace,
 * the shared local rail runs down the side, and the panels take the rest. It reuses every
 * shared piece rather than keeping a student-shaped copy of them, which is how the two
 * views stayed out of step before (a bespoke tab strip here, an active state painted with
 * `bg-secondary` and white text, from back when secondary was a coloured surface).
 *
 * Only the sections differ, and they differ because of what a student may see: Assignments
 * and Grades, and nothing else. No permission is decided here; the sections a student never
 * had access to simply are not in this list.
 */
export function StudentCourseView({ course, tab, onTabChange }: StudentCourseViewProps) {
  // The same lg breakpoint the staff course page uses, from the same hook, so the two
  // switch between rail and strip at the same width.
  const railNav = useIsDesktopNav();

  const publishedCount = course.assignments.filter((a) => a.isPublished).length;
  const tabs = [
    { value: 'assignments', label: 'Assignments', Icon: BookOpen, count: publishedCount },
    { value: 'grades', label: 'Grades', Icon: Table },
  ] as const;

  return (
    <Tabs
      defaultValue="assignments"
      value={tab}
      onValueChange={onTabChange}
      orientation={railNav ? 'vertical' : 'horizontal'}
      // gap-6, and the number is not arbitrary: `dashboard/layout.tsx` puts py-6 above
      // the banner, so this is what makes the air under it match the air over it. It was
      // gap-4, set when that padding was 16px, and it has read as a squeeze ever since.
      //
      // A gap, not a space-y-*. The Tabs primitive is `flex flex-col gap-2`, and a space-y-*
      // on top of that does not replace the gap, it ADDS to it: tailwind-merge only
      // reconciles classes that set the same property, and gap and margin are not the same
      // property. One mechanism, one value.
      className="gap-6"
    >
      <CourseHeaderContent course={course} isStudent />

      {/* One control at a time: two tablists under one Tabs root would emit the same
          `tab-*` ids that each panel points its aria-labelledby at. */}
      <LocalNavLayout
        breakpoint="lg"
        nav={
          railNav ? (
            <TabRail tabs={tabs} ariaLabel="Course sections" menuLabel="Course Menu" linkPanels />
          ) : (
            <TabBar
              ariaLabel="Course sections"
              selectId="student-course-tab-select"
              value={tab}
              onValueChange={onTabChange}
              linkPanels
              // Two sections. Spreading them across the width reads as a layout accident
              // rather than a choice.
              fill={false}
              tabs={tabs}
            />
          )
        }
      >
        <CourseTabPanel value="assignments" active={tab === 'assignments'}>
          <StudentAssignmentsTable course={course} />
        </CourseTabPanel>

        <CourseTabPanel value="grades" active={tab === 'grades'}>
          <StudentGradesTable courseId={course.id} />
        </CourseTabPanel>
      </LocalNavLayout>
    </Tabs>
  );
}
