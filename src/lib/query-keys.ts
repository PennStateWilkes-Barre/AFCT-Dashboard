/**
 * Central TanStack Query key factory.
 *
 * Every `useQuery`/`fetchQuery`/`invalidateQueries` call should build its key
 * through `queryKeys` rather than hand-writing an array. Benefits:
 *   - One place defines each key's shape, so a rename or a new scoping variable
 *     (e.g. adding `courseId`) is a single edit instead of a cross-file sweep.
 *   - Keys stay consistent, so reads dedupe and invalidations hit the right
 *     entries. Partial keys (e.g. `queryKeys.course.all(id)`) are valid prefixes
 *     for `invalidateQueries`.
 *   - Any variable a `queryFn` reads must appear in the key; the
 *     `@tanstack/query/exhaustive-deps` lint enforces this; building keys here
 *     makes it easy to get right.
 *
 * Mirrors `lib/api-paths.ts` (URL builders). Migration to this factory is
 * incremental; not every call site routes through it yet.
 */

/** Normalize an id list so key order never causes a cache miss (`[a,b]` == `[b,a]`). */
const sortedIds = (ids: readonly string[]): string[] => [...ids].sort();

export const queryKeys = {
  // --- Course lists --------------------------------------------------------
  courses: {
    /** Prefix for every course-list entry; use to invalidate the list and the nav together. */
    all: () => ['courses'] as const,
    list: () => ['courses', 'list'] as const,
    nav: () => ['courses', 'nav'] as const,
  },

  // --- A single course and its sections ------------------------------------
  course: {
    /** The course-wide Statistics tab. */
    statistics: (courseId: string) => ['course', courseId, 'statistics'] as const,
    /** Prefix for every entry scoped to a course; use to invalidate all of them. */
    all: (courseId: string) => ['course', courseId] as const,
    view: (courseId: string, view: string) => ['course', courseId, view] as const,
    students: (courseId: string) => ['course', courseId, 'students'] as const,
    /**
     * The student list including dropped members, for the submissions table. A separate
     * entry from `students` on purpose: it is a different question (`includeDropped`) and
     * a different answer, so sharing one key would serve whichever arrived first.
     */
    studentsAll: (courseId: string) => ['course', courseId, 'students', 'all'] as const,
    /** Faculty and TAs eligible to run the copy, for the Duplicate Course dialog. */
    duplicateStaff: (courseId: string) => ['course', courseId, 'duplicate-staff'] as const,
    roster: (courseId: string) => ['course', courseId, 'roster'] as const,
    rosterEntry: (courseId: string, userId: string) =>
      ['course', courseId, 'roster', userId] as const,
    /** One page of the roster table; the key is the whole server-side query. */
    rosterPage: <T>(courseId: string, params: T) =>
      ['course', courseId, 'roster-page', params] as const,
    /** Enrollable accounts matching a search, for the Enroll dialog. */
    enrollableUsers: (courseId: string, q: string) =>
      ['course', courseId, 'enrollable-users', q] as const,
    // Group sets (redesigned group management). All nest under the course prefix
    // so invalidateQueries(['course', courseId]) cascades.
    groupSets: (courseId: string) => ['course', courseId, 'group-sets'] as const,
    groupSet: (courseId: string, setId: string) =>
      ['course', courseId, 'group-set', setId] as const,
    /** Prefix for the gradebook; use to invalidate both entries below. */
    /** Which LMS courses open this one (the course-level placements). */
    lmsLink: (courseId: string) => ['course', courseId, 'lms-link'] as const,
    grades: (courseId: string) => ['course', courseId, 'grades'] as const,
    /** The gradebook's assignment columns and student total (cached per course). */
    gradeColumns: (courseId: string) => ['course', courseId, 'grades', 'columns'] as const,
    /** One page of the gradebook; the key is the whole server-side query. */
    gradePage: <T>(courseId: string, params: T) =>
      ['course', courseId, 'grades', 'page', params] as const,
    studentGrades: (courseId: string) => ['course', courseId, 'student-grades'] as const,
    problems: (courseId: string) => ['course', courseId, 'problems'] as const,
    assignmentsList: (courseId: string) => ['course', courseId, 'assignments-list'] as const,
    /** Prefix for the course activity feed; use to invalidate both entries below. */
    activity: (courseId: string) => ['course', courseId, 'activity'] as const,
    /** One page of the activity feed; the key is the whole server-side query. */
    activityPage: <T>(courseId: string, params: T) =>
      ['course', courseId, 'activity', 'page', params] as const,
    /** The course's assignments and problems, for the activity filter menus. */
    activityFilters: (courseId: string) => ['course', courseId, 'activity', 'filters'] as const,
  },

  // --- Assignments (all nested under their course so course-level invalidation
  //     cascades to them) ---------------------------------------------------
  assignment: {
    /**
     * The assignment "shell" (problems view). Shared by the max-points cell, the
     * student navigator, and the student assignment view so they dedupe onto one
     * read. Nested under the course→assignment prefix (like every key below), so
     * `invalidateQueries(['course', courseId])` reaches it.
     */
    /** Prefix for every entry scoped to one assignment; use to invalidate all of them. */
    all: (courseId: string, assignmentId: string) =>
      ['course', courseId, 'assignment', assignmentId] as const,
    shell: (courseId: string, assignmentId: string) =>
      ['course', courseId, 'assignment', assignmentId, 'shell'] as const,
    /**
     * The caller's own submissions/comments/grades for an assignment; the
     * response is user-specific, so it must never be reused across a user switch
     * (the QueryClient is cleared on identity change; see QueryProvider).
     */
    studentContext: (courseId: string, assignmentId: string) =>
      ['course', courseId, 'assignment', assignmentId, 'student-context'] as const,
    groupsAndMappings: (courseId: string, assignmentId: string) =>
      ['course', courseId, 'assignment', assignmentId, 'groups-and-mappings'] as const,
    /** Who the assignment is aimed at (students or groups). */
    assignees: (courseId: string, assignmentId: string) =>
      ['course', courseId, 'assignment', assignmentId, 'assignees'] as const,
    /** The assignment's date exceptions. */
    overrides: (courseId: string, assignmentId: string) =>
      ['course', courseId, 'assignment', assignmentId, 'overrides'] as const,
    /** Which LMS placements open this assignment. */
    lmsLinks: (courseId: string, assignmentId: string) =>
      ['course', courseId, 'assignment', assignmentId, 'lms-links'] as const,
    gradeBreakdown: (courseId: string, assignmentId: string) =>
      ['course', courseId, 'assignment', assignmentId] as const,
    problemGradesSummary: (courseId: string, assignmentId: string) =>
      ['course', courseId, 'assignment', assignmentId, 'problem-grades', 'summary'] as const,
    problemGrades: (courseId: string, assignmentId: string, studentId: string) =>
      ['course', courseId, 'assignment', assignmentId, 'problem-grades', studentId] as const,
    reviewData: (courseId: string, assignmentId: string, studentId: string) =>
      ['course', courseId, 'assignment', assignmentId, 'review-data', studentId] as const,
    studentGroup: (courseId: string, assignmentId: string, studentId: string) =>
      ['course', courseId, 'assignment', assignmentId, 'student-group', studentId] as const,
    statistics: (courseId: string, assignmentId: string) =>
      ['course', courseId, 'assignment', assignmentId, 'statistics'] as const,
    similarity: (courseId: string, assignmentId: string) =>
      ['course', courseId, 'assignment', assignmentId, 'similarity'] as const,
    // The threshold is part of the question, so moving it asks again rather than showing a
    // number that was true of a different setting.
    similarityCount: (courseId: string, assignmentId: string, share?: number) =>
      ['course', courseId, 'assignment', assignmentId, 'similarity', 'count', share] as const,
  },

  /** Calendar: assignments due in a date range (self-scoped to the caller). */
  assignmentsRange: (startIso: string, endIso: string) =>
    ['assignments', 'range', startIso, endIso] as const,

  // --- Admin / system ------------------------------------------------------
  admin: {
    users: () => ['admin', 'users'] as const,
    usersAll: () => ['admin', 'users', 'all'] as const,
    usersFaculty: () => ['admin', 'users', 'faculty'] as const,
    usersTa: () => ['admin', 'users', 'ta'] as const,
    /** One page of the Users table; the key is the whole server-side query. */
    usersPage: <T>(params: T) => ['admin', 'users', params] as const,
    /** Prefix for the status dashboard; use to refresh every tab at once. */
    status: () => ['admin', 'status'] as const,
    /** Per-domain status endpoints for the tabbed status dashboard. */
    statusSummary: () => ['admin', 'status', 'summary'] as const,
    statusServer: () => ['admin', 'status', 'server'] as const,
    statusDatabase: () => ['admin', 'status', 'database'] as const,
    statusDocker: () => ['admin', 'status', 'docker'] as const,
    statusNetwork: () => ['admin', 'status', 'network'] as const,
    statusSessions: () => ['admin', 'status', 'sessions'] as const,
    statusFiles: () => ['admin', 'status', 'files'] as const,
    statusRateLimits: () => ['admin', 'status', 'rate-limits'] as const,
    statusWorkers: () => ['admin', 'status', 'workers'] as const,
    settings: () => ['admin', 'settings'] as const,
    /**
     * Registered LTI platforms. Deliberately NOT under `settings`: it is a different resource
     * with its own endpoint, and saving a system setting should not refetch the platform list.
     */
    ltiPlatforms: () => ['admin', 'lti-platforms'] as const,
    settingsBackups: () => ['admin', 'settings', 'backups'] as const,
    settingsTls: () => ['admin', 'settings', 'tls'] as const,
    logs: <T>(params: T) => ['admin', 'logs', params] as const,
    logsFields: () => ['admin', 'logs', 'fields'] as const,
    /** One page of the Autograder table; the key is the whole server-side query. */
    submissions: <T>(params: T) => ['admin', 'submissions', params] as const,
    /** Cascading filter lists behind the submissions log (courses → assignments → problems). */
    submissionFilters: {
      courses: () => ['admin', 'submission-filters', 'courses'] as const,
      assignments: (courseIds: readonly string[]) =>
        ['admin', 'submission-filters', 'assignments', sortedIds(courseIds)] as const,
      problems: (assignmentIds: readonly string[]) =>
        ['admin', 'submission-filters', 'problems', sortedIds(assignmentIds)] as const,
    },
  },

  // --- Evaluator trials (staff dry runs) -----------------------------------
  evaluatorTrial: (id: string) => ['evaluator-trial', id] as const,

  // --- Public / self -------------------------------------------------------
  systemSettingsPublic: () => ['system-settings', 'public'] as const,
  /** The signed-in account's own record. Predates the `me` group below; left where it is
   *  because many components already read it and the key is not worth churning. */
  profile: () => ['profile'] as const,

  /** The signed-in account's own things, on the Account page. */
  me: {
    /** Prefix for everything below. */
    all: () => ['me'] as const,
    clientTokens: () => ['me', 'client-tokens'] as const,
    identities: () => ['me', 'identities'] as const,
  },
} as const;
