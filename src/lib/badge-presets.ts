import type { badgeVariants } from '@/components/ui/badge';
import type { VariantProps } from 'class-variance-authority';

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

/**
 * Which badge treatment a settled concept gets.
 *
 * Mapping only. Nothing here decides whether a submission is late or a course is open: that
 * is domain logic and stays where the domain lives. This file exists because the same
 * concept was being mapped to a colour in several components at once, and two of them had
 * already drifted.
 */

/**
 * A course's own lifecycle, from its start and end dates.
 *
 * Deliberately separate from registration below even though the two resolve to the same
 * treatment today and share all three words. They answer different questions ("is the course
 * running" against "can somebody still enrol"), and one of them will change first.
 */
export const COURSE_LIFECYCLE_BADGE = {
  upcoming: 'info',
  open: 'success',
  closed: 'neutral',
} as const satisfies Record<string, BadgeVariant>;

/** Whether the registration window is open, from its own pair of dates. */
export const REGISTRATION_STATUS_BADGE = {
  upcoming: 'info',
  open: 'success',
  closed: 'neutral',
} as const satisfies Record<string, BadgeVariant>;

/**
 * Roles, in categorical hues.
 *
 * Not semantic ones, which is the point of the change: Admin used to be red and Student
 * green, so the roster read as a list of failures and successes. A role is an identity, and
 * an identity is neither.
 */
export const ROLE_BADGE = {
  ADMIN: 'category-violet',
  FACULTY: 'category-blue',
  TA: 'category-amber',
  STUDENT: 'category-slate',
} as const satisfies Record<string, BadgeVariant>;

/** How a role is written when the badge has no explicit label. TA stays an initialism. */
export const ROLE_LABEL = {
  ADMIN: 'Admin',
  FACULTY: 'Faculty',
  TA: 'TA',
  STUDENT: 'Student',
} as const satisfies Record<keyof typeof ROLE_BADGE, string>;

/**
 * Activity-log categories, in categorical hues. Green is Problem and fuchsia is Grade: neither
 * reports a state, and both would be a mistake to read as one.
 *
 * Grade was rose until it sat next to the red ERROR and SECURITY badges in the System Logs
 * table and read as one of them. Fuchsia is the only large empty arc left on the wheel that is
 * not the brand teal, which Grade also used to be and which belongs to the product's own
 * colour rather than to a category.
 */
export const ACTIVITY_CATEGORY_BADGE = {
  SYSTEM: 'category-slate',
  USER: 'category-blue',
  COURSE: 'category-indigo',
  ASSIGNMENT: 'category-violet',
  PROBLEM: 'category-green',
  SUBMISSION: 'category-orange',
  GRADE: 'category-fuchsia',
} as const satisfies Record<string, BadgeVariant>;

/**
 * Activity-log severity, which is a STATE and therefore stays semantic.
 *
 * The pairing with the categories above is the whole point: a category says which part of the
 * system an entry is about, a severity says whether anybody needs to do something about it,
 * and the two have to be readable as different questions on the same row. So a fuchsia GRADE
 * badge beside a neutral INFO badge is a routine grade entry, not an error.
 *
 * INFO is `neutral`, not `info`. Almost every entry a healthy system writes is INFO, so the
 * blue it used to take drew a stripe down the page and spent the reader's attention on the
 * rows that least needed it. Quiet by default; the eye is then free for the four or five rows
 * that are not.
 *
 * ERROR and SECURITY are `danger` and `destructive`, which are genuinely different
 * treatments rather than two names for red: danger is a soft fill with dark red text, the
 * shape every other badge here has, and destructive is a solid red fill with white on it. One
 * says something failed; the other says look at this now.
 */
export const ACTIVITY_SEVERITY_BADGE = {
  INFO: 'neutral',
  WARNING: 'warning',
  ERROR: 'danger',
  SECURITY: 'destructive',
} as const satisfies Record<string, BadgeVariant>;

/** A severity the log has invented since this map was written still has to render. */
export const ACTIVITY_SEVERITY_FALLBACK: BadgeVariant = 'neutral';

/** A category the log has invented since this map was written still has to render. */
export const ACTIVITY_CATEGORY_FALLBACK: BadgeVariant = 'category-slate';

/**
 * Enrolment standing, which is a status and stays semantic. Kept apart from the role badge on
 * purpose: a dropped Faculty member is still Faculty, and encoding one through the other's
 * colour would lose that.
 */
export const ENROLLMENT_STATUS_BADGE = {
  ENROLLED: 'success',
  DROPPED: 'warning',
} as const satisfies Record<string, BadgeVariant>;

/**
 * What a file in the viewer is, as opposed to what machine it draws.
 *
 * Three stores, and telling them apart matters more here than anywhere else in the app: a
 * student's attempt and the instructor's answer are the same picture on the canvas, and reading
 * one as the other is the expensive mistake. The words carry the distinction; the hues only
 * keep the three apart at a glance, the way the role badges do.
 *
 * Fuchsia for the solution on purpose. It is the loudest of the three because it is the one
 * nobody should mistake for a student's work, and it is the furthest from the colours the
 * machine-type badge beside it uses.
 */
export const VIEWER_FILE_KIND_BADGE = {
  submissions: 'category-blue',
  solutions: 'category-fuchsia',
  problems: 'category-slate',
} as const satisfies Record<string, BadgeVariant>;

/** What each one is called on screen. Singular: the badge is about the one file on screen. */
export const VIEWER_FILE_KIND_LABEL = {
  submissions: 'Submission',
  solutions: 'Solution',
  problems: 'Problem file',
} as const satisfies Record<string, string>;
