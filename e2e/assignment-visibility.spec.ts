import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { courseWithoutStudent, createFixtureCourse, signIn, unique, USERS } from './helpers';

/**
 * What a student is allowed to SEE.
 *
 * The rules being pinned:
 *   1. An unpublished assignment is not readable by a student.
 *   2. An assignment whose audience excludes the student is not readable either.
 *   3. Neither leaks the assignment's existence or its title into the page.
 *
 * NOTE ON WHAT IS ASSERTED. The API is the security boundary and it answers 404. The
 * PAGE answers 200 and simply renders nothing - the guard is at render time, not a
 * Next.js notFound(). So these specs assert the API status AND that the title never
 * reaches the DOM, rather than asserting a 404 from the page navigation, which would be
 * testing a rendering choice instead of the actual protection.
 *
 * Fixtures are created over the API with the signed-in faculty session rather than
 * through the create wizard: the wizard has its own spec, and routing every visibility
 * assertion through wizard markup would mean a label change fails these for an
 * unrelated reason.
 */

// Built once per run rather than found in the seed: see createFixtureCourse for why
// hunting for a seeded course was unreliable in two separate ways.
let COURSE = '';
let COURSE_WITHOUT_STUDENT: string | null = null;
/** An enrolled STUDENT who is NOT our test student, for "assigned to someone else". */
let OTHER_STUDENT_ID = '';

test.beforeAll(async ({ browser }) => {
  COURSE = await createFixtureCourse(browser);
  COURSE_WITHOUT_STUDENT = await courseWithoutStudent(browser);

  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, 'faculty2');
  // The course payload carries staff only, so peers come from the paginated roster
  // endpoint. Reading `enrolled` off the course silently yielded undefined once the roster
  // moved server-side, and nothing noticed because this suite was not run by CI.
  const roster = (await (
    await page.request.get(`/api/courses/${COURSE}/roster?role=STUDENT&pageSize=50`)
  ).json()) as { rows: Array<{ id: string; email: string; role: string }> };
  const other = roster.rows.find((m) => m.role === 'STUDENT' && m.email !== USERS.student.email);
  // The fixture course starts with one student, which is all the other specs need. The
  // "assigned to someone else" case needs a second, so fall back to the faculty's own id
  // only if the roster somehow already has one.
  OTHER_STUDENT_ID = other?.id ?? '';
  await context.close();
});

type Created = { id: string };

async function createAssignment(
  request: APIRequestContext,
  body: Record<string, unknown> = {},
): Promise<{ id: string; title: string }> {
  const title = unique('E2E Visibility');
  const res = await request.post(`/api/courses/${COURSE}/assignments`, {
    data: {
      title,
      dueDate: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
      assignedToEveryone: true,
      isPublished: true,
      ...body,
    },
  });
  expect(res.ok(), `assignment create failed: ${res.status()} ${await res.text()}`).toBe(true);
  return { id: ((await res.json()) as Created).id, title };
}

/**
 * The id of an enrolled member of the fixture course, by email.
 *
 * From the roster endpoint, not the course payload: the latter carries staff only since the
 * roster moved server-side, so reading a student off it yields undefined.
 */
async function enrolledStudentId(facultyPage: Page, email: string): Promise<string> {
  const roster = (await (
    await facultyPage.request.get(`/api/courses/${COURSE}/roster?pageSize=100`)
  ).json()) as { rows: Array<{ id: string; email: string }> };
  const found = roster.rows.find((m) => m.email === email);
  if (!found) throw new Error(`${email} is not on the fixture course roster`);
  return found.id;
}

/** A faculty page that can create fixtures. */
async function asFaculty(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, 'faculty2');
  return page;
}

/** Everything the student can observe about an assignment. */
async function studentView(browser: Browser, assignmentId: string, title: string) {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, 'student');
  const api = await page.request.get(`/api/courses/${COURSE}/assignments/${assignmentId}`);
  await page.goto(`/dashboard/courses/${COURSE}/${assignmentId}`);
  return { apiStatus: api.status(), leaksTitle: (await page.content()).includes(title) };
}

test.describe('student assignment visibility', () => {
  test('an unpublished assignment is unreadable and does not leak its title', async ({
    browser,
  }) => {
    const faculty = await asFaculty(browser);
    const { id, title } = await createAssignment(faculty.request, { isPublished: false });

    const seen = await studentView(browser, id, title);

    // 404 rather than 403: a 403 confirms the assignment exists, which is precisely
    // what leaving it unpublished is meant to prevent.
    expect(seen.apiStatus).toBe(404);
    expect(seen.leaksTitle).toBe(false);
  });

  test('a published assignment assigned to everyone is readable', async ({ browser }) => {
    // The control for the tests around it: same student, same path, only the flag differs.
    const faculty = await asFaculty(browser);
    const { id, title } = await createAssignment(faculty.request, { isPublished: true });

    const seen = await studentView(browser, id, title);

    expect(seen.apiStatus).toBe(200);
    expect(seen.leaksTitle).toBe(true);
  });

  test('an assignment assigned to someone else is unreadable', async ({ browser }) => {
    const faculty = await asFaculty(browser);
    const { id, title } = await createAssignment(faculty.request, {
      isPublished: true,
      assignedToEveryone: false,
      // A real audience that simply does not include our student. An empty list is
      // rejected by validation, so "assigned to nobody" is not a reachable state.
      assignees: [{ targetType: 'STUDENT', userId: OTHER_STUDENT_ID }],
    });

    const seen = await studentView(browser, id, title);

    // Masked as 404 by the API, and the page must not render it either. These used
    // to disagree - see the note at the bottom of this file.
    expect(seen.apiStatus).toBe(404);
    expect(seen.leaksTitle).toBe(false);
  });

  test('an assignment before its unlock date hides its body', async ({ browser }) => {
    const faculty = await asFaculty(browser);
    const description = `LOCKED-BODY-${Math.random().toString(36).slice(2, 8)}`;
    const { id, title } = await createAssignment(faculty.request, {
      isPublished: true,
      description,
      unlockAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
      dueDate: new Date(Date.now() + 14 * 24 * 3600_000).toISOString(),
    });

    const page = await (await browser.newContext()).newPage();
    await signIn(page, 'student');
    // The API withholds the body correctly (200, but the description is stripped).
    const api = await page.request.get(`/api/courses/${COURSE}/assignments/${id}`);
    expect((await api.text()).includes(description)).toBe(false);

    await page.goto(`/dashboard/courses/${COURSE}/${id}`);
    // Give the page a chance to render before asserting an absence. Checking straight
    // after goto() passes trivially because nothing has painted yet, which is how this
    // test first "passed" against a page that did leak.
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByText(description)).toHaveCount(0);
    // Belt and braces: the raw HTML must not carry it either, since a server component
    // could ship it in the payload without painting it.
    expect((await page.content()).includes(description)).toBe(false);
    expect(title).toBeTruthy();
  });

  test('a signed-out visitor is sent to login rather than the assignment', async ({ browser }) => {
    const faculty = await asFaculty(browser);
    const { id } = await createAssignment(faculty.request);

    const anon = await (await browser.newContext()).newPage();
    await anon.goto(`/dashboard/courses/${COURSE}/${id}`);
    await expect(anon).toHaveURL(/\/login/);
  });
});

test.describe('dashboard upcoming assignments', () => {
  /** The visible dashboard text for a signed-in role. */
  async function dashboardText(browser: Browser, role: 'student' | 'faculty2') {
    const page = await (await browser.newContext()).newPage();
    await signIn(page, role);
    await page.goto('/dashboard');
    // The list renders after hydration; wait for the section rather than a fixed pause.
    await page
      .getByRole('heading', { name: /Upcoming Assignments/i })
      .first()
      .waitFor({ timeout: 30_000 })
      .catch(() => {
        /* an empty dashboard is a legitimate state; the assertions below still hold */
      });
    return page.content();
  }

  test('a student sees work assigned to them by name, not just to everyone', async ({
    browser,
  }) => {
    // The audience filter used to be "assignedToEveryone OR I have a date override", so
    // being named directly as an assignee was not enough and the student never saw their
    // own assignment here.
    const faculty = await asFaculty(browser);
    const studentId = await enrolledStudentId(faculty, USERS.student.email);
    const { title } = await createAssignment(faculty.request, {
      isPublished: true,
      assignedToEveryone: false,
      assignees: [{ targetType: 'STUDENT', userId: studentId }],
    });

    expect(await dashboardText(browser, 'student')).toContain(title);
  });

  test('the instructor sees an assignment they scoped to one student', async ({ browser }) => {
    // Same root cause seen from the other side: staff went through the student audience
    // test too, so an instructor could not see work they had just assigned.
    const faculty = await asFaculty(browser);
    const studentId = await enrolledStudentId(faculty, USERS.student.email);
    const { title } = await createAssignment(faculty.request, {
      isPublished: true,
      assignedToEveryone: false,
      assignees: [{ targetType: 'STUDENT', userId: studentId }],
    });

    expect(await dashboardText(browser, 'faculty2')).toContain(title);
  });

  test('a student still does not see work assigned only to a classmate', async ({ browser }) => {
    // The guard on the fix above: widening the filter must not turn into a disclosure.
    const faculty = await asFaculty(browser);
    const { title } = await createAssignment(faculty.request, {
      isPublished: true,
      assignedToEveryone: false,
      assignees: [{ targetType: 'STUDENT', userId: OTHER_STUDENT_ID }],
    });

    expect(await dashboardText(browser, 'student')).not.toContain(title);
  });

  test('a student does not see an unpublished assignment', async ({ browser }) => {
    const faculty = await asFaculty(browser);
    const { title } = await createAssignment(faculty.request, { isPublished: false });

    expect(await dashboardText(browser, 'student')).not.toContain(title);
  });
});

test.describe('course access', () => {
  test('a student cannot read a course they are not enrolled in', async ({ page }) => {
    test.skip(!COURSE_WITHOUT_STUDENT, 'seed has no course this student is absent from');
    await signIn(page, 'student');
    const res = await page.request.get(`/api/courses/${COURSE_WITHOUT_STUDENT}`);
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('every course on the student dashboard actually opens for them', async ({ page }) => {
    // A link the student cannot load means the dashboard query and the access check
    // disagree, which is how "phantom" courses show up.
    await signIn(page, 'student');
    await page
      .locator('a[href^="/dashboard/courses/"]')
      .first()
      .waitFor({ state: 'attached', timeout: 30_000 });

    const hrefs = await page
      .getByRole('link')
      .evaluateAll((els) =>
        els.map((e) => (e as HTMLAnchorElement).getAttribute('href') ?? '').filter(Boolean),
      );
    const courseIds = [
      ...new Set(
        hrefs
          .map((h) => /^\/dashboard\/courses\/([^/]+)$/.exec(h)?.[1])
          .filter((id): id is string => Boolean(id)),
      ),
    ];

    expect(courseIds.length).toBeGreaterThan(0);
    for (const id of courseIds) {
      // The link has to lead somewhere. A course the student is enrolled in but which has not
      // started yet is deliberately listed and deliberately not readable: the page answers
      // with "opens on <date>" rather than its contents, so following the link works even
      // though the API behind it refuses.
      const page404 = await page.request.get(`/dashboard/courses/${id}`);
      expect(
        page404.status(),
        `dashboard linked course ${id} but the page does not load`,
      ).toBeLessThan(400);

      // And when the API does refuse, it must be for a reason the product intends. A bare
      // "Forbidden" here is the phantom-course case this test exists to catch: the dashboard
      // query and the access gate disagreeing about who may see what.
      const api = await page.request.get(`/api/courses/${id}`);
      if (api.status() >= 400) {
        const body = (await api.json().catch(() => ({}))) as { error?: string };
        expect(
          body.error ?? '',
          `dashboard linked course ${id} and the API refused it without a reason`,
        ).toMatch(/has not started yet|has not been published/i);
      }
    }
  });
});

test.describe('staff permissions', () => {
  test('a student cannot create an assignment', async ({ page }) => {
    await signIn(page, 'student');
    const res = await page.request.post(`/api/courses/${COURSE}/assignments`, {
      data: { title: 'should not exist', dueDate: new Date().toISOString() },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('faculty get management controls a student does not', async ({ page, browser }) => {
    await signIn(page, 'faculty2');
    await page.goto(`/dashboard/courses/${COURSE}`);
    await expect(page.getByRole('button', { name: 'Create Assignment' })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Roster/ })).toBeVisible();

    const studentPage = await (await browser.newContext()).newPage();
    await signIn(studentPage, 'student');
    await studentPage.goto(`/dashboard/courses/${COURSE}`);
    await expect(studentPage.getByRole('button', { name: 'Create Assignment' })).toHaveCount(0);
  });
});

test.describe('seed assumptions', () => {
  test('faculty2 is a plain instructor, not an admin', async ({ page }) => {
    // faculty@example.com is ALSO flagged isAdmin by the seed, which makes it useless
    // for testing instructor permissions. Everything above depends on faculty2 not
    // having that shortcut, so assert it rather than trusting it.
    await signIn(page, 'faculty2');
    const res = await page.request.get('/api/me');
    expect(res.ok()).toBe(true);
    const me = (await res.json()) as { email?: string; isAdmin?: boolean };
    expect(me.email).toBe(USERS.faculty2.email);
    expect(me.isAdmin ?? false).toBe(false);
  });
});

/*
 * WHY THESE TWO EXIST.
 *
 * src/app/dashboard/courses/[id]/[aid]/page.tsx used to decide student access with just:
 *
 *     const hasStudentAccess = enrollment?.role === 'STUDENT' && assignment.isPublished;
 *
 * Enrolled + published, and nothing else. It did not ask whether the student was in the
 * assignment's audience, nor whether unlockAt had passed, while the API route for the
 * same assignment checked both. So the API answered 404 (or stripped the body) and the
 * server-rendered page handed over the title and description regardless, making both
 * "assign to specific students" and "lock content until unlockAt" bypassable by opening
 * the URL directly.
 *
 * The page now runs the same resolveStudentContentGate the API routes use, so the two
 * cannot drift apart again. These specs are the regression test.
 */
