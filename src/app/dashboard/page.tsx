import type { Metadata } from 'next';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import DashboardClient from './DashboardClient';
import { DueDateModule } from '@/components/modules/DueDateModule';
import { JoinCourseModule } from '@/components/modules/JoinCourseModule';
import { WelcomePanel } from '@/components/dashboard/WelcomePanel';
import { greetingFor } from '@/lib/greeting';
import { DEFAULT_SYSTEM_TIMEZONE } from '@/lib/system-settings';
import { toStudentSafeEnrolled } from '@/lib/course-format';
import { getCourseDateBucket } from '@/lib/course-status';
import {
  assignedToStudentWhere,
  groupIdsFromOverrides,
  overridesForStudentWhere,
} from '@/lib/assignment-visibility';
import { effectiveDeadline } from '@/lib/effective-deadline';
import { LaunchNotice } from '@/components/lti/LaunchNotice';

export const metadata: Metadata = {
  title: 'AFCT Dashboard',
};

export default async function DashboardPage({
  searchParams,
}: {
  // Set when a launch from an LMS could not open a course and sent them here instead.
  searchParams: Promise<{ lms?: string; course?: string }>;
}) {
  const session = await auth();
  const { lms, course: lmsCourseTitle } = await searchParams;

  if (!session?.user) {
    return (
      // A callout, not a saturated block. `bg-destructive` with white text is 2.89:1 in
      // dark, because --destructive lightens there to work as TEXT; the status-danger
      // triad is the pairing built for a filled message and is theme-aware.
      <div
        role="alert"
        className="border-status-danger-border bg-status-danger-bg text-status-danger rounded border p-4 text-lg"
      >
        You are not signed in.
      </div>
    );
  }

  // Get user's id
  const { id } = session.user;

  // Greeting name. Falls back to the first word of the display name, then to no name at
  // all, so this never renders "Welcome back, undefined" or a dangling comma.
  const firstName =
    session.user.firstName?.trim() || session.user.name?.trim().split(/\s+/)[0] || '';

  // Get all courses for the user via roster entries
  const rosterEntries = await prisma.roster.findMany({
    where: {
      userId: id,
      // A course the viewer was dropped from (as a student) leaves their dashboard; their
      // staff courses and active enrollments stay.
      NOT: { role: 'STUDENT', status: 'DROPPED' },
      course: {
        // Never surface archived or soft-deleted courses on the dashboard (archiving
        // or deleting a course does not flip isPublished, so students could otherwise
        // still see a published-then-archived course and its upcoming assignments).
        isArchived: false,
        deletedAt: null,
        endDate: {
          gte: new Date(),
        },
      },
    },
    select: {
      role: true,
      courseId: true,
      course: {
        select: {
          id: true,
          name: true,
          code: true,
          semester: true,
          credits: true,
          startDate: true,
          endDate: true,
          isPublished: true,
          isArchived: true,
          roster: {
            // Drop dropped students from the card's roster so the staff-facing student
            // count reflects the active class (staff rows are always kept).
            where: { NOT: { role: 'STUDENT', status: 'DROPPED' } },
            select: {
              role: true,
              user: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                },
              },
            },
          },
        },
      },
    },
  });

  // Map courses and attach the user's role in each. A student must not even see an
  // unpublished course they're enrolled in (e.g. a faculty pre-enroll before
  // release); staff/admin see theirs regardless of publish state.
  const viewerIsAdmin = Boolean(session.user.isAdmin);
  const courses = rosterEntries
    .filter(
      (entry) =>
        viewerIsAdmin ||
        entry.role === 'FACULTY' ||
        entry.role === 'TA' ||
        entry.course.isPublished,
    )
    .map((entry) => {
      const { course } = entry;
      // The viewer's role in THIS course decides roster visibility: staff see the
      // members; a student must not receive classmate names, so their roster is
      // reduced to staff names + count-only placeholders (the cards only show
      // instructor/TA names and a staff-gated student count).
      const isStaffHere = viewerIsAdmin || entry.role === 'FACULTY' || entry.role === 'TA';
      const enrolledMembers = course.roster.map((r) => ({ ...r.user, courseRole: r.role }));

      return {
        ...course,
        userRole: entry.role,
        enrolled: isStaffHere ? enrolledMembers : toStudentSafeEnrolled(enrolledMembers),
      };
    });

  const courseIds = courses.map((c) => c.id);

  // Split the courses by the viewer's role in each, using the same staff test as the
  // cards above. Upcoming Assignments is cross-course and one person can be a student in
  // one course and staff in another, so the audience filter has to be applied per course
  // rather than to the whole query.
  const staffCourseIds = rosterEntries
    .filter((entry) => viewerIsAdmin || entry.role === 'FACULTY' || entry.role === 'TA')
    .map((entry) => entry.courseId)
    .filter((courseId) => courseIds.includes(courseId));
  const studentCourseIds = courseIds.filter((courseId) => !staffCourseIds.includes(courseId));

  // The dashboard cards show only in-progress courses, matching the sidebar's
  // "Current Courses" bucket. Upcoming courses live in the sidebar's Upcoming
  // section; they still feed the (cross-course) Upcoming Assignments list above.
  const currentCourses = courses.filter((c) => getCourseDateBucket(c) === 'current');

  // NOTE: the "pending grading" module was removed. Its map was never populated
  // (nothing ever inserted a first entry), so it always rendered empty while still
  // running two unbounded submission/grade queries on this (the most-visited)
  // page. The feature can be rebuilt properly later; until then it does no work.

  // Get upcoming assignments for all the user's courses, resolved for THIS user: a
  // student with a due-date override sees (and is sorted by) their own effective due
  // date. Staff have no override rows, so they see the base dates unchanged. The query
  // matches on the base due OR an override that applies to them, their group's included, so
  // an extension into the future still surfaces even when the base date has passed.
  const now = new Date();
  const rawAssignments =
    courseIds.length === 0
      ? []
      : await prisma.assignment.findMany({
          where: {
            isPublished: true,
            // Audience, per course. In a course they teach, staff see everything they
            // set; in a course they are a student in, they see only work assigned to
            // them - directly, via a group, or to everyone.
            //
            // This used to be a single "assignedToEveryone OR I have an override" test,
            // which under-showed badly in both directions: a student assigned by an
            // assignee row without a date override never saw their own assignment, and
            // neither did the instructor who scoped it to them.
            OR: [
              { courseId: { in: staffCourseIds } },
              {
                courseId: { in: studentCourseIds },
                // Published AND opened. `studentCourseIds` is already built from the
                // published list, but this panel is a student's "what is due" and the cost of
                // being wrong is a deadline for work they cannot reach, so the rule is stated
                // here rather than inherited from how the list above happened to be filtered.
                course: { isPublished: true, startDate: { lte: now } },
                ...assignedToStudentWhere(id),
              },
            ],
            // Base due OR this user's override due is in the future, so an extension
            // still surfaces once the base date has passed.
            AND: [
              {
                OR: [
                  { dueDate: { gt: now } },
                  {
                    overrides: {
                      some: {
                        AND: [overridesForStudentWhere(id), { dueDate: { gt: now } }],
                      },
                    },
                  },
                ],
              },
            ],
          },
          select: {
            id: true,
            title: true,
            dueDate: true,
            unlockAt: true,
            allowLateSubmissions: true,
            lateCutoff: true,
            courseId: true,
            // Their own STUDENT row and the GROUP row for any group they are in. Selecting
            // `{ userId: id }` alone meant a group extension never applied, and because the
            // filter above widens on group overrides the row was fetched and then dropped by
            // the "still upcoming" filter below: work they still had time on vanished from
            // the panel whose whole job is to say what is due.
            overrides: {
              where: overridesForStudentWhere(id),
              select: {
                targetType: true,
                userId: true,
                groupId: true,
                unlockAt: true,
                dueDate: true,
                lateCutoff: true,
                allowLateSubmissions: true,
              },
            },
            // The module labels each row with its course so multi-course users can
            // tell which "Lab 3" is which.
            course: { select: { code: true } },
          },
          orderBy: { dueDate: 'asc' },
        });

  const assignments = rawAssignments
    .map((a) => {
      const eff = effectiveDeadline(
        {
          unlockAt: a.unlockAt,
          dueDate: a.dueDate,
          allowLateSubmissions: a.allowLateSubmissions,
          lateCutoff: a.lateCutoff,
        },
        a.overrides,
        id,
        groupIdsFromOverrides(a.overrides),
      );
      return {
        id: a.id,
        title: a.title,
        courseId: a.courseId,
        course: a.course,
        dueDate: eff.dueDate,
      };
    })
    // Drop rows whose effective due has already passed (base was in range but the
    // override moved it into the past).
    .filter((a) => a.dueDate > now)
    .sort((x, y) => x.dueDate.getTime() - y.dueDate.getTime());

  // Whose morning it is.
  //
  // Read from the database rather than from the session, which is the trap here: the session
  // type declares `timezone`, but the JWT callback never puts one in it, so `session.user
  // .timezone` is undefined for everybody and reads as "no preference" instead of failing. Two
  // primary-key lookups in parallel, which is the one query this panel costs and the reason it
  // can greet correctly: AFCT runs at five universities across four US timezones off a single
  // installation, and the server's own clock belongs to none of them.
  const [profile, settings] = await Promise.all([
    prisma.user.findUnique({ where: { id }, select: { timezone: true } }),
    prisma.systemSettings.findUnique({ where: { id: 1 }, select: { timezone: true } }),
  ]);
  const greeting = greetingFor(
    new Date(),
    profile?.timezone || settings?.timezone || DEFAULT_SYSTEM_TIMEZONE,
  );

  // Counted off the two arrays this page already built, so the summary costs no query.
  const courseSummary =
    currentCourses.length === 1 ? '1 current course' : `${currentCourses.length} current courses`;
  const upcomingCount = assignments.length;
  const assignmentSummary =
    upcomingCount === 0
      ? 'No upcoming assignments'
      : upcomingCount === 1
        ? '1 upcoming assignment'
        : `${upcomingCount} upcoming assignments`;

  return (
    // A fixed rail rather than a quarter of the viewport: at 25% the two modules kept
    // growing on a wide monitor while the courses beside them stayed the same size.
    // items-start keeps the rail from stretching to the left column's height.
    // The single-column case needs minmax(0,1fr) spelled out: an implicit grid column is
    // sized `auto`, whose minimum is the content's min-content width, so on a phone the
    // registration-code boxes pushed the whole page 66px wider than the screen.
    <div className="grid w-full grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_21rem] xl:grid-cols-[minmax(0,1fr)_23rem]">
      <section className="min-w-0">
        {/* Replaces the sr-only "Dashboard" h1, and sits inside the left column so the
            rail starts level with it rather than below the whole greeting. The counts are
            passed in already worded: they are counted off the two arrays this page has
            just built, so the panel is presentation and costs no query. */}
        <WelcomePanel
          greeting={greeting}
          firstName={firstName}
          courseSummary={courseSummary}
          assignmentSummary={assignmentSummary}
        />

        {/* Renders nothing unless an LMS launch sent them here, which is most of the time. */}
        <LaunchNotice notice={lms} courseTitle={lmsCourseTitle} />
        <DashboardClient
          sessionUser={{ id, isAdmin: session.user.isAdmin ?? false }}
          courses={currentCourses}
          title={'Courses'}
        />
      </section>

      <aside className="space-y-4 self-start">
        <JoinCourseModule />
        <DueDateModule assignments={assignments} />
      </aside>
    </div>
  );
}
