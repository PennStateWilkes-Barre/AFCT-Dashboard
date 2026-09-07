import type { Metadata } from 'next';
import type { CourseRole } from '@prisma/client';
import { notFound } from 'next/navigation';
import CourseClient from './CourseClient';
import { WorkspaceSurface } from '@/components/WorkspaceSurface';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { courseLmsLinks } from '@/lib/lti/links';
import { LaunchNotice } from '@/components/lti/LaunchNotice';
import { getCourseRole } from '@/lib/permissions';
import { toStudentSafeEnrolled } from '@/lib/course-format';
import { courseHasStarted } from '@/lib/course-status';
import { CourseNotStarted } from '@/components/course/CourseNotStarted';

export const metadata: Metadata = {
  title: 'Course',
};

type Props = {
  params: Promise<{ id: string }>;
  // Set when an LMS launch landed here rather than on the assignment the link named.
  searchParams?: Promise<{ lms?: string; course?: string }>;
};

export default async function AdminCoursePage({ params, searchParams }: Props) {
  const { id } = await params;
  const { lms, course: noticeSubject } = (await searchParams) ?? {};
  const session = await auth();
  const viewerIsAdmin = Boolean(session?.user?.isAdmin);

  // Resolve the viewer's role first, then gate the load on it (a system admin or
  // any enrolled member). Without this a signed-in non-member who visits
  // /dashboard/courses/<id> would receive the course's roster (names, emails,
  // avatars), registration code, and counts in the SSR payload before any
  // API-route check ran; a 404 also avoids revealing whether the course exists.
  const viewerRole = await getCourseRole(session?.user?.id, id);
  if (!viewerIsAdmin && viewerRole === null) {
    notFound();
  }
  // Only course staff (FACULTY/TA or admin) may see the full roster, including
  // classmate emails. For a student, we don't even query peers' emails, and the
  // roster is reduced to staff names + count-only placeholders below.
  const isStaff = viewerIsAdmin || viewerRole === 'FACULTY' || viewerRole === 'TA';

  const course = await prisma.course.findFirst({
    // Exclude soft-deleted courses; they're hidden from the dashboard for everyone
    // (recovery is out-of-band), so a deleted course 404s here like a missing one.
    where: { id, deletedAt: null },
    include: {
      _count: {
        select: {
          assignments: true,
          problems: true,
          roster: true,
        },
      },
      // Course STAFF only. Students are not seeded with the page: the roster tab pages
      // through GET /api/courses/[id]/roster, so a 1,000-student course no longer inlines
      // its whole roster into the server-rendered HTML. `_count.roster` still carries the
      // total for the tab label.
      roster: {
        where: { role: { in: ['FACULTY', 'TA'] as CourseRole[] } },
        select: {
          role: true,
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              avatar: true,
              cropX: true,
              cropY: true,
              zoom: true,
              // Emails are only for staff; never queried for a student viewer.
              email: isStaff,
            },
          },
        },
      },
    },
  });

  if (!course) {
    notFound();
  }

  // A student may only open a PUBLISHED course; staff/admin may open theirs while
  // unpublished. 404-mask an unpublished course from a student (matches the API's
  // canAccessCourse rule and keeps its existence hidden).
  if (!isStaff && !course.isPublished) {
    notFound();
  }

  // Published but not open yet. Not a 404: the course is listed under Upcoming Courses and a
  // student may well have just registered for it, so the honest answer is when it opens
  // rather than pretending it is not there. `canAccessCourse` refuses its content either way,
  // so every API this page would call is already closed; this is the page saying so in words
  // instead of failing to load. Staff are exempt, as they are at the gate.
  if (!isStaff && !courseHasStarted(course.startDate)) {
    return (
      <WorkspaceSurface>
        <CourseNotStarted
          name={course.name}
          code={course.code}
          startDate={course.startDate}
          timezone={course.timezone}
        />
      </WorkspaceSurface>
    );
  }

  const staffMembers = course.roster.map((r) => ({ ...r.user, courseRole: r.role }));
  // A student still gets staff names without emails; there are no peer rows to strip now.
  const staff = isStaff ? staffMembers : toStudentSafeEnrolled(staffMembers);

  const initialCourse = {
    id: course.id,
    name: course.name,
    code: course.code,
    // Registration/join code is staff-only; never send it to a student's client.
    regCode: isStaff ? course.regCode : null,
    semester: course.semester,
    credits: course.credits,
    startDate: course.startDate,
    endDate: course.endDate,
    registrationOpenAt: course.registrationOpenAt,
    registrationCloseAt: course.registrationCloseAt,
    isPublished: course.isPublished,
    isArchived: course.isArchived,
    deletedAt: course.deletedAt, // always null here: deleted courses are filtered out
    timezone: course.timezone,
    emptyStringNotation: course.emptyStringNotation,
    createdAt: course.createdAt,
    updatedAt: course.updatedAt,
    staff,
    assignments: [],
    problems: [],
    assignmentTotal: course._count.assignments,
    problemTotal: course._count.problems,
    rosterTotal: course._count.roster,
    // Which LMS courses open this one, for the header badge. Read here as well as in the API,
    // because this page renders from its own query and never calls it. Staff only: how a course
    // is wired to an LMS is course administration.
    lmsLinks: isStaff ? await courseLmsLinks(course.id) : [],
    viewerRole,
    viewerIsAdmin,
  };

  return (
    // A work page: one continuous white surface, staff view and student view alike. The
    // wrapper sits here rather than inside CourseClient so the launch notice lands on the
    // surface too; the surface bleeds upward, and would otherwise ride over it.
    <WorkspaceSurface>
      {/* Renders nothing unless a launch sent them here, which is nearly always. */}
      <LaunchNotice notice={lms} courseTitle={noticeSubject} />
      <CourseClient initialCourse={initialCourse} />
    </WorkspaceSurface>
  );
}
