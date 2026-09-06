/** @vitest-environment jsdom */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IdentitiesSection } from './IdentitiesSection';
import { renderWithClient } from '@/test/query';

/**
 * The connected-accounts tab.
 *
 * jsdom does no layout, so these prove wiring: that Connect starts a real provider sign-in
 * rather than posting a form, and that somebody whose only way in is an identity cannot remove
 * it. The second is enforced by the route as well, and is repeated here because a disabled
 * button is the difference between a refusal and a dead end.
 */

const signIn = vi.hoisted(() => vi.fn());
vi.mock('next-auth/react', () => ({ signIn }));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ showToast: toast }));

vi.mock('@/hooks/use-effective-timezone', () => ({
  useEffectiveTimezone: () => ({ timezone: 'UTC', hour12: false }),
}));

const identity = {
  id: 'li-1',
  kind: 'OIDC',
  issuer: 'https://idp.example.test',
  subject: 'sub-1',
  linkedVia: 'SELF_SERVICE',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastSignInAt: null,
};

const respond = (body: unknown, ok = true) =>
  Promise.resolve({ ok, status: ok ? 200 : 409, json: () => Promise.resolve(body) } as Response);

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/dashboard/account');
});

describe('the list', () => {
  it('shows a connected account with how it was connected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => respond({ identities: [identity], hasPassword: true })),
    );

    renderWithClient(<IdentitiesSection providerLabel="Penn State" />);

    expect(await screen.findByText('Penn State')).toBeInTheDocument();
    expect(screen.getByText(/You connected this/)).toBeInTheDocument();
  });

  it('says so when nothing is connected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => respond({ identities: [], hasPassword: true })),
    );

    renderWithClient(<IdentitiesSection providerLabel="Penn State" />);

    expect(
      await screen.findByText(/have not connected an institutional account/),
    ).toBeInTheDocument();
  });
});

describe('connecting', () => {
  /**
   * The point of the whole tab. Only the provider can say the account over there belongs to
   * whoever is signed in here, so this must be a real sign-in and not a form post.
   */
  it('starts a provider sign-in that returns to this tab', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => respond({ identities: [], hasPassword: true })),
    );
    const user = userEvent.setup();

    renderWithClient(<IdentitiesSection providerLabel="Penn State" />);
    await user.click(await screen.findByRole('button', { name: /Connect Penn State/ }));

    expect(signIn).toHaveBeenCalledWith('oidc', {
      callbackUrl: '/dashboard/account?tab=accounts',
    });
  });
});

describe('disconnecting', () => {
  it('asks first, then removes it', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) =>
      init?.method === 'DELETE'
        ? respond({ success: true })
        : respond({ identities: [identity], hasPassword: true }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithClient(<IdentitiesSection providerLabel="Penn State" />);
    await user.click(await screen.findByRole('button', { name: /Disconnect/ }));

    // Asserted before confirming, because both buttons are named "Disconnect": without this the
    // test would pass just as well if the dialog never opened and the list button ran the action.
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/Disconnect this account\?/);

    await user.click(await within(dialog).findByRole('button', { name: 'Disconnect' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/me/identities/li-1', { method: 'DELETE' }),
    );
  });

  /**
   * Somebody with no password and one identity would lock themselves out. The route refuses
   * too; this stops them reaching a refusal they cannot do anything about.
   */
  it('is not offered when it is the only way in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => respond({ identities: [identity], hasPassword: false })),
    );

    renderWithClient(<IdentitiesSection providerLabel="Penn State" />);

    expect(await screen.findByRole('button', { name: /Disconnect/ })).toBeDisabled();
    expect(screen.getByText(/only way to sign in/)).toBeInTheDocument();
  });

  it('is offered when a password exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => respond({ identities: [identity], hasPassword: true })),
    );

    renderWithClient(<IdentitiesSection providerLabel="Penn State" />);

    expect(await screen.findByRole('button', { name: /Disconnect/ })).toBeEnabled();
  });
});

describe('coming back from the provider', () => {
  it('reports a successful connection', async () => {
    window.history.replaceState({}, '', '/dashboard/account?linked=1');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => respond({ identities: [identity], hasPassword: true })),
    );

    renderWithClient(<IdentitiesSection providerLabel="Penn State" />);

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    // Stripped, so a reload does not repeat the message.
    expect(window.location.search).toBe('?tab=accounts');
  });

  it('explains an identity that belongs to somebody else', async () => {
    window.history.replaceState({}, '', '/dashboard/account?error=already-linked-elsewhere');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => respond({ identities: [], hasPassword: true })),
    );

    renderWithClient(<IdentitiesSection providerLabel="Penn State" />);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('different AFCT account')),
    );
  });
});

/**
 * `LinkedIdentity` holds LMS launches as well as institutional sign-ins, and every row used to
 * carry the one configured OIDC label: somebody's Canvas identity was presented to them as an
 * institutional account they had connected.
 */
describe('what each connection is called', () => {
  it('names an LMS identity as an LMS, not as the institution', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        respond({
          identities: [
            { ...identity, id: 'i-lti', kind: 'LTI', issuer: 'https://canvas.school.edu' },
          ],
          hasPassword: true,
        }),
      ),
    );

    renderWithClient(<IdentitiesSection providerLabel="Penn State" />);

    expect(await screen.findByText(/Your LMS \(canvas.school.edu\)/)).toBeInTheDocument();
    expect(screen.queryByText('Penn State')).not.toBeInTheDocument();
  });

  it('offers no new connection when institutional sign-in is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => respond({ identities: [], hasPassword: true })),
    );

    renderWithClient(<IdentitiesSection providerLabel={null} canConnect={false} />);

    expect(await screen.findByText(/switched off for this AFCT/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /connect/i })).not.toBeInTheDocument();
  });
});

/**
 * What the page says about identities it cannot currently use.
 *
 * With institutional sign-in off, an OIDC identity is kept and removable but cannot sign
 * anybody in, because the provider is not installed at all. An LMS identity is unaffected: it
 * comes back whenever somebody opens AFCT from the LMS.
 */
describe('when institutional sign-in is switched off', () => {
  it('does not claim an institutional connection still signs you in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => respond({ identities: [identity], hasPassword: true })),
    );

    renderWithClient(<IdentitiesSection providerLabel="Penn State" canConnect={false} />);

    const message = await screen.findByText(/switched off for this AFCT/);
    expect(message).toHaveTextContent(/cannot be used to sign in/);
    expect(message).toHaveTextContent(/works again if it is switched back on/);
  });
});

/**
 * The two kinds are undone differently, and the dialog used to describe the configured
 * institution whichever row was being removed.
 */
describe('the disconnect confirmation', () => {
  const openDialogFor = async (over: Record<string, unknown>) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => respond({ identities: [{ ...identity, ...over }], hasPassword: true })),
    );
    renderWithClient(<IdentitiesSection providerLabel="Penn State" />);
    await userEvent.click(await screen.findByRole('button', { name: /disconnect/i }));
  };

  it('names the institution for an institutional account', async () => {
    await openDialogFor({});

    expect(await screen.findByText(/sign in to AFCT with Penn State/)).toBeInTheDocument();
  });

  it('describes an LMS identity as an LMS, and how it comes back', async () => {
    await openDialogFor({ kind: 'LTI', issuer: 'https://canvas.school.edu' });

    expect(await screen.findByText(/Opening AFCT from that LMS again/)).toBeInTheDocument();
    expect(screen.queryByText(/sign in to AFCT with Penn State/)).not.toBeInTheDocument();
  });
});

/**
 * Focus after a disconnect.
 *
 * The Disconnect button is inside the row the removal deletes, and the confirm is awaited, so
 * by the time the dialog closes Radix's restore target has gone and focus falls to the body.
 * A keyboard user was returned to the top of the page every time.
 */
describe('where focus goes after disconnecting', () => {
  it('lands on the section heading rather than on the body', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        init?.method === 'DELETE'
          ? respond({ ok: true })
          : respond({ identities: [identity], hasPassword: true }),
      ),
    );

    renderWithClient(<IdentitiesSection providerLabel="Penn State" />);
    await screen.findByRole('button', { name: /disconnect/i });

    await user.click(screen.getByRole('button', { name: /disconnect/i }));
    await user.click(await screen.findByRole('button', { name: /^disconnect$/i, hidden: false }));

    await waitFor(() => {
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toHaveTextContent('Connected accounts');
    });
  });
});

/**
 * Same rewrite as TokensSection, same thing worth re-proving: a failed read must land on the
 * empty state rather than the loading one, and `hasPassword` must stay `true` when we do not
 * know, since it only ever gates offering to remove somebody's last way in.
 */
describe('when the connected accounts cannot be loaded', () => {
  it('says so once and stops loading rather than spinning', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => respond({}, false)),
    );

    renderWithClient(<IdentitiesSection providerLabel="Penn State" />);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Could not load your connected accounts. Refresh the page to try again.',
      ),
    );
    expect(toast.error).toHaveBeenCalledTimes(1);
    // Resolved to "nothing connected" rather than sitting on the loading placeholder.
    expect(
      await screen.findByText(/You have not connected an institutional account\./i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Loading your connected accounts/i)).not.toBeInTheDocument();
  });
});
