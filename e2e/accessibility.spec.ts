import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import type { Result } from 'axe-core';
import { createFixtureCourse, signIn, unique } from './helpers';

/**
 * Automated accessibility smoke scan (axe-core) over a few representative pages.
 *
 * Scope note: this suite deliberately excludes the two colour-contrast rules. A separate
 * visual redesign owns colour and contrast, so those findings are tracked there; leaving
 * them on here would drown the structural issues this scan exists to catch (missing
 * names, bad roles, broken landmark/heading structure, unlabeled controls). Every other
 * WCAG 2.0/2.1 A and AA rule stays enabled. Do not widen this exclusion to silence a
 * real finding; fix the markup instead.
 *
 * axe catches only the ~30-40% of WCAG that is machine-checkable. Keyboard operation,
 * focus order, screen-reader wording, and reflow still need a human; see
 * docs/accessibility-audit.md for the manual checklist.
 */

const DISABLED_RULES = ['color-contrast', 'color-contrast-enhanced'];

async function scan(page: Page) {
  return new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .disableRules(DISABLED_RULES)
    .analyze();
}

/** A readable failure message: rule, impact, help URL, and the offending selectors. */
function summarize(violations: Result[]): string {
  return violations
    .map((v) => {
      const nodes = v.nodes.map((n) => `      - ${n.target.join(' ')}`).join('\n');
      return `  [${v.impact ?? 'n/a'}] ${v.id}: ${v.help}\n    ${v.helpUrl}\n${nodes}`;
    })
    .join('\n\n');
}

test.describe('accessibility (axe, contrast excluded)', () => {
  test('login page (signed out)', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Sign In' }).waitFor();
    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });

  test('admin dashboard', async ({ page }) => {
    await signIn(page, 'admin');
    await expect(page).toHaveURL(/\/dashboard/);
    // Let the dashboard shell settle (sidebar + main content) before scanning.
    await page.getByRole('main').waitFor();
    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });

  test('admin system settings', async ({ page }) => {
    await signIn(page, 'admin');
    await page.goto('/dashboard/system-settings');
    await page.getByRole('main').waitFor();
    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });

  test('student dashboard', async ({ page }) => {
    await signIn(page, 'student');
    await expect(page).toHaveURL(/\/dashboard/);
    await page.getByRole('main').waitFor();
    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });
});

/**
 * The description editor and the dialogs layered over it.
 *
 * These are scanned separately because none of them exist in the page's resting state: the
 * toolbar's menus, the equation/link/shortcut dialogs and the discard confirm are all opened by
 * the user, and a scan of the page behind them proves nothing about them. Radix portals each one
 * to the document body, so scanning the whole page with it open is the right scope.
 */
test.describe('accessibility: description editor (axe, contrast excluded)', () => {
  let COURSE = '';
  let ASSIGNMENT = '';

  test.beforeAll(async ({ browser }) => {
    COURSE = await createFixtureCourse(browser);
    ASSIGNMENT = await createAssignment(browser, COURSE);
  });

  async function createAssignment(browser: Browser, courseId: string): Promise<string> {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await signIn(page, 'faculty2');
      const res = await page.request.post(`/api/courses/${courseId}/assignments`, {
        data: {
          title: unique('A11y editor'),
          dueDate: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
          assignedToEveryone: true,
          isPublished: false,
        },
      });
      expect(res.ok(), `assignment create failed: ${res.status()} ${await res.text()}`).toBe(true);
      return ((await res.json()) as { id: string }).id;
    } finally {
      await context.close();
    }
  }

  async function openDetails(page: Page) {
    await signIn(page, 'faculty2');
    await page.goto(`/dashboard/courses/${COURSE}/${ASSIGNMENT}?tab=description`);
    // Generous: under `next dev` a first hit on a route compiles it.
    // getByRole with an exact name, not getByLabel('Title'). The Details tab wraps its form in a
    // region named "Title and description", and getByLabel matches on substring, so the bare
    // label resolved to both that region and the input and every test in this file died on strict
    // mode. The role plus an exact name picks the field and nothing else.
    await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toBeVisible({
      timeout: 60_000,
    });
  }

  test('the editor at rest', async ({ page }) => {
    await openDetails(page);
    await page.getByRole('textbox', { name: 'Description' }).waitFor();
    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });

  test('the expanded editor', async ({ page }) => {
    await openDetails(page);
    await page.getByRole('button', { name: 'Expand editor' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });

  test('the equation dialog', async ({ page }) => {
    await openDetails(page);
    await page.getByRole('button', { name: 'Insert equation' }).click();
    await expect(page.getByLabel('LaTeX')).toBeVisible();
    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });

  test('the link dialog', async ({ page }) => {
    await openDetails(page);
    await page.getByRole('button', { name: 'Add link' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });

  test('the keyboard shortcuts dialog', async ({ page }) => {
    await openDetails(page);
    await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });

  /**
   * The overflow menu, minus one known app-wide finding.
   *
   * Every Radix dropdown menu in AFCT trips `aria-hidden-focus`: opening one marks the page
   * behind it `aria-hidden` while its ~60 links and buttons stay focusable. It is not specific
   * to this menu (a menu on /dashboard/users reports the same thing) and not something the
   * editor work introduced. An open Dialog leaves the DOM in the identical state; axe stays
   * quiet there only because it special-cases the modal-dialog pattern, and a menu is not one.
   *
   * In practice focus cannot land there: the background is `pointer-events: none` and Radix's
   * focus scope pulls focus back, verified in a browser. The real fix is `inert` on the
   * background instead of `aria-hidden`, which is upstream Radix behaviour, so it is tracked
   * rather than patched here. Everything else in the menu is still scanned, so a NEW violation
   * fails this test.
   */
  const KNOWN_MENU_FINDING = 'aria-hidden-focus';

  test('the toolbar overflow menu', async ({ page }) => {
    await openDetails(page);
    await page.getByRole('button', { name: 'More formatting' }).first().click();
    await expect(page.getByRole('menu')).toBeVisible();
    const { violations } = await scan(page);
    const unexpected = violations.filter((v) => v.id !== KNOWN_MENU_FINDING);
    expect(unexpected, summarize(unexpected)).toEqual([]);
  });

  test('the discard-changes confirm', async ({ page }) => {
    await openDetails(page);
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Renamed while auditing');
    // Any in-app link triggers the guard's capture-phase interception.
    await page.getByRole('link', { name: 'Dashboard' }).first().click();
    await expect(page.getByRole('dialog', { name: 'Discard unsaved changes?' })).toBeVisible();
    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });

  /**
   * Focus management, which axe cannot see: it inspects a snapshot, and these are all about
   * where focus GOES when something opens or closes. Losing focus to the document body strands
   * a keyboard user at the top of the page with no idea what happened, which is why every one
   * of these has explicit code behind it. Until now none of it was asserted anywhere.
   */
  test('leaving the expanded editor returns focus to the Expand button', async ({ page }) => {
    await openDetails(page);
    const expand = page.getByRole('button', { name: 'Expand editor' });
    await expand.click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(expand).toBeFocused();
  });

  test('the discard confirm opens on the safe choice, so Enter stays', async ({ page }) => {
    await openDetails(page);
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Renamed while auditing');
    await page.getByRole('link', { name: 'Dashboard' }).first().click();

    const confirm = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'Stay on page' })).toBeFocused();

    // Enter therefore keeps the work rather than throwing it away.
    await page.keyboard.press('Enter');
    await expect(confirm).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`${ASSIGNMENT}`));
    await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
      'Renamed while auditing',
    );
  });

  test('Escape on the confirm keeps the page, and never discards', async ({ page }) => {
    await openDetails(page);
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Renamed while auditing');
    await page.getByRole('link', { name: 'Dashboard' }).first().click();

    const confirm = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
    await expect(confirm).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(confirm).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`${ASSIGNMENT}`));
    await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
      'Renamed while auditing',
    );
  });

  test('Keep editing puts focus back inside the dialog it was protecting', async ({ page }) => {
    await signIn(page, 'faculty2');
    await page.goto(`/dashboard/courses/${COURSE}/${ASSIGNMENT}?tab=problems`);
    await page.getByRole('button', { name: 'Create Problem' }).first().click();

    const wizard = page.getByRole('dialog', { name: 'Create Problem' });
    await expect(wizard).toBeVisible({ timeout: 60_000 });
    await wizard.getByLabel('Title').fill('Half-built problem');
    await page.keyboard.press('Escape');

    const confirm = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Keep editing' }).click();
    await expect(confirm).toBeHidden();

    // The point of Keep editing is to carry on editing. Focus landing on the body instead
    // would drop a keyboard user back at the top of the page with the dialog still open.
    const focusedInWizard = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      const active = document.activeElement;
      return {
        onBody: active === document.body || active === null,
        insideADialog: dialogs.some((d) => d.contains(active)),
        tag: active?.tagName ?? null,
      };
    });
    expect(focusedInWizard.onBody, 'focus was dropped on the body').toBe(false);
    expect(focusedInWizard.insideADialog, 'focus left the Create Problem dialog').toBe(true);
  });

  test('the editor is reachable and escapable by keyboard alone', async ({ page }) => {
    await openDetails(page);
    const box = page.getByRole('textbox', { name: 'Description' });
    await box.focus();
    await expect(box).toBeFocused();

    // Tab must move OUT of the document rather than inserting a tab character: a keyboard user
    // who cannot leave the editor is trapped on the page (WCAG 2.1.2).
    await page.keyboard.press('Tab');
    await expect(box).not.toBeFocused();
  });
});

/**
 * The four server-side paginated tables.
 *
 * These are scanned as a group because they share one component (`DataTable`) but each wires
 * it differently: its own toolbar filters, its own column set, and its own empty state. The
 * shared parts (aria-sort, the single live region in the footer, the labelled search box) are
 * unit-tested in `data-table.test.tsx`; what only a browser can prove is that each caller's
 * filter controls and column headers still come out with accessible names once they are
 * composed together and rendered for real.
 *
 * Scanned at rest with whatever the fixture course holds. An empty table is not a wasted scan:
 * the empty state is its own markup, and it is the state a new course actually starts in.
 *
 * Run the file whole. Isolating this block with `-g` against a freshly started `next dev`
 * makes the fixture's first sign-in the first request to hit the credentials route, and the
 * cold compile lands as "Email or password is incorrect" rather than a timeout, which reads
 * like a seeded-password problem and is not one. The describes above warm that route.
 */
test.describe('accessibility: paginated tables (axe, contrast excluded)', () => {
  let COURSE = '';

  test.beforeAll(async ({ browser }) => {
    COURSE = await createFixtureCourse(browser);
  });

  /** Open a course tab as course staff and wait for its table to exist. */
  async function openCourseTab(page: Page, tab: string, tableName: string) {
    await signIn(page, 'faculty2');
    await page.goto(`/dashboard/courses/${COURSE}?tab=${tab}`);
    // Generous: under `next dev` a first hit on a route compiles it.
    await expect(page.getByRole('table', { name: tableName })).toBeVisible({ timeout: 60_000 });
  }

  test('the course roster', async ({ page }) => {
    await openCourseTab(page, 'roster', 'Course roster table');
    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });

  test('the gradebook', async ({ page }) => {
    await openCourseTab(page, 'grades', 'Course grades table');
    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });

  test('the course activity log', async ({ page }) => {
    await openCourseTab(page, 'activity', 'Activity log table');
    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });

  test('the submissions page', async ({ page }) => {
    await signIn(page, 'admin');
    await page.goto('/dashboard/submissions');
    await expect(page.getByRole('table', { name: 'Submissions' })).toBeVisible({ timeout: 60_000 });
    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });
});

/**
 * The pages the scan never reached.
 *
 * The suite above is thorough about the surfaces it visits and silent about the rest: seven
 * dashboard routes had never been loaded by axe at all, so every rule it enables proved nothing
 * there. That is a worse gap than the two contrast rules this file excludes, because it is
 * invisible: a green run said "no violations" about pages nobody had looked at.
 *
 * Admin-facing screens come first. They are dialog-heavy, they are where the tables and scrolling
 * panels live, and they are operated by faculty rather than by anyone who wrote them.
 */
test.describe('accessibility: the rest of the dashboard (axe, contrast excluded)', () => {
  /**
   * Sign in, open a route, wait for the page to actually be there, and scan it.
   *
   * The heading is waited for rather than the `main` landmark, and that is the whole point of
   * the argument. The layout renders `main` before the page has loaded anything into it, so a
   * scan gated on the landmark would pass just as happily against an empty shell, a redirect to
   * the dashboard, or a route that had quietly 404'd. "No violations" would then be true and
   * worthless. The level-1 heading is the first thing that only exists if the page rendered.
   */
  async function scanRoute(page: Page, role: 'admin' | 'student', path: string, heading: string) {
    await signIn(page, role);
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible({
      timeout: 60_000,
    });
    return scan(page);
  }

  test('user accounts', async ({ page }) => {
    const { violations } = await scanRoute(page, 'admin', '/dashboard/users', 'User Accounts');
    expect(violations, summarize(violations)).toEqual([]);
  });

  test('system status', async ({ page }) => {
    const { violations } = await scanRoute(
      page,
      'admin',
      '/dashboard/system-status',
      'System Status',
    );
    expect(violations, summarize(violations)).toEqual([]);
  });

  test('system logs', async ({ page }) => {
    const { violations } = await scanRoute(page, 'admin', '/dashboard/system-logs', 'System Logs');
    expect(violations, summarize(violations)).toEqual([]);
  });

  test('the course list', async ({ page }) => {
    const { violations } = await scanRoute(page, 'admin', '/dashboard/courses', 'Courses');
    expect(violations, summarize(violations)).toEqual([]);
  });

  test('archived courses', async ({ page }) => {
    const { violations } = await scanRoute(
      page,
      'admin',
      '/dashboard/archived-courses',
      'Archived Courses',
    );
    expect(violations, summarize(violations)).toEqual([]);
  });

  /** A student surface, and one of the least-visited parts of the app. */
  test('the calendar', async ({ page }) => {
    const { violations } = await scanRoute(page, 'student', '/dashboard/calendar', 'Calendar');
    expect(violations, summarize(violations)).toEqual([]);
  });

  test('the account page', async ({ page }) => {
    const { violations } = await scanRoute(page, 'student', '/dashboard/account', 'Account');
    expect(violations, summarize(violations)).toEqual([]);
  });
});

/**
 * Account recovery, signed out.
 *
 * Reached by somebody who cannot get in, which is the worst moment to meet an unlabelled control,
 * and the one surface where nobody can ask a colleague to read the screen for them. Both states
 * are worth scanning: the form as it arrives, and what a spent or invented link produces, since
 * the second is what most people who follow an old email will see.
 */
test.describe('accessibility: account recovery (axe, contrast excluded)', () => {
  test('the request form', async ({ page }) => {
    await page.goto('/forgot-password');
    // The control itself, not the landmark: the landmark renders either way.
    await expect(page.getByRole('textbox').first()).toBeVisible({ timeout: 30_000 });
    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });

  test('a link that is no longer any good', async ({ page }) => {
    await page.goto('/reset-password?token=not-a-real-token');
    // Whatever the page decides to say about a dead link, it has to say something.
    await expect(page.getByRole('main')).not.toBeEmpty({ timeout: 30_000 });
    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });
});

/**
 * The surfaces built since the last audit.
 *
 * Two WCAG sweeps and the block above between them covered the app as it stood in July. Almost
 * everything below shipped after that and had never been scanned at all: the assignment page's
 * own tabs, the group sets, the problem bank, the evaluator sandbox, and the LTI screens an LMS
 * draws inside its own page. A green suite said nothing about any of them.
 */
test.describe('accessibility: surfaces added since the last audit', () => {
  let COURSE = '';
  let ASSIGNMENT = '';

  test.beforeAll(async ({ browser }) => {
    COURSE = await createFixtureCourse(browser);
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await signIn(page, 'faculty2');
      const res = await page.request.post(`/api/courses/${COURSE}/assignments`, {
        data: {
          title: unique('A11y tabs'),
          dueDate: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
          assignedToEveryone: true,
          isPublished: true,
        },
      });
      expect(res.ok(), `assignment create failed: ${res.status()} ${await res.text()}`).toBe(true);
      ASSIGNMENT = ((await res.json()) as { id: string }).id;
    } finally {
      await context.close();
    }
  });

  /**
   * Open one of the assignment page's tabs and wait for the tab itself to be selected, rather
   * than for the page shell. The shell renders before the panel has anything in it, so waiting
   * on it would scan an empty box and call it clean.
   */
  async function openAssignmentTab(page: Page, tab: string, tabName: string) {
    await signIn(page, 'faculty2');
    await page.goto(`/dashboard/courses/${COURSE}/${ASSIGNMENT}?tab=${tab}`);
    await expect(page.getByRole('tab', { name: tabName, selected: true })).toBeVisible({
      timeout: 60_000,
    });
  }

  for (const [tab, name] of [
    ['type', 'Type'],
    ['assign-to', 'Assign To'],
    ['problems', 'Problems'],
    ['submissions', 'Submissions'],
    ['statistics', 'Statistics'],
    ['similarity', 'Similarity'],
    ['settings', 'Settings'],
  ] as const) {
    test(`the assignment ${name} tab`, async ({ page }) => {
      await openAssignmentTab(page, tab, name);
      const { violations } = await scan(page);
      expect(violations, summarize(violations)).toEqual([]);
    });
  }

  test('the course groups tab', async ({ page }) => {
    await signIn(page, 'faculty2');
    await page.goto(`/dashboard/courses/${COURSE}?tab=groups`);
    await expect(page.getByRole('tab', { name: 'Groups', selected: true })).toBeVisible({
      timeout: 60_000,
    });
    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });

  test('the course problem bank', async ({ page }) => {
    await signIn(page, 'faculty2');
    await page.goto(`/dashboard/courses/${COURSE}?tab=problems`);
    await expect(page.getByRole('tab', { name: 'Problems', selected: true })).toBeVisible({
      timeout: 60_000,
    });
    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });

  test('the course settings tab', async ({ page }) => {
    await signIn(page, 'faculty2');
    await page.goto(`/dashboard/courses/${COURSE}?tab=settings`);
    await expect(page.getByRole('tab', { name: 'Settings', selected: true })).toBeVisible({
      timeout: 60_000,
    });
    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });

  test('the evaluator sandbox', async ({ page }) => {
    await signIn(page, 'faculty2');
    await page.goto('/dashboard/evaluator-sandbox');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 60_000 });
    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });

  /**
   * A student's own view of an assignment, which is the surface the study measures and the one
   * with the least attention paid to it.
   */
  test('the student assignment view', async ({ page }) => {
    await signIn(page, 'student');
    await page.goto(`/dashboard/courses/${COURSE}/${ASSIGNMENT}`);
    await expect(page.getByRole('main')).not.toBeEmpty({ timeout: 60_000 });
    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });

  /**
   * The two tabs of a student's course page. Both were card lists until recently and are now
   * tables, one built on the shared DataTable and one hand-rolled for its parent/child rows,
   * and neither had ever been scanned.
   */
  test('the student assignments tab', async ({ page }) => {
    await signIn(page, 'student');
    await page.goto(`/dashboard/courses/${COURSE}?tab=assignments`);
    await expect(page.getByRole('heading', { name: 'Assignments' })).toBeVisible({
      timeout: 60_000,
    });
    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });

  test('the student grades tab', async ({ page }) => {
    await signIn(page, 'student');
    await page.goto(`/dashboard/courses/${COURSE}?tab=grades`);
    await expect(page.getByRole('heading', { name: 'Grades' })).toBeVisible({ timeout: 60_000 });
    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });
});

/**
 * The same surfaces with something open.
 *
 * A scan at rest never sees a dialog or a menu, which is how two prior audits missed the
 * aria-hidden problem the editor block already covers. These are the newer dialogs, opened the
 * way somebody would open them.
 */
test.describe('accessibility: newer dialogs (axe, contrast excluded)', () => {
  let COURSE = '';

  test.beforeAll(async ({ browser }) => {
    COURSE = await createFixtureCourse(browser);
  });

  test('the create-group-set dialog', async ({ page }) => {
    await signIn(page, 'faculty2');
    await page.goto(`/dashboard/courses/${COURSE}?tab=groups`);
    const open = page.getByRole('button', { name: /Create Group Set|New Group Set/i }).first();
    await expect(open).toBeVisible({ timeout: 60_000 });
    await open.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });

  test('the course settings tab with the status card', async ({ page }) => {
    await signIn(page, 'faculty2');
    await page.goto(`/dashboard/courses/${COURSE}?tab=settings`);
    await expect(page.getByRole('tab', { name: 'Settings', selected: true })).toBeVisible({
      timeout: 60_000,
    });
    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });

  /**
   * The per-problem settings dialog, and the warning it grows when the feedback switch moves.
   *
   * Two scans rather than one: the warning is only in the DOM after the switch is flipped, and
   * it is the part of this dialog that is new. Scanning the dialog at rest would report clean
   * about markup that had never rendered.
   */
  test('the problem settings dialog, before and after the feedback warning', async ({ page }) => {
    // A seeded assignment that already has problems, found rather than built: creating one
    // needs an answer file upload, and this test is about the dialog's markup, not the fixture.
    await signIn(page, 'faculty');

    const courses = await page.request.get('/api/me/manageable-courses');
    expect(courses.ok(), `courses: ${courses.status()}`).toBe(true);
    const courseList = (await courses.json()) as { id: string }[] | { courses: { id: string }[] };
    const courseIds = (Array.isArray(courseList) ? courseList : courseList.courses).map(
      (c) => c.id,
    );

    let target: { courseId: string; assignmentId: string } | null = null;
    for (const courseId of courseIds) {
      const res = await page.request.get(`/api/courses/${courseId}/assignments`);
      if (!res.ok()) continue;
      const body = (await res.json()) as { id: string }[] | { assignments: { id: string }[] };
      const assignments = Array.isArray(body) ? body : body.assignments;
      for (const assignment of assignments ?? []) {
        const detail = await page.request.get(
          `/api/courses/${courseId}/assignments/${assignment.id}`,
        );
        if (!detail.ok()) continue;
        const withProblems = (await detail.json()) as { problems?: unknown[] };
        if ((withProblems.problems?.length ?? 0) > 0) {
          target = { courseId, assignmentId: assignment.id };
          break;
        }
      }
      if (target) break;
    }

    // Asserted, not skipped: a skip here would report clean about a dialog never opened.
    expect(target, 'no seeded assignment with problems found').not.toBeNull();

    await page.goto(`/dashboard/courses/${target!.courseId}/${target!.assignmentId}?tab=problems`);
    await page
      .getByRole('button', { name: /Actions for/ })
      .first()
      .waitFor({ timeout: 60_000 });

    // The table itself first: it gained a Feedback column, and a sortable header is markup.
    const table = await scan(page);
    expect(table.violations, `problems table\n${summarize(table.violations)}`).toEqual([]);

    await page
      .getByRole('button', { name: /Actions for/ })
      .first()
      .click({ timeout: 60_000 });
    await page
      .getByRole('menuitem', { name: /Settings|Edit/ })
      .first()
      .click();

    const dialog = page.getByRole('dialog', { name: 'Problem Settings' });
    await expect(dialog).toBeVisible({ timeout: 30_000 });

    const atRest = await scan(page);
    expect(atRest.violations, `at rest\n${summarize(atRest.violations)}`).toEqual([]);

    // The warning is only in the DOM once the switch moves, so scanning at rest alone would
    // report clean about the markup this feature actually added.
    await dialog.getByLabel('Show Feedback to Students').click();

    const withWarning = await scan(page);
    expect(withWarning.violations, `with warning\n${summarize(withWarning.violations)}`).toEqual(
      [],
    );
  });

  /** The account page's own panels, which a student reaches to set a password or a token. */
  test('the account page tabs', async ({ page }) => {
    await signIn(page, 'student');
    await page.goto('/dashboard/account');
    await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible({
      timeout: 60_000,
    });
    // Asserted rather than skipped: a `count()` guard here would let the whole test pass by
    // finding nothing, which is exactly how a scan reports clean about a page it never opened.
    for (const tab of ['Profile photo', 'Password', 'Connected accounts', 'App tokens']) {
      const trigger = page.getByRole('tab', { name: tab });
      await expect(trigger).toBeVisible();
      await trigger.click();
      const { violations } = await scan(page);
      expect(violations, `${tab}\n${summarize(violations)}`).toEqual([]);
    }
  });
});

/**
 * The stacked card view a DataTable becomes below 640px. Every other scan here runs at desktop
 * width, so this DOM (cards, label/value pairs, the corner action) had never been scanned; an
 * earlier audit found an unlabelled list in `data-table-cards.tsx` the hard way.
 */
test.describe('accessibility: the stacked card view on a phone (axe, contrast excluded)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('system logs as cards', async ({ page }) => {
    await signIn(page, 'admin');
    await page.goto('/dashboard/system-logs');
    await expect(page.getByRole('heading', { level: 1, name: 'System Logs' })).toBeVisible({
      timeout: 60_000,
    });

    // The card view, not the table: proof the scan below is looking at the right DOM.
    await expect(page.getByRole('list', { name: 'System logs table' })).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);

    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });

  test('the course list as cards', async ({ page }) => {
    await signIn(page, 'admin');
    await page.goto('/dashboard/courses');
    await expect(page.getByRole('heading', { level: 1, name: 'Courses' })).toBeVisible({
      timeout: 60_000,
    });

    await expect(page.getByRole('table')).toHaveCount(0);
    // The corner action this view puts on each card, which the desktop table renders as an
    // ordinary cell: a different element in a different place, and only reachable here.
    await expect(page.getByRole('button', { name: /Actions for / }).first()).toBeVisible();

    const { violations } = await scan(page);
    expect(violations, summarize(violations)).toEqual([]);
  });
});
