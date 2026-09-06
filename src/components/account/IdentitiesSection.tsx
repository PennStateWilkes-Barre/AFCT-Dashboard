'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { signIn } from 'next-auth/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Unlink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog';
import { showToast } from '@/lib/toast';
import { formatDateTimeInTimeZone } from '@/lib/date-format';
import { useEffectiveTimezone } from '@/hooks/use-effective-timezone';
import { SettingsSection, SETTINGS_STANDARD } from '@/components/settings/settings-layout';
import { queryKeys } from '@/lib/query-keys';

const IDENTITIES_DESCRIPTION =
  'Sign in to AFCT with your institution instead of an AFCT password. You can connect one and still keep your password.';

type LinkedIdentity = {
  id: string;
  kind: string;
  issuer: string;
  subject: string;
  linkedVia: string;
  createdAt: string;
  lastSignInAt: string | null;
};

/** Plain language for how a connection came about. Nobody outside the code says "just in time". */
const HOW_LINKED: Record<string, string> = {
  SELF_SERVICE: 'You connected this',
  AUTO_VERIFIED_EMAIL: 'Matched your email address',
  JUST_IN_TIME: 'Created when you first signed in',
  ADMIN: 'An administrator connected this',
};

/**
 * The institutional sign-ins connected to your own account.
 *
 * Connect starts a real OIDC sign-in rather than posting a form: only the provider can prove
 * the account over there belongs to whoever is signed in here. It is also the only way an
 * admin gets one, since automatic linking refuses admin accounts.
 */
export function IdentitiesSection({
  providerLabel,
  canConnect = true,
}: {
  providerLabel: string | null;
  /**
   * Whether a new institutional account can be connected right now. Separate from whether
   * existing ones are shown: an administrator turning the provider off must not hide identities
   * that still exist and still work.
   */
  canConnect?: boolean;
}) {
  const { timezone, hour12 } = useEffectiveTimezone();
  const [unlinking, setUnlinking] = useState<LinkedIdentity | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Cached, so returning to the Account page does not re-ask, and so an unlink here updates
   * anything else reading the same key. It also picks up the retry-once default: a single
   * flaky response used to leave the section empty with a toast and no second attempt.
   */
  const queryClient = useQueryClient();
  const identitiesQuery = useQuery({
    queryKey: queryKeys.me.identities(),
    queryFn: async () => {
      const res = await fetch('/api/me/identities');
      if (!res.ok) throw new Error('Failed to load identities');
      return (await res.json()) as { identities: LinkedIdentity[]; hasPassword: boolean };
    },
  });
  // `null` is the loading state below. A failed read resolves to an empty list rather than a
  // permanent spinner, which is what the old catch did.
  const identities: LinkedIdentity[] | null = identitiesQuery.isPending
    ? null
    : (identitiesQuery.data?.identities ?? []);
  // Assume they have one until told otherwise: this only ever gates removing the last way in,
  // so the safe default while loading or after a failure is "do not offer to remove it".
  const hasPassword = identitiesQuery.data?.hasPassword ?? true;

  useEffect(() => {
    if (identitiesQuery.isError)
      showToast.error('Could not load your connected accounts. Refresh the page to try again.');
  }, [identitiesQuery.isError]);

  /** Re-read through the cache after an unlink, so other readers of the key follow. */
  const load = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.me.identities() }),
    [queryClient],
  );

  /**
   * The result of a connection attempt comes back as a query parameter, because the round trip
   * goes out to the provider and back. Read it once, tell them, then strip it so a reload does
   * not repeat the message.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const linked = params.get('linked');
    const error = params.get('error');
    if (!linked && !error) return;

    if (linked) {
      showToast.success('Account connected', {
        description: 'You can sign in with it from now on.',
      });
    } else if (error === 'already-linked-elsewhere') {
      showToast.error('That institutional login is already connected to a different AFCT account.');
    } else {
      showToast.error('That account could not be connected. Check your connection and try again.');
    }
    window.history.replaceState({}, '', window.location.pathname + '?tab=accounts');
    void load();
  }, [load]);

  const unlink = async () => {
    if (!unlinking) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/me/identities/${unlinking.id}`, { method: 'DELETE' });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        showToast.error(
          data.error ?? 'Could not disconnect that account. Check your connection and try again.',
        );
        return;
      }
      showToast.success('Account disconnected');
      setUnlinking(null);
      await load();
    } catch {
      showToast.error('Could not disconnect that account. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const label = providerLabel ?? 'your institution';

  /**
   * What a row actually is.
   *
   * `LinkedIdentity` holds institutional sign-ins and LMS launches alike, and every row used to
   * be labelled with the one configured OIDC provider: somebody's Canvas identity was presented
   * to them as an institutional account they had connected, which is neither true nor something
   * they could act on. The issuer is shown for an LMS row because a person may be launching
   * from more than one, and it is the only thing that tells them apart.
   */
  const rowLabel = (identity: { kind: string; issuer: string }) => {
    if (identity.kind !== 'LTI') return label;
    try {
      return `Your LMS (${new URL(identity.issuer).host})`;
    } catch {
      return 'Your LMS';
    }
  };
  // Removing the last one would lock them out, and the refusal belongs where the button is
  // rather than as a surprise after the click.
  const isOnlyWayIn = !hasPassword && (identities?.length ?? 0) <= 1;
  /**
   * Where focus lands once a connection is removed.
   *
   * The Disconnect button is inside the row the removal deletes, and the confirm is awaited, so
   * by the time the dialog closes Radix's restore target is gone and focus falls to the body.
   */
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Both states are drawn in the panel, so the tab does not start as bare text on the page
  // background and then grow a card once the list arrives.
  if (identities === null) {
    return (
      <SettingsSection
        title="Connected accounts"
        description={IDENTITIES_DESCRIPTION}
        className={SETTINGS_STANDARD}
      >
        <p role="status" aria-live="polite" className="text-muted-foreground text-sm">
          Loading your connected accounts...
        </p>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title="Connected accounts"
      description={IDENTITIES_DESCRIPTION}
      headingRef={headingRef}
      className={SETTINGS_STANDARD}
    >
      {identities.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          You have not connected an institutional account.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {identities.map((identity) => (
            <li
              key={identity.id}
              className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{rowLabel(identity)}</p>
                <p className="text-muted-foreground truncate text-xs">
                  {HOW_LINKED[identity.linkedVia] ?? 'Connected'}
                  {' on '}
                  {formatDateTimeInTimeZone(identity.createdAt, timezone, hour12)}
                </p>
                <p className="text-muted-foreground truncate text-xs">
                  {identity.lastSignInAt
                    ? `Last used ${formatDateTimeInTimeZone(identity.lastSignInAt, timezone, hour12)}`
                    : 'Not used to sign in yet'}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setUnlinking(identity)}
                disabled={isOnlyWayIn}
                /* The explanation is the paragraph below, pointed at rather than repeated in a
                   `title`: a disabled button never receives focus or hover, so a title on one
                   is text nobody can reach. A description is still exposed in browse mode. */
                aria-describedby={isOnlyWayIn ? 'only-way-in-note' : undefined}
              >
                <Unlink className="mr-2 h-4 w-4" aria-hidden="true" />
                Disconnect
              </Button>
            </li>
          ))}
        </ul>
      )}

      {isOnlyWayIn && identities.length > 0 && (
        <p id="only-way-in-note" className="text-muted-foreground text-sm">
          This is the only way to sign in to your account, so it cannot be disconnected. To be able
          to disconnect it, ask an administrator to send you a password reset, which lets you set an
          AFCT password as well.
        </p>
      )}

      {canConnect ? (
        <Button
          onClick={() => void signIn('oidc', { callbackUrl: '/dashboard/account?tab=accounts' })}
        >
          <Link2 className="mr-2 h-4 w-4" aria-hidden="true" />
          Connect {label}
        </Button>
      ) : (
        <p className="text-muted-foreground text-sm">
          Institutional sign-in is switched off for this AFCT, so there is nothing new to connect
          and an institutional account cannot be used to sign in at the moment. Anything already
          connected is kept, can be disconnected here, and works again if it is switched back on.
          Connections from your LMS are unaffected: they come from opening AFCT there.
        </p>
      )}

      <ConfirmDialog
        open={unlinking !== null}
        onCancel={() => setUnlinking(null)}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          headingRef.current?.focus();
        }}
        title="Disconnect this account?"
        /**
         * Written from the row being removed, not from the configured provider.
         *
         * The two kinds are undone differently: an institutional account is connected again
         * from this page, and an LMS identity comes back by opening AFCT from the LMS. Naming
         * the institution while removing a Canvas identity told somebody the wrong thing about
         * both what they were losing and how to get it back.
         */
        description={
          unlinking
            ? unlinking.kind === 'LTI'
              ? `${rowLabel(unlinking)} will be removed from your AFCT account. Opening AFCT from that LMS again may reconnect it.`
              : `You will no longer be able to sign in to AFCT with ${rowLabel(unlinking)}. You can connect it again from this page.`
            : undefined
        }
        confirmText="Disconnect"
        // Removes a way into the account, which is what this variant is for.
        variant="destructive"
        onConfirm={unlink}
        busy={busy}
      />
    </SettingsSection>
  );
}
