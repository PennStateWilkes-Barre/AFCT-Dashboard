import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const prismaMock = vi.hoisted(() => ({
  course: { findFirst: vi.fn() },
  activityLog: { findMany: vi.fn(), count: vi.fn() },
  roster: { findFirst: vi.fn(), findMany: vi.fn() },
  assignment: { findMany: vi.fn() },
  problem: { findMany: vi.fn() },
}));

const authMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));

import { GET } from './route';
import { ACTIVITY_SORT_KEYS } from '@/lib/activity-log-values';

const req = (query = '') => new NextRequest(`http://localhost/api/courses/c1/activity${query}`);
const ctx = { params: Promise.resolve({ id: 'c1' }) };
/** Authorize the caller as course staff. */
const staff = () => {
  authMock.mockResolvedValue({ user: { id: 'u1' } });
  prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
};

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: 'u1' } });
  // Default: caller not enrolled (denied); authorized tests grant a course role.
  prismaMock.roster.findFirst.mockResolvedValue(null);
  prismaMock.roster.findMany.mockResolvedValue([]);
  prismaMock.course.findFirst.mockResolvedValue({ id: 'c1', startDate: null, endDate: null });
  prismaMock.activityLog.findMany.mockResolvedValue([]);
  prismaMock.activityLog.count.mockResolvedValue(0);
  prismaMock.assignment.findMany.mockResolvedValue([]);
  prismaMock.problem.findMany.mockResolvedValue([]);
});

describe('GET /api/courses/[id]/activity', () => {
  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);

    const req = new NextRequest('http://localhost/api/courses/c1/activity');
    const res = await GET(req, { params: Promise.resolve({ id: 'c1' }) });

    expect(res.status).toBe(401);
  });

  it('returns 404 when a permitted caller hits a missing course', async () => {
    // Admin passes the access gate, then the handler's existence check returns 404.
    authMock.mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    prismaMock.course.findFirst.mockResolvedValue(null);

    const req = new NextRequest('http://localhost/api/courses/c1/activity');
    const res = await GET(req, { params: Promise.resolve({ id: 'c1' }) });

    expect(res.status).toBe(404);
  });

  it('returns 403 for non-privileged user not in roster', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    prismaMock.course.findFirst.mockResolvedValue({ id: 'c1' });
    prismaMock.activityLog.findMany.mockResolvedValue([]);
    prismaMock.activityLog.count.mockResolvedValue(0);
    // roster.findFirst already defaults to null (denied) via beforeEach.

    const req = new NextRequest('http://localhost/api/courses/c1/activity');
    const res = await GET(req, { params: Promise.resolve({ id: 'c1' }) });

    expect(res.status).toBe(403);
  });

  it('denies an enrolled STUDENT (staff-only feed)', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    prismaMock.course.findFirst.mockResolvedValue({ id: 'c1' });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'STUDENT' });

    const req = new NextRequest('http://localhost/api/courses/c1/activity');
    const res = await GET(req, { params: Promise.resolve({ id: 'c1' }) });

    expect(res.status).toBe(403);
  });

  it('returns the page envelope', async () => {
    staff();
    prismaMock.activityLog.findMany.mockResolvedValue([{ id: 'log1' }]);
    prismaMock.activityLog.count.mockResolvedValue(80);

    const res = await GET(req('?page=2&pageSize=5'), ctx);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      rows: [{ id: 'log1' }],
      total: 80,
      page: 2,
      pageSize: 5,
      totalPages: 16,
    });
  });

  it('turns page and pageSize into skip and take', async () => {
    staff();

    await GET(req('?page=3&pageSize=20'), ctx);

    const call = prismaMock.activityLog.findMany.mock.calls[0][0];
    expect(call.skip).toBe(40);
    expect(call.take).toBe(20);
  });

  it('clamps an oversized pageSize', async () => {
    staff();

    await GET(req('?pageSize=99999'), ctx);

    expect(prismaMock.activityLog.findMany.mock.calls[0][0].take).toBe(200);
  });

  it('never reads the whole roster to decide visibility', async () => {
    staff();

    await GET(req(), ctx);

    // Membership is a relation filter now. Loading every roster row per request is what
    // this replaced; `roster.findFirst` (the auth gate) is expected, `findMany` is not.
    expect(prismaMock.roster.findMany).not.toHaveBeenCalled();
  });

  /*
   * The visibility rule is the one thing this route must not get wrong, and the rewrite to
   * relation filters is exactly the kind of change that could widen it. These assert the
   * rule as clauses that must be present, so a filter can narrow the feed but never
   * loosen who appears in it.
   */
  describe('visibility', () => {
    const startDate = new Date('2026-01-01');
    const endDate = new Date('2026-05-01');
    const isMember = { user: { rosterEntries: { some: { courseId: 'c1' } } } };
    const isStaff = {
      user: { rosterEntries: { some: { courseId: 'c1', role: { in: ['FACULTY', 'TA'] } } } },
    };
    const inDates = { timestamp: { gte: startDate, lte: endDate } };

    const visibilityOf = () => {
      const where = prismaMock.activityLog.findMany.mock.calls[0][0].where;
      // Caller filters AND on top of the visibility clause, which is always first.
      return where.AND[0];
    };

    beforeEach(() => {
      staff();
      prismaMock.course.findFirst.mockResolvedValue({ id: 'c1', startDate, endDate });
    });

    it('shows admin and staff course-content any time, and clips other members', async () => {
      await GET(req(), ctx);

      const actorClause = visibilityOf().OR[0].AND[1];
      // Any admin, enrolled or not, on course content, any time.
      expect(actorClause.OR).toContainEqual({ user: { isAdmin: true } });
      // Enrolled Faculty/TA, any time.
      expect(actorClause.OR).toContainEqual(isStaff);
      // Other enrolled members, only within the course dates.
      expect(actorClause.OR).toContainEqual({ AND: [isMember, inDates] });
    });

    it('shows member (non-admin) logins only within the course dates', async () => {
      await GET(req(), ctx);

      const loginBranch = visibilityOf().OR[1];
      expect(loginBranch.AND).toContainEqual({ action: { contains: 'LOGIN' } });
      expect(loginBranch.AND).toContainEqual(isMember);
      // Admin logins are excluded (only their course edits are relevant).
      expect(loginBranch.AND).toContainEqual({ user: { isAdmin: false } });
      expect(loginBranch.AND).toContainEqual(inDates);
    });

    it('keeps the visibility clause intact when a caller filter is applied', async () => {
      await GET(req('?category=COURSE&q=grade'), ctx);

      const where = prismaMock.activityLog.findMany.mock.calls[0][0].where;
      // Filters are siblings of the visibility clause, never merged into its OR.
      expect(where.AND[0].OR).toHaveLength(2);
      expect(where.AND).toContainEqual({ category: { in: ['COURSE'] } });
    });
  });

  describe('filters, search and sort', () => {
    beforeEach(() => staff());

    const clauses = () => prismaMock.activityLog.findMany.mock.calls[0][0].where.AND;

    it('filters by category, dropping unknown tokens', async () => {
      await GET(req('?category=COURSE&category=BANANA'), ctx);

      expect(clauses()).toContainEqual({ category: { in: ['COURSE'] } });
    });

    it('filters by assignment and problem', async () => {
      await GET(req('?assignmentId=a1&assignmentId=a2&problemId=p1'), ctx);

      expect(clauses()).toContainEqual({ assignmentId: { in: ['a1', 'a2'] } });
      expect(clauses()).toContainEqual({ problemId: { in: ['p1'] } });
    });

    it('searches action, category and the actor by default', async () => {
      await GET(req('?q=grade'), ctx);

      const like = { contains: 'grade', mode: 'insensitive' };
      // slice(1) skips the visibility clause, which is itself an OR.
      const or = clauses()
        .slice(1)
        .find((c: { OR?: unknown[] }) => c.OR)?.OR;
      expect(or).toContainEqual({ action: like });
      expect(or).toContainEqual({ category: like });
      expect(or).toContainEqual({ user: { email: like } });
    });

    it('narrows the search to one field when a scope is picked', async () => {
      await GET(req('?q=grade&field=action'), ctx);

      expect(clauses()).toContainEqual({
        OR: [{ action: { contains: 'grade', mode: 'insensitive' } }],
      });
    });

    it('defaults to newest first with a stable tiebreaker', async () => {
      await GET(req(), ctx);

      expect(prismaMock.activityLog.findMany.mock.calls[0][0].orderBy).toEqual([
        { timestamp: 'desc' },
        { id: 'asc' },
      ]);
    });

    it('sorts by an allowed column', async () => {
      await GET(req('?sortBy=action&sortDir=asc'), ctx);

      expect(prismaMock.activityLog.findMany.mock.calls[0][0].orderBy).toEqual([
        { action: 'asc' },
        { id: 'asc' },
      ]);
    });

    /**
     * The other half of the guard in `activity-columns.test.tsx`: that one pins the table's
     * sort controls to ACTIVITY_SORT_KEYS, this one pins the server to the same list. Without
     * both, adding a column and forgetting the route's map gives a header that sorts nothing
     * while still showing an indicator.
     */
    it('accepts every column the table offers a sort control for', async () => {
      for (const key of ACTIVITY_SORT_KEYS) {
        prismaMock.activityLog.findMany.mockClear();
        await GET(req(`?sortBy=${key}&sortDir=asc`), ctx);

        const orderBy = prismaMock.activityLog.findMany.mock.calls[0][0].orderBy;
        // The field the key names, rather than "not the default": an unrecognised key falls
        // back to `{ timestamp: sortDir }`, which for sortDir=asc is not the default either.
        const field = key === 'userLastName' ? 'lastName' : key;
        expect(JSON.stringify(orderBy[0])).toContain(field);
      }
    });

    it('falls back to timestamp for a column that is not sortable', async () => {
      await GET(req('?sortBy=assignment'), ctx);

      expect(prismaMock.activityLog.findMany.mock.calls[0][0].orderBy).toEqual([
        { timestamp: 'desc' },
        { id: 'asc' },
      ]);
    });
  });

  describe('?part=filters', () => {
    it('returns the course assignments and problems', async () => {
      staff();
      prismaMock.assignment.findMany.mockResolvedValue([{ id: 'a1', title: 'A1' }]);
      prismaMock.problem.findMany.mockResolvedValue([{ id: 'p1', title: 'P1' }]);

      const res = await GET(req('?part=filters'), ctx);

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        assignments: [{ id: 'a1', title: 'A1' }],
        problems: [{ id: 'p1', title: 'P1' }],
      });
      // No page query for the options request.
      expect(prismaMock.activityLog.findMany).not.toHaveBeenCalled();
    });

    /**
     * The two option lists are the only place this route names assignments and problems, and
     * the prisma mock answers with its fixture whatever the `where` says. Without the
     * `courseId` the filter dropdowns on one course's activity page would list every
     * assignment and problem title in the installation, which is other courses' material.
     */
    it('lists only this course’s assignments and problems', async () => {
      staff();
      prismaMock.assignment.findMany.mockResolvedValue([]);
      prismaMock.problem.findMany.mockResolvedValue([]);

      await GET(req('?part=filters'), ctx);

      expect(prismaMock.assignment.findMany.mock.calls[0][0]).toMatchObject({
        where: { courseId: 'c1' },
      });
      expect(prismaMock.problem.findMany.mock.calls[0][0]).toMatchObject({
        where: { courseId: 'c1' },
      });
    });
  });

  it('returns 500 when activity query fails', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN', isAdmin: true } });
    prismaMock.course.findFirst.mockResolvedValue({ id: 'c1' });
    prismaMock.activityLog.findMany.mockRejectedValue(new Error('boom'));

    const res = await GET(req('?page=1&pageSize=10'), ctx);

    expect(res.status).toBe(500);
  });
});
