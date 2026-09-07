'use client';

import React from 'react';
import { Book, Check, Copy, Link as LinkIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { COURSE_LIFECYCLE_BADGE } from '@/lib/badge-presets';
import { Button } from '@/components/ui/button';
import type { FullCourse } from '@/types/course';
import { getInstructors, type EnrolledUser } from '@/lib/course-roster';
import { showToast } from '@/lib/toast';
import { formatRegistrationCode } from '@/lib/format-registration-code';
import { LmsLinkBadge } from '@/components/lti/LmsLinkBadge';
import {
  IdentityPanel,
  IdentityPanelIcon,
  IDENTITY_BADGE,
  IDENTITY_ICON_BUTTON,
} from '@/components/IdentityPanel';

interface CourseHeaderProps {
  course: FullCourse;
  isStudent: boolean;
}

/**
 * The course registration code plus one-click copy of the code and of a shareable
 * invite link. The code is shown grouped as `ABCD-EFGH` for readability, but the
 * copied value is the plain 8-character code the join endpoint expects; the invite
 * link is `/dashboard?joinCode=<code>`, which joins the course on open.
 */
function RegistrationCode({ code }: { code: string }) {
  const [copied, setCopied] = React.useState<null | 'code' | 'link'>(null);
  const formatted = formatRegistrationCode(code);

  const copy = async (value: string, which: 'code' | 'link', okMsg: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
      showToast.success(okMsg);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      showToast.error('Could not copy to the clipboard. Select the code and copy it manually.');
    }
  };

  const copyCode = () => void copy(code, 'code', 'Registration code copied');
  const copyLink = () =>
    void copy(`${window.location.origin}/dashboard?joinCode=${code}`, 'link', 'Invite link copied');

  return (
    <span className="flex items-center gap-1.5">
      <span className="text-course-banner-muted-foreground">Registration Code: </span>
      <span className="font-mono font-medium tracking-wide">{formatted}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={IDENTITY_ICON_BUTTON}
        onClick={copyCode}
        aria-label={
          copied === 'code' ? 'Registration code copied' : `Copy registration code ${formatted}`
        }
        title="Copy registration code"
      >
        {/* The one green left in the banner, and it is a status rather than part of the
            identity: this is the app's "that worked" colour, lightened to read on navy the way
            every other value here is. */}
        {copied === 'code' ? (
          <Check className="size-3.5 text-emerald-300" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={IDENTITY_ICON_BUTTON}
        onClick={copyLink}
        aria-label={copied === 'link' ? 'Invite link copied' : 'Copy invite link'}
        title="Copy invite link"
      >
        {copied === 'link' ? (
          <Check className="size-3.5 text-emerald-300" />
        ) : (
          <LinkIcon className="size-3.5" />
        )}
      </Button>
    </span>
  );
}

/**
 * The course banner: the icon, the title, the badges and (for staff) the faculty/TA/
 * registration line, on the branded navy surface every course page opens with.
 *
 * ONE implementation for both views. AdminCourseView and StudentCourseView used to wrap
 * this in their own `<section className="grid grid-cols-1 gap-3">`, which meant the shell
 * was described twice and could drift; it belongs to the header, so it lives here.
 *
 * The surface, the network, the padding and the height floor all come from `IdentityPanel`,
 * which the assignment page uses too; only what goes inside differs. Read the note there before
 * changing anything here, in particular the rule that nothing inside a banner may use a page
 * token or a `dark:` utility.
 */
export function CourseHeaderContent({ course, isStudent }: CourseHeaderProps) {
  const normalizeDate = (value?: string | Date | null) => {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  };
  const startDate = normalizeDate(course.startDate);
  const endDate = normalizeDate(course.endDate);

  // Which dates put the course in which state is this component's business; which colour
  // that state gets is not. See lib/badge-presets, which the courses table reads too. The
  // banner then renders it in its own fixed chip; see IDENTITY_BADGE for why.
  const courseStatus = (() => {
    if (!startDate || !endDate) {
      return { label: 'Upcoming', theme: { variant: COURSE_LIFECYCLE_BADGE.upcoming } };
    }
    const now = Date.now();
    if (now < startDate.getTime()) {
      return { label: 'Upcoming', theme: { variant: COURSE_LIFECYCLE_BADGE.upcoming } };
    }
    if (now > endDate.getTime()) {
      return { label: 'Closed', theme: { variant: COURSE_LIFECYCLE_BADGE.closed } };
    }
    return { label: 'Open', theme: { variant: COURSE_LIFECYCLE_BADGE.open } };
  })();

  // Everyone's, and complete: the header names every faculty member and TA. The course
  // payload carries exactly those two roles, and a student's copy of it keeps their names
  // while dropping their emails (`toStudentSafeEnrolled`), so this line is safe to show to
  // a student. Who teaches the course is the first thing they look for on it.
  const staff: EnrolledUser[] = course.staff ?? [];
  const formatAllNames = (users: EnrolledUser[]) => {
    if (!Array.isArray(users) || users.length === 0) return 'None assigned';
    return users
      .map((u) => `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim())
      .filter(Boolean)
      .join(', ');
  };
  const facultyNames = formatAllNames(getInstructors(staff));
  const tas = staff.filter((u) => u.courseRole === 'TA');
  const registrationCode = (course.regCode ?? '').toUpperCase();

  // -- render ---------------------------------------------------------------
  return (
    <IdentityPanel labelledBy="course-page-title">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        {/*
            basis-full below sm, a growing basis-0 above it, and that split is load-bearing.

            The badges are shrink-0 and about 290px wide. At `flex-1` (which is basis-0) the
            title's own basis is zero, so on a 390px screen the badge row took the whole line
            and left the heading nothing: the course name came out stacked one letter per line,
            1500px tall. A full basis makes the title claim its own row and pushes the badges
            onto the next one, which is also the order this is supposed to have on a phone.

            break-words, not overflow-wrap:anywhere. `anywhere` is the value that also shrinks
            an element's min-content width, which is what let the collapse above happen in the
            first place; this one only breaks a word that genuinely cannot fit.

            min-w-0 so a long course name wraps instead of pushing the badges off the banner.
            The title is never truncated here: this is the one place the whole name belongs.

            The 24rem floor above sm is what decides when the badges give up and take their own
            row. The badge row is a fixed ~290px, so on a 1024px screen the title was left with
            335px and "CMPSC 131: Programming and Computation I: Fundamentals" came down in
            four lines beside three chips. A minimum makes flex-wrap do the arithmetic: below
            roughly 700px of banner the badges drop to the next line and the title gets the
            width, above it they sit alongside as they should.
          */}
        <h1
          id="course-page-title"
          className="flex min-w-0 basis-full items-start gap-3 text-2xl leading-tight font-semibold tracking-tight sm:min-w-96 sm:grow sm:basis-0 sm:gap-4"
        >
          {/* The Book that marks a course everywhere else in the app. */}
          <IdentityPanelIcon icon={Book} />
          {/* One title, one colour. The code used to be muted and the name foreground,
                which broke "CMPSC 131: Programming and Computation I" into two ranks for no
                reason; its position already tells you which part is the code. */}
          <span className="min-w-0 break-words">
            {course.code}: {course.name}
          </span>
        </h1>

        {/* Indented to the title's text on the same terms the metadata below is, which only
              shows when the row has wrapped underneath: pushed right by justify-between on a
              wide banner, the padding costs nothing. Without it a wrapped badge row sat
              against the banner edge while the faculty line under it started 72px in.

              The padding also decides, as a side effect, when the row wraps at all: it counts
              towards the badges' flex width, so between roughly 640 and 700px of banner the
              badges take their own line and the title gets the full width rather than being
              squeezed to its 24rem floor. Removing it puts a long course name into four lines
              beside three chips, which is taller than the wrap it avoids. */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:pl-[4.5rem]">
          <Badge variant="secondary" className={IDENTITY_BADGE}>
            {course.semester}
          </Badge>
          <Badge variant="outline" className={IDENTITY_BADGE}>
            {course.credits} credit{course.credits === 1 ? '' : 's'}
          </Badge>
          <Badge variant={courseStatus.theme.variant} className={IDENTITY_BADGE}>
            {courseStatus.label}
          </Badge>
          {/* Only staff receive `lmsLinks`, so this is empty for a student and renders
                nothing. It sits last because it is the one badge that is often absent, and
                a row that changes length at the end is easier to read than one that shifts
                in the middle. */}
          {!isStudent && <LmsLinkBadge links={course.lmsLinks ?? []} className={IDENTITY_BADGE} />}
        </div>
      </div>

      {/* Faculty, TAs (only when there are any), then the registration code + copy.
            Indented to the title's text rather than the banner edge on wide screens, so the
            identity block reads as one column: the sm icon is 56px and the gap beside it 16.
            No indent below sm, where the rows are stacked full width anyway.

            The names are for everyone; the registration code is not. A student is never
            sent one (`regCode` is null in their payload), so this guard is the second of
            two rather than the only one, and it is here so that a change to the payload
            cannot quietly put a join code on a student's screen. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm sm:pl-[4.5rem]">
        <span>
          <span className="text-course-banner-muted-foreground">Faculty: </span>
          <span className="font-medium">{facultyNames}</span>
        </span>
        {tas.length > 0 && (
          <span>
            <span className="text-course-banner-muted-foreground">TAs: </span>
            <span className="font-medium">{formatAllNames(tas)}</span>
          </span>
        )}
        {!isStudent && registrationCode ? <RegistrationCode code={registrationCode} /> : null}
      </div>
    </IdentityPanel>
  );
}
