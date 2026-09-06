'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/components/ui/button';
import InputGroup from '@/components/ui/InputGroup';
import { showToast } from '@/lib/toast';
import { ChangePasswordSchema, type ChangePasswordInput } from '@/schemas/password';
import { AuthPageBackground } from '@/components/auth/AuthPageBackground';
import { PasswordRulesHelper } from '@/components/auth/PasswordRulesHelper';
import { passwordRules } from '@/lib/password-policy';
import { safeSignOut } from '@/lib/safe-signout';
import { apiPaths } from '@/lib/api-paths';

export function ForcedPasswordChangeForm() {
  const router = useRouter();
  const { update } = useSession();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    control,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ChangePasswordInput>({
    resolver: zodResolver(ChangePasswordSchema),
    defaultValues: { oldPassword: '', newPassword: '', confirmNewPassword: '' },
    mode: 'onBlur',
    reValidateMode: 'onChange',
  });

  const newPassword = watch('newPassword');
  const confirmPassword = watch('confirmNewPassword');
  const helperId = 'forced-password-helper';
  const passwordRuleStatuses = passwordRules.map((rule) => ({
    label: rule.short,
    passed: rule.test(newPassword),
  }));

  const onSubmit = async (values: ChangePasswordInput) => {
    setSubmitError(null);
    const res = await fetch(apiPaths.myPassword(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword: values.oldPassword, newPassword: values.newPassword }),
    });

    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      const errorMessage = body.error || 'Failed to change password.';
      setSubmitError(errorMessage);
      showToast.error(errorMessage);
      return;
    }

    showToast.success('Password changed');
    // Re-sync the JWT to the just-changed credentials before navigating. Without this the
    // token still snapshots the old password instant, so the session callback revokes it
    // and bounces the user right back to this screen. Then send them to the dashboard.
    await update({ refreshCredentials: true });
    router.push('/dashboard');
    router.refresh();
  };

  return (
    <div className="auth-light relative flex min-h-dvh w-full items-start justify-center overflow-x-hidden pt-24 md:pt-[14vh]">
      {/* The shared signed-out ground, rather than the teal gradient this screen used to draw
          for itself. It was the last copy of a palette the product no longer uses. */}
      <AuthPageBackground />

      <main className="relative z-10 mx-4 w-full max-w-[430px]">
        <div className="bg-card rounded-2xl border p-8 shadow-lg">
          <div className="mb-6 text-center">
            <h1 className="text-2xl font-semibold tracking-tight">Change Temporary Password</h1>
            <p className="text-muted-foreground mt-2 text-sm leading-6">
              Your account is using a temporary password. You must choose a new password before
              continuing to the dashboard.
            </p>
          </div>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <Controller
              name="oldPassword"
              control={control}
              render={({ field }) => (
                <InputGroup
                  label="Temporary Password"
                  name="oldPassword"
                  type="password"
                  showEye
                  autoComplete="current-password"
                  fieldProps={field}
                  error={errors.oldPassword?.message}
                />
              )}
            />

            <Controller
              name="newPassword"
              control={control}
              render={({ field }) => (
                <InputGroup
                  label="New Password"
                  name="newPassword"
                  type="password"
                  showEye
                  showStatus
                  autoComplete="new-password"
                  isValid={!errors.newPassword && !!newPassword}
                  fieldProps={field}
                  error={errors.newPassword?.message}
                  additionalDescribedBy={helperId}
                />
              )}
            />

            <Controller
              name="confirmNewPassword"
              control={control}
              render={({ field }) => (
                <InputGroup
                  label="Confirm New Password"
                  name="confirmNewPassword"
                  type="password"
                  showEye
                  showStatus
                  autoComplete="new-password"
                  isValid={
                    !errors.confirmNewPassword &&
                    !!confirmPassword &&
                    confirmPassword === newPassword
                  }
                  fieldProps={field}
                  error={errors.confirmNewPassword?.message}
                />
              )}
            />

            <PasswordRulesHelper id={helperId} rules={passwordRuleStatuses} />

            {submitError ? (
              <p role="alert" className="text-destructive text-sm">
                {submitError}
              </p>
            ) : null}

            <div className="flex gap-3">
              <Button type="submit" className="flex-1" disabled={isSubmitting}>
                {isSubmitting ? 'Saving...' : 'Change Password'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={isSubmitting}
                onClick={() => void safeSignOut({ callbackUrl: '/login' })}
              >
                Sign Out
              </Button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}
