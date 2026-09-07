'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import InputGroup from '@/components/ui/InputGroup';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog';
import { showToast } from '@/lib/toast';
import { formatDateTimeInTimeZone } from '@/lib/date-format';
import { useEffectiveTimezone } from '@/hooks/use-effective-timezone';
import { SettingsSection, SETTINGS_STANDARD } from '@/components/settings/settings-layout';
import { queryKeys } from '@/lib/query-keys';

type ClientToken = {
  id: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
};

/**
 * Tokens for the desktop client, on the account page.
 *
 * This is why the account page exists: a token list needs a table with labels, last-used dates
 * and a revoke action, and that does not belong in a dialog.
 *
 * A new token is shown **once**. That is a deliberate security property and an accessibility
 * problem at the same time, so the value is rendered as selectable text with a real label
 * rather than as something only a mouse can copy, and the copy result is announced.
 */
export function TokensSection() {
  // Dates in the course/effective timezone, like every other date the app shows, rather than
  // whatever the browser happens to be set to.
  const { timezone, hour12 } = useEffectiveTimezone();
  const [label, setLabel] = useState('');
  const [issuing, setIssuing] = useState(false);
  /** The plaintext of a token just issued. Held in memory only, and never fetched again. */
  const [justIssued, setJustIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const issuedPanelRef = useRef<HTMLDivElement>(null);

  /**
   * Move focus to the new token when it appears.
   *
   * It is displayed exactly once and never again, and it arrived above the button that made
   * it with nothing announced: somebody using a screen reader pressed Create token, heard
   * silence, and the one copy of the value was sitting off-screen behind them. Focusing the
   * field reads its label, "Copy this now. It will not be shown again.", along with the value.
   */
  useEffect(() => {
    if (!justIssued) return;
    const field = issuedPanelRef.current?.querySelector('input');
    field?.focus();
  }, [justIssued]);
  const [revoking, setRevoking] = useState<ClientToken | null>(null);
  /** Where focus lands after a revoke: the row that held the button is gone by then. */
  const tokensHeadingRef = useRef<HTMLHeadingElement>(null);

  /**
   * Cached, so leaving the Account page and coming back does not refetch, and so a revoke in
   * one place updates anywhere else reading the same key. It also gets the retry-once default:
   * before this, a single flaky response left the list empty with a toast and no second try.
   */
  const queryClient = useQueryClient();
  const tokensQuery = useQuery({
    queryKey: queryKeys.me.clientTokens(),
    queryFn: async () => {
      const res = await fetch('/api/me/client-tokens');
      if (!res.ok) throw new Error('Failed to load tokens');
      return ((await res.json()) as { tokens: ClientToken[] }).tokens;
    },
  });
  // `null` means "still loading", which the list below renders as a spinner. A failed read
  // resolves to an empty list rather than a permanent spinner, the way it did before.
  const tokens: ClientToken[] | null = tokensQuery.isPending ? null : (tokensQuery.data ?? []);

  useEffect(() => {
    if (tokensQuery.isError)
      showToast.error('Could not load your tokens. Reload the page to try again.');
  }, [tokensQuery.isError]);

  /** Re-read the list after issuing or revoking, through the cache so other readers follow. */
  const load = () => queryClient.invalidateQueries({ queryKey: queryKeys.me.clientTokens() });

  const issue = async () => {
    setIssuing(true);
    try {
      const res = await fetch('/api/me/client-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim() || undefined }),
      });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { token: string };
      setJustIssued(data.token);
      setCopied(false);
      setLabel('');
      await load();
    } catch {
      showToast.error('Could not create a token. Try again.');
    } finally {
      setIssuing(false);
    }
  };

  const revoke = async (token: ClientToken) => {
    try {
      const res = await fetch(`/api/me/client-tokens/${token.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      showToast.success('Token revoked');
      await load();
    } catch {
      showToast.error('Could not revoke the token. Try again.');
    } finally {
      setRevoking(null);
    }
  };

  const copy = async () => {
    if (!justIssued) return;
    try {
      await navigator.clipboard.writeText(justIssued);
      // Cleared first so a second press changes the region's text and is announced again.
      // Leaving it true meant the second Copy produced silence and no visible change.
      setCopied(false);
      setCopied(true);
    } catch {
      // Clipboard access can be refused. The value is on screen and selectable, so say that
      // rather than pretending the copy worked.
      showToast.error('Could not copy. Select the token and copy it manually.');
    }
  };

  return (
    <div className="space-y-6">
      {/* Two panels rather than one: creating a token and reviewing the ones you already have
          are separate acts, and the second is a table. */}
      <SettingsSection
        title="Create a token"
        /* This used to say the desktop client signs in with a token pasted from here. It does
           not: its login window asks for a server, an email and a password, and gets its own
           token from those. Saying otherwise sent people looking for a field that is not there. */
        description={
          <>
            A token lets a program reach AFCT on your behalf, through the AFCT client API, without
            your password. Name it so you can tell your machines apart, and revoke it when you stop
            using one. The AFCT desktop client does not use these: it asks for your email and
            password and signs in with those.
          </>
        }
        className={SETTINGS_STANDARD}
      >
        {justIssued ? (
          <div
            ref={issuedPanelRef}
            className="border-status-info-border bg-status-info-bg space-y-3 rounded-md border p-4"
          >
            <p className="text-sm font-medium">Your new token</p>
            {/* Rendered as a labelled, readonly field rather than decorative text: it has to be
              reachable and selectable by keyboard, since this is the only time it exists. */}
            <InputGroup
              name="new-client-token"
              label="Copy this now. It will not be shown again."
              value={justIssued}
              setValue={() => {}}
              readOnly
            />
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => void copy()}>
                <Copy className="h-4 w-4" aria-hidden="true" />
                Copy token
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setJustIssued(null)}>
                Done
              </Button>
            </div>
            {/* One live region for this area, so the copy result is announced once. */}
            <p role="status" aria-live="polite" className="text-sm">
              {copied ? 'Token copied to the clipboard.' : ''}
            </p>
          </div>
        ) : null}

        {/* A name is a short value, so it keeps a short field rather than stretching the
            panel. System Settings pairs its short fields two-up for the same reason. */}
        <div className="max-w-md space-y-3">
          <InputGroup
            name="token-label"
            label="Name this token"
            value={label}
            setValue={setLabel}
            disabled={issuing}
            placeholder="My laptop"
            description="Optional, but it is how you will tell your tokens apart later."
          />
          <div>
            <Button type="button" onClick={() => void issue()} disabled={issuing}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {issuing ? 'Creating…' : 'Create token'}
            </Button>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Your tokens"
        headingRef={tokensHeadingRef}
        className={SETTINGS_STANDARD}
      >
        {tokens === null ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : tokens.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            You have no tokens. Create one above if you use the desktop client.
          </p>
        ) : (
          <div
            tabIndex={0}
            role="region"
            aria-label="Tokens you have issued for the desktop client"
            className="focus-visible:ring-ring overflow-x-auto focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none"
          >
            <table className="w-full text-sm">
              <caption className="sr-only">Tokens you have issued for the desktop client</caption>
              <thead>
                <tr className="text-muted-foreground text-left">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Name
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Created
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Last used
                  </th>
                  <th scope="col" className="py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((token) => (
                  <tr key={token.id} className="border-t">
                    <th scope="row" className="py-2 pr-4 text-left font-normal">
                      {token.label || 'Unnamed token'}
                    </th>
                    <td className="py-2 pr-4">
                      {formatDateTimeInTimeZone(token.createdAt, timezone, hour12)}
                    </td>
                    <td className="text-muted-foreground py-2 pr-4">
                      {token.lastUsedAt
                        ? formatDateTimeInTimeZone(token.lastUsedAt, timezone, hour12)
                        : 'Never used'}
                    </td>
                    <td className="py-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setRevoking(token)}
                        /* Which token. Tabbing the table otherwise gave "Revoke, Revoke,
                           Revoke" with nothing to tell them apart. The name still begins with
                           the visible word, so speech input for "Revoke" still matches
                           (WCAG 2.5.3), and this is a real button, so a label belongs on it. */
                        aria-label={`Revoke ${token.label || 'Unnamed token'}`}
                      >
                        Revoke
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SettingsSection>

      {/*
        `open={...}` rather than mounting the dialog conditionally. Unmounting an open Radix
        dialog tears it out of the tree instead of closing it, so the close transition and the
        focus restore are both skipped. The handler then sends focus to the section heading,
        because the button that opened this was in the row the revoke has just removed.
      */}
      <ConfirmDialog
        open={!!revoking}
        variant="destructive"
        title="Revoke this token?"
        description={`The client using ${revoking?.label || 'this token'} will stop working immediately and will need a new one.`}
        confirmText="Revoke token"
        onConfirm={() => (revoking ? revoke(revoking) : undefined)}
        onCancel={() => setRevoking(null)}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          tokensHeadingRef.current?.focus();
        }}
      />
    </div>
  );
}

export default TokensSection;
