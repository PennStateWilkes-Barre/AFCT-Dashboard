/** @vitest-environment jsdom */

import React from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/ui/InputGroup', () =>
  import('@/test/mocks/ui').then((mod) => mod.inputGroupMock),
);
vi.mock('@/lib/toast', () => import('@/test/mocks/toast').then((m) => m.toastModuleMock));
vi.mock('@/hooks/use-effective-timezone', () => ({
  useEffectiveTimezone: () => ({ timezone: 'UTC', hour12: false }),
}));

import { toastMock } from '@/test/mocks/toast';
import { TokensSection } from './TokensSection';
import { renderWithClient } from '@/test/query';

const globalWithReact = globalThis as typeof globalThis & { React?: typeof React };
globalWithReact.React = React;

// jsdom exposes navigator.clipboard through a getter only, so it cannot be assigned. It also
// has to be stubbed AFTER userEvent.setup(), which installs a clipboard stub of its own.
const stubClipboard = (writeText: ReturnType<typeof vi.fn>) => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
};

const token = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  label: 'My laptop',
  createdAt: '2026-01-01T10:00:00.000Z',
  lastUsedAt: null,
  expiresAt: null,
  ...over,
});

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ tokens: [] }) });
});

describe('TokensSection', () => {
  it('says so when there are no tokens', async () => {
    renderWithClient(<TokensSection />);

    expect(await screen.findByText(/You have no tokens/)).toBeInTheDocument();
  });

  it('lists tokens with when they were last used', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ tokens: [token(), token({ id: 't2', label: 'Lab machine' })] }),
    });

    renderWithClient(<TokensSection />);

    expect(await screen.findByText('My laptop')).toBeInTheDocument();
    expect(screen.getByText('Lab machine')).toBeInTheDocument();
    expect(screen.getAllByText('Never used')).toHaveLength(2);
  });

  /**
   * The token is returned once and never again, so losing it here means issuing another. It
   * has to be on screen as real, selectable text rather than only behind a copy button, which
   * is both a keyboard and a screen-reader concern.
   */
  describe('a newly issued token', () => {
    beforeEach(() => {
      fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
        Promise.resolve(
          init?.method === 'POST'
            ? { ok: true, json: async () => ({ token: 'plaintext-token-value', id: 't9' }) }
            : { ok: true, json: async () => ({ tokens: [] }) },
        ),
      );
    });

    it('is shown as selectable text, not just a copy button', async () => {
      const user = userEvent.setup();
      renderWithClient(<TokensSection />);

      await user.click(screen.getByRole('button', { name: /create token/i }));

      const field = await screen.findByDisplayValue('plaintext-token-value');
      expect(field).toBeInTheDocument();
    });

    it('warns that it will not be shown again', async () => {
      const user = userEvent.setup();
      renderWithClient(<TokensSection />);

      await user.click(screen.getByRole('button', { name: /create token/i }));

      expect(await screen.findByText(/will not be shown again/i)).toBeInTheDocument();
    });

    it('announces a successful copy rather than changing only a colour', async () => {
      const user = userEvent.setup();
      const writeText = stubClipboard(vi.fn().mockResolvedValue(undefined));
      renderWithClient(<TokensSection />);
      await user.click(screen.getByRole('button', { name: /create token/i }));

      await user.click(await screen.findByRole('button', { name: /copy token/i }));

      expect(writeText).toHaveBeenCalledWith('plaintext-token-value');
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(/copied to the clipboard/i),
      );
    });

    // Clipboard access can be refused, and the value is on screen anyway.
    it('says what to do instead when the clipboard is unavailable', async () => {
      const user = userEvent.setup();
      stubClipboard(vi.fn().mockRejectedValue(new Error('denied')));
      renderWithClient(<TokensSection />);
      await user.click(screen.getByRole('button', { name: /create token/i }));

      await user.click(await screen.findByRole('button', { name: /copy token/i }));

      await waitFor(() =>
        expect(toastMock.error).toHaveBeenCalledWith(expect.stringMatching(/copy it manually/i)),
      );
    });
  });

  /**
   * Revoking cuts off a machine that is presumably in use, so it asks first. The guard is only
   * worth having if backing out actually backs out.
   */
  describe('revoking', () => {
    beforeEach(() => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ tokens: [token()] }) });
    });

    it('asks before revoking', async () => {
      const user = userEvent.setup();
      renderWithClient(<TokensSection />);
      await user.click(await screen.findByRole('button', { name: /^Revoke My laptop$/ }));

      expect(screen.getByRole('dialog')).toHaveTextContent(/revoke this token/i);
      expect(fetchMock).not.toHaveBeenCalledWith(
        expect.stringContaining('/t1'),
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('sends nothing when the confirmation is cancelled', async () => {
      const user = userEvent.setup();
      renderWithClient(<TokensSection />);
      await user.click(await screen.findByRole('button', { name: /^Revoke My laptop$/ }));
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(fetchMock).not.toHaveBeenCalledWith(
        expect.stringContaining('/t1'),
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('revokes once confirmed', async () => {
      const user = userEvent.setup();
      renderWithClient(<TokensSection />);
      await user.click(await screen.findByRole('button', { name: /^Revoke My laptop$/ }));
      const dialog = screen.getByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Revoke token' }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/me/client-tokens/t1',
          expect.objectContaining({ method: 'DELETE' }),
        ),
      );
    });
  });
});

/**
 * The one moment the token exists.
 *
 * It is shown once and never again. It used to appear above the Create button with nothing
 * announced and focus left where it was, so somebody using a screen reader pressed the button,
 * heard silence, and the value was behind them.
 */
describe('when a token is created', () => {
  it('puts focus on the field holding it', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return { ok: true, json: async () => ({ token: 'afct_secret_value', label: 'Laptop' }) };
      }
      return { ok: true, json: async () => ({ tokens: [] }) };
    });

    renderWithClient(<TokensSection />);
    await waitFor(() => expect(screen.getByLabelText(/name this token/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /create token/i }));

    await waitFor(() => {
      const field = screen.getByDisplayValue('afct_secret_value');
      expect(document.activeElement).toBe(field);
    });
  });
});

/**
 * The read moved onto TanStack Query, so the failure path had to be re-proved.
 *
 * Before, a failed load did `setTokens([])` inside a catch. Now the query owns the error and
 * the component derives the list from it, and the easy mistake is leaving `data` undefined so
 * the section renders its loading state forever rather than saying there is nothing here.
 */
describe('when the token list cannot be loaded', () => {
  it('shows the empty state and says so once, rather than spinning', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    renderWithClient(<TokensSection />);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        'Could not load your tokens. Reload the page to try again.',
      ),
    );
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText(/You have no tokens\./i),
    ).toBeInTheDocument();
  });
});
