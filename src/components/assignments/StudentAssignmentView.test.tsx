/** @vitest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import StudentAssignmentPage from './StudentAssignmentView';
import type { AssignmentWithDetails } from '@/lib/assignment-details';

// Render with a fresh QueryClient per test (retry off, no lingering cache) so each
// assignment/context query starts clean.
const renderWithClient = (ui: React.ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
};

import { toastMock } from '@/test/mocks/toast';

vi.mock('@/lib/toast', () => import('@/test/mocks/toast').then((m) => m.toastModuleMock));
const toastError = toastMock.error;

vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: { user: { id: 'u1', isAdmin: false } },
    status: 'authenticated',
  }),
}));

const pushMock = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'c1', aid: 'a1' }),
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => ({ get: () => null }),
}));

vi.mock('@/hooks/use-effective-timezone', () => ({
  useEffectiveTimezone: () => ({ timezone: 'UTC' }),
}));

vi.mock('@/hooks/use-empty-string-symbol', () => ({
  useEmptyStringSymbol: () => '∅',
}));

// Lightweight stubs for the heavy children. ProblemListCard just renders the
// problem titles it receives so we can assert the problem shows up.
vi.mock('@/components/assignments/ProblemListCard', () => ({
  ProblemListCard: ({ problems }: { problems: Array<{ id: string; title: string }> }) => (
    <ul data-testid="problem-list">
      {problems.map((p) => (
        <li key={p.id}>{p.title}</li>
      ))}
    </ul>
  ),
}));

// ProblemWorkspace stub exposes the comment flow: a field to set the comment text
// (onCommentTextChange) and a button to save it (onSaveComment).
vi.mock('@/components/assignments/ProblemWorkspace', () => ({
  default: ({
    onSaveComment,
    onCommentTextChange,
    commentText,
  }: {
    onSaveComment: () => void;
    onCommentTextChange: (text: string) => void;
    commentText: string;
  }) => (
    <div data-testid="problem-workspace">
      <input
        data-testid="comment-input"
        value={commentText}
        onChange={(e) => onCommentTextChange(e.target.value)}
      />
      <button type="button" onClick={onSaveComment}>
        Save Comment
      </button>
    </div>
  ),
}));

vi.mock('@/components/JffViewerDialog', () => ({ default: () => null }));
vi.mock('@/components/dialogs/RegexViewerDialog', () => ({ RegexViewerDialog: () => null }));
vi.mock('@/components/dialogs/CfgViewerDialog', () => ({ CfgViewerDialog: () => null }));

const buildAssignment = (): AssignmentWithDetails =>
  ({
    id: 'a1',
    title: 'Regex Basics',
    courseId: 'c1',
    isPublished: true,
    dueDate: new Date('2026-01-10T00:00:00.000Z'),
    maxPoints: 100,
    allowLateSubmissions: false,
    lateCutoff: null,
    course: { id: 'c1', name: 'Automata', code: 'CS101' },
    problems: [
      {
        problem: {
          id: 'p1',
          title: 'Problem One',
          type: 'FA',
          maxPoints: 10,
          maxSubmissions: 3,
          autograderEnabled: true,
        },
        maxPoints: 10,
        maxSubmissions: 3,
        autograderEnabled: true,
      },
    ],
  }) as unknown as AssignmentWithDetails;

const emptyContext = {
  assignmentGrade: null,
  problemGrades: {},
  submissionCount: 0,
  submissionsByProblem: {},
  commentsByProblem: {},
};

// Simple URL router over fetch so tests only care about the endpoint hit.
type FetchResult = { ok: boolean; status?: number; json: () => Promise<unknown> };
const routeFetch = (routes: Record<string, () => FetchResult>) =>
  vi.fn((url: string) => {
    const key = Object.keys(routes).find((r) => url.includes(r));
    if (!key) throw new Error(`Unexpected fetch: ${url}`);
    return Promise.resolve(routes[key]());
  });

describe('StudentAssignmentPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('renders the seeded assignment, skips the assignment fetch, and pulls student-context', async () => {
    const fetchMock = routeFetch({
      'student-context': () => ({ ok: true, json: async () => emptyContext }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithClient(<StudentAssignmentPage initialAssignment={buildAssignment()} />);

    // Title comes from the seeded initialAssignment (initialData).
    expect(screen.getAllByText('Regex Basics').length).toBeGreaterThan(0);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/courses/c1/assignments/a1/student-context');
    });

    // The assignment shell was seeded, so no GET for the assignment itself.
    const calledUrls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(calledUrls.some((u) => u.startsWith('/api/courses/c1/assignments/a1?'))).toBe(false);
  });

  /**
   * Before the release time the API withholds the description and sends no problems, so the
   * page had nothing left to draw: a banner and then blank space, with no reason given.
   */
  describe('an assignment that has not opened yet', () => {
    const locked = () =>
      ({
        ...buildAssignment(),
        locked: true,
        description: null,
        descriptionJson: null,
        problems: [],
        unlockAt: new Date('2099-03-01T15:00:00.000Z'),
      }) as unknown as AssignmentWithDetails;

    it('says it is not open, rather than rendering an empty page', async () => {
      vi.stubGlobal(
        'fetch',
        routeFetch({ 'student-context': () => ({ ok: true, json: async () => emptyContext }) }),
      );

      renderWithClient(<StudentAssignmentPage initialAssignment={locked()} />);

      expect(
        await screen.findByRole('heading', { name: /has not opened yet/i }),
      ).toBeInTheDocument();
    });

    it('tells the student when it opens', async () => {
      vi.stubGlobal(
        'fetch',
        routeFetch({ 'student-context': () => ({ ok: true, json: async () => emptyContext }) }),
      );

      renderWithClient(<StudentAssignmentPage initialAssignment={locked()} />);

      await screen.findByRole('heading', { name: /has not opened yet/i });
      expect(screen.getByText(/become available on/i)).toBeInTheDocument();
    });

    it('still names the assignment, which was never the part being withheld', async () => {
      vi.stubGlobal(
        'fetch',
        routeFetch({ 'student-context': () => ({ ok: true, json: async () => emptyContext }) }),
      );

      renderWithClient(<StudentAssignmentPage initialAssignment={locked()} />);

      expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Regex Basics');
    });
  });

  it('renders the problem from initialAssignment while student-context is empty', async () => {
    const fetchMock = routeFetch({
      'student-context': () => ({ ok: true, json: async () => emptyContext }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithClient(<StudentAssignmentPage initialAssignment={buildAssignment()} />);

    await waitFor(() => {
      // ProblemListCard stub renders the (truncated) problem title.
      expect(screen.getByText('Problem One')).toBeInTheDocument();
    });
    expect(screen.getByTestId('problem-workspace')).toBeInTheDocument();
  });

  it('posts a comment then refetches student-context on success', async () => {
    let contextCalls = 0;
    const fetchMock = routeFetch({
      'student-context': () => {
        contextCalls += 1;
        return { ok: true, json: async () => emptyContext };
      },
      '/comments': () => ({ ok: true, json: async () => ({ id: 'cm1' }) }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithClient(<StudentAssignmentPage initialAssignment={buildAssignment()} />);

    // Wait for the initial student-context fetch to settle.
    await waitFor(() => expect(contextCalls).toBe(1));

    // Set non-empty comment text (handleSubmitComment early-returns on empty).
    fireEvent.change(screen.getByTestId('comment-input'), { target: { value: 'Nice problem' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Comment' }));

    // POST fires against the canonical comments endpoint with the problem in the body.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/comments',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ content: 'Nice problem', assignmentId: 'a1', problemId: 'p1' }),
        }),
      );
    });

    // Invalidation refetches student-context (a second call).
    await waitFor(() => expect(contextCalls).toBe(2));
    expect(toastMock.created).toHaveBeenCalledWith('Comment');
  });

  /**
   * A refused page is not a broken one. The old behaviour told everybody to refresh, which for
   * the commonest case (an unpublished course) is advice that can never work.
   */
  describe('when the server refuses', () => {
    const refuse = (status: number, error: string) =>
      routeFetch({
        'student-context': () => ({ ok: false, status, json: async () => ({ error }) }),
      });

    it('passes on the reason the server gave, and gets off the page', async () => {
      vi.stubGlobal(
        'fetch',
        refuse(403, 'This course has not been published yet, so it is not open to students.'),
      );

      renderWithClient(<StudentAssignmentPage initialAssignment={buildAssignment()} />);

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          'This course has not been published yet, so it is not open to students.',
        ),
      );
      expect(pushMock).toHaveBeenCalledWith('/dashboard');
    });

    /**
     * Seen on prod: a student following an LMS link to something they could not open was told
     * twice and pushed to the dashboard twice, because the assignment and its context are
     * fetched separately and failed together.
     */
    it('says it once, however many of the page reads fail', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: false,
          status: 404,
          json: async () => ({ error: 'Not found' }),
        })),
      );

      // No seeded assignment, so BOTH reads run and both fail: that is the case that reported
      // twice. Seeding one leaves only the context query to fail, which never could.
      renderWithClient(<StudentAssignmentPage initialAssignment={null} />);

      await waitFor(() => expect(toastError).toHaveBeenCalled());
      expect(toastError).toHaveBeenCalledTimes(1);
      expect(pushMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to plain words when the server only says Forbidden', async () => {
      vi.stubGlobal('fetch', refuse(403, 'Forbidden'));

      renderWithClient(<StudentAssignmentPage initialAssignment={buildAssignment()} />);

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith('You do not have access to this assignment.'),
      );
    });

    it('says a server error once as well, not once per read', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: false,
          status: 500,
          json: async () => ({ error: 'Internal error' }),
        })),
      );

      renderWithClient(<StudentAssignmentPage initialAssignment={null} />);

      await waitFor(() => expect(toastError).toHaveBeenCalled());
      expect(toastError).toHaveBeenCalledTimes(1);
    });

    /**
     * The two reads can fail differently, and in either order.
     *
     * A "reported already" flag let whichever failed first decide everything, so a 500 landing
     * before a 403 swallowed the 403 and the redirect it owes, and the student sat on a page
     * they had no access to. A terminal answer speaks whatever came before it.
     */
    const failingWith = (assignmentStatus: number, contextStatus: number) =>
      vi.fn(async (url: string) => {
        const status = url.includes('student-context') ? contextStatus : assignmentStatus;
        return { ok: false, status, json: async () => ({ error: `status ${status}` }) };
      });

    it('lets a 403 have its say, and its redirect, after a generic failure', async () => {
      // The assignment read fails generically; the context read refuses.
      vi.stubGlobal('fetch', failingWith(500, 403));

      renderWithClient(<StudentAssignmentPage initialAssignment={null} />);

      await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/dashboard'));
      expect(pushMock).toHaveBeenCalledTimes(1);
    });

    it('lets a 404 have its say after a generic failure', async () => {
      vi.stubGlobal('fetch', failingWith(500, 404));

      renderWithClient(<StudentAssignmentPage initialAssignment={null} />);

      await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/dashboard'));
      expect(
        toastError.mock.calls.some(([message]) => String(message).includes('not available')),
      ).toBe(true);
    });

    it('does not add a second message when a generic failure follows a refusal', async () => {
      // Refusal first this time: the terminal answer is already on screen.
      vi.stubGlobal('fetch', failingWith(403, 500));

      renderWithClient(<StudentAssignmentPage initialAssignment={null} />);

      await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/dashboard'));
      expect(toastError).toHaveBeenCalledTimes(1);
      expect(pushMock).toHaveBeenCalledTimes(1);
    });

    it('says nothing twice when both reads refuse the same way', async () => {
      vi.stubGlobal('fetch', failingWith(403, 403));

      renderWithClient(<StudentAssignmentPage initialAssignment={null} />);

      await waitFor(() => expect(toastError).toHaveBeenCalled());
      expect(toastError).toHaveBeenCalledTimes(1);
      expect(pushMock).toHaveBeenCalledTimes(1);
    });

    it('still offers a refresh for a failure that might actually be transient', async () => {
      vi.stubGlobal('fetch', refuse(500, 'Internal error'));

      renderWithClient(<StudentAssignmentPage initialAssignment={buildAssignment()} />);

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          'Could not load the assignment. Refresh the page to try again.',
        ),
      );
      expect(pushMock).not.toHaveBeenCalled();
    });
  });

  it('surfaces a toast when the student-context fetch fails', async () => {
    const fetchMock = routeFetch({
      'student-context': () => ({ ok: false, json: async () => ({}) }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithClient(<StudentAssignmentPage initialAssignment={buildAssignment()} />);

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        'Could not load the assignment. Refresh the page to try again.',
      );
    });
  });
});
