import { describe, expect, it } from 'vitest';
import { queryKeys } from './query-keys';

/**
 * TanStack invalidates by prefix: `invalidateQueries({ queryKey: ['courses'] })` reaches every
 * entry whose key starts with those elements. So a "prefix" helper is only useful if it really
 * is a prefix of the entries it is meant to reach, and an entry only gets invalidated if it was
 * built from the same factory.
 *
 * Both halves of that failed once. The calendar hand-wrote `['me','courses','nav']` for the
 * same endpoint the sidebar read as `['courses','nav']`, so it was a second cache entry that
 * every `invalidateQueries(['courses'])` in the app missed: publish a course, and the
 * calendar's filter kept the old list. Nothing caught it, because a wrong key still returns
 * data, just its own copy.
 */
const isPrefixOf = (prefix: readonly unknown[], key: readonly unknown[]) =>
  prefix.length <= key.length && prefix.every((part, i) => part === key[i]);

describe('query key prefixes reach what they are meant to', () => {
  it('courses.all covers the list and the sidebar nav', () => {
    const prefix = queryKeys.courses.all();
    expect(isPrefixOf(prefix, queryKeys.courses.list())).toBe(true);
    expect(isPrefixOf(prefix, queryKeys.courses.nav())).toBe(true);
  });

  it('course.all covers every entry scoped to that course', () => {
    const prefix = queryKeys.course.all('c1');
    const entries = [
      queryKeys.course.statistics('c1'),
      queryKeys.course.view('c1', 'problems'),
      queryKeys.course.students('c1'),
      queryKeys.course.studentsAll('c1'),
      queryKeys.course.duplicateStaff('c1'),
      queryKeys.course.roster('c1'),
      queryKeys.course.rosterEntry('c1', 'u1'),
      queryKeys.course.rosterPage('c1', { page: 1 }),
      queryKeys.course.enrollableUsers('c1', 'ada'),
      queryKeys.course.groupSets('c1'),
      queryKeys.course.groupSet('c1', 'gs1'),
      queryKeys.course.grades('c1'),
      queryKeys.course.gradeColumns('c1'),
      queryKeys.course.gradePage('c1', { page: 1 }),
      queryKeys.course.studentGrades('c1'),
      queryKeys.course.problems('c1'),
      queryKeys.course.assignmentsList('c1'),
      queryKeys.course.activity('c1'),
      queryKeys.course.activityPage('c1', { page: 1 }),
      queryKeys.course.activityFilters('c1'),
    ];
    for (const key of entries) expect(isPrefixOf(prefix, key)).toBe(true);
  });

  it('the gradebook and activity prefixes cover their own pages', () => {
    expect(isPrefixOf(queryKeys.course.grades('c1'), queryKeys.course.gradeColumns('c1'))).toBe(
      true,
    );
    expect(
      isPrefixOf(queryKeys.course.grades('c1'), queryKeys.course.gradePage('c1', { page: 2 })),
    ).toBe(true);
    expect(
      isPrefixOf(queryKeys.course.activity('c1'), queryKeys.course.activityPage('c1', { page: 2 })),
    ).toBe(true);
    expect(
      isPrefixOf(queryKeys.course.activity('c1'), queryKeys.course.activityFilters('c1')),
    ).toBe(true);
  });

  it('assignment.all covers every entry scoped to that assignment', () => {
    const prefix = queryKeys.assignment.all('c1', 'a1');
    const entries = [
      queryKeys.assignment.shell('c1', 'a1'),
      queryKeys.assignment.studentContext('c1', 'a1'),
      queryKeys.assignment.groupsAndMappings('c1', 'a1'),
      queryKeys.assignment.assignees('c1', 'a1'),
      queryKeys.assignment.overrides('c1', 'a1'),
      queryKeys.assignment.lmsLinks('c1', 'a1'),
      queryKeys.assignment.problemGradesSummary('c1', 'a1'),
      queryKeys.assignment.problemGrades('c1', 'a1', 'stu1'),
      queryKeys.assignment.reviewData('c1', 'a1', 'stu1'),
      queryKeys.assignment.studentGroup('c1', 'a1', 'stu1'),
      queryKeys.assignment.statistics('c1', 'a1'),
      queryKeys.assignment.similarity('c1', 'a1'),
      queryKeys.assignment.similarityCount('c1', 'a1', 0.8),
    ];
    for (const key of entries) expect(isPrefixOf(prefix, key)).toBe(true);
  });

  it('every assignment entry also sits under its course, so course-level invalidation cascades', () => {
    const coursePrefix = queryKeys.course.all('c1');
    expect(isPrefixOf(coursePrefix, queryKeys.assignment.all('c1', 'a1'))).toBe(true);
    expect(isPrefixOf(coursePrefix, queryKeys.assignment.reviewData('c1', 'a1', 'stu1'))).toBe(
      true,
    );
  });

  it('admin.status and admin.users cover their own entries', () => {
    const status = queryKeys.admin.status();
    for (const key of [
      queryKeys.admin.statusSummary(),
      queryKeys.admin.statusServer(),
      queryKeys.admin.statusDatabase(),
      queryKeys.admin.statusDocker(),
      queryKeys.admin.statusNetwork(),
      queryKeys.admin.statusSessions(),
      queryKeys.admin.statusFiles(),
      queryKeys.admin.statusRateLimits(),
      queryKeys.admin.statusWorkers(),
    ]) {
      expect(isPrefixOf(status, key)).toBe(true);
    }

    const users = queryKeys.admin.users();
    expect(isPrefixOf(users, queryKeys.admin.usersAll())).toBe(true);
    expect(isPrefixOf(users, queryKeys.admin.usersFaculty())).toBe(true);
    expect(isPrefixOf(users, queryKeys.admin.usersTa())).toBe(true);
    expect(isPrefixOf(users, queryKeys.admin.usersPage({ page: 1 }))).toBe(true);

    expect(isPrefixOf(queryKeys.admin.settings(), queryKeys.admin.settingsBackups())).toBe(true);
    expect(isPrefixOf(queryKeys.admin.settings(), queryKeys.admin.settingsTls())).toBe(true);
  });
});

describe('keys that must not collide', () => {
  it('separates the roster student list from the one that includes dropped members', () => {
    // Different questions with different answers; one key would serve whichever landed first.
    expect(queryKeys.course.students('c1')).not.toEqual(queryKeys.course.studentsAll('c1'));
  });

  it('separates two courses, two assignments, and two students', () => {
    expect(queryKeys.course.all('c1')).not.toEqual(queryKeys.course.all('c2'));
    expect(queryKeys.assignment.all('c1', 'a1')).not.toEqual(queryKeys.assignment.all('c1', 'a2'));
    expect(queryKeys.assignment.reviewData('c1', 'a1', 'stu1')).not.toEqual(
      queryKeys.assignment.reviewData('c1', 'a1', 'stu2'),
    );
  });

  it('treats a different similarity threshold as a different question', () => {
    expect(queryKeys.assignment.similarityCount('c1', 'a1', 0.8)).not.toEqual(
      queryKeys.assignment.similarityCount('c1', 'a1', 0.9),
    );
  });

  it('ignores the order of an id list, so the same filter is one cache entry', () => {
    // The submissions log builds these from checkbox order, which the user controls.
    expect(queryKeys.admin.submissionFilters.assignments(['b', 'a'])).toEqual(
      queryKeys.admin.submissionFilters.assignments(['a', 'b']),
    );
    expect(queryKeys.admin.submissionFilters.problems(['p2', 'p1'])).toEqual(
      queryKeys.admin.submissionFilters.problems(['p1', 'p2']),
    );
  });
});
