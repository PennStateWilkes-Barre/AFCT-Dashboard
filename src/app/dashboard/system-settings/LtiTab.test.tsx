/** @vitest-environment jsdom */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toastMock, resetToastMock } from '@/test/mocks/toast';
import { LtiTab } from './LtiTab';
import { renderWithClient } from '@/test/query';

/**
 * Registering an LMS: the values AFCT hands over, and the ones it takes back. Both halves have
 * to be right or nothing launches.
 */

vi.mock('@/lib/toast', () => import('@/test/mocks/toast').then((m) => m.toastModuleMock));

const platform = {
  id: 'p-1',
  name: 'Canvas',
  issuer: 'https://canvas.test',
  clientId: '10000000000001',
  deploymentId: '1:abc',
  authLoginUrl: 'https://canvas.test/api/lti/authorize_redirect',
  tokenUrl: 'https://canvas.test/login/oauth2/token',
  keysetUrl: 'https://canvas.test/api/lti/security/jwks',
};

const ok = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);

function show(platforms: (typeof platform)[] = [], siteUrl = 'https://afct.test') {
  const fetchMock = vi.fn().mockReturnValue(ok({ platforms }));
  vi.stubGlobal('fetch', fetchMock);
  renderWithClient(<LtiTab siteUrl={siteUrl} />);
  return fetchMock;
}

/**
 * The two halves use some of the same field names, so everything is scoped to its own section
 * rather than matched across the whole tab.
 */
const section = (heading: string) =>
  within(screen.getByRole('heading', { name: heading }).parentElement as HTMLElement);

/** The manual endpoints are reference values now, not fields, so they are read as text. */
const manual = () => within(screen.getByRole('complementary', { name: 'Manual configuration' }));

/** Fills the add form with something the shared schema accepts. */
async function fillForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Add an LMS/ }));
  const form = section('Add an LMS');
  const type = async (label: RegExp, value: string) => user.type(form.getByLabelText(label), value);
  await type(/^Name/, 'Canvas');
  await type(/Platform issuer/, 'https://canvas.test');
  await type(/Client ID/, '10000000000001');
  await type(/Deployment ID/, '1:abc');
  await type(/Authorization URL/, 'https://canvas.test/auth');
  await type(/Token URL/, 'https://canvas.test/token');
  await type(/Public keyset URL/, 'https://canvas.test/jwks');
}

beforeEach(() => {
  vi.clearAllMocks();
  resetToastMock();
  vi.unstubAllGlobals();
});

/** The values an administrator has to paste into the LMS. Wrong here means nothing works. */
describe('what AFCT hands over', () => {
  it('builds its URLs from the site address', async () => {
    show([], 'https://afct.example.edu');

    await screen.findByRole('heading', { name: 'Manual configuration' });
    const give = manual();
    expect(give.getByText('https://afct.example.edu/api/lti/login')).toBeInTheDocument();
    expect(give.getByText('https://afct.example.edu/api/lti/jwks')).toBeInTheDocument();
    // Target link URI and Redirection URI are deliberately the same endpoint.
    expect(give.getAllByText('https://afct.example.edu/api/lti/launch')).toHaveLength(2);
  });

  /*
   * These are display text now, not read-only inputs. A value nobody can edit should not
   * look like a field that refuses to work, and the thing you came to do with it is copy it.
   */
  it('presents the endpoints as values, not as form controls', async () => {
    show([], 'https://afct.example.edu');

    await screen.findByRole('heading', { name: 'Manual configuration' });
    expect(manual().queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('gives every endpoint its own named copy action', async () => {
    show([], 'https://afct.example.edu');

    await screen.findByRole('heading', { name: 'Manual configuration' });
    const give = manual();
    for (const name of [
      'Copy Target link URI',
      'Copy Login initiation URL',
      'Copy Redirection URI',
      'Copy Public keyset URL',
    ]) {
      expect(give.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('copies the endpoint the button belongs to', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    show([], 'https://afct.example.edu');

    await screen.findByRole('heading', { name: 'Manual configuration' });
    await user.click(manual().getByRole('button', { name: 'Copy Public keyset URL' }));

    expect(writeText).toHaveBeenCalledWith('https://afct.example.edu/api/lti/jwks');
  });

  // Each caveat sits with the endpoint it is about, rather than in one paragraph under all four.
  it('keeps the endpoint-specific warnings', async () => {
    show([], 'https://afct.example.edu');

    await screen.findByRole('heading', { name: 'Manual configuration' });
    expect(manual().getByText(/trailing slash or a different host/)).toBeInTheDocument();
    expect(manual().getByText(/reachable from your LMS/)).toBeInTheDocument();
  });

  // A trailing slash in the configured site URL would otherwise produce a double slash.
  it('does not double the slash when the site URL ends in one', async () => {
    show([], 'https://afct.test/');

    await screen.findByRole('heading', { name: 'Manual configuration' });
    expect(manual().getAllByText('https://afct.test/api/lti/launch').length).toBeGreaterThan(0);
  });
});

/**
 * The automatic path. An administrator creates a link here and pastes it into their LMS, so the
 * only thing this screen can get wrong is showing them the wrong link, or losing it.
 */
describe('creating a registration link', () => {
  const showAndClick = async (
    user: ReturnType<typeof userEvent.setup>,
    response: Partial<Response> & { json: () => Promise<unknown> },
  ) => {
    const fetchMock = vi.fn(async (url: string) =>
      url === '/api/admin/lti/registration-token'
        ? (response as Response)
        : ((await ok({ platforms: [] })) as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderWithClient(<LtiTab siteUrl="https://afct.test" />);
    await user.click(await screen.findByRole('button', { name: /Create a registration link/ }));
    return fetchMock;
  };

  it('shows the link the server minted, and nothing it guessed itself', async () => {
    const user = userEvent.setup();
    await showAndClick(user, {
      ok: true,
      status: 201,
      json: async () => ({
        url: 'https://afct.test/lti/register?rt=secret-token',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    });

    expect(
      await screen.findByText('https://afct.test/lti/register?rt=secret-token'),
    ).toBeInTheDocument();
  });

  it('says what went wrong rather than showing an empty field', async () => {
    const user = userEvent.setup();
    await showAndClick(user, {
      ok: false,
      status: 403,
      json: async () => ({ error: 'Only administrators can do that.' }),
    });

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith('Only administrators can do that.'),
    );
    expect(screen.queryByText(/lti\/register\?rt=/)).not.toBeInTheDocument();
  });

  it('copies the link, and says so where a screen reader will hear it', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await showAndClick(user, {
      ok: true,
      status: 201,
      json: async () => ({
        url: 'https://afct.test/lti/register?rt=secret-token',
        expiresAt: new Date().toISOString(),
      }),
    });

    await user.click(await screen.findByRole('button', { name: 'Copy registration link' }));

    expect(writeText).toHaveBeenCalledWith('https://afct.test/lti/register?rt=secret-token');
    // Every copyable value carries its own live region, so scope to the one that spoke:
    // an assertion on "the" status region would now be ambiguous rather than wrong.
    await waitFor(() =>
      expect(screen.getAllByRole('status').map((el) => el.textContent)).toContain(
        'Registration link copied to the clipboard.',
      ),
    );
  });
});

describe('the registered list', () => {
  it('says plainly when nothing is registered yet', async () => {
    show([]);

    expect(await screen.findByText('No LMSs registered')).toBeInTheDocument();
    expect(screen.getByText(/Nobody can open AFCT from an LMS yet/)).toBeInTheDocument();
  });

  it('shows a registration with the values that identify it', async () => {
    show([platform]);

    expect(await screen.findByText('Canvas')).toBeInTheDocument();
    expect(screen.getByText('https://canvas.test')).toBeInTheDocument();
    expect(screen.getByText(/Client 10000000000001, deployment 1:abc/)).toBeInTheDocument();
  });

  it('reports a failed load rather than showing an empty list as fact', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    renderWithClient(<LtiTab siteUrl="https://afct.test" />);

    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
  });
});

describe('registering one', () => {
  it('checks the values before sending them', async () => {
    show([]);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /Add an LMS/ }));
    await user.type(section('Add an LMS').getByLabelText(/^Name/), 'Canvas');
    await user.click(screen.getByRole('button', { name: /^Register$/ }));

    // Rejected next to the fields, without a round trip.
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('posts a complete registration and reloads the list', async () => {
    const fetchMock = show([]);
    const user = userEvent.setup();

    await screen.findByRole('button', { name: /Add an LMS/ });
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /^Register$/ }));

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('LMS registered'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/lti/platforms',
      expect.objectContaining({ method: 'POST' }),
    );
    // Loaded once at mount, posted, then reloaded from the server.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  /**
   * The route refuses a duplicate triple, which is the mistake an administrator actually makes
   * when a second course is added. Its wording is the useful one.
   */
  it('shows the reason the server refused', async () => {
    const fetchMock = vi.fn().mockReturnValue(ok({ platforms: [] }));
    fetchMock.mockReturnValueOnce(ok({ platforms: [] })).mockReturnValueOnce(
      Promise.resolve({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ error: 'That LMS is already registered.' }),
      } as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderWithClient(<LtiTab siteUrl="https://afct.test" />);
    const user = userEvent.setup();

    await screen.findByRole('button', { name: /Add an LMS/ });
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /^Register$/ }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith('That LMS is already registered.'),
    );
  });
});

/** Removing a registration stops every launch from that LMS, so it asks first. */
describe('removing one', () => {
  it('asks before removing', async () => {
    show([platform]);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Remove Canvas' }));

    expect(await screen.findByText(/Remove this registration\?/)).toBeInTheDocument();
    // Nothing sent yet: the list load is still the only call.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('deletes only once confirmed', async () => {
    const fetchMock = show([platform]);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Remove Canvas' }));
    await user.click(await screen.findByRole('button', { name: /^Remove$/ }));

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Registration removed'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/lti/platforms/p-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
