'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import InputGroup from '@/components/ui/InputGroup';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog';
import { showToast } from '@/lib/toast';
import { LtiPlatformSchema } from '@/schemas/lti';
import { SettingsAsideCard, SettingsAsideLayout, SettingsSection } from '@/components/settings/settings-layout';
import { CopyableValue } from './CopyableValue';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';

type Platform = {
  id: string;
  name: string;
  issuer: string;
  clientId: string;
  deploymentId: string;
  authLoginUrl: string;
  tokenUrl: string;
  tokenAudience: string;
  keysetUrl: string;
};

const EMPTY = {
  name: '',
  issuer: '',
  clientId: '',
  deploymentId: '',
  authLoginUrl: '',
  tokenUrl: '',
  tokenAudience: '',
  keysetUrl: '',
};

/**
 * LTI tab: which LMSs may open AFCT.
 *
 * Registration is mutual, so the tab has two halves. The values AFCT needs go in the form; the
 * values the LMS needs are listed above it, ready to copy.
 */
/**
 * The four endpoint values an LMS wants when it is configured by hand.
 *
 * Reference, in the rail, not four read-only InputGroups in the middle of the page. This is
 * the fallback path: dynamic registration fills all of it in for you, so it should be
 * findable without competing with the button that does the job for you.
 *
 * The two caveats that used to sit in a paragraph under all four fields now sit with the
 * endpoint each one is actually about.
 */
function ManualConfigurationCard({ base }: { base: string }) {
  return (
    <SettingsAsideCard title="Manual configuration">
      <div className="space-y-4">
        <p className="text-muted-foreground text-xs leading-4.5">
          Use these only if your LMS cannot do dynamic registration, or you would rather register
          AFCT by hand.
        </p>

        <CopyableValue label="Target link URI" value={`${base}/api/lti/launch`} />
        <CopyableValue label="Login initiation URL" value={`${base}/api/lti/login`} />
        <CopyableValue
          label="Redirection URI"
          value={`${base}/api/lti/launch`}
          description="Your LMS compares this exactly. A trailing slash or a different host is the usual cause of a failed launch."
        />
        <CopyableValue
          label="Public keyset URL"
          value={`${base}/api/lti/jwks`}
          description="Your LMS reads this from its own servers, not from a browser, so AFCT has to be reachable from your LMS. Grades will not reach it otherwise."
        />
      </div>
    </SettingsAsideCard>
  );
}

export function LtiTab({ siteUrl }: { siteUrl: string }) {
  const base = siteUrl.replace(/\/+$/, '');
  const [draft, setDraft] = useState(EMPTY);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<Platform | null>(null);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [creatingLink, setCreatingLink] = useState(false);

  /**
   * Cached, so switching between System Settings tabs does not re-ask each time, and so a
   * registration made elsewhere shows up here. Retry-once comes with it: a flaky response
   * used to leave the list empty with a toast and no second attempt.
   */
  const queryClient = useQueryClient();
  const platformsQuery = useQuery({
    queryKey: queryKeys.admin.ltiPlatforms(),
    queryFn: async () => {
      const res = await fetch('/api/admin/lti/platforms');
      if (!res.ok) throw new Error('Failed to load platforms');
      return ((await res.json()) as { platforms: Platform[] }).platforms;
    },
  });
  // `null` is the loading row below; a failed read resolves to an empty list rather than a
  // permanent spinner, the way the old catch did.
  const platforms: Platform[] | null = platformsQuery.isPending
    ? null
    : (platformsQuery.data ?? []);

  useEffect(() => {
    if (platformsQuery.isError)
      showToast.error('Could not load the registered LMSs. Refresh the page to try again.');
  }, [platformsQuery.isError]);

  const load = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.admin.ltiPlatforms() }),
    [queryClient],
  );

  const save = async () => {
    // Checked here with the same schema the route uses, so a typo is caught next to the field
    // rather than after a round trip.
    const parsed = LtiPlatformSchema.safeParse(draft);
    if (!parsed.success) {
      showToast.error(parsed.error.issues[0]?.message ?? 'Check the values and try again.');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/admin/lti/platforms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        showToast.error(
          data.error ?? 'Could not register that LMS. Check your connection and try again.',
        );
        return;
      }
      showToast.success('LMS registered');
      setDraft(EMPTY);
      setAdding(false);
      await load();
    } catch {
      showToast.error('Could not register that LMS. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!removing) return;
    try {
      const res = await fetch(`/api/admin/lti/platforms/${removing.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      showToast.success('Registration removed');
      setRemoving(null);
      await load();
    } catch {
      showToast.error('Could not remove that registration. Check your connection and try again.');
    }
  };

  const createLink = async () => {
    setCreatingLink(true);
    try {
      const res = await fetch('/api/admin/lti/registration-token', { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as {
        url?: string;
        expiresAt?: string;
        error?: string;
      };
      if (!res.ok || !data.url || !data.expiresAt) {
        showToast.error(data.error ?? 'Could not create a registration link. Try again.');
        return;
      }
      setLink({ url: data.url, expiresAt: data.expiresAt });
    } catch {
      showToast.error('Could not create a registration link. Check your connection and try again.');
    } finally {
      setCreatingLink(false);
    }
  };

  const set = (key: keyof typeof EMPTY) => (value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));

  return (
    <>
      {/*
        The manual endpoints go in the rail, and asidePlacement="after" puts them last when
        the columns stack. They are the fallback path: an admin whose LMS cannot do dynamic
        registration. On a phone they should not sit between someone and the button they
        came for, which is why this is the one tab whose rail is not read first.
      */}
      <SettingsAsideLayout asidePlacement="after" aside={<ManualConfigurationCard base={base} />}>
        <SettingsSection
          title="Register automatically"
          description="Connect an LMS with a temporary registration link. This is the easiest way."
        >
          <p className="text-muted-foreground max-w-3xl text-sm">
            Create a link and paste it into your LMS where it asks for a registration or tool URL.
            Canvas, Moodle and Brightspace each call this something slightly different; look for
            dynamic registration.
          </p>
          {link ? (
            <div className="max-w-2xl space-y-3">
              <CopyableValue
                label="Registration link"
                value={link.url}
                copyName="registration link"
                description={`Works once, and expires at ${new Date(link.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Anyone holding it can register an LMS, so treat it like a password.`}
              />
              <Button type="button" size="sm" variant="ghost" onClick={() => setLink(null)}>
                Done
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <Button onClick={() => void createLink()} disabled={creatingLink}>
                {creatingLink ? 'Creating...' : 'Create a registration link'}
              </Button>
              {/* Not buried in the paragraph above: an admin who creates one and comes back
                  tomorrow needs to know it will already be dead. */}
              <p className="text-muted-foreground text-xs leading-4.5">
                The link works once and expires after an hour.
              </p>
            </div>
          )}
        </SettingsSection>

        <SettingsSection
          title="Registered LMSs"
          description="LMS platforms currently allowed to launch AFCT."
          action={
            !adding && (
              <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
                <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
                Add an LMS
              </Button>
            )
          }
        >
          {platforms === null ? (
            <p className="text-muted-foreground text-sm">Loading...</p>
          ) : platforms.length === 0 ? (
            // Understated, not an illustration: the useful part is what it means, which is
            // that the LTI half of the install does nothing yet.
            <div className="bg-muted/40 space-y-1 rounded-md border p-4">
              <p className="text-foreground text-sm font-medium">No LMSs registered</p>
              <p className="text-muted-foreground text-xs leading-4.5">
                Nobody can open AFCT from an LMS yet. Register one automatically above, or add it by
                hand.
              </p>
            </div>
          ) : (
            <ul className="divide-y rounded-md border">
              {platforms.map((platform) => (
                <li key={platform.id} className="flex items-start justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{platform.name}</p>
                    <p className="text-muted-foreground truncate text-xs">{platform.issuer}</p>
                    <p className="text-muted-foreground truncate text-xs">
                      Client {platform.clientId}, deployment {platform.deploymentId}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRemoving(platform)}
                    aria-label={`Remove ${platform.name}`}
                  >
                    <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </SettingsSection>

        {adding && (
          <div className="bg-card space-y-4 rounded-lg border p-4 shadow-xs">
            <h3 className="text-sm font-semibold">Add an LMS</h3>
            <p className="text-muted-foreground text-xs">
              Your LMS gives you these when you create a developer key for AFCT.
            </p>

            {/* Short identifiers pair up; the URLs below stay full rows, because half a
                URL is harder to check than a taller form. */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <InputGroup
                label="Name"
                name="lti-name"
                value={draft.name}
                setValue={set('name')}
                placeholder="Penn State Canvas"
              />
              <InputGroup
                label="Client ID"
                name="lti-client-id"
                value={draft.clientId}
                setValue={set('clientId')}
              />
              <InputGroup
                label="Deployment ID"
                name="lti-deployment-id"
                value={draft.deploymentId}
                setValue={set('deploymentId')}
              />
            </div>
            <InputGroup
              label="Platform issuer"
              name="lti-issuer"
              value={draft.issuer}
              setValue={set('issuer')}
              placeholder="https://canvas.instructure.com"
            />
            <InputGroup
              label="Authorization URL"
              name="lti-auth-url"
              value={draft.authLoginUrl}
              setValue={set('authLoginUrl')}
            />
            <InputGroup
              label="Token URL"
              name="lti-token-url"
              value={draft.tokenUrl}
              setValue={set('tokenUrl')}
            />
            <InputGroup
              label="Public keyset URL"
              name="lti-keyset-url"
              value={draft.keysetUrl}
              setValue={set('keysetUrl')}
            />
            {/* Last, and described rather than labelled tersely, because almost nobody needs it and
                the one place it is needed is not guessable from the name. */}
            <InputGroup
              label="Token audience (optional)"
              name="lti-token-audience"
              value={draft.tokenAudience}
              setValue={set('tokenAudience')}
              description="Only D2L Brightspace needs this: use the Brightspace OAuth2 Audience from its registration. Leave it empty for Canvas, Moodle and Blackboard, which expect the token URL."
            />

            <div className="flex gap-2">
              <Button onClick={save} disabled={saving}>
                {saving ? 'Registering...' : 'Register'}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setAdding(false);
                  setDraft(EMPTY);
                }}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </SettingsAsideLayout>

      <ConfirmDialog
        open={removing !== null}
        onCancel={() => setRemoving(null)}
        title="Remove this registration?"
        description={`Nobody will be able to open AFCT from ${removing?.name ?? 'this LMS'} until it is registered again. Work already in AFCT is not affected.`}
        confirmText="Remove"
        variant="destructive"
        onConfirm={remove}
      />
    </>
  );
}
