'use client';

import { useQuery } from '@tanstack/react-query';
import { apiPaths } from '@/lib/api-paths';
import { clampSessionTimeoutMinutes, DEFAULT_SESSION_TIMEOUT_MINUTES } from '@/lib/system-settings';
import { queryKeys } from '@/lib/query-keys';

export type PublicSystemSettings = {
  timezone?: string | null;
  allowSignup?: boolean;
  sessionTimeoutMinutes?: number;
  hcaptchaSiteKey?: string;
  clock24Hour?: boolean;
};

/**
 * Cached read of the public system settings. Shares the `['system-settings',
 * 'public']` query key with {@link useEffectiveTimezone}, so components that need
 * either the timezone or the session timeout dedupe onto a single fetch.
 */
export function usePublicSystemSettings() {
  return useQuery({
    queryKey: queryKeys.systemSettingsPublic(),
    queryFn: async () => {
      const res = await fetch(apiPaths.systemSettingsPublic(), { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load public settings');
      return (await res.json()) as PublicSystemSettings;
    },
    staleTime: 5 * 60 * 1000,
  });
}

/** The configured idle-timeout in minutes, clamped, with the default while loading. */
export function useSessionTimeoutMinutes(): number {
  const { data } = usePublicSystemSettings();
  return clampSessionTimeoutMinutes(
    Number(data?.sessionTimeoutMinutes) || DEFAULT_SESSION_TIMEOUT_MINUTES,
  );
}
