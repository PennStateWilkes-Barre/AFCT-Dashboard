import { visibleAssignmentsForWidth } from '@/lib/calendar-shared';
import { assignedToStudentWhere, overridesForStudentWhere } from '@/lib/assignment-visibility';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  roster: { findMany: vi.fn(), groupBy: vi.fn() },
  assignment: { findMany: vi.fn() },
  submission: { findMany: vi.fn() },
  assignmentProblemGrade: { findMany: vi.fn(), groupBy: vi.fn() },
  user: { findUnique: vi.fn() },
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

import { getAssignmentsForUserRange } from './calendar-assignments';

const range = { startDate: new Date('2026-01-01'), endDate: new Date('2026-02-01') };

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.assignment.findMany.mockResolvedValue([]);
  prismaMock.submission.findMany.mockResolvedValue([]);
  prismaMock.assignmentProblemGrade.findMany.mockResolvedValue([]);
  prismaMock.roster.groupBy.mockResolvedValue([]);
  prismaMock.assignmentProblemGrade.groupBy.mockResolvedValue([]);
  prismaMock.user.findUnique.mockResolvedValue({ isAdmin: false });
});

describe('getAssignmentsForUserRange', () => {
  it('returns [] and skips the assignment query when the user has no courses', async () => {
    prismaMock.roster.findMany.mockResolvedValue([]);

    const res = await getAssignmentsForUserRange({ userId: 'u1', ...range });

    expect(res).toEqual([]);
    expect(prismaMock.assignment.findMany).not.toHaveBeenCalled();
  });

  it('shows all assignments for staff courses but only published ones for student courses', async () => {
    prismaMock.roster.findMany.mockResolvedValue([
      { courseId: 'staff-course', role: 'FACULTY' },
      { courseId: 'ta-course', role: 'TA' },
      { courseId: 'student-course', role: 'STUDENT' },
    ]);

    await getAssignmentsForUserRange({ userId: 'u1', ...range });

    const where = prismaMock.assignment.findMany.mock.calls[0][0].where;
    // Staff/TA courses: every assignment whose base due is in range. Student course:
    // gated on the assignment AND the course being published, matched on the base due OR an
    // override that applies to them, their group's included (an extension granted to a group is
    // its members' deadline). Whether they are assigned at all is the assignee table's answer,
    // never the overrides': asking those hid work assigned to them that carried no exception.
    expect(where.OR).toEqual([
      {
        courseId: { in: ['staff-course', 'ta-course'] },
        dueDate: { gte: range.startDate, lte: range.endDate },
      },
      {
        courseId: { in: ['student-course'] },
        isPublished: true,
        // Published AND started: a student cannot open a course before its start date, so its
        // deadlines must not appear on their calendar either.
        course: { isPublished: true, startDate: { lte: expect.any(Date) } },
        AND: [
          {
            OR: [
              { dueDate: { gte: range.startDate, lte: range.endDate } },
              {
                overrides: {
                  some: {
                    AND: [
                      overridesForStudentWhere('u1'),
                      { dueDate: { gte: range.startDate, lte: range.endDate } },
                    ],
                  },
                },
              },
            ],
          },
          assignedToStudentWhere('u1'),
        ],
      },
    ]);
    // The old top-level `dueDate` and unscoped `courseId` filters are gone.
    expect(where.courseId).toBeUndefined();
    expect(where.dueDate).toBeUndefined();
    // Archived and soft-deleted courses are excluded from the calendar for everyone.
    expect(where.course).toEqual({ isArchived: false, deletedAt: null });
  });

  it('treats every rostered course as staff when the viewer is an admin', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ isAdmin: true });
    prismaMock.roster.findMany.mockResolvedValue([
      { courseId: 'enrolled-as-student', role: 'STUDENT' },
    ]);

    await getAssignmentsForUserRange({ userId: 'admin1', ...range });

    const where = prismaMock.assignment.findMany.mock.calls[0][0].where;
    // The global admin flag outranks the STUDENT roster row: no publish gating, and the
    // student branch (with its override match) targets an empty course set.
    expect(where.OR).toEqual([
      {
        courseId: { in: ['enrolled-as-student'] },
        dueDate: { gte: range.startDate, lte: range.endDate },
      },
      {
        courseId: { in: [] },
        isPublished: true,
        // Published AND started: a student cannot open a course before its start date, so its
        // deadlines must not appear on their calendar either.
        course: { isPublished: true, startDate: { lte: expect.any(Date) } },
        AND: [
          {
            OR: [
              { dueDate: { gte: range.startDate, lte: range.endDate } },
              {
                overrides: {
                  some: {
                    AND: [
                      overridesForStudentWhere('admin1'),
                      { dueDate: { gte: range.startDate, lte: range.endDate } },
                    ],
                  },
                },
              },
            ],
          },
          assignedToStudentWhere('admin1'),
        ],
      },
    ]);
  });

  it('selects and carries isPublished through so staff drafts can be marked', async () => {
    prismaMock.roster.findMany.mockResolvedValue([{ courseId: 'staff-course', role: 'FACULTY' }]);
    prismaMock.assignment.findMany.mockResolvedValue([
      {
        id: 'a1',
        title: 'Draft One',
        courseId: 'staff-course',
        dueDate: new Date('2026-01-15'),
        isPublished: false,
        course: { id: 'staff-course', code: 'CS1', name: 'Course One' },
      },
    ]);

    const res = await getAssignmentsForUserRange({ userId: 'u1', ...range });

    expect(prismaMock.assignment.findMany.mock.calls[0][0].select.isPublished).toBe(true);
    expect(res).toHaveLength(1);
    expect(res[0].isPublished).toBe(false);
  });
});

/**
 * How much a day cell tries to show at a given viewport width.
 *
 * The cell carries an explicit min-height per breakpoint (roughly 56px on a phone, 80px from
 * `sm`, 96px or more from `md`), and these tiers mirror those heights. On a phone the cell is
 * also only about 45px wide, so a chip truncates to three or four characters and says less than
 * the marker the cell falls back to, which is why the answer there is none.
 *
 * Tested here rather than through the calendar, because this is the part that is a decision. The
 * rendering it drives is layout, and jsdom does no layout: `CalendarClient.test.tsx` mocks the
 * calendar away entirely, so no day cell renders there and a test asserting on chips would pass
 * or fail for reasons unrelated to width.
 */
/**
 * A group extension is the group members' deadline. The query that decides which assignments
 * to fetch has always widened on group overrides; the rows it selected to RESOLVE the date
 * did not, so the override was fetched for the filter and then invisible to the resolver. The
 * assignment came back on its base date and, when that fell outside the month, was dropped
 * entirely: gone from the calendar in the very month the group was working to.
 */
describe('a group extension on the calendar', () => {
  const groupOverride = {
    targetType: 'GROUP',
    userId: null,
    groupId: 'g1',
    unlockAt: null,
    dueDate: new Date('2026-01-20T12:00:00.000Z'),
    lateCutoff: null,
    allowLateSubmissions: null,
  };

  const setup = (overrides: unknown[]) => {
    prismaMock.roster.findMany.mockResolvedValue([{ courseId: 'c1', role: 'STUDENT' }]);
    prismaMock.assignment.findMany.mockResolvedValue([
      {
        id: 'a1',
        title: 'Group Lab',
        courseId: 'c1',
        // Base due is in December, outside the January range the calendar asked for.
        dueDate: new Date('2025-12-10T12:00:00.000Z'),
        unlockAt: null,
        allowLateSubmissions: false,
        lateCutoff: null,
        isPublished: true,
        overrides,
        course: { id: 'c1', code: 'CMPEN 331', name: 'Computer Organization' },
      },
    ]);
  };

  it('moves the assignment to the group date, inside the month it was asked for', async () => {
    setup([groupOverride]);

    const res = await getAssignmentsForUserRange({ userId: 'u1', ...range });

    expect(res).toHaveLength(1);
    expect(res[0].dueDate).toEqual(new Date('2026-01-20T12:00:00.000Z'));
  });

  it("selects the group rows to resolve with, not just the student's own", async () => {
    setup([groupOverride]);

    await getAssignmentsForUserRange({ userId: 'u1', ...range });

    // The pairing that the bug broke: select with overridesForStudentWhere, resolve with the
    // group ids it returns. Asserting the select keeps a future edit from narrowing it back
    // to `{ userId }`, which fails silently rather than loudly.
    const args = prismaMock.assignment.findMany.mock.calls[0][0];
    expect(args.select.overrides.where).toEqual(overridesForStudentWhere('u1'));
  });

  it('still drops an assignment whose own extension moved it out of the range', async () => {
    setup([{ ...groupOverride, dueDate: new Date('2026-05-01T12:00:00.000Z') }]);

    const res = await getAssignmentsForUserRange({ userId: 'u1', ...range });

    expect(res).toEqual([]);
  });
});

describe('how many assignments fit in a day cell', () => {
  it('shows none on a phone, where the cell has room for the date alone', () => {
    expect(visibleAssignmentsForWidth(360)).toBe(0);
    expect(visibleAssignmentsForWidth(390)).toBe(0);
  });

  it('shows two on a small tablet, where the cell is 80px tall', () => {
    expect(visibleAssignmentsForWidth(640)).toBe(2);
    expect(visibleAssignmentsForWidth(767)).toBe(2);
  });

  it('shows three from a normal window size upward', () => {
    expect(visibleAssignmentsForWidth(768)).toBe(3);
    expect(visibleAssignmentsForWidth(1279)).toBe(3);
    expect(visibleAssignmentsForWidth(2560)).toBe(3);
  });

  // The boundaries are the whole content of this function, so they are what gets pinned.
  // Cells carry an explicit height per breakpoint now, so there are two boundaries rather
  // than three: 1280 no longer changes the answer.
  it('changes exactly at the breakpoints and nowhere else', () => {
    expect(visibleAssignmentsForWidth(639)).toBe(0);
    expect(visibleAssignmentsForWidth(640)).toBe(2);
    expect(visibleAssignmentsForWidth(767)).toBe(2);
    expect(visibleAssignmentsForWidth(768)).toBe(3);
    expect(visibleAssignmentsForWidth(1279)).toBe(3);
    expect(visibleAssignmentsForWidth(1280)).toBe(3);
  });
});
