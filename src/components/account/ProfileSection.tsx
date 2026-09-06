'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { showToast } from '@/lib/toast';

import InputGroup from '@/components/ui/InputGroup';
import SelectField from '@/components/ui/SelectField';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';

import type { SessionUser } from '@/types/next-auth';
import {
  UpdateProfileSchema,
  type UpdateProfileRaw,
  type UpdateProfileInput,
} from '@/schemas/profile';
import { SettingsSection, SETTINGS_COMPACT } from '@/components/settings/settings-layout';
import { COMMON_TIMEZONES, formatTimezoneLabel } from '@/lib/timezones';
import { apiPaths } from '@/lib/api-paths';
import { queryKeys } from '@/lib/query-keys';

// Sentinel for the "follow my device/system" choice. Radix Select forbids an
// empty-string item value, so we use a token and translate it to '' on submit;
// the server stores that as null, which makes the display-timezone resolver fall
// through to the system default, then the browser.
const AUTO_TIMEZONE = '__auto__';

type ProfileSectionProps = {
  user: SessionUser;
  onSave?: (updatedUser: Partial<SessionUser>) => Promise<void>;
};

/**
 * Your name and timezone, on the account page.
 *
 * The photo used to live here too, sharing this form's Save button. It has its own tab now,
 * and the route takes a partial update, so this form sends the three fields it owns and says
 * nothing about the avatar.
 */
export function ProfileSection({ user, onSave }: ProfileSectionProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  // Names are served from the session cache, so refresh it after a save rather than leaving
  // the sidebar showing the old one.
  const { update: updateSession } = useSession();
  // What "Automatic" would resolve to on this device, shown for reassurance.
  const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  // RHF defaults. Email is read-only, so it isn't in the schema.
  const defaults: UpdateProfileRaw = useMemo(
    () => ({
      firstName: user.firstName ?? '',
      lastName: user.lastName ?? '',
      timezone: user.timezone ?? '',
    }),
    [user],
  );

  const {
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isValid },
  } = useForm<UpdateProfileRaw, unknown, UpdateProfileInput>({
    resolver: zodResolver(UpdateProfileSchema),
    defaultValues: defaults,
    mode: 'onChange',
    reValidateMode: 'onChange',
  });

  // Seed once, on mount. The dialog this replaced seeded on an open/close transition for a
  // specific reason: the parent rebuilds the `user` object on every render, so re-seeding on
  // any re-render let a background refetch or session update clobber what was being typed. A
  // page has no open transition, so the equivalent guard is to seed exactly once.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    reset(defaults, { keepDirty: false, keepErrors: false, keepTouched: false, keepValues: false });
  }, [defaults, reset]);

  const resetForm = () =>
    reset(defaults, { keepDirty: false, keepTouched: false, keepErrors: false, keepValues: false });

  const onSubmit = async (values: UpdateProfileInput) => {
    const parsed: UpdateProfileInput = UpdateProfileSchema.parse(values);

    const formData = new FormData();
    formData.append('firstName', parsed.firstName);
    formData.append('lastName', parsed.lastName);
    // Always send it: a blank value tells the server to clear the override
    // (Automatic), so the display timezone follows the system/browser again.
    formData.append('timezone', parsed.timezone ?? '');

    try {
      const res = await fetch(apiPaths.me(), { method: 'POST', body: formData });
      if (!res.ok) throw new Error('Failed to update profile');

      // The saved values become the form's new baseline. Resetting to `defaults` instead
      // would put the old name back on screen, because the prop this page was given cannot
      // have caught up yet.
      reset(
        { firstName: parsed.firstName, lastName: parsed.lastName, timezone: parsed.timezone ?? '' },
        { keepDirty: false, keepTouched: false, keepErrors: false },
      );

      await updateSession();
      // The page reads the user from the session on the server, so ask for it again.
      router.refresh();

      // Kept for any parent that also wants the updated fields.
      await onSave?.({
        firstName: parsed.firstName,
        lastName: parsed.lastName,
        timezone: parsed.timezone || undefined,
      });

      // The display-timezone hook reads /api/me through this cached key; refetch
      // it so a changed (or cleared) timezone takes effect without a reload.
      await queryClient.invalidateQueries({ queryKey: queryKeys.profile() });

      showToast.updated('Profile');
    } catch {
      showToast.error('Could not save your profile. Check your connection and try again.');
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <SettingsSection title="Profile" className={SETTINGS_COMPACT}>
        {/* First + last name sit side by side to save vertical space, and stack
            on very small screens. */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Controller
            name="firstName"
            control={control}
            render={({ field }) => (
              <InputGroup
                label="First Name"
                name="firstName"
                fieldProps={field}
                error={errors.firstName?.message}
              />
            )}
          />

          <Controller
            name="lastName"
            control={control}
            render={({ field }) => (
              <InputGroup
                label="Last Name"
                name="lastName"
                fieldProps={field}
                error={errors.lastName?.message}
              />
            )}
          />
        </div>

        {/* Timezone */}
        <Controller
          name="timezone"
          control={control}
          render={({ field }) => (
            <SelectField
              label="Timezone"
              name="timezone"
              id="timezone"
              // Empty override renders as "Automatic". Radix needs a non-empty
              // item value, so map '' <-> AUTO_TIMEZONE across the boundary.
              value={field.value ? field.value : AUTO_TIMEZONE}
              onValueChange={(v) => field.onChange(v === AUTO_TIMEZONE ? '' : v)}
              placeholder="Select timezone"
              description={`Automatic follows this device's timezone (currently ${browserTimezone}).`}
              options={[
                { value: AUTO_TIMEZONE, label: 'Automatic (detect from browser)' },
                ...COMMON_TIMEZONES.map((tz) => ({
                  value: tz,
                  label: formatTimezoneLabel(tz),
                })),
              ]}
            />
          )}
        />

        {/* Email (read-only) */}
        <InputGroup
          label="Email"
          name="email"
          value={user.email}
          type="email"
          disabled
          description="Email cannot be changed."
        />

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={resetForm} disabled={isSubmitting}>
            Reset
          </Button>
          <Button
            type="submit"
            disabled={!isValid || isSubmitting}
            title={!isValid ? 'Fix validation errors to save' : undefined}
          >
            {isSubmitting ? 'Saving...' : 'Save changes'}
          </Button>
        </div>
      </SettingsSection>
    </form>
  );
}

export default ProfileSection;
