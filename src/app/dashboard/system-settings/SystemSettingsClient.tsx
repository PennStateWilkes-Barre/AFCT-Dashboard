'use client';

import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { TabBar, TabRail } from '@/components/course/course-tabs';
import { LocalNavLayout } from '@/components/local-nav';
import { SETTINGS_ASIDE_GRID, SETTINGS_WORKSPACE } from '@/components/settings/settings-layout';
import { useIsDesktopNav } from '@/hooks/use-desktop-nav';
import { Button } from '@/components/ui/button';
import { showToast } from '@/lib/toast';
import { apiPaths } from '@/lib/api-paths';
import { COMMON_TIMEZONES, formatTimezoneLabel } from '@/lib/timezones';
import {
  clampSessionTimeoutMinutes,
  clampSubmissionEvalTimeoutMs,
  clampSubmissionEvalMaxMemoryMb,
  clampSubmissionResubmitCooldownMs,
  clampSubmissionMaxConcurrent,
  clampSubmissionMaxAttempts,
  clampSubmissionAnalyzerLimit,
  clampLoginMaxAttempts,
  clampLoginLockoutMinutes,
  clampBackupHour,
  clampBackupRetentionDays,
  clampActivityLogRetentionDays,
} from '@/lib/system-settings';
import { parseDomainList } from '@/lib/email';
import { SystemSettingsUpdateSchema } from '@/schemas/systemSettings';
import {
  Settings,
  SlidersHorizontal,
  Cpu,
  DatabaseBackup,
  LogIn,
  Mail,
  ShieldCheck,
  Link2,
  Lock,
  RefreshCw,
} from 'lucide-react';
import {
  buildSettingsSnapshot,
  formReducer,
  msToSec,
  secToMs,
  EMPTY_FORM,
  SETTINGS_TAB_KEY,
  SETTINGS_TABS,
  describeSettingsIssue,
  type SystemSettingsResponse,
  type FormSnapshot,
  type FormAction,
} from './system-settings-shared';
import { DEFAULT_SMTP_PORT } from '@/lib/system-settings';
import { GeneralTab } from './GeneralTab';
import { EmailTab } from './EmailTab';
import { SignInTab } from './SignInTab';
import { LtiTab } from './LtiTab';
import { EvaluatorTab } from './EvaluatorTab';
import { BackupsTab } from './BackupsTab';
import { CaptchaTab } from './CaptchaTab';
import { TlsTab } from './TlsTab';
import { UpdatesTab } from './UpdatesTab';
import { PAGE_HEADER_ICON_CLASS } from '@/lib/page-header';
import { queryKeys } from '@/lib/query-keys';

export default function SystemSettingsClient() {
  const queryClient = useQueryClient();

  // Cached system-settings read. The response seeds the editable form once; the
  // form's own local state is the source of truth after that, so navigating back
  // to this page shows the cached values instantly instead of reloading.
  const {
    data: settingsData,
    isLoading: settingsLoading,
    isError: settingsError,
  } = useQuery({
    queryKey: queryKeys.admin.settings(),
    queryFn: async () => {
      const res = await fetch(apiPaths.admin.settings(), { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load system settings');
      return (await res.json()) as SystemSettingsResponse;
    },
    staleTime: 30_000,
  });

  // Seed the form synchronously from whatever the cache holds on the first render.
  // On a warm remount `settingsData` is already present, so the fields initialize
  // populated (and enabled) with no flash; a cold load leaves this null and the
  // effect below seeds once the fetch resolves.
  const [initialSeed] = useState<FormSnapshot | null>(() =>
    settingsData ? buildSettingsSnapshot(settingsData) : null,
  );

  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState('general');
  // The ~19 Save-covered fields live in one reducer-managed object. `setField` is the
  // typed single-field updater the field JSX calls; a whole-object `reset` seeds/restores
  // the form (on load, Cancel, and after save).
  const [form, dispatchForm] = useReducer(formReducer, initialSeed ?? EMPTY_FORM);
  const setField = useCallback(<K extends keyof FormSnapshot>(field: K, value: FormSnapshot[K]) => {
    dispatchForm({ type: 'set', field, value } as FormAction);
  }, []);

  const {
    timezone,
    maxUploadSizeMb,
    allowSignup,
    signupAllowedDomains,
    clock24Hour,
    sessionTimeoutMinutes,
    evalTimeoutSec,
    resubmitCooldownSec,
    evalMaxMemoryMb,
    maxConcurrent,
    maxAttempts,
    analyzerLimit,
    loginMaxAttempts,
    loginLockoutMinutes,
    backupEnabled,
    backupHour,
    backupRetentionDays,
    activityLogRetentionDays,
    hcaptchaSiteKey,
    smtpEnabled,
    smtpHost,
    smtpPort,
    smtpSecurity,
    smtpUsername,
    smtpFromAddress,
    smtpFromName,
    oidcEnabled,
    oidcIssuer,
    oidcClientId,
    oidcButtonLabel,
    oidcTrustEmail,
    allowLinkedAccountPasswords,
  } = form;

  // hCaptcha secret is write-only (we only know whether one is set), so it stays local
  // here (the site key is part of the form object). These feed Save, the dirty-check,
  // and the enabled state, so they live in the parent and pass down to the Captcha tab.
  const [hcaptchaSecretKey, setHcaptchaSecretKey] = useState('');
  const [hcaptchaSecretConfigured, setHcaptchaSecretConfigured] = useState(() =>
    Boolean(settingsData?.hcaptchaSecretConfigured),
  );
  const [hcaptchaSecretClear, setHcaptchaSecretClear] = useState(false);

  // The mail password is write-only for the same reason as the hCaptcha secret: the server
  // only ever tells us whether one is stored.
  const [smtpPassword, setSmtpPassword] = useState('');
  const [smtpPasswordConfigured, setSmtpPasswordConfigured] = useState(() =>
    Boolean(settingsData?.smtpPasswordConfigured),
  );
  const [smtpPasswordClear, setSmtpPasswordClear] = useState(false);
  // Whether this deployment can read the stored mail password, which separates "Enabled" from
  // "Enabled, but unavailable" on the Email tab.
  const [smtpPasswordReadable, setSmtpPasswordReadable] = useState(() =>
    Boolean(settingsData?.smtpPasswordReadable),
  );

  // The OIDC client secret is write-only for the same reason as the two above.
  const [oidcClientSecret, setOidcClientSecret] = useState('');
  const [oidcClientSecretConfigured, setOidcClientSecretConfigured] = useState(() =>
    Boolean(settingsData?.oidcClientSecretConfigured),
  );
  // Whether this deployment can actually read the stored secret, which decides between
  // "Enabled" and "Enabled, but unavailable" on the tab.
  const [oidcClientSecretReadable, setOidcClientSecretReadable] = useState(() =>
    Boolean(settingsData?.oidcClientSecretReadable),
  );
  const [oidcClientSecretClear, setOidcClientSecretClear] = useState(false);

  // Baseline of saved values, for unsaved-changes detection. Seeded synchronously
  // on a warm cache so `loading` (below) is false immediately: no disabled flash.
  const [baseline, setBaseline] = useState<FormSnapshot | null>(initialSeed);

  // Seed the editable form from the cached settings response, once. Guarded on
  // `baseline` so a later background refetch can't clobber in-progress edits.
  useEffect(() => {
    if (!settingsData || baseline) return;
    const norm = buildSettingsSnapshot(settingsData);

    dispatchForm({ type: 'reset', snapshot: norm });
    setHcaptchaSecretConfigured(Boolean(settingsData.hcaptchaSecretConfigured));
    setHcaptchaSecretKey('');
    setHcaptchaSecretClear(false);
    setSmtpPasswordConfigured(Boolean(settingsData.smtpPasswordConfigured));
    setSmtpPasswordReadable(Boolean(settingsData.smtpPasswordReadable));
    setSmtpPassword('');
    setSmtpPasswordClear(false);
    setOidcClientSecretConfigured(Boolean(settingsData.oidcClientSecretConfigured));
    setOidcClientSecretReadable(Boolean(settingsData.oidcClientSecretReadable));
    setOidcClientSecret('');
    setOidcClientSecretClear(false);
    setBaseline(norm);
  }, [settingsData, baseline]);

  // Surface a load failure the same way the imperative fetch did.
  useEffect(() => {
    if (settingsError)
      showToast.error('Could not load system settings. Refresh the page to try again.');
  }, [settingsError]);

  // Restore the last-viewed tab on load, and remember it on change.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(SETTINGS_TAB_KEY);
      if (saved && SETTINGS_TABS.includes(saved)) setTab(saved);
    } catch {
      // ignore storage errors
    }
  }, []);

  const handleTabChange = (value: string) => {
    setTab(value);
    try {
      localStorage.setItem(SETTINGS_TAB_KEY, value);
    } catch {
      // ignore storage errors
    }
  };

  const timezoneOptions = useMemo(
    () =>
      COMMON_TIMEZONES.map((tz) => ({
        value: tz,
        label: formatTimezoneLabel(tz),
      })),
    [],
  );

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!timezone || !COMMON_TIMEZONES.includes(timezone as (typeof COMMON_TIMEZONES)[number])) {
      showToast.error('Please select a valid timezone.');
      return;
    }

    const clampedSize = Math.max(1, Math.min(50, Math.trunc(Number(maxUploadSizeMb) || 0)));
    const clampedTimeout = clampSessionTimeoutMinutes(Number(sessionTimeoutMinutes));
    // The field can be emptied while typing; fall back rather than sending NaN.
    const smtpPortValue = Number(smtpPort) || DEFAULT_SMTP_PORT;
    const evalTimeoutMs = clampSubmissionEvalTimeoutMs(secToMs(Number(evalTimeoutSec)));
    const resubmitCooldownMs = clampSubmissionResubmitCooldownMs(
      secToMs(Number(resubmitCooldownSec)),
    );
    const memoryMb = clampSubmissionEvalMaxMemoryMb(Number(evalMaxMemoryMb));
    const concurrent = clampSubmissionMaxConcurrent(Number(maxConcurrent));
    const attempts = clampSubmissionMaxAttempts(Number(maxAttempts));
    const analyzer = clampSubmissionAnalyzerLimit(Number(analyzerLimit));
    const loginAttempts = clampLoginMaxAttempts(Number(loginMaxAttempts));
    const lockoutMinutes = clampLoginLockoutMinutes(Number(loginLockoutMinutes));
    const bkpHour = clampBackupHour(Number(backupHour));
    const bkpRetention = clampBackupRetentionDays(Number(backupRetentionDays));
    const logRetention = clampActivityLogRetentionDays(Number(activityLogRetentionDays));
    // Canonicalize the domain allow-list (dedupe/lowercase) so what we display and
    // cache after saving matches exactly what the server stores.
    const canonicalDomains = parseDomainList(signupAllowedDomains).domains.join(',');

    // Validate + normalize the whole payload through the shared schema (the same
    // one the route validates with) before sending. Surfaces any field error
    // (e.g. an invalid timezone) as a toast and makes the schema the single
    // authority for the request shape.
    const parsedSettings = SystemSettingsUpdateSchema.safeParse({
      timezone,
      maxUploadSizeMb: clampedSize,
      allowSignup,
      signupAllowedDomains: canonicalDomains,
      clock24Hour,
      sessionTimeoutMinutes: clampedTimeout,
      submissionEvalTimeoutMs: evalTimeoutMs,
      submissionResubmitCooldownMs: resubmitCooldownMs,
      submissionEvalMaxMemoryMb: memoryMb,
      submissionMaxConcurrent: concurrent,
      submissionMaxAttempts: attempts,
      submissionAnalyzerLimit: analyzer,
      loginMaxAttempts: loginAttempts,
      loginLockoutMinutes: lockoutMinutes,
      backupEnabled,
      backupHour: bkpHour,
      backupRetentionDays: bkpRetention,
      activityLogRetentionDays: logRetention,
      hcaptchaSiteKey: hcaptchaSiteKey.trim(),
      ...(hcaptchaSecretClear
        ? { hcaptchaSecretClear: true }
        : hcaptchaSecretKey.trim()
          ? { hcaptchaSecretKey: hcaptchaSecretKey.trim() }
          : {}),
      smtpEnabled,
      smtpHost: smtpHost.trim(),
      smtpPort: smtpPortValue,
      smtpSecurity,
      smtpUsername: smtpUsername.trim(),
      smtpFromAddress: smtpFromAddress.trim(),
      smtpFromName: smtpFromName.trim(),
      // Same write-only rule as the hCaptcha secret: send nothing to keep what is stored.
      ...(smtpPasswordClear
        ? { smtpPasswordClear: true }
        : // Sent exactly as typed. A mail password is opaque and its edges may be part of it;
          // trimming here quietly undid the server's care to store it verbatim.
          smtpPassword !== ''
          ? { smtpPassword }
          : {}),
      oidcEnabled,
      oidcIssuer: oidcIssuer.trim(),
      oidcClientId: oidcClientId.trim(),
      oidcButtonLabel: oidcButtonLabel.trim(),
      oidcTrustEmail,
      allowLinkedAccountPasswords,
      ...(oidcClientSecretClear
        ? { oidcClientSecretClear: true }
        : // Sent exactly as typed: the secret is opaque, and its edges may be significant.
          oidcClientSecret !== ''
          ? { oidcClientSecret }
          : {}),
    });
    if (!parsedSettings.success) {
      const issue = parsedSettings.error.issues[0];
      showToast.error(
        issue ? describeSettingsIssue(issue) : 'Please review the settings and try again.',
      );
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(apiPaths.admin.settings(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsedSettings.data),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || 'Failed to save settings');
      }
      const savedSiteKey = hcaptchaSiteKey.trim();
      // Fold the saved (clamped/canonicalized) values back into the form and make them
      // the new baseline in one shot, so what's shown and the dirty-check both match
      // exactly what the server stored.
      const savedSnapshot: FormSnapshot = {
        timezone,
        maxUploadSizeMb: clampedSize,
        allowSignup,
        signupAllowedDomains: canonicalDomains,
        clock24Hour,
        sessionTimeoutMinutes: clampedTimeout,
        evalTimeoutSec: msToSec(evalTimeoutMs),
        resubmitCooldownSec: msToSec(resubmitCooldownMs),
        evalMaxMemoryMb: memoryMb,
        maxConcurrent: concurrent,
        maxAttempts: attempts,
        analyzerLimit: analyzer,
        loginMaxAttempts: loginAttempts,
        loginLockoutMinutes: lockoutMinutes,
        backupEnabled,
        backupHour: bkpHour,
        backupRetentionDays: bkpRetention,
        activityLogRetentionDays: logRetention,
        hcaptchaSiteKey: savedSiteKey,
        smtpEnabled,
        smtpHost: smtpHost.trim(),
        smtpPort,
        smtpSecurity,
        smtpUsername: smtpUsername.trim(),
        smtpFromAddress: smtpFromAddress.trim(),
        smtpFromName: smtpFromName.trim(),
        oidcEnabled,
        oidcIssuer: oidcIssuer.trim(),
        oidcClientId: oidcClientId.trim(),
        oidcButtonLabel: oidcButtonLabel.trim(),
        oidcTrustEmail,
        allowLinkedAccountPasswords,
      };
      dispatchForm({ type: 'reset', snapshot: savedSnapshot });
      setBaseline(savedSnapshot);
      setHcaptchaSecretConfigured(
        hcaptchaSecretClear ? false : hcaptchaSecretKey.trim() ? true : hcaptchaSecretConfigured,
      );
      /**
       * What the save left stored, worked out before the typed values are cleared below.
       *
       * Readable matters as much as configured. A secret this deployment could not decrypt
       * shows as "Enabled, but unavailable"; replacing it fixes that, because whatever was
       * just saved was encrypted with the key this deployment holds. Updating only
       * `configured` left the old `readable: false` in place, so the moment the typed value
       * was cleared the screen went back to calling a working secret unreadable, and the only
       * way to see the truth was to reload the page.
       */
      const oidcSecretNowStored = oidcClientSecretClear
        ? false
        : oidcClientSecret !== '' || oidcClientSecretConfigured;
      setOidcClientSecretConfigured(oidcSecretNowStored);
      setOidcClientSecretReadable(
        oidcClientSecretClear ? false : oidcClientSecret !== '' ? true : oidcClientSecretReadable,
      );

      const smtpPasswordNowStored = smtpPasswordClear
        ? false
        : smtpPassword !== '' || smtpPasswordConfigured;
      setSmtpPasswordConfigured(smtpPasswordNowStored);
      setSmtpPasswordReadable(
        smtpPasswordClear ? false : smtpPassword !== '' ? true : smtpPasswordReadable,
      );
      setOidcClientSecret('');
      setOidcClientSecretClear(false);
      setHcaptchaSecretKey('');
      setHcaptchaSecretClear(false);
      // The plaintext has been saved; keeping it in the page serves nothing and outlives its
      // purpose in memory and in the field.
      setSmtpPassword('');
      setSmtpPasswordClear(false);
      // Keep the read cache consistent with what we just saved so a later revisit
      // (served from cache) reflects the new values, not the pre-save response.
      queryClient.setQueryData<SystemSettingsResponse>(['admin', 'settings'], (prev) =>
        prev
          ? {
              ...prev,
              timezone,
              maxUploadSizeMb: clampedSize,
              allowSignup,
              signupAllowedDomains: canonicalDomains,
              clock24Hour,
              sessionTimeoutMinutes: clampedTimeout,
              submissionEvalTimeoutMs: evalTimeoutMs,
              submissionResubmitCooldownMs: resubmitCooldownMs,
              submissionEvalMaxMemoryMb: memoryMb,
              submissionMaxConcurrent: concurrent,
              submissionMaxAttempts: attempts,
              submissionAnalyzerLimit: analyzer,
              loginMaxAttempts: loginAttempts,
              loginLockoutMinutes: lockoutMinutes,
              backupEnabled,
              backupHour: bkpHour,
              backupRetentionDays: bkpRetention,
              activityLogRetentionDays: logRetention,
              hcaptchaSiteKey: savedSiteKey,
              smtpEnabled,
              smtpHost: smtpHost.trim(),
              smtpPort: smtpPortValue,
              smtpSecurity,
              smtpUsername: smtpUsername.trim(),
              smtpFromAddress: smtpFromAddress.trim(),
              smtpFromName: smtpFromName.trim(),
              oidcEnabled,
              oidcIssuer: oidcIssuer.trim(),
              oidcClientId: oidcClientId.trim(),
              oidcButtonLabel: oidcButtonLabel.trim(),
              oidcTrustEmail,
              allowLinkedAccountPasswords,
              // The same answers the component state took above, so a revisit served from
              // cache says what the screen says rather than the pre-save response.
              oidcClientSecretConfigured: oidcSecretNowStored,
              oidcClientSecretReadable: oidcClientSecretClear
                ? false
                : oidcClientSecret !== '' || oidcClientSecretReadable,
              // A password that was just set is now stored; a cleared one is not.
              smtpPasswordConfigured: smtpPasswordNowStored,
              smtpPasswordReadable: smtpPasswordClear
                ? false
                : smtpPassword !== '' || smtpPasswordReadable,
              hcaptchaSecretConfigured: hcaptchaSecretClear
                ? false
                : hcaptchaSecretKey.trim()
                  ? true
                  : prev.hcaptchaSecretConfigured,
            }
          : prev,
      );
      showToast.updated('System settings');
    } catch (err) {
      showToast.error(err instanceof Error ? err.message : 'Failed to save settings.');
    } finally {
      setSaving(false);
    }
  };

  const resetForm = () => {
    if (!baseline) return;
    dispatchForm({ type: 'reset', snapshot: baseline });
    // Every unsaved secret, not only hCaptcha's: Reset means the form as it was saved, and a
    // typed password left behind would be saved by the next click of Save.
    setHcaptchaSecretKey('');
    setHcaptchaSecretClear(false);
    setSmtpPassword('');
    setSmtpPasswordClear(false);
    setOidcClientSecret('');
    setOidcClientSecretClear(false);
  };

  // "Loading" until the cached response has seeded the form, so fields never
  // flash empty on a cache-warm revisit (isLoading is already false then).
  const loading = settingsLoading || (!!settingsData && !baseline);
  const disabled = loading || saving;

  // `form` is the current snapshot; compare it to the saved baseline for the dirty state.
  /**
   * Changed, including the secrets the form object cannot hold.
   *
   * Write-only secrets live outside `form` because the browser is never sent the stored value,
   * so comparing snapshots cannot see them. Only hCaptcha was counted, which meant typing a
   * mail password or a client secret and nothing else left the page looking saved: no unsaved
   * marker, no Reset, and on the Email tab no warning that "Send test message" uses the
   * settings that are stored rather than the ones on screen.
   *
   * The typed value is what counts, never the stored one, which is not here to compare.
   */
  const isDirty =
    !!baseline &&
    (JSON.stringify(form) !== JSON.stringify(baseline) ||
      hcaptchaSecretKey.trim() !== '' ||
      hcaptchaSecretClear ||
      smtpPassword !== '' ||
      smtpPasswordClear ||
      oidcClientSecret !== '' ||
      oidcClientSecretClear);

  const hcaptchaEnabled =
    hcaptchaSiteKey.trim() !== '' ||
    hcaptchaSecretKey.trim() !== '' ||
    (hcaptchaSecretConfigured && !hcaptchaSecretClear);

  // Single source of truth for the tab strip and its mobile select fallback, so the
  // two never drift apart.
  const settingsTabs = [
    { value: 'general', label: 'General', Icon: SlidersHorizontal },
    { value: 'queue', label: 'Evaluator', Icon: Cpu },
    { value: 'backups', label: 'Backups', Icon: DatabaseBackup },
    { value: 'email', label: 'Email', Icon: Mail },
    { value: 'sign-in', label: 'Sign-in', Icon: LogIn },
    { value: 'lti', label: 'LTI', Icon: Link2 },
    { value: 'captcha', label: 'Captcha', Icon: ShieldCheck },
    { value: 'tls', label: 'TLS Certificate', Icon: Lock },
    { value: 'updates', label: 'Updates', Icon: RefreshCw },
  ] as const;

  // The TLS and Updates tabs have no fields covered by the shared Save; they drive
  // their own actions (issue a certificate, run an upgrade). Hiding the Save/Reset row
  // there keeps it from looking like those tabs have unsaved settings. Every other tab,
  // Backups included (its schedule is part of the form), needs it.
  const showSave = tab !== 'tls' && tab !== 'updates';

  // xl rather than lg: a rail plus a settings form needs more room than a table does.
  const railNav = useIsDesktopNav(1280);

  return (
    // Spacing stated per element rather than through `space-y`, because the first child is
    // the sr-only status line: it is out of flow, so a wrapper gap would put nothing above
    // the title. The 24px above comes from <main>'s py-6; this supplies the matching 24
    // below, so the title sits in equal air.
    <div>
      <p className="sr-only" aria-live="polite">
        {loading ? 'Loading system settings' : saving ? 'Saving system settings' : ''}
      </p>

      <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight">
        {/* Decorative: the heading beside it already says what this is. The icon the
            sidebar already uses for this page, on the neutral muted surface the other
            admin pages use. */}
        <Settings className={PAGE_HEADER_ICON_CLASS} aria-hidden="true" />
        <span>System Settings</span>
      </h1>

      {/* With the intro sentence gone, the title sat almost on top of the Settings Menu.
          This is the other half of the pair above: 24px, matching the gap over the title.

          Nine sections is too many for a strip, so above xl they become a rail beside the
          form. Below that the strip and its select stay exactly as they were. One control
          at a time: rendering both would put two tablists under one Tabs root. */}
      <Tabs
        value={tab}
        onValueChange={handleTabChange}
        orientation={railNav ? 'vertical' : 'horizontal'}
        className="mt-6 w-full gap-6"
      >
        {/* The WORKSPACE is wide; the content inside it is not. Pinning the whole page to
            max-w-3xl left a 1920px monitor two thirds empty and still wrapped help text
            into slivers, so each section picks its own measure instead (see
            settings-layout). */}
        <LocalNavLayout
          contentClassName={SETTINGS_WORKSPACE}
          nav={
            railNav ? (
              <TabRail
                tabs={settingsTabs}
                ariaLabel="System settings sections"
                menuLabel="Settings Menu"
              />
            ) : (
              <TabBar
                ariaLabel="System settings sections"
                selectId="system-settings-tab-select"
                value={tab}
                onValueChange={handleTabChange}
                tabs={settingsTabs}
              />
            )
          }
        >
          <TabsContent value="general">
            <GeneralTab
              form={form}
              setField={setField}
              disabled={disabled}
              loading={loading}
              configuredUrl={settingsData?.configuredUrl}
              timezoneOptions={timezoneOptions}
            />
          </TabsContent>

          <TabsContent value="queue">
            <EvaluatorTab form={form} setField={setField} disabled={disabled} />
          </TabsContent>

          <TabsContent value="backups">
            <BackupsTab form={form} setField={setField} disabled={disabled} />
          </TabsContent>

          <TabsContent value="email">
            <EmailTab
              enabled={smtpEnabled}
              host={smtpHost}
              port={typeof smtpPort === 'number' ? smtpPort : DEFAULT_SMTP_PORT}
              security={smtpSecurity}
              username={smtpUsername}
              fromAddress={smtpFromAddress}
              fromName={smtpFromName}
              setField={setField}
              disabled={disabled}
              password={smtpPassword}
              // A password typed just now is readable by definition; otherwise ask the server.
              passwordReadable={smtpPassword !== '' || smtpPasswordReadable}
              setPassword={setSmtpPassword}
              passwordConfigured={smtpPasswordConfigured}
              passwordClear={smtpPasswordClear}
              setPasswordClear={setSmtpPasswordClear}
              savedHost={settingsData?.smtpHost}
              dirty={isDirty}
            />
          </TabsContent>

          <TabsContent value="sign-in">
            <SignInTab
              enabled={oidcEnabled}
              issuer={oidcIssuer}
              clientId={oidcClientId}
              buttonLabel={oidcButtonLabel}
              trustEmail={oidcTrustEmail}
              allowLinkedAccountPasswords={allowLinkedAccountPasswords}
              setField={setField}
              disabled={disabled}
              clientSecret={oidcClientSecret}
              setClientSecret={setOidcClientSecret}
              clientSecretConfigured={oidcClientSecretConfigured}
              // A secret typed just now is readable by definition; otherwise ask the server.
              clientSecretReadable={oidcClientSecret !== '' || oidcClientSecretReadable}
              clientSecretClear={oidcClientSecretClear}
              setClientSecretClear={setOidcClientSecretClear}
              // Derived from the site URL the installer set, so an admin can hand it to IT
              // without guessing at the path.
              redirectUri={`${(settingsData?.configuredUrl ?? '').replace(/\/+$/, '')}/api/auth/callback/oidc`}
            />
          </TabsContent>

          <TabsContent value="lti">
            {/* Same source as the OIDC redirect URL: the site URL the installer set. */}
            <LtiTab siteUrl={settingsData?.configuredUrl ?? ''} />
          </TabsContent>

          <TabsContent value="captcha">
            <CaptchaTab
              siteKey={hcaptchaSiteKey}
              setField={setField}
              disabled={disabled}
              secretKey={hcaptchaSecretKey}
              setSecretKey={setHcaptchaSecretKey}
              secretConfigured={hcaptchaSecretConfigured}
              secretClear={hcaptchaSecretClear}
              setSecretClear={setHcaptchaSecretClear}
              hcaptchaEnabled={hcaptchaEnabled}
              savedSiteKey={settingsData?.hcaptchaSiteKey}
            />
          </TabsContent>

          <TabsContent value="tls">
            <TlsTab configuredUrl={settingsData?.configuredUrl} />
          </TabsContent>

          <TabsContent value="updates">
            <UpdatesTab disabled={disabled} />
          </TabsContent>

          {/* Save action, under the section it saves. Hidden on tabs with no savable
                fields (TLS, Updates), which run their own actions instead. */}
          {showSave && (
            <div
              /*
               * Right-aligned, and exactly as wide as the form it saves, so Save sits under
               * the form's right edge rather than out on the left margin where it read as a
               * page-level control that happened to be nearby.
               *
               * That width is the grid's first column, which no max-width can name: it
               * depends on the rail and the gap. So the footer borrows the SAME grid template
               * every tab's form now uses and takes column one, and the two agree by
               * construction rather than by two numbers kept in step by hand. On Backups that
               * also keeps Save under the schedule it saves, rather than out at the right
               * edge of the backup table, which is a wider section it does not touch.
               */
              className={`${SETTINGS_WORKSPACE} ${SETTINGS_ASIDE_GRID} mt-5`}
            >
              <div
                // Status first, then the escape hatch, then the primary action last: the order
                // a footer is read in. flex-wrap so the three do not fight for room at 390px.
                className="flex flex-wrap items-center justify-end gap-3 border-t pt-4 min-[1400px]:col-start-1"
              >
                {isDirty && (
                  <span className="text-muted-foreground mr-auto text-sm">Unsaved changes</span>
                )}
                {isDirty && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={resetForm}
                    disabled={saving}
                  >
                    Reset
                  </Button>
                )}
                <Button
                  type="submit"
                  form="system-settings-form"
                  size="sm"
                  aria-label="Save system settings"
                  disabled={disabled}
                >
                  {saving ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            </div>
          )}
        </LocalNavLayout>
      </Tabs>

      {/* The settings inputs live outside a <form> element, so this empty form
          gives the sticky Save button something to submit via form=. */}
      <form id="system-settings-form" onSubmit={onSubmit} className="hidden" aria-hidden="true" />
    </div>
  );
}
