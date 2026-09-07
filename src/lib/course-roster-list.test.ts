import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  roster: { findMany: vi.fn(), count: vi.fn() },
  assignment: { findMany: vi.fn() },
  submission: { groupBy: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

import { getCourseRosterPage } from './course-roster-list';

const member = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  role: 'STUDENT',
  status: 'ENROLLED',
  user: {
    id: 'u1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@x.edu',
    avatar: null,
    cropX: 10,
    cropY: 20,
    zoom: 2,
  },
  ...over,
});

/** The AND clauses the query was built from, for asserting on one at a time. */
const whereClauses = () => prismaMock.roster.findMany.mock.calls[0][0].where.AND;
const orderBy = () => prismaMock.roster.findMany.mock.calls[0][0].orderBy;

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.roster.count.mockResolvedValue(0);
  prismaMock.roster.findMany.mockResolvedValue([]);
  prismaMock.assignment.findMany.mockResolvedValue([]);
  prismaMock.submission.groupBy.mockResolvedValue([]);
});

describe('getCourseRosterPage', () => {
  it('always scopes to the course', async () => {
    await getCourseRosterPage({ courseId: 'c1', skip: 0, take: 10 });

    expect(whereClauses()).toContainEqual({ courseId: 'c1' });
  });

  it('applies skip and take', async () => {
    await getCourseRosterPage({ courseId: 'c1', skip: 40, take: 20 });

    expect(prismaMock.roster.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 40, take: 20 }),
    );
  });

  it('counts with the same where clause as the rows', async () => {
    await getCourseRosterPage({ courseId: 'c1', skip: 0, take: 10, roles: ['STUDENT'] });

    expect(prismaMock.roster.count.mock.calls[0][0].where).toEqual(
      prismaMock.roster.findMany.mock.calls[0][0].where,
    );
  });

  describe('filters', () => {
    it('ORs within the role filter', async () => {
      await getCourseRosterPage({ courseId: 'c1', skip: 0, take: 10, roles: ['FACULTY', 'TA'] });

      expect(whereClauses()).toContainEqual({ role: { in: ['FACULTY', 'TA'] } });
    });

    it('ANDs role with status, so Student plus Dropped narrows', async () => {
      await getCourseRosterPage({
        courseId: 'c1',
        skip: 0,
        take: 10,
        roles: ['STUDENT'],
        statuses: ['DROPPED'],
      });

      expect(whereClauses()).toContainEqual({ role: { in: ['STUDENT'] } });
      expect(whereClauses()).toContainEqual({ status: { in: ['DROPPED'] } });
    });

    it('adds no clause when every value in a dimension is selected', async () => {
      await getCourseRosterPage({
        courseId: 'c1',
        skip: 0,
        take: 10,
        roles: ['FACULTY', 'TA', 'STUDENT'],
        statuses: ['ENROLLED', 'DROPPED'],
      });

      expect(whereClauses()).toHaveLength(1); // the courseId clause only
    });
  });

  describe('search', () => {
    it('spans name and email when the scope is all', async () => {
      await getCourseRosterPage({ courseId: 'c1', skip: 0, take: 10, q: 'ada', field: 'all' });

      expect(whereClauses()).toContainEqual({
        OR: [
          { user: { firstName: { contains: 'ada', mode: 'insensitive' } } },
          { user: { lastName: { contains: 'ada', mode: 'insensitive' } } },
          { user: { email: { contains: 'ada', mode: 'insensitive' } } },
        ],
      });
    });

    it('narrows to one field when a scope is picked', async () => {
      await getCourseRosterPage({ courseId: 'c1', skip: 0, take: 10, q: 'ada', field: 'email' });

      expect(whereClauses()).toContainEqual({
        OR: [{ user: { email: { contains: 'ada', mode: 'insensitive' } } }],
      });
    });
  });

  describe('sorting', () => {
    it('defaults to surname order with a stable tiebreaker', async () => {
      await getCourseRosterPage({ courseId: 'c1', skip: 0, take: 10 });

      expect(orderBy()).toEqual([
        { user: { lastName: 'asc' } },
        { user: { firstName: 'asc' } },
        { id: 'asc' },
      ]);
    });

    it('falls back to the default for an unknown column', async () => {
      await getCourseRosterPage({ courseId: 'c1', skip: 0, take: 10, sortBy: 'nonsense' });

      expect(orderBy()).toEqual([
        { user: { lastName: 'asc' } },
        { user: { firstName: 'asc' } },
        { id: 'asc' },
      ]);
    });

    it('sorts by role, then surname within a role', async () => {
      await getCourseRosterPage({ courseId: 'c1', skip: 0, take: 10, sortBy: 'role' });

      expect(orderBy()).toEqual([{ role: 'asc' }, { user: { lastName: 'asc' } }, { id: 'asc' }]);
    });

    it('honours a descending direction', async () => {
      await getCourseRosterPage({
        courseId: 'c1',
        skip: 0,
        take: 10,
        sortBy: 'email',
        sortDir: 'desc',
      });

      expect(orderBy()).toEqual([{ user: { email: 'desc' } }, { id: 'asc' }]);
    });
  });

  describe('rows', () => {
    it('flattens a member and keeps the avatar crop values', async () => {
      prismaMock.roster.count.mockResolvedValue(1);
      prismaMock.roster.findMany.mockResolvedValue([member()]);

      const { rows, total } = await getCourseRosterPage({ courseId: 'c1', skip: 0, take: 10 });

      expect(total).toBe(1);
      expect(rows[0]).toMatchObject({
        rosterId: 'r1',
        id: 'u1',
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@x.edu',
        // The crop values used to be dropped by the API but selected by SSR, so avatars
        // silently reset to their default framing once the tab fetch replaced the rows.
        cropX: 10,
        cropY: 20,
        zoom: 2,
        role: 'STUDENT',
        enrollmentStatus: 'ENROLLED',
      });
    });

    it('resolves hasSubmissions for the page students only', async () => {
      prismaMock.roster.findMany.mockResolvedValue([
        member(),
        // A user has at most one roster row per course (@@unique([courseId, userId])), so
        // a second row is a different person.
        member({ id: 'r2', user: { ...member().user, id: 'u2' } }),
      ]);
      prismaMock.assignment.findMany.mockResolvedValue([{ id: 'a1' }]);
      prismaMock.submission.groupBy.mockResolvedValue([{ studentId: 'u1' }]);

      const { rows } = await getCourseRosterPage({ courseId: 'c1', skip: 0, take: 10 });

      expect(rows[0].hasSubmissions).toBe(true);
      expect(rows[1].hasSubmissions).toBe(false);
      // The whole point: the id list is the page's students, not the course's.
      expect(prismaMock.submission.groupBy.mock.calls[0][0].where.studentId.in).toEqual([
        'u1',
        'u2',
      ]);
    });

    it('never marks staff as having submissions', async () => {
      prismaMock.roster.findMany.mockResolvedValue([member({ role: 'FACULTY' })]);

      const { rows } = await getCourseRosterPage({ courseId: 'c1', skip: 0, take: 10 });

      expect(rows[0].hasSubmissions).toBe(false);
      // No students on the page, so the submission lookup is skipped entirely.
      expect(prismaMock.assignment.findMany).not.toHaveBeenCalled();
    });

    it('skips the submission lookup for an empty page', async () => {
      await getCourseRosterPage({ courseId: 'c1', skip: 0, take: 10 });

      expect(prismaMock.assignment.findMany).not.toHaveBeenCalled();
      expect(prismaMock.submission.groupBy).not.toHaveBeenCalled();
    });
  });
});

/**
 * What the "has submitted anything" lookup asks.
 *
 * When the submission delegate has no aggregate available, the helper falls back to one
 * question per student, and that question has to name both the student and the assignments of
 * this course. The prisma mock answers from its fixture whatever the `where` says, so without
 * the `studentId` every student on the page would be marked as having submitted, and without
 * the assignment list the mark would come from their work in some other course.
 */
describe('what the has-submitted fallback asks', () => {
  it('asks per student, bounded by this course’s assignments', async () => {
    prismaMock.roster.count.mockResolvedValue(1);
    prismaMock.roster.findMany.mockResolvedValue([member()]);
    prismaMock.assignment.findMany.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }]);
    // No aggregate on the delegate, so the helper takes the per-student path.
    const noAggregate = { findFirst: prismaMock.submission.findFirst };
    prismaMock.submission.findFirst.mockResolvedValue({ studentId: 'u1' });
    const real = { groupBy: prismaMock.submission.groupBy, findMany: prismaMock.submission.findMany };
    // @ts-expect-error deliberately removing both aggregates to reach the per-student path
    delete prismaMock.submission.groupBy;
    // @ts-expect-error same
    delete prismaMock.submission.findMany;

    try {
      await getCourseRosterPage({ courseId: 'c1', skip: 0, take: 10 });
    } finally {
      prismaMock.submission.groupBy = real.groupBy;
      prismaMock.submission.findMany = real.findMany;
    }

    expect(noAggregate.findFirst.mock.calls[0][0]).toMatchObject({
      where: { studentId: 'u1', assignmentId: { in: ['a1', 'a2'] } },
    });
    // And the assignment list itself is this course's.
    expect(prismaMock.assignment.findMany.mock.calls[0][0]).toMatchObject({
      where: { courseId: 'c1' },
    });
  });
});
