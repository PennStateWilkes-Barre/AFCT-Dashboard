import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  user: { findMany: vi.fn() },
  activityLog: { findMany: vi.fn(), count: vi.fn() },
  // The route names the records an entry points at. Absent from this mock, the tests below
  // passed only because no fixture carried a courseId, so the lookups short-circuited and the
  // code that resolves them never ran.
  course: { findMany: vi.fn() },
  assignment: { findMany: vi.fn() },
  problem: { findMany: vi.fn() },
}));

const authMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));

import { GET } from './route';
import { routeCtx } from '@/test/route';

const request = (query = '') => new Request(`http://localhost/api/logging${query}`);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('GET /api/logging', () => {
  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);
    expect((await GET(request(), routeCtx())).status).toBe(401);
  });

  it('returns 403 when the user is not an admin', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'STUDENT' } });
    expect((await GET(request(), routeCtx())).status).toBe(403);
  });

  it('returns a page of logs, the author named alongside the id rather than instead of it', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.activityLog.count.mockResolvedValue(2);
    prismaMock.activityLog.findMany.mockResolvedValue([
      { id: 'log1', userId: 'u1', action: 'A', timestamp: new Date('2025-01-02T00:00:00.000Z') },
      { id: 'log2', userId: null, action: 'B', timestamp: new Date('2025-01-01T00:00:00.000Z') },
    ]);
    prismaMock.user.findMany.mockResolvedValue([
      { id: 'u1', firstName: 'Ada', lastName: 'Lovelace', email: null },
    ]);

    const res = await GET(request(), routeCtx());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(50);
    expect(body.totalPages).toBe(1);
    /**
     * The id survives. Copy JSON serialises this row into bug reports and disclosure records,
     * and a name is not an identifier: two people share one, and a deleted account leaves it
     * pointing at nothing.
     */
    expect(body.rows[0].userId).toBe('u1');
    expect(body.rows[0].userDisplayName).toBe('Ada Lovelace');
    expect(body.rows[1].userId).toBeNull();
    expect(body.rows[1].userDisplayName).toBeNull();
  });

  it('applies page and pageSize as skip/take', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.activityLog.count.mockResolvedValue(100);
    prismaMock.activityLog.findMany.mockResolvedValue([]);

    const res = await GET(request('?page=3&pageSize=20'), routeCtx());

    const call = prismaMock.activityLog.findMany.mock.calls[0][0];
    expect(call.skip).toBe(40);
    expect(call.take).toBe(20);
    const body = await res.json();
    expect(body.totalPages).toBe(5);
    expect(body.page).toBe(3);
  });

  it('clamps pageSize to the maximum', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.activityLog.count.mockResolvedValue(0);
    prismaMock.activityLog.findMany.mockResolvedValue([]);

    await GET(request('?pageSize=99999'), routeCtx());

    expect(prismaMock.activityLog.findMany.mock.calls[0][0].take).toBe(200);
  });

  it('searches action/category and logs authored by matching users', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    // First user.findMany = search-by-name match; second = name resolution.
    prismaMock.user.findMany
      .mockResolvedValueOnce([{ id: 'u1' }])
      .mockResolvedValueOnce([{ id: 'u1', firstName: 'Ada', lastName: 'Lovelace', email: null }]);
    prismaMock.activityLog.count.mockResolvedValue(1);
    prismaMock.activityLog.findMany.mockResolvedValue([
      { id: 'log1', userId: 'u1', action: 'LOGIN', timestamp: new Date() },
    ]);

    const res = await GET(request('?q=ada'), routeCtx());

    expect(res.status).toBe(200);
    const where = prismaMock.activityLog.findMany.mock.calls[0][0].where;
    // action + category + matched-user clauses, wrapped in the AND combiner.
    const orClause = where.AND[0].OR;
    expect(orClause).toHaveLength(3);
    expect(orClause).toContainEqual({ userId: { in: ['u1'] } });
    const body = await res.json();
    expect(body.rows[0].userId).toBe('u1');
    expect(body.rows[0].userDisplayName).toBe('Ada Lovelace');
  });

  it('scopes the search to a single field (action) without a user lookup', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.activityLog.count.mockResolvedValue(0);
    prismaMock.activityLog.findMany.mockResolvedValue([]);

    await GET(request('?q=login&field=action'), routeCtx());

    const where = prismaMock.activityLog.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      AND: [{ OR: [{ action: { contains: 'login', mode: 'insensitive' } }] }],
    });
    // Action scope never resolves users.
    expect(prismaMock.user.findMany).not.toHaveBeenCalled();
  });

  it('returns no rows when a name-scoped search matches no users', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findMany.mockResolvedValue([]); // no user matches
    prismaMock.activityLog.count.mockResolvedValue(0);
    prismaMock.activityLog.findMany.mockResolvedValue([]);

    await GET(request('?q=nobody&field=name'), routeCtx());

    const where = prismaMock.activityLog.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ AND: [{ id: { in: [] } }] });
  });

  it('sorts by an allowed column and direction', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.activityLog.count.mockResolvedValue(0);
    prismaMock.activityLog.findMany.mockResolvedValue([]);

    await GET(request('?sortBy=action&sortDir=asc'), routeCtx());

    expect(prismaMock.activityLog.findMany.mock.calls[0][0].orderBy).toEqual({ action: 'asc' });
  });

  it('sorts the user column by author last name', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.activityLog.count.mockResolvedValue(0);
    prismaMock.activityLog.findMany.mockResolvedValue([]);

    await GET(request('?sortBy=userId&sortDir=desc'), routeCtx());

    expect(prismaMock.activityLog.findMany.mock.calls[0][0].orderBy).toEqual({
      user: { lastName: 'desc' },
    });
  });

  it('defaults to newest-first for an unknown sort column', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.activityLog.count.mockResolvedValue(0);
    prismaMock.activityLog.findMany.mockResolvedValue([]);

    await GET(request('?sortBy=bogus&sortDir=asc'), routeCtx());

    expect(prismaMock.activityLog.findMany.mock.calls[0][0].orderBy).toEqual({ timestamp: 'desc' });
  });

  it('filters by severity when a valid level is given (case-insensitive)', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.activityLog.count.mockResolvedValue(0);
    prismaMock.activityLog.findMany.mockResolvedValue([]);

    await GET(request('?severity=error'), routeCtx());

    const where = prismaMock.activityLog.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ AND: [{ severity: { in: ['ERROR'] } }] });
  });

  it('filters by multiple severities (repeated param)', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.activityLog.count.mockResolvedValue(0);
    prismaMock.activityLog.findMany.mockResolvedValue([]);

    await GET(request('?severity=error&severity=security'), routeCtx());

    const where = prismaMock.activityLog.findMany.mock.calls[0][0].where;
    // Kept in canonical order regardless of param order.
    expect(where).toEqual({ AND: [{ severity: { in: ['ERROR', 'SECURITY'] } }] });
  });

  it('ignores an unknown severity value', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.activityLog.count.mockResolvedValue(0);
    prismaMock.activityLog.findMany.mockResolvedValue([]);

    await GET(request('?severity=bogus'), routeCtx());

    const where = prismaMock.activityLog.findMany.mock.calls[0][0].where;
    expect(where).toEqual({});
  });

  it('filters by category when valid (case-insensitive) and ignores unknown', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.activityLog.count.mockResolvedValue(0);
    prismaMock.activityLog.findMany.mockResolvedValue([]);

    await GET(request('?category=course'), routeCtx());
    expect(prismaMock.activityLog.findMany.mock.calls[0][0].where).toEqual({
      AND: [{ category: { in: ['COURSE'] } }],
    });

    await GET(request('?category=bogus'), routeCtx());
    expect(prismaMock.activityLog.findMany.mock.calls[1][0].where).toEqual({});
  });

  it('falls back to email when the user has no name', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.activityLog.count.mockResolvedValue(1);
    prismaMock.activityLog.findMany.mockResolvedValue([
      { id: 'log1', userId: 'u1', action: 'A', timestamp: new Date() },
    ]);
    prismaMock.user.findMany.mockResolvedValue([
      { id: 'u1', firstName: null, lastName: null, email: 'nameless@x.edu' },
    ]);

    const res = await GET(request(), routeCtx());
    const body = await res.json();
    expect(body.rows[0].userDisplayName).toBe('nameless@x.edu');
    expect(body.rows[0].userId).toBe('u1');
  });

  it('leaves the raw id when the author is not found', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.activityLog.count.mockResolvedValue(1);
    prismaMock.activityLog.findMany.mockResolvedValue([
      { id: 'log1', userId: 'ghost', action: 'A', timestamp: new Date() },
    ]);
    prismaMock.user.findMany.mockResolvedValue([]);

    const res = await GET(request(), routeCtx());
    const body = await res.json();
    expect(body.rows[0].userId).toBe('ghost');
  });

  it('returns 500 when the query fails', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.activityLog.count.mockRejectedValue(new Error('db down'));
    prismaMock.activityLog.findMany.mockResolvedValue([]);

    expect((await GET(request(), routeCtx())).status).toBe(500);
  });
});

/**
 * Naming what an entry is about.
 *
 * `courseId` and the rest are columns on the row, and an identifier is no use to somebody
 * reading an audit trail. The names are resolved per page, batched the same way the author names
 * are, so this stays a fixed number of queries however large the page is.
 */
describe('the records an entry points at', () => {
  const asAdmin = () =>
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });

  const withLogs = (logs: Record<string, unknown>[]) => {
    prismaMock.activityLog.count.mockResolvedValue(logs.length);
    prismaMock.activityLog.findMany.mockResolvedValue(logs);
    prismaMock.user.findMany.mockResolvedValue([]);
  };

  it('names the course, assignment and problem', async () => {
    asAdmin();
    withLogs([
      {
        id: 'log1',
        userId: null,
        action: 'PROBLEM_GRADE_UPDATED',
        timestamp: new Date(),
        courseId: 'c1',
        assignmentId: 'a1',
        problemId: 'p1',
        submissionId: 's1',
      },
    ]);
    prismaMock.course.findMany.mockResolvedValue([{ id: 'c1', code: 'CMPSC 464', name: 'Theory' }]);
    prismaMock.assignment.findMany.mockResolvedValue([{ id: 'a1', title: 'Problem set 1' }]);
    prismaMock.problem.findMany.mockResolvedValue([{ id: 'p1', title: 'DFA' }]);

    const body = await (await GET(request(), routeCtx())).json();

    expect(body.rows[0].related).toEqual({
      course: 'CMPSC 464, Theory',
      assignment: 'Problem set 1',
      problem: 'DFA',
      submission: 's1',
    });

    // Each lookup asks for the ids this page's entries actually carry, one query per kind.
    // The mocks answer with their fixture whatever the `where` says, so the names above
    // would still come out right if a lookup asked for the wrong column's ids, or none.
    expect(prismaMock.course.findMany.mock.calls[0][0]).toMatchObject({
      where: { id: { in: ['c1'] } },
    });
    expect(prismaMock.assignment.findMany.mock.calls[0][0]).toMatchObject({
      where: { id: { in: ['a1'] } },
    });
    expect(prismaMock.problem.findMany.mock.calls[0][0]).toMatchObject({
      where: { id: { in: ['p1'] } },
    });
  });

  /**
   * The relations are `SetNull` on delete, so an id can outlive what it pointed at. The id is
   * kept rather than dropped: it still says the entry was about something, which in an audit
   * trail beats saying nothing.
   */
  it('keeps the identifier for a record that has since been deleted', async () => {
    asAdmin();
    withLogs([
      { id: 'log1', userId: null, action: 'A', timestamp: new Date(), courseId: 'gone' },
    ]);
    prismaMock.course.findMany.mockResolvedValue([]);
    prismaMock.assignment.findMany.mockResolvedValue([]);
    prismaMock.problem.findMany.mockResolvedValue([]);

    const body = await (await GET(request(), routeCtx())).json();

    expect(body.rows[0].related.course).toBe('gone');
  });

  // One query per kind for the whole page, not one per row.
  it('resolves a page in a fixed number of queries', async () => {
    asAdmin();
    withLogs(
      Array.from({ length: 25 }, (_, i) => ({
        id: `log${i}`,
        userId: null,
        action: 'A',
        timestamp: new Date(),
        courseId: i % 2 === 0 ? 'c1' : 'c2',
      })),
    );
    prismaMock.course.findMany.mockResolvedValue([
      { id: 'c1', code: 'A', name: 'One' },
      { id: 'c2', code: 'B', name: 'Two' },
    ]);
    prismaMock.assignment.findMany.mockResolvedValue([]);
    prismaMock.problem.findMany.mockResolvedValue([]);

    await GET(request(), routeCtx());

    expect(prismaMock.course.findMany).toHaveBeenCalledTimes(1);
    // Deduplicated: two distinct courses across twenty-five rows.
    expect(prismaMock.course.findMany.mock.calls[0][0].where.id.in).toEqual(['c1', 'c2']);
  });

  // Nothing to resolve should cost nothing.
  it('asks for nothing when no entry points anywhere', async () => {
    asAdmin();
    withLogs([{ id: 'log1', userId: null, action: 'A', timestamp: new Date() }]);

    await GET(request(), routeCtx());

    expect(prismaMock.course.findMany).not.toHaveBeenCalled();
    expect(prismaMock.assignment.findMany).not.toHaveBeenCalled();
    expect(prismaMock.problem.findMany).not.toHaveBeenCalled();
  });
});
