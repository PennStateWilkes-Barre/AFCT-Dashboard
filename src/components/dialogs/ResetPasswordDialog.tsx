'use client';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import InputGroup from '@/components/ui/InputGroup';
import SwitchField from '@/components/ui/SwitchField';
import { useState, useEffect } from 'react';
import { showToast } from '@/lib/toast';
import { PasswordRulesHelper } from '@/components/auth/PasswordRulesHelper';
import { isStrongPassword, passwordRules } from '@/lib/password-policy';
import { ResetPasswordSchema } from '@/schemas/password';

type Props = {
  open: boolean;
  setOpen: (open: boolean) => void;
  onResetPassword: (newPassword: string, isTemporary: boolean) => Promise<void>;
  targetUserName?: string;
  /**
   * Whether this account has an AFCT password at all.
   *
   * There is nothing to *reset* on an account created by an institutional sign-in or an LMS
   * launch, so the dialog says it is setting a first one instead. Defaults true, which is what
   * every caller meant before this existed.
   */
  hasPassword?: boolean;
};

export function ResetPasswordDialog({
  open,
  setOpen,
  onResetPassword,
  targetUserName,
  hasPassword = true,
}: Props) {
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isTemporary, setIsTemporary] = useState(false);
  const passwordHelperId = 'admin-reset-password-helper';
  const passwordRuleStatuses = passwordRules.map((rule) => ({
    label: rule.short,
    passed: rule.test(newPassword),
  }));

  useEffect(() => {
    if (!open) {
      setNewPassword('');
      setConfirmNewPassword('');
      setLoading(false);
      setShowNew(false);
      setShowConfirm(false);
      setIsTemporary(false);
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const parsed = ResetPasswordSchema.safeParse({ newPassword, confirmNewPassword });
    if (!parsed.success) {
      showToast.error(parsed.error.issues[0]?.message ?? 'Please review the password fields.');
      return;
    }

    setLoading(true);
    try {
      await onResetPassword(parsed.data.newPassword, isTemporary);
      showToast.success(hasPassword ? 'Password reset' : 'Password set');
      setOpen(false);
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error
          ? err.message
          : hasPassword
            ? 'Failed to reset password'
            : 'Failed to set the password';
      showToast.error(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{hasPassword ? 'Reset Password' : 'Set a Password'}</DialogTitle>
          <DialogDescription>
            {hasPassword
              ? targetUserName
                ? `Set a new password for ${targetUserName}. This signs them out of AFCT everywhere, including the desktop client.`
                : 'Set a new password for this user. This signs them out of AFCT everywhere, including the desktop client.'
              : targetUserName
                ? `${targetUserName} signs in through an institution or an LMS and has no AFCT password. This gives them one; they can carry on signing in as they do now.`
                : 'This user signs in through an institution or an LMS and has no AFCT password. This gives them one; they can carry on signing in as they do now.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* autoComplete off, deliberately: an administrator is setting *another*
              user's password here, so the browser must not offer the admin's own saved
              credentials, and must not save this one against the admin's account. That
              differs from the login and change-password forms, where the person typing
              is authenticating and a password manager should help. */}
          <InputGroup
            name="newPassword"
            label="New Password"
            autoComplete="off"
            value={newPassword}
            setValue={setNewPassword}
            type={showNew ? 'text' : 'password'}
            showEye
            isPasswordVisible={showNew}
            togglePasswordVisibility={() => setShowNew((v) => !v)}
            showStatus
            isValid={isStrongPassword(newPassword)}
            additionalDescribedBy={passwordHelperId}
          />
          <InputGroup
            name="confirmNewPassword"
            label="Confirm New Password"
            autoComplete="off"
            value={confirmNewPassword}
            setValue={setConfirmNewPassword}
            type={showConfirm ? 'text' : 'password'}
            showEye
            isPasswordVisible={showConfirm}
            togglePasswordVisibility={() => setShowConfirm((v) => !v)}
            showStatus
            isValid={confirmNewPassword.length > 0 && confirmNewPassword === newPassword}
          />
          <PasswordRulesHelper id={passwordHelperId} rules={passwordRuleStatuses} />
          <SwitchField
            label="Temporary password"
            name="temporaryPassword"
            checked={isTemporary}
            onCheckedChange={setIsTemporary}
            description="Require the user to change this password at their next login."
            descriptionPlacement="inline"
          />
          <DialogFooter className="mt-2">
            <Button
              variant="secondary"
              type="button"
              onClick={() => setOpen(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? 'Saving...' : 'Reset Password'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
