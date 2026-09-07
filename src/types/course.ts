import type { Course, Assignment, Problem } from '@prisma/client';

// Assignment with problem count as returned by API. `maxPoints` is not stored on
// the assignment record any more; consumers are expected to fetch it separately
// from /api/assignments/:id (it is calculated by summing the problem maxPoints).
/** One per-student due-date override, summarized for the staff assignment table. */
export type AssignmentOverrideSummary = {
  studentName: string;
  unlockAt?: string | Date | null;
  dueDate?: string | Date | null;
  lateCutoff?: string | Date | null;
  allowLateSubmissions?: boolean | null;
};

export type AssignmentWithProblemCount = Assignment & {
  problemCount: number;
  // Individual (false) vs group (true), derived server-side from groupSetId. The course
  // table's Type column/filter reads this.
  isGroup: boolean;
  maxPoints?: number;
  allowLateSubmissions?: boolean;
  lateCutoff?: string | Date | null;
  hasSubmissionsOrComments?: boolean;
  submissionCount?: number;
  commentCount?: number;
  /** Per-student overrides (staff view only); empty/absent when there are none. */
  overrides?: AssignmentOverrideSummary[];
  /**
   * Student view only: the assignment exists but has not reached this student's effective
   * unlock time, so the API masked its description. Never set for staff.
   */
  locked?: boolean;
};

export type FullCourse = Course & {
  /**
   * The course's FACULTY and TA members, as User objects augmented with their course role.
   * Deliberately NOT the whole roster: a course can carry a thousand students, so the
   * roster tab pages through `GET /api/courses/[id]/roster` and this payload stays bounded.
   * `rosterTotal` below is the count of every member, staff and students together.
   */
  staff?: Array<{
    id: string;
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    avatar?: string | null;
    role?: string;
    courseRole?: string;
  }>;
  assignments: AssignmentWithProblemCount[];
  problems: Problem[];
  assignmentTotal?: number;
  problemTotal?: number;
  rosterTotal?: number;
  /**
   * The LMS courses connected to this one, for the header badge. Staff only: the payload sends
   * an empty array to a student rather than the real list.
   */
  lmsLinks?: Array<{ platform: string; context: string | null }>;
  // viewer's role in this course (ADMIN | FACULTY | TA | STUDENT) or null
  viewerRole?: string | null;
  // whether the viewer is a global site admin
  viewerIsAdmin?: boolean;
};

export type DeleteTarget = {
  id: string;
  type: 'problem' | 'assignment';
};

export type EnrollableUser = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
};

export type TabType =
  | 'assignments'
  | 'problems'
  | 'roster'
  | 'grades'
  | 'statistics'
  | 'groups'
  | 'activity'
  | 'settings';
