'use client';

import { useQuery } from '@tanstack/react-query';
import { apiPaths } from '@/lib/api-paths';
import { usePublicSystemSettings } from '@/hooks/use-public-system-settings';
import { queryKeys } from '@/lib/query-keys';

/**
 * Resolves the timezone to display dates in: the user's own profile timezone,
 * else the system default, else the browser's. Both reads go through the query
 * cache (shared keys), so the many components that call this hook on a page load
 * dedupe onto a single `/api/me` + `/api/system-settings/public` fetch instead
 * of each firing their own (previously a 5+ request stampede per page).
 */
export function useEffectiveTimezone() {
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  const profileQuery = useQuery({
    queryKey: queryKeys.profile(),
    queryFn: async () => {
      const res = await fetch(apiPaths.me(), { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load profile');
      return (await res.json()) as { timezone?: string | null };
    },
    staleTime: 5 * 60 * 1000,
  });

  // Share the single ['system-settings','public'] query (one queryFn and type)
  // rather than registering a second queryFn for the same cache key.
  const publicSettings = usePublicSystemSettings();

  const userTz = profileQuery.data?.timezone || '';
  const serverTz = publicSettings.data?.timezone || '';
  // Before either resolves (or on error) both are empty, so we fall back to the
  // browser timezone, matching the previous hook's default.
  const timezone = userTz || serverTz || browserTz || 'UTC';
  // App-wide clock preference (admin System Settings). Defaults to 12-hour until it
  // resolves. `hour12` is what the date formatters take.
  const hour12 = !(publicSettings.data?.clock24Hour ?? false);
  const loading = profileQuery.isLoading || publicSettings.isLoading;

  return { timezone, hour12, loading };
}
