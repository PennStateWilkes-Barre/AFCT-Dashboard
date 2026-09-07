import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { describe, it, expect, beforeEach, vi } from 'vitest';

globalThis.React = React;

const authMock = vi.hoisted(() => vi.fn());
const redirectMock = vi.hoisted(() =>
  vi.fn(() => {
    // Mirror Next's redirect(): throws a control-flow error that unwinds render.
    throw new Error('NEXT_REDIRECT');
  }),
);

// Supplied by RootProviders in the real app, which the root layout wraps every page in.
// QueryProvider's cache-reset reads it, so without this the test fails for a reason that
// says nothing about this page.
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));
// Stubbed, but NOT inert: the real watcher reads the idle timeout through react-query, and
// that is the whole reason this page has to supply a query client of its own. A stub that
// rendered null passed happily while the real page threw "No QueryClient set" in the browser.
// This one keeps the dependency that actually mattered and drops the rest.
vi.mock('@/components/session/SessionWatcher', () => ({
  __esModule: true,
  default: function SessionWatcherProbe() {
    useQuery({ queryKey: ['viewer-test-probe'], queryFn: async () => null, enabled: false });
    return null;
  },
}));
// Reaches the database and resolves permissions, neither of which this page's own tests are
// about. Its behaviour is covered in lib/viewer-properties.test.ts.
vi.mock('@/lib/viewer-properties', () => ({ loadViewerProperties: vi.fn(async () => null) }));
// Course staff by default, which is who this page is for. The refusal has its own tests.
const canOpenViewerFileMock = vi.hoisted(() => vi.fn(async (_kind: string, _file: string) => true));
vi.mock('@/lib/viewer-access', () => ({ canOpenViewerFile: canOpenViewerFileMock }));
vi.mock('./ViewerClient', () => ({ ViewerClient: () => null }));

import ViewerPage from './page';

const params = (o: Record<string, string>) => Promise.resolve(o);
const signedIn = () => authMock.mockResolvedValue({ user: { id: 'u1', inactive: false } });

/** Render the returned tree to a string, which is enough to assert which branch was taken. */
async function renderPage(search: Record<string, string>) {
  const el = await ViewerPage({ searchParams: params(search) });
  const { renderToStaticMarkup } = await import('react-dom/server');
  return renderToStaticMarkup(el as React.ReactElement);
}

const GOOD = { kind: 'submissions', file: 'abc.jff', type: 'FA' };

describe('the standalone viewer page', () => {
  beforeEach(() => {
    authMock.mockReset();
    redirectMock.mockClear();
    canOpenViewerFileMock.mockReset();
    canOpenViewerFileMock.mockResolvedValue(true);
  });

  it('sends a signed-out visitor to sign in', async () => {
    authMock.mockResolvedValue(null);
    await expect(renderPage(GOOD)).rejects.toThrow('NEXT_REDIRECT');
    expect(redirectMock).toHaveBeenCalledWith('/login');
  });

  it('sends an account deactivated since sign-in to sign in', async () => {
    // Same two conditions the dashboard layout applies. A session alone is not enough.
    authMock.mockResolvedValue({ user: { id: 'u1', inactive: true } });
    await expect(renderPage(GOOD)).rejects.toThrow('NEXT_REDIRECT');
  });

  it('renders the viewer for a well-formed link', async () => {
    signedIn();
    const html = await renderPage({ ...GOOD, title: 'Ada, Problem 2' });
    expect(html).toContain('Ada, Problem 2');
    expect(html).not.toContain('Nothing to show');
  });

  /**
   * The window is a marking tool. Enforced here rather than by leaving the link off a
   * student's page, because this URL is guessable, bookmarkable and shareable.
   */
  it('refuses somebody who is not staff on that file, and says where to go instead', async () => {
    signedIn();
    canOpenViewerFileMock.mockResolvedValue(false);

    const html = await renderPage(GOOD);

    expect(html).toContain('Nothing to show');
    expect(html).toMatch(/course staff/i);
    expect(html).toMatch(/assignment page/i);
  });

  it('drops only the files this reader may not open, and shows the rest', async () => {
    // Staffness is per course: somebody can be faculty in one and a student in another, and
    // one link can carry both.
    signedIn();
    canOpenViewerFileMock.mockImplementation(
      async (_kind: string, file: string) => file === 'a.jff',
    );

    const html = await renderPage({
      tabs: JSON.stringify([
        { kind: 'submissions', file: 'a.jff', type: 'FA', name: 'a.jff', title: 'Mine to mark' },
        {
          kind: 'submissions',
          file: 'b.jff',
          type: 'FA',
          name: 'b.jff',
          title: 'Another course',
        },
      ]),
    });

    expect(html).toContain('Mine to mark');
    expect(html).not.toContain('Another course');
  });

  it.each([
    ['an unknown file store', { kind: 'pfps', file: 'a.jff', type: 'FA' }, /which kind of file/i],
    ['a traversal name', { kind: 'submissions', file: '../x', type: 'FA' }, /name a file/i],
    [
      'an unknown machine type',
      { kind: 'submissions', file: 'a.jff', type: 'MEALY' },
      /kind of machine/i,
    ],
    ['nothing at all', {}, /which kind of file/i],
    ['a truncated tab list', { tabs: '[{"kind":"submi' }, /damaged/i],
  ])('refuses %s and says which part of the link is wrong', async (_l, search, expected) => {
    // These URLs get bookmarked and hand-edited, so a refusal has to be readable.
    signedIn();
    const html = await renderPage(search as Record<string, string>);
    expect(html).toContain('Nothing to show');
    expect(html).toMatch(expected);
  });

  it('checks the session before it looks at the link at all', async () => {
    // A signed-out visitor must not learn whether a file name is valid.
    authMock.mockResolvedValue(null);
    await expect(renderPage({ kind: 'nonsense' })).rejects.toThrow('NEXT_REDIRECT');
  });
});

describe('the providers the page has to bring with it', () => {
  beforeEach(() => {
    authMock.mockReset();
    signedIn();
  });

  it('supplies a query client, because nothing outside the dashboard does', async () => {
    // The failure this guards against is not subtle in the browser and was invisible here:
    // the page rendered a blank error boundary while every test passed.
    await expect(renderPage({ ...GOOD, title: 'Ada' })).resolves.toContain('Ada');
  });
});

describe('the title tab', () => {
  beforeEach(() => {
    authMock.mockReset();
    signedIn();
  });

  it('shows the file name alone when it was sent', async () => {
    const html = await renderPage({
      ...GOOD,
      title: 'd_flip-flop.jff - D Flip-Flop',
      name: 'd_flip-flop.jff',
    });
    // The tab reads as a file name. The composed heading is still there on hover, and stays
    // the graph's accessible name.
    expect(html).toContain('>d_flip-flop.jff<');
    expect(html).toContain('title="d_flip-flop.jff - D Flip-Flop"');
  });

  it('falls back to the full title when no name was sent', async () => {
    // Older links, and callers that do not have the file name to hand. Longer than ideal,
    // never wrong.
    const html = await renderPage({ ...GOOD, title: 'answer.jff - Problem' });
    expect(html).toContain('answer.jff - Problem');
  });

  it('is open at the bottom, which is what joins it to the toolbar', async () => {
    const html = await renderPage(GOOD);
    expect(html).toContain('rounded-t-md');
    expect(html).toContain('border-b-0');
  });
});
