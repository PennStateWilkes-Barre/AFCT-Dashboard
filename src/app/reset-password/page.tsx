'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AuthPageBackground } from '@/components/auth/AuthPageBackground';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import InputGroup from '@/components/ui/InputGroup';
import { PasswordRulesHelper } from '@/components/auth/PasswordRulesHelper';
import { isStrongPassword, passwordRules } from '@/lib/password-policy';
import { CompletePasswordResetSchema } from '@/schemas/password';

const HELPER_ID = 'reset-password-rules';

function ResetPasswordForm() {
  const token = useSearchParams().get('token') ?? '';
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [state, setState] = useState<'idle' | 'saving' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = CompletePasswordResetSchema.safeParse({
      token,
      newPassword,
      confirmNewPassword,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Please review the form and try again.');
      return;
    }

    setError(null);
    setState('saving');
    try {
      const res = await fetch('/api/auth/password-reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });
      if (res.ok) {
        setState('done');
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? 'Could not reset the password. Try again.');
      setState('idle');
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
      setState('idle');
    }
  };

  // Arriving with no token at all means a mangled link, and there is nothing to submit.
  if (!token) {
    return (
      <CardContent className="space-y-4">
        <p className="text-sm">
          This reset link is incomplete. It may have been cut short by your email program. Ask for a
          new one and open it directly.
        </p>
        <Button asChild className="w-full">
          <Link href="/forgot-password">Request a new link</Link>
        </Button>
      </CardContent>
    );
  }

  if (state === 'done') {
    return (
      <CardContent className="space-y-4">
        <p role="status" className="text-sm">
          Your password has been changed. You have been signed out everywhere else, so sign in again
          with the new password.
        </p>
        <Button asChild className="w-full">
          <Link href="/login">Go to sign in</Link>
        </Button>
      </CardContent>
    );
  }

  return (
    <CardContent>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <InputGroup
          name="newPassword"
          label="New password"
          autoComplete="new-password"
          value={newPassword}
          setValue={setNewPassword}
          type={showNew ? 'text' : 'password'}
          showEye
          isPasswordVisible={showNew}
          togglePasswordVisibility={() => setShowNew((v) => !v)}
          showStatus
          isValid={isStrongPassword(newPassword)}
          additionalDescribedBy={HELPER_ID}
          disabled={state === 'saving'}
        />
        <InputGroup
          name="confirmNewPassword"
          label="Confirm new password"
          autoComplete="new-password"
          value={confirmNewPassword}
          setValue={setConfirmNewPassword}
          type={showConfirm ? 'text' : 'password'}
          showEye
          isPasswordVisible={showConfirm}
          togglePasswordVisibility={() => setShowConfirm((v) => !v)}
          showStatus
          isValid={confirmNewPassword.length > 0 && confirmNewPassword === newPassword}
          disabled={state === 'saving'}
        />
        <PasswordRulesHelper
          id={HELPER_ID}
          rules={passwordRules.map((rule) => ({
            label: rule.short,
            passed: rule.test(newPassword),
          }))}
        />
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        <Button type="submit" className="w-full" disabled={state === 'saving'}>
          {state === 'saving' ? 'Saving…' : 'Set new password'}
        </Button>
      </form>
    </CardContent>
  );
}

/**
 * Choosing a new password after following a reset link.
 *
 * The token lives in the query string, so this reads it through `useSearchParams` and therefore
 * needs a Suspense boundary.
 */
export default function ResetPasswordPage() {
  // `w-full` is load-bearing: the root layout puts `flex` on <body>, so a top-level
  // <main> is a flex item and shrinks to its content width without it, which leaves the
  // card pinned to the left however it is centred inside.
  return (
    <main className="auth-light relative flex min-h-dvh w-full items-center justify-center px-4 py-12">
      <AuthPageBackground />
      <Card className="relative z-10 w-full max-w-md">
        <CardHeader>
          <CardTitle aria-level={1}>Choose a new password</CardTitle>
        </CardHeader>
        <Suspense
          fallback={
            <CardContent>
              <p className="text-muted-foreground text-sm">Loading…</p>
            </CardContent>
          }
        >
          <ResetPasswordForm />
        </Suspense>
      </Card>
    </main>
  );
}
