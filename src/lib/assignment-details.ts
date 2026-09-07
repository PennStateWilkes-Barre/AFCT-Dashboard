import type { Problem, CourseRole } from '@prisma/client';

export type AssignmentProblemLink = {
  // The API projects a subset of Problem plus the rich description, which Prisma's Problem type
  // already includes; the intersection keeps that explicit for read surfaces.
  problem: Problem & { descriptionJson?: unknown };
  maxPoints: number;
  maxSubmissions: number;
  autograderEnabled: boolean;
  /** Whether students see the evaluator's feedback on this problem, or only the verdict. */
  showFeedback: boolean;
};

export type AssignmentCourseSummary = {
  id: string;
  name: string;
  code?: string;
  isArchived?: boolean;
  /** The course's canonical timezone; anchors deadlines; used for dual-zone display. */
  timezone?: string | null;
  roster?: Array<{
    role: CourseRole | null;
    user: {
      id: string;
      firstName: string | null;
      lastName: string | null;
    };
  }>;
};

export type AssignmentWithDetails = {
  id: string;
  title: string;
  description?: string | null;
  /**
   * The stored rich description, when the assignment has one. Unvalidated here on purpose: the
   * editor and every renderer run it through `validateRichDescription` and fall back to the
   * plain-text `description`, so a document written by an older or newer version cannot break a
   * page. Withheld (null) from a student while the assignment's content is locked, exactly like
   * `description`.
   */
  descriptionJson?: unknown;
  descriptionFormat?: 'PLAIN_TEXT' | 'TIPTAP_JSON';
  courseId: string;
  courseName?: string;
  courseCode?: string;
  courseIsArchived?: boolean;
  dueDate: string | Date;
  unlockAt?: string | Date | null;
  /**
   * True while the assignment has not reached this student's release time. Its description
   * and problems are withheld, so a page that ignores this renders an empty shell.
   */
  locked?: boolean;
  assignedToEveryone?: boolean;
  groupSetId?: string | null;
  maxPoints: number;
  allowLateSubmissions?: boolean;
  /** Whether unsubmitted work counts as zero once its deadline has passed. */
  missingWorkIsZero?: boolean;
  lateCutoff?: string | Date | null;
  isPublished: boolean;
  createdAt?: Date;
  updatedAt?: Date;
  problems: AssignmentProblemLink[];
  course?: AssignmentCourseSummary;
};

export type StudentProblemSubmission = {
  id: string;
  submittedAt: string;
  grade: number | null;
  feedback: string | null;
  problemId: string;
  status: string;
  fileName?: string | null;
  originalFileName?: string | null;
  correct?: boolean | null;
  /**
   * "First Last" of whoever made the attempt. Sent only for a group assignment, where the
   * caller sees their whole group's submissions and needs to tell them apart; absent on an
   * individual one, where every attempt is their own.
   */
  submittedBy?: string | null;
};

export type StudentProblemComment = {
  id: string;
  content: string;
  createdAt: string;
  authorId?: string | null;
  authorName: string;
  authorRole: CourseRole;
  problemId: string;
};

export type StudentAssignmentContext = {
  assignmentGrade: number | null;
  submissionCount: number;
  problemGrades: Record<string, number | null>;
  /**
   * Problem ids whose zero is for work never handed in, rather than one that was marked. Both are
   * the number 0 and the screen has to tell them apart.
   */
  missingProblems?: string[];
  submissionsByProblem: Record<string, StudentProblemSubmission[]>;
  commentsByProblem: Record<string, StudentProblemComment[]>;
  /**
   * Per-problem submission cap for THIS caller: the shared base plus any
   * extra-submission grants for them or their group. `max` null means unlimited.
   */
  problemLimits?: Record<string, { max: number | null; granted: number }>;
  /** The caller's own group on a group assignment; null on an individual one. */
  group?: { id: string; name: string } | null;
  /** Their groupmates, the caller excluded. Names only, and only for their own group. */
  groupMembers?: Array<{ id: string; firstName: string | null; lastName: string | null }>;
};
