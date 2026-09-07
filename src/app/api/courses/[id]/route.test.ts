import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  course: {
    findUnique: vi.fn(),
    update: vi.fn(),
    findFirst: vi.fn(),
    delete: vi.fn(),
  },
  roster: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    count: vi.fn(),
  },
  assignment: {
    count: vi.fn(),
  },
  problem: {
    count: vi.fn(),
  },
  submission: {
    findFirst: vi.fn(),
    count: vi.fn(),
  },
  comment: {
    count: vi.fn(),
  },
  assignmentProblem: {
    findMany: vi.fn(),
  },
  // The header badge asks which LMS courses open this one. Mocked here as well as everywhere
  // else the payload is read: a missing delegate makes the whole route 500, which reads as an
  // unrelated failure.
  ltiContextLink: {
    findMany: vi.fn(),
  },
  systemSettings: {
    findUnique: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
  },
  $transaction: vi.fn(),
}));

const authMock = vi.hoisted(() => vi.fn());
const activityLogMock = vi.hoisted(() => vi.fn());
const canArchiveMock = vi.hoisted(() => vi.fn());
const canUnpublishMock = vi.hoisted(() => vi.fn());
const toDateTimeMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/activity-log-utils', () => ({ createEnhancedActivityLog: activityLogMock }));
vi.mock('@/lib/course-status-checks', () => ({
  canArchiveCourse: canArchiveMock,
  canUnpublishCourse: canUnpublishMock,
}));
vi.mock('@/lib/date-convert', () => ({
  toDateTimeInTimezone: toDateTimeMock,
}));

import { GET, PUT, DELETE } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(null);
  // Default: the course is not archived, so the wrapper's archive freeze is a no-op.
  prismaMock.course.findUnique.mockResolvedValue({ isArchived: false });
  prismaMock.ltiContextLink.findMany.mockResolvedValue([]);
  canArchiveMock.mockResolvedValue({ canArchive: true, reason: '' });
  canUnpublishMock.mockResolvedValue({ canUnpublish: true, reason: '' });
  toDateTimeMock.mockImplementation((val: string) => new Date(val));
  // Run the transaction callback against the same mock.
  prismaMock.$transaction.mockImplementation(async (fn: (tx: typeof prismaMock) => unknown) =>
    fn(prismaMock),
  );
});

describe('GET /api/courses/[id]', () => {
  it('returns 400 when id is missing', async () => {
    // Authenticated so the wrapper reaches its missing-course-id check (auth is
    // verified before the id is resolved).
    authMock.mockResolvedValue({ user: { id: 'admin-1', isAdmin: true } });

    const res = await GET(new Request('http://localhost/api/courses/'), {
      params: Promise.resolve({ id: '' }),
    });

    expect(res.status).toBe(400);
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await GET(new Request('http://localhost/api/courses/1'), {
      params: Promise.resolve({ id: 'course-1' }),
    });

    expect(res.status).toBe(401);
  });

  it('returns 404 for a soft-deleted course, even for an admin', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', isAdmin: true } });
    prismaMock.roster.findFirst.mockResolvedValue(null);
    prismaMock.course.findUnique.mockResolvedValue({
      id: 'course-1',
      deletedAt: new Date(),
      _count: { assignments: 0, problems: 0, roster: 0 },
      roster: [],
    });

    const res = await GET(new Request('http://localhost/api/courses/1'), {
      params: Promise.resolve({ id: 'course-1' }),
    });

    expect(res.status).toBe(404);
  });

  it('returns 403 when a non-staff user is not enrolled in the course', async () => {
    authMock.mockResolvedValue({ user: { id: 'stranger', role: 'STUDENT' } });
    prismaMock.course.findUnique.mockResolvedValue({ id: 'course-1' });
    prismaMock.roster.findFirst.mockResolvedValue(null);

    const res = await GET(new Request('http://localhost/api/courses/1'), {
      params: Promise.resolve({ id: 'course-1' }),
    });

    expect(res.status).toBe(403);
  });

  it('allows an enrolled student to view the course', async () => {
    authMock.mockResolvedValue({ user: { id: 'stu-1', role: 'STUDENT' } });
    prismaMock.course.findUnique.mockResolvedValue({
      id: 'course-1',
      name: 'C1',
      code: 'CS1',
      regCode: 'ABC123',
      semester: 'Fall 2026',
      credits: 3,
      startDate: new Date('2026-08-25T13:00:00.000Z'),
      endDate: new Date('2026-12-15T22:00:00.000Z'),
      registrationOpenAt: null,
      registrationCloseAt: null,
      isPublished: true,
      isArchived: false,
      emptyStringNotation: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'STUDENT', course: { isPublished: true } });

    const res = await GET(new Request('http://localhost/api/courses/1'), {
      params: Promise.resolve({ id: 'course-1' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.viewerRole).toBe('STUDENT');
  });

  it('tells staff which LMS courses open this one, and a student nothing', async () => {
    const course = {
      id: 'course-1',
      name: 'C1',
      code: 'CS1',
      semester: 'Fall 2026',
      credits: 3,
      startDate: new Date('2026-08-25T13:00:00.000Z'),
      endDate: new Date('2026-12-15T22:00:00.000Z'),
      isPublished: true,
      isArchived: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    };
    prismaMock.course.findUnique.mockResolvedValue(course);
    prismaMock.ltiContextLink.findMany.mockResolvedValue([
      { contextTitle: 'CMPSC 464 F26', platform: { name: 'Canvas', issuer: 'https://c.test' } },
    ]);

    authMock.mockResolvedValue({ user: { id: 'u1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    const staffBody = await (
      await GET(new Request('http://localhost/api/courses/1'), {
        params: Promise.resolve({ id: 'course-1' }),
      })
    ).json();

    expect(staffBody.lmsLinks).toEqual([{ platform: 'Canvas', context: 'CMPSC 464 F26' }]);

    // How a course is wired to an LMS is course administration, so the same payload says
    // nothing about it to a student, whatever the links are.
    authMock.mockResolvedValue({ user: { id: 'stu-1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue({
      role: 'STUDENT',
      course: { isPublished: true },
    });
    const studentBody = await (
      await GET(new Request('http://localhost/api/courses/1'), {
        params: Promise.resolve({ id: 'course-1' }),
      })
    ).json();

    expect(studentBody.lmsLinks).toEqual([]);
  });

  it('restricts a student view to published assignments and omits the problem bank', async () => {
    authMock.mockResolvedValue({ user: { id: 'stu-1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'STUDENT', course: { isPublished: true } });
    prismaMock.course.findUnique.mockResolvedValue({
      id: 'course-1',
      name: 'C1',
      code: 'CS1',
      isPublished: true,
      isArchived: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      _count: { assignments: 5, problems: 9, roster: 3 },
      assignments: [],
      roster: [],
    });

    await GET(new Request('http://localhost/api/courses/1'), {
      params: Promise.resolve({ id: 'course-1' }),
    });

    // Pick the handler's fetch (the one with `include`), not the wrapper's
    // soft-delete `select` probe that now runs first.
    const include = prismaMock.course.findUnique.mock.calls.find((c) => c[0]?.include)?.[0].include;
    // Students only get published assignments that are assigned to them (published alone
    // would leak every assignment's id and description), and never the problem bank.
    expect(include.assignments.where.isPublished).toBe(true);
    expect(include.assignments.where.OR).toEqual([
      { assignedToEveryone: true },
      { assignees: { some: { userId: 'stu-1' } } },
      { assignees: { some: { studentGroup: { memberships: { some: { userId: 'stu-1' } } } } } },
    ]);
    expect(include.problems).toBeUndefined();

    // The response totals must not leak counts of hidden data.
    const body = await (
      await GET(new Request('http://localhost/api/courses/1'), {
        params: Promise.resolve({ id: 'course-1' }),
      })
    ).json();
    expect(body.problems).toEqual([]);
    expect(body.problemTotal).toBe(0);
    expect(body.assignmentTotal).toBe(0); // no published assignments in this mock
  });

  it('gives staff all assignments and the problem bank', async () => {
    authMock.mockResolvedValue({ user: { id: 'fac-1', role: 'FACULTY' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.course.findUnique.mockResolvedValue({
      id: 'course-1',
      name: 'C1',
      code: 'CS1',
      isPublished: true,
      isArchived: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      _count: { assignments: 5, problems: 9, roster: 3 },
      assignments: [],
      problems: [],
      roster: [],
    });

    await GET(new Request('http://localhost/api/courses/1'), {
      params: Promise.resolve({ id: 'course-1' }),
    });

    // Pick the handler's fetch (the one with `include`), not the wrapper's
    // soft-delete `select` probe that now runs first.
    const include = prismaMock.course.findUnique.mock.calls.find((c) => c[0]?.include)?.[0].include;
    expect(include.assignments.where).toEqual({});
    expect(include.problems).toBe(true);
  });

  it('asks the database for course staff only, never the students', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN', isAdmin: true } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.course.findUnique.mockResolvedValue({
      id: 'course-1',
      name: 'C1',
      code: 'CS1',
      isPublished: true,
      isArchived: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      _count: { assignments: 0, problems: 0, roster: 1200 },
      assignments: [],
      roster: [],
    });

    await GET(new Request('http://localhost/api/courses/1'), {
      params: Promise.resolve({ id: 'course-1' }),
    });

    // The whole point of the change: a 1,200-student course must not inline its roster
    // into a payload that is read on every tab. Students come from the paginated
    // GET /api/courses/[id]/roster instead.
    // Pick the handler's fetch (the one with `include`), not the wrapper's soft-delete probe.
    const include = prismaMock.course.findUnique.mock.calls.find((c) => c[0]?.include)?.[0].include;
    expect(include.roster.where).toEqual({ role: { in: ['FACULTY', 'TA'] } });
  });

  it('reports the whole roster size even though it only returns staff', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN', isAdmin: true } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.course.findUnique.mockResolvedValue({
      id: 'course-1',
      name: 'C1',
      code: 'CS1',
      isPublished: true,
      isArchived: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      _count: { assignments: 0, problems: 0, roster: 1200 },
      assignments: [],
      roster: [
        {
          role: 'FACULTY',
          status: 'ENROLLED',
          user: { id: 'u1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@x.edu' },
        },
      ],
    });

    const body = await (
      await GET(new Request('http://localhost/api/courses/1'), {
        params: Promise.resolve({ id: 'course-1' }),
      })
    ).json();

    // One staff row on the payload, 1,200 members in the course. The tab count reads the
    // second number, so it must not be derived from the array.
    expect(body.staff).toHaveLength(1);
    expect(body.rosterTotal).toBe(1200);
  });

  it('gives a student a privacy-safe roster (staff names only, no classmate email)', async () => {
    authMock.mockResolvedValue({ user: { id: 'stu-1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'STUDENT', course: { isPublished: true } });
    prismaMock.course.findUnique.mockResolvedValue({
      id: 'course-1',
      name: 'C1',
      code: 'CS1',
      regCode: 'SECRET',
      isPublished: true,
      isArchived: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      _count: { assignments: 0, problems: 0, roster: 2 },
      assignments: [],
      roster: [
        {
          role: 'FACULTY',
          user: { id: 'u1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@x.edu' },
        },
        {
          role: 'STUDENT',
          user: { id: 'u2', firstName: 'Alan', lastName: 'Turing', email: 'alan@x.edu' },
        },
      ],
    });

    const body = await (
      await GET(new Request('http://localhost/api/courses/1'), {
        params: Promise.resolve({ id: 'course-1' }),
      })
    ).json();

    expect(body.regCode).toBeNull(); // reg code is staff-only
    // The mock returns a student row deliberately, ignoring the query's where clause, so
    // this proves the student-facing reduction still strips peers even if a classmate row
    // ever reached it.
    const serialized = JSON.stringify(body.staff);
    expect(serialized).not.toContain('@x.edu'); // no emails
    expect(serialized).not.toContain('Alan'); // no classmate (student) name
    expect(serialized).not.toContain('u2'); // no classmate id
    expect(body.staff).toContainEqual(
      expect.objectContaining({ firstName: 'Ada', courseRole: 'FACULTY' }),
    );
  });

  it('returns 404 when course is not found', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN', isAdmin: true } });
    prismaMock.course.findUnique.mockResolvedValue(null);

    const res = await GET(new Request('http://localhost/api/courses/1'), {
      params: Promise.resolve({ id: 'missing' }),
    });

    expect(res.status).toBe(404);
  });

  it('returns course with its staff and assignment flags', async () => {
    prismaMock.course.findUnique.mockResolvedValue({
      id: 'course-1',
      name: 'Course 1',
      code: 'CS101',
      regCode: 'ABC123',
      semester: 'Fall 2026',
      credits: 3,
      startDate: new Date('2026-08-25T13:00:00.000Z'),
      endDate: new Date('2026-12-15T22:00:00.000Z'),
      isPublished: true,
      isArchived: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      // Staff only: the query's where clause keeps students out of this payload.
      roster: [
        {
          role: 'FACULTY',
          status: 'ENROLLED',
          user: { id: 'u1', firstName: 'Ada', lastName: 'Lovelace', role: 'FACULTY' },
        },
        {
          role: 'TA',
          status: 'ENROLLED',
          user: { id: 'u3', firstName: 'Grace', lastName: 'Hopper', role: 'TA' },
        },
      ],
      problems: [{ id: 'p1', title: 'P1' }],
      assignments: [
        {
          id: 'a1',
          title: 'A1',
          description: null,
          dueDate: new Date('2026-09-01T00:00:00.000Z'),
          isPublished: true,
          allowLateSubmissions: true,
          lateCutoff: new Date('2026-09-05T00:00:00.000Z'),
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-02T00:00:00.000Z'),
          courseId: 'course-1',
          problems: [{ maxPoints: 60 }, { maxPoints: 40 }],
          _count: { problems: 2 },
        },
      ],
    });

    prismaMock.submission.findFirst.mockResolvedValue({ id: 's1' });
    prismaMock.submission.count.mockResolvedValue(2);
    prismaMock.comment.count.mockResolvedValue(1);
    prismaMock.assignmentProblem.findMany.mockResolvedValue([{ problemId: 'p1' }]);
    authMock.mockResolvedValue({ user: { id: 'viewer-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });

    const res = await GET(new Request('http://localhost/api/courses/1'), {
      params: Promise.resolve({ id: 'course-1' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.staff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'u1', courseRole: 'FACULTY' }),
        expect.objectContaining({ id: 'u3', courseRole: 'TA' }),
      ]),
    );
    // hasSubmissions is gone from this payload: it only ever answered "may this roster row
    // be removed", and computing it here crossed every student with every assignment.
    expect(body.staff[0]).not.toHaveProperty('hasSubmissions');
    expect(body.assignments[0]).toEqual(
      expect.objectContaining({
        maxPoints: 100,
        submissionCount: 2,
        commentCount: 1,
        hasSubmissionsOrComments: true,
        allowLateSubmissions: true,
        lateCutoff: '2026-09-05T00:00:00.000Z',
        // Individual/Group classification defaults to individual (false).
        isGroup: false,
      }),
    );
    expect(body.viewerRole).toBe('FACULTY');
  });

  it('hides class-wide submission/comment counts from a student', async () => {
    prismaMock.course.findUnique.mockResolvedValue({
      id: 'course-1',
      name: 'Course 1',
      code: 'CS101',
      isPublished: true,
      isArchived: false,
      _count: { assignments: 1, problems: 0, roster: 2 },
      roster: [
        {
          role: 'STUDENT',
          user: { id: 'viewer-1', firstName: 'S', lastName: 'One', role: 'STUDENT' },
        },
      ],
      problems: [],
      assignments: [
        {
          id: 'a1',
          title: 'A1',
          description: null,
          dueDate: new Date('2026-09-01T00:00:00.000Z'),
          isPublished: true,
          allowLateSubmissions: true,
          lateCutoff: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-02T00:00:00.000Z'),
          courseId: 'course-1',
          problems: [{ maxPoints: 100 }],
          _count: { problems: 1 },
        },
      ],
    });
    // Non-zero on purpose: the student path must NOT query these class-wide totals.
    prismaMock.submission.count.mockResolvedValue(7);
    prismaMock.comment.count.mockResolvedValue(3);
    authMock.mockResolvedValue({ user: { id: 'viewer-1', role: 'STUDENT' } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'STUDENT', course: { isPublished: true } });

    const res = await GET(new Request('http://localhost/api/courses/1'), {
      params: Promise.resolve({ id: 'course-1' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assignments[0]).toEqual(
      expect.objectContaining({
        submissionCount: 0,
        commentCount: 0,
        hasSubmissionsOrComments: false,
      }),
    );
    expect(prismaMock.submission.count).not.toHaveBeenCalled();
    expect(prismaMock.comment.count).not.toHaveBeenCalled();
    expect(body.viewerRole).toBe('STUDENT');
  });

  it('returns 500 when get throws', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN', isAdmin: true } });
    prismaMock.course.findUnique.mockRejectedValue(new Error('db error'));

    const res = await GET(new Request('http://localhost/api/courses/1'), {
      params: Promise.resolve({ id: 'course-1' }),
    });

    expect(res.status).toBe(500);
  });
});

describe('PUT /api/courses/[id]', () => {
  it('returns 400 when id is missing', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });

    const req = new Request('http://localhost/api/courses/', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isArchived: false, isPublished: true }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: '' }) });
    expect(res.status).toBe(400);
  });

  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);

    const req = new Request('http://localhost/api/courses/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isArchived: false, isPublished: true }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: 'course-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 409 and does not update when the course is archived', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.course.findUnique.mockResolvedValue({ isArchived: true });

    const req = new Request('http://localhost/api/courses/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Course 1',
        code: 'CS101',
        semester: 'Fall 2026',
        credits: 3,
        startDate: '2026-08-25T09:00',
        endDate: '2026-12-15T17:00',
        registrationOpenAt: '2026-07-01T09:00',
        registrationCloseAt: '2026-09-01T09:00',
        isPublished: true,
        isArchived: false,
        instructorIds: ['u1'],
      }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: 'course-1' }) });
    expect(res.status).toBe(409);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('returns 400 when isArchived is not a boolean', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ timezone: 'America/New_York' });

    const req = new Request('http://localhost/api/courses/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isArchived: 'nope', isPublished: true }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: 'course-1' }) });
    expect(res.status).toBe(400);
  });

  it('returns 403 when archive check fails', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ timezone: 'America/New_York' });
    canArchiveMock.mockResolvedValue({ canArchive: false, reason: 'archive blocked' });

    const req = new Request('http://localhost/api/courses/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Course 1',
        code: 'CS101',
        semester: 'Fall 2026',
        credits: 3,
        startDate: '2026-08-25T09:00',
        endDate: '2026-12-15T17:00',
        registrationOpenAt: '2026-08-01T09:00',
        registrationCloseAt: '2026-08-31T17:00',
        isArchived: true,
        isPublished: true,
      }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: 'course-1' }) });
    expect(res.status).toBe(403);
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      expect.anything(),
      expect.objectContaining({ action: 'COURSE_ARCHIVE_REJECTED', severity: 'WARNING' }),
    );
  });

  it('returns 403 when unpublish check fails', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ timezone: 'America/New_York' });
    canUnpublishMock.mockResolvedValue({ canUnpublish: false, reason: 'unpublish blocked' });

    const req = new Request('http://localhost/api/courses/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Course 1',
        code: 'CS101',
        semester: 'Fall 2026',
        credits: 3,
        startDate: '2026-08-25T09:00',
        endDate: '2026-12-15T17:00',
        registrationOpenAt: '2026-08-01T09:00',
        registrationCloseAt: '2026-08-31T17:00',
        isArchived: false,
        isPublished: false,
      }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: 'course-1' }) });
    expect(res.status).toBe(403);
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      expect.anything(),
      expect.objectContaining({ action: 'COURSE_UNPUBLISH_REJECTED', severity: 'WARNING' }),
    );
  });

  it('returns 400 when registration window is missing', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ timezone: 'America/New_York' });

    const req = new Request('http://localhost/api/courses/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isArchived: false, isPublished: true, registrationOpenAt: null }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: 'course-1' }) });
    expect(res.status).toBe(400);
  });

  it('requires at least one faculty member', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });

    const req = new Request('http://localhost/api/courses/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Course 1',
        code: 'CS101',
        semester: 'Fall 2026',
        credits: 3,
        startDate: '2026-08-25T09:00',
        endDate: '2026-12-15T17:00',
        isPublished: true,
        isArchived: false,
        instructorIds: [],
      }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: 'course-1' }) });
    expect(res.status).toBe(400);
  });

  it('updates course and syncs faculty roster', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ timezone: 'America/New_York' });
    prismaMock.systemSettings.findUnique.mockResolvedValue({ timezone: 'America/New_York' });

    const txMock = {
      course: {
        update: vi.fn().mockResolvedValue({ id: 'course-1' }),
        findUnique: vi.fn().mockResolvedValue({
          id: 'course-1',
          name: 'Course 1',
          code: 'CS101',
          regCode: 'ABC123',
          semester: 'Fall 2026',
          credits: 3,
          startDate: new Date('2026-08-25T13:00:00.000Z'),
          endDate: new Date('2026-12-15T22:00:00.000Z'),
          isPublished: true,
          isArchived: false,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-02T00:00:00.000Z'),
          problems: [],
          assignments: [
            {
              id: 'a1',
              title: 'A1',
              description: null,
              dueDate: new Date('2026-09-01T00:00:00.000Z'),
              isPublished: true,
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
              updatedAt: new Date('2026-01-02T00:00:00.000Z'),
              courseId: 'course-1',
              problems: [{ maxPoints: 25 }, { maxPoints: 25 }, { maxPoints: 50 }],
              _count: { problems: 3 },
            },
          ],
          roster: [
            {
              role: 'FACULTY',
              user: { id: 'u1', firstName: 'Ada', lastName: 'Lovelace', role: 'FACULTY' },
            },
          ],
        }),
      },
      roster: {
        findMany: vi.fn().mockResolvedValue([{ userId: 'u1', role: 'FACULTY' }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(txMock));
    prismaMock.submission.count.mockResolvedValue(0);
    prismaMock.comment.count.mockResolvedValue(0);
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });

    const req = new Request('http://localhost/api/courses/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Course 1',
        code: 'CS101',
        semester: 'Fall 2026',
        credits: 3,
        startDate: '2026-08-25T09:00',
        endDate: '2026-12-15T17:00',
        registrationOpenAt: '2026-07-01T09:00',
        registrationCloseAt: '2026-09-01T09:00',
        isPublished: true,
        isArchived: false,
        instructorIds: ['u1', 'u2'],
      }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: 'course-1' }) });
    expect(res.status).toBe(200);
    expect(txMock.roster.createMany).toHaveBeenCalled();
    expect(activityLogMock).toHaveBeenCalled();
  });

  it('rejects an empty instructor list once the registration window is provided', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ timezone: 'America/New_York' });

    const req = new Request('http://localhost/api/courses/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Course 1',
        code: 'CS101',
        semester: 'Fall 2026',
        credits: 3,
        startDate: '2026-08-25T09:00',
        endDate: '2026-12-15T17:00',
        registrationOpenAt: '2026-07-01T09:00',
        registrationCloseAt: '2026-09-01T09:00',
        isPublished: true,
        isArchived: false,
        instructorIds: [],
      }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: 'course-1' }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('At least one faculty member is required.');
  });

  it('forbids a TA from changing the faculty roster (instructorIds) and logs a SECURITY event', async () => {
    // A TA passes the route's `manage` gate but must NOT be able to edit the faculty
    // set — otherwise they could promote themselves and remove every instructor.
    authMock.mockResolvedValue({ user: { id: 'ta-1', isAdmin: false } });
    prismaMock.user.findUnique.mockResolvedValue({ timezone: 'America/New_York' });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'TA' });

    const req = new Request('http://localhost/api/courses/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Course 1',
        code: 'CS101',
        semester: 'Fall 2026',
        credits: 3,
        startDate: '2026-08-25T09:00',
        endDate: '2026-12-15T17:00',
        registrationOpenAt: '2026-07-01T09:00',
        registrationCloseAt: '2026-09-01T09:00',
        isPublished: true,
        isArchived: false,
        instructorIds: ['ta-1'],
      }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: 'course-1' }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/faculty or an administrator/i);
    // Blocked before any write.
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(activityLogMock).toHaveBeenCalledWith(
      prismaMock,
      expect.anything(),
      expect.objectContaining({ action: 'COURSE_FACULTY_EDIT_DENIED', severity: 'SECURITY' }),
    );
  });

  it('falls back to the system timezone and groups TA/student roster rows', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    // No personal timezone -> system settings fallback path.
    prismaMock.user.findUnique.mockResolvedValue({ timezone: null });
    prismaMock.systemSettings.findUnique.mockResolvedValue({ timezone: 'UTC' });

    const txMock = {
      course: {
        update: vi.fn().mockResolvedValue({ id: 'course-1' }),
        findUnique: vi.fn().mockResolvedValue({
          id: 'course-1',
          name: 'Course 1',
          code: 'CS101',
          regCode: 'ABC123',
          semester: 'Fall 2026',
          credits: 3,
          startDate: new Date('2026-08-25T13:00:00.000Z'),
          endDate: new Date('2026-12-15T22:00:00.000Z'),
          isPublished: true,
          isArchived: false,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-02T00:00:00.000Z'),
          problems: [],
          assignments: [],
          roster: [
            {
              role: 'FACULTY',
              user: { id: 'u1', firstName: 'Ada', lastName: 'L', role: 'FACULTY' },
            },
            { role: 'TA', user: { id: 'u2', firstName: 'Tim', lastName: 'A', role: 'TA' } },
            {
              role: 'STUDENT',
              user: { id: 'u3', firstName: 'Sam', lastName: 'S', role: 'STUDENT' },
            },
          ],
        }),
      },
      roster: {
        findMany: vi.fn().mockResolvedValue([{ userId: 'u1', role: 'FACULTY' }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };

    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(txMock));
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });

    const req = new Request('http://localhost/api/courses/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Course 1',
        code: 'CS101',
        semester: 'Fall 2026',
        credits: 3,
        startDate: '2026-08-25T09:00',
        endDate: '2026-12-15T17:00',
        registrationOpenAt: '2026-07-01T09:00',
        registrationCloseAt: '2026-09-01T09:00',
        isPublished: true,
        isArchived: false,
        instructorIds: ['u1'],
      }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: 'course-1' }) });
    expect(res.status).toBe(200);
    expect(prismaMock.systemSettings.findUnique).toHaveBeenCalled();
    const body = await res.json();
    expect(body.enrolled).toHaveLength(3);
  });

  it('syncs faculty remove/promote/add and includes admin in instructor lists', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ timezone: 'America/New_York' });
    prismaMock.systemSettings.findUnique.mockResolvedValue({ timezone: 'America/New_York' });

    const txMock = {
      course: {
        update: vi.fn().mockResolvedValue({ id: 'course-1' }),
        findUnique: vi.fn().mockResolvedValue({
          id: 'course-1',
          name: 'Course 1',
          code: 'CS101',
          regCode: 'ABC123',
          semester: 'Fall 2026',
          credits: 3,
          startDate: new Date('2026-08-25T13:00:00.000Z'),
          endDate: new Date('2026-12-15T22:00:00.000Z'),
          isPublished: true,
          isArchived: false,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-02T00:00:00.000Z'),
          problems: [],
          assignments: [],
          roster: [
            {
              role: 'ADMIN',
              user: { id: 'admin-1', firstName: 'Admin', lastName: 'User', role: 'ADMIN' },
            },
            {
              role: 'FACULTY',
              user: { id: 'u3', firstName: 'Grace', lastName: 'Hopper', role: 'FACULTY' },
            },
            {
              role: 'STUDENT',
              user: { id: 's1', firstName: 'Stu', lastName: 'Dent', role: 'STUDENT' },
            },
          ],
        }),
      },
      roster: {
        findMany: vi.fn().mockResolvedValue([
          { userId: 'u1', role: 'FACULTY' },
          { userId: 'u3', role: 'TA' },
          { userId: 'u4', role: 'FACULTY' },
        ]),
        deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(txMock));
    prismaMock.submission.count.mockResolvedValue(0);
    prismaMock.comment.count.mockResolvedValue(0);
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'ADMIN' });

    const req = new Request('http://localhost/api/courses/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Course 1',
        code: 'CS101',
        semester: 'Fall 2026',
        credits: 3,
        startDate: '2026-08-25T09:00',
        endDate: '2026-12-15T17:00',
        registrationOpenAt: '2026-07-01T09:00',
        registrationCloseAt: '2026-09-01T09:00',
        isPublished: true,
        isArchived: false,
        instructorIds: ['u3', 'u5'],
      }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: 'course-1' }) });

    expect(res.status).toBe(200);
    expect(txMock.roster.deleteMany).toHaveBeenCalled();
    expect(txMock.roster.updateMany).toHaveBeenCalled();
    expect(txMock.roster.createMany).toHaveBeenCalled();

    const body = await res.json();
    expect(body.enrolled).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'admin-1', courseRole: 'ADMIN' })]),
    );
  });

  it('records changed fields in the audit log when values differ', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ timezone: 'America/New_York' });
    prismaMock.systemSettings.findUnique.mockResolvedValue({ timezone: 'America/New_York' });

    const refreshed = {
      id: 'course-1',
      name: 'Renamed Course',
      code: 'CS102',
      regCode: 'ABC123',
      semester: 'Fall 2026',
      credits: 4,
      startDate: new Date('2026-08-25T13:00:00.000Z'),
      endDate: new Date('2026-12-15T22:00:00.000Z'),
      registrationOpenAt: null,
      registrationCloseAt: null,
      isPublished: true,
      isArchived: false,
      emptyStringNotation: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      problems: [],
      assignments: [],
      roster: [
        {
          role: 'FACULTY',
          user: { id: 'u1', firstName: 'Ada', lastName: 'L', role: 'FACULTY' },
        },
      ],
    };

    const txMock = {
      course: {
        update: vi.fn().mockResolvedValue({ id: 'course-1' }),
        // First findUnique = `before` snapshot (old values); second = refreshed course.
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({
            name: 'Old Course',
            code: 'CS101',
            semester: 'Fall 2026',
            credits: 3,
            isPublished: false,
            isArchived: false,
            emptyStringNotation: null,
            startDate: new Date('2026-08-25T13:00:00.000Z'),
            endDate: new Date('2026-12-15T22:00:00.000Z'),
            registrationOpenAt: null,
            registrationCloseAt: null,
          })
          .mockResolvedValueOnce(refreshed),
      },
      roster: {
        findMany: vi.fn().mockResolvedValue([{ userId: 'u1', role: 'FACULTY' }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };

    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(txMock));
    prismaMock.submission.count.mockResolvedValue(0);
    prismaMock.comment.count.mockResolvedValue(0);
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });

    const req = new Request('http://localhost/api/courses/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Renamed Course',
        code: 'CS102',
        semester: 'Fall 2026',
        credits: 4,
        startDate: '2026-08-25T09:00',
        endDate: '2026-12-15T17:00',
        registrationOpenAt: '2026-07-01T09:00',
        registrationCloseAt: '2026-09-01T09:00',
        isPublished: true,
        isArchived: false,
        instructorIds: ['u1'],
      }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: 'course-1' }) });
    expect(res.status).toBe(200);

    // The audit log must capture the fields that actually changed.
    const logCall = activityLogMock.mock.calls.find((c) => c[2]?.action === 'UPDATE_COURSE');
    expect(logCall).toBeTruthy();
    expect(logCall![2].metadata.changedFields).toEqual(
      expect.arrayContaining(['name', 'code', 'credits', 'isPublished']),
    );
    expect(logCall![2].metadata.changes.name).toEqual({ from: 'Old Course', to: 'Renamed Course' });
  });

  it('returns 500 when transaction throws', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ timezone: 'America/New_York' });
    prismaMock.$transaction.mockRejectedValue(new Error('tx failed'));

    const req = new Request('http://localhost/api/courses/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Course 1',
        code: 'CS101',
        semester: 'Fall 2026',
        credits: 3,
        startDate: '2026-08-25T09:00',
        endDate: '2026-12-15T17:00',
        registrationOpenAt: '2026-07-01T09:00',
        registrationCloseAt: '2026-09-01T09:00',
        isPublished: true,
        isArchived: false,
        instructorIds: ['u1'],
      }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: 'course-1' }) });
    expect(res.status).toBe(500);
  });

  it('returns 500 when updated course cannot be reloaded', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ timezone: 'America/New_York' });

    const txMock = {
      course: {
        update: vi.fn().mockResolvedValue({ id: 'course-1' }),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      roster: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };

    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(txMock));

    const req = new Request('http://localhost/api/courses/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Course 1',
        code: 'CS101',
        semester: 'Fall 2026',
        credits: 3,
        startDate: '2026-08-25T09:00',
        endDate: '2026-12-15T17:00',
        registrationOpenAt: '2026-07-01T09:00',
        registrationCloseAt: '2026-09-01T09:00',
        isPublished: true,
        isArchived: false,
        instructorIds: ['u1'],
      }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: 'course-1' }) });
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/courses/[id]', () => {
  it('returns 400 when id is missing', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });

    const req = new Request('http://localhost/api/courses/', {
      method: 'DELETE',
      body: JSON.stringify({}),
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: '' }) });

    expect(res.status).toBe(400);
  });

  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);

    const req = new Request('http://localhost/api/courses/1', {
      method: 'DELETE',
      body: JSON.stringify({}),
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'course-1' }) });

    expect(res.status).toBe(401);
  });

  it('forbids a non-admin staff member from deleting (admin-only)', async () => {
    // Faculty passes the manage wrapper but must not delete a course.
    authMock.mockResolvedValue({ user: { id: 'fac-1', isAdmin: false } });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });

    const req = new Request('http://localhost/api/courses/1', {
      method: 'DELETE',
      body: JSON.stringify({}),
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'course-1' }) });

    expect(res.status).toBe(403);
    expect(prismaMock.course.delete).not.toHaveBeenCalled();
  });

  it('returns 404 when course does not exist', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.course.findFirst.mockResolvedValue(null);

    const req = new Request('http://localhost/api/courses/1', {
      method: 'DELETE',
      body: JSON.stringify({}),
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'course-1' }) });

    expect(res.status).toBe(404);
  });

  it('hard-deletes an empty course (no assignments, problems, students, submissions)', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.course.findFirst.mockResolvedValue({ id: 'course-1', name: 'Course 1', code: 'C1' });
    prismaMock.assignment.count.mockResolvedValue(0);
    prismaMock.problem.count.mockResolvedValue(0);
    prismaMock.roster.count.mockResolvedValue(0);
    prismaMock.submission.count.mockResolvedValue(0);
    prismaMock.course.delete.mockResolvedValue({ id: 'course-1' });

    const req = new Request('http://localhost/api/courses/1', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'course-1' }) });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ deleted: 'hard' });
    expect(prismaMock.course.delete).toHaveBeenCalledWith({ where: { id: 'course-1' } });
    expect(prismaMock.course.update).not.toHaveBeenCalled();
    expect(activityLogMock).toHaveBeenCalled();
  });

  /**
   * The counts and the write have to be one serializable transaction.
   *
   * Separately, this was a check-then-act on a destructive path: count, then delete, with a
   * gap in between. A submission arriving in that gap was cascaded away by the hard delete,
   * with no soft-delete left to recover it. Serializable is what makes the emptiness test
   * mean anything, because Postgres aborts on the conflict rather than letting the insert
   * through.
   */
  it('decides and deletes inside one serializable transaction', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.course.findFirst.mockResolvedValue({ id: 'course-1', name: 'Course 1', code: 'C1' });
    prismaMock.assignment.count.mockResolvedValue(0);
    prismaMock.problem.count.mockResolvedValue(0);
    prismaMock.roster.count.mockResolvedValue(0);
    prismaMock.submission.count.mockResolvedValue(0);
    prismaMock.course.delete.mockResolvedValue({ id: 'course-1' });

    const req = new Request('http://localhost/api/courses/1', { method: 'DELETE' });
    await DELETE(req, { params: Promise.resolve({ id: 'course-1' }) });

    expect(prismaMock.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
  });

  it('soft-deletes a course that has students or work', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.course.findFirst.mockResolvedValue({ id: 'course-1', name: 'Course 1', code: 'C1' });
    prismaMock.assignment.count.mockResolvedValue(0);
    prismaMock.problem.count.mockResolvedValue(0);
    prismaMock.roster.count.mockResolvedValue(3); // has students
    prismaMock.submission.count.mockResolvedValue(0);
    prismaMock.course.update.mockResolvedValue({ id: 'course-1', name: 'Course 1' });

    const req = new Request('http://localhost/api/courses/1', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'course-1' }) });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ deleted: 'soft' });
    // Soft delete: stamps deletedAt via update, never a hard delete.
    expect(prismaMock.course.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
    );
    expect(prismaMock.course.delete).not.toHaveBeenCalled();
    expect(activityLogMock).toHaveBeenCalled();
  });

  it('returns 500 when the delete throws', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.course.findFirst.mockResolvedValue({ id: 'course-1', name: 'Course 1', code: 'C1' });
    prismaMock.assignment.count.mockResolvedValue(0);
    prismaMock.problem.count.mockResolvedValue(0);
    prismaMock.roster.count.mockResolvedValue(0);
    prismaMock.submission.count.mockResolvedValue(0);
    prismaMock.course.delete.mockRejectedValue(new Error('delete failed'));

    const req = new Request('http://localhost/api/courses/1', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'course-1' }) });

    expect(res.status).toBe(500);
  });
});

/**
 * What the reads and roster writes on this route are scoped to.
 *
 * The per-assignment totals and the linked-problem lookup are bounded by the ids this course
 * produced, and the faculty roster edits are bounded by the course in the URL. The prisma
 * mocks answer whatever the `where` says, so none of the tests above notice a missing key:
 * `deleteMany({ where: { courseId: id, role: 'FACULTY', userId: { in: toRemove } } })` without
 * its `courseId` removes those people as faculty from every course in the installation, and
 * the assertion that it "was called" still passes.
 */
describe('what this route reads and writes are scoped to', () => {
  const staffCourse = () => ({
    id: 'course-1',
    name: 'C1',
    code: 'CS1',
    semester: 'Fall 2026',
    credits: 3,
    isPublished: true,
    isArchived: false,
    deletedAt: null,
    startDate: null,
    endDate: null,
    registrationOpenAt: null,
    registrationCloseAt: null,
    _count: { assignments: 1, problems: 1, roster: 1 },
    roster: [],
    problems: [{ id: 'p1', title: 'P1' }],
    assignments: [
      {
        id: 'a1',
        title: 'A1',
        description: null,
        dueDate: null,
        isPublished: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
        courseId: 'course-1',
        problems: [{ maxPoints: 10 }],
        _count: { problems: 1 },
      },
    ],
  });

  it('counts submissions and comments per assignment, and looks up links by problem', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.course.findUnique.mockResolvedValue(staffCourse());
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.submission.count.mockResolvedValue(0);
    prismaMock.comment.count.mockResolvedValue(0);
    prismaMock.assignmentProblem.findMany.mockResolvedValue([]);

    const res = await GET(new Request('http://localhost/api/courses/1'), {
      params: Promise.resolve({ id: 'course-1' }),
    });
    expect(res.status).toBe(200);

    expect(prismaMock.submission.count).toHaveBeenCalledWith({ where: { assignmentId: 'a1' } });
    expect(prismaMock.comment.count).toHaveBeenCalledWith({ where: { assignmentId: 'a1' } });
    expect(prismaMock.assignmentProblem.findMany.mock.calls[0][0]).toMatchObject({
      where: { problemId: { in: ['p1'] } },
    });
  });

  it('removes and promotes faculty only on this course', async () => {
    authMock.mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN', isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ timezone: 'America/New_York' });
    prismaMock.roster.findFirst.mockResolvedValue({ role: 'FACULTY' });
    prismaMock.submission.count.mockResolvedValue(0);
    prismaMock.comment.count.mockResolvedValue(0);

    prismaMock.systemSettings.findUnique.mockResolvedValue({ timezone: 'America/New_York' });
    const updated = () => ({
      ...staffCourse(),
      regCode: 'ABC123',
      roster: [{ role: 'FACULTY', user: { id: 'u2', firstName: 'B', lastName: 'C' } }],
    });
    const txMock = {
      course: {
        update: vi.fn().mockResolvedValue({ id: 'course-1' }),
        findUnique: vi.fn().mockResolvedValue(updated()),
      },
      roster: {
        // u1 is faculty and is being dropped; u2 is a student being promoted.
        findMany: vi.fn().mockResolvedValue([
          { userId: 'u1', role: 'FACULTY' },
          { userId: 'u2', role: 'STUDENT' },
        ]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    prismaMock.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(txMock));

    const req = new Request('http://localhost/api/courses/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Course 1',
        code: 'CS101',
        semester: 'Fall 2026',
        credits: 3,
        startDate: '2026-08-25T09:00',
        endDate: '2026-12-15T17:00',
        registrationOpenAt: '2026-07-01T09:00',
        registrationCloseAt: '2026-09-01T09:00',
        isPublished: true,
        isArchived: false,
        instructorIds: ['u2'],
      }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: 'course-1' }) });
    expect(res.status).toBe(200);

    expect(txMock.roster.findMany.mock.calls[0][0]).toMatchObject({
      where: { courseId: 'course-1' },
    });
    expect(txMock.roster.deleteMany).toHaveBeenCalledWith({
      where: { courseId: 'course-1', role: 'FACULTY', userId: { in: ['u1'] } },
    });
    expect(txMock.roster.updateMany).toHaveBeenCalledWith({
      where: { courseId: 'course-1', userId: { in: ['u2'] } },
      data: { role: 'FACULTY' },
    });
    // The refreshed payload counts per assignment, the same way the GET view does.
    expect(prismaMock.submission.count).toHaveBeenCalledWith({ where: { assignmentId: 'a1' } });
    expect(prismaMock.comment.count).toHaveBeenCalledWith({ where: { assignmentId: 'a1' } });
  });
});
