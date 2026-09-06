import { useQuery } from '@tanstack/react-query';
import { DEFAULT_MAX_UPLOAD_SIZE_MB } from '@/lib/system-settings';
import { apiPaths } from '@/lib/api-paths';
import { queryKeys } from '@/lib/query-keys';

type UseMaxUploadSizeResult = {
  maxMb: number;
  loading: boolean;
  error: string | null;
};

type PublicSystemSettings = {
  sessionTimeoutMinutes?: number;
  maxUploadSizeMb?: number;
};

export function useMaxUploadSize(): UseMaxUploadSizeResult {
  // Deliberately shared key so multiple upload dialogs dedupe on this
  // public-settings read.
  const { data, isLoading, isError } = useQuery<PublicSystemSettings>({
    queryKey: queryKeys.systemSettingsPublic(),
    queryFn: async () => {
      const res = await fetch(apiPaths.systemSettingsPublic(), { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to fetch settings');
      return (await res.json()) as PublicSystemSettings;
    },
    staleTime: 5 * 60_000,
  });

  return {
    maxMb: data?.maxUploadSizeMb ?? DEFAULT_MAX_UPLOAD_SIZE_MB,
    loading: isLoading,
    error: isError ? 'Could not load upload limit' : null,
  };
}
