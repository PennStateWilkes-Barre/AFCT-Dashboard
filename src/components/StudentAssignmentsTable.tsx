'use client';

import { BookOpen } from 'lucide-react';

import { useStudentAssignmentColumns } from '@/components/student-assignment-columns';
import { DataTable } from '@/components/ui/data-table';
import { useEffectiveTimezone } from '@/hooks/use-effective-timezone';
import type { FullCourse } from '@/types/course';

interface StudentAssignmentsTableProps {
  course: FullCourse;
}

/**
 * The student's Assignments workspace: a heading and the course's published assignments
 * as a table.
 *
 * This was a list of bordered cards, one per assignment, which meant a student comparing
 * two deadlines had to read two blocks of prose. The shared DataTable puts the same facts
 * in columns they can sort, and brings the stacked phone layout and the empty state every
 * other table here already has.
 *
 * No outer Card. This IS the page's active panel, so wrapping it put a bounded thing
 * inside a bounded thing.
 */
export function StudentAssignmentsTable({ course }: StudentAssignmentsTableProps) {
  const { timezone, hour12 } = useEffectiveTimezone();
  const columns = useStudentAssignmentColumns(timezone, hour12);

  // The API already limits a student to assignments assigned to them, but the same course
  // payload feeds staff previews, so the published filter stays here too.
  const publishedAssignments = course.assignments.filter((assignment) => assignment.isPublished);

  return (
    <section className="space-y-6" aria-labelledby="student-assignments-title">
      <div className="space-y-1">
        {/* The same icon the Course Menu gives this section, so the heading and the rail item
            a student just clicked name the panel the same way. Decorative: the heading beside
            it already says what this is. */}
        <h2
          id="student-assignments-title"
          className="flex items-center gap-2 text-xl font-semibold"
        >
          <BookOpen className="text-muted-foreground size-5 shrink-0" aria-hidden="true" />
          Assignments
        </h2>
        <p className="text-muted-foreground text-sm">
          Open an assignment by clicking on its title.
        </p>
      </div>

      <DataTable
        columns={columns}
        data={publishedAssignments}
        tableLabel="Assignments table"
        // Its own key: the default is shared by every table that omits one, so a page size
        // chosen here would follow the student onto unrelated tables.
        storageKey="student-assignments"
        // Soonest first. The card list was in whatever order the query returned, which is
        // not an order a student can use.
        defaultSorting={[{ id: 'dueDate', desc: false }]}
        // No search, filters, Columns or Export. A student's course has a handful of
        // assignments, all of them on one page, so the toolbar was a row of controls with
        // nothing to do. Sorting stays, on the column headers.
        showToolbar={false}
        defaultPageSize={20}
        emptyTitle="No assignments yet"
        emptyDescription="Your instructor has not published any assignments for this course."
        emptyIcon={BookOpen}
        loadingMessage="Loading assignments, please wait..."
      />
    </section>
  );
}
