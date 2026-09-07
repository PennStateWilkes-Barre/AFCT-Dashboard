import { describe, expect, it } from 'vitest';
import {
  assignedToStudentWhere,
  groupIdsFromOverrides,
  isStudentAssigned,
} from './assignment-visibility';

describe('isStudentAssigned', () => {
  it('assigns everyone when assignedToEveryone is true', () => {
    expect(isStudentAssigned({ assignedToEveryone: true }, [], 'stu-1')).toBe(true);
  });

  it('assigns only students with an assignee row when not everyone', () => {
    expect(isStudentAssigned({ assignedToEveryone: false }, [{ userId: 'stu-1' }], 'stu-1')).toBe(
      true,
    );
    expect(isStudentAssigned({ assignedToEveryone: false }, [{ userId: 'other' }], 'stu-1')).toBe(
      false,
    );
    expect(isStudentAssigned({ assignedToEveryone: false }, [], 'stu-1')).toBe(false);
  });

  it('defaults a missing flag to assigned', () => {
    // A partial select can omit the flag; the NOT NULL default is true.
    expect(isStudentAssigned({} as { assignedToEveryone: boolean }, [], 'stu-1')).toBe(true);
  });

  it('assigns a student via a group assignee row for a group they belong to', () => {
    const assignees = [{ userId: null, groupId: 'g1' }];
    expect(isStudentAssigned({ assignedToEveryone: false }, assignees, 'stu-1', ['g1'])).toBe(true);
    // Not a member of the targeted group -> not assigned.
    expect(isStudentAssigned({ assignedToEveryone: false }, assignees, 'stu-1', ['g2'])).toBe(
      false,
    );
  });
});

/**
 * The half of the pair that is easy to forget. `overridesForStudentWhere` selects a group's
 * override rows; `effectiveDeadline` then ignores them unless it is handed the group ids.
 * Selecting one without the other returns the BASE date with no error, which is a wrong
 * deadline shown to a student rather than a failure anyone would notice.
 */
describe('groupIdsFromOverrides', () => {
  it('keeps the group ids and drops the student rows, which carry none', () => {
    expect(
      groupIdsFromOverrides([
        { groupId: null },
        { groupId: 'g1' },
        { groupId: undefined },
        { groupId: 'g2' },
      ]),
    ).toEqual(['g1', 'g2']);
  });

  it('is empty for a student with no group override, which is the base-date case', () => {
    expect(groupIdsFromOverrides([{ groupId: null }])).toEqual([]);
    expect(groupIdsFromOverrides([])).toEqual([]);
  });
});

describe('assignedToStudentWhere', () => {
  it('matches everyone, the student own assignee row, or a group they belong to', () => {
    expect(assignedToStudentWhere('stu-1')).toEqual({
      OR: [
        { assignedToEveryone: true },
        { assignees: { some: { userId: 'stu-1' } } },
        { assignees: { some: { studentGroup: { memberships: { some: { userId: 'stu-1' } } } } } },
      ],
    });
  });
});
