import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { showToast } from '@/lib/toast';
import type { User } from '@prisma/client';
import { apiPaths } from '@/lib/api-paths';
import { queryKeys } from '@/lib/query-keys';

export type RosterUser = User & { role?: string };

/** Full display name for a roster user, falling back to email. */
export function getUserName(user: User): string {
  return `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email || 'Unknown user';
}

/**
 * The chosen people, named for a review line.
 *
 * The email is added only where the name alone would not say who: two members of staff called
 * the same thing is ordinary in a university, and the picker shows every email precisely so the
 * chooser can tell them apart. Repeating all of them here would make a summary line unreadable
 * for the sake of the case that is not usually the one on screen.
 *
 * An id with nobody behind it (a list still loading, or somebody deleted since) is left as the
 * id, which is what this did before and is at least traceable.
 */
export function namesForReview(ids: readonly string[], people: readonly RosterUser[]): string {
  const chosen = ids.map((id) => ({ id, user: people.find((person) => person.id === id) }));
  const seen = new Map<string, number>();
  for (const { user } of chosen) {
    if (!user) continue;
    const name = getUserName(user);
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  return chosen
    .map(({ id, user }) => {
      if (!user) return id;
      const name = getUserName(user);
      return (seen.get(name) ?? 0) > 1 ? `${name} (${user.email})` : name;
    })
    .join(', ');
}

/**
 * Loads the faculty and TA option lists for the course create/duplicate wizards. Both
 * queries share the admin-users cache keys (so sibling dialogs dedupe onto one request),
 * fire only while `open`, and surface a load failure as a toast.
 */
export function useFacultyTaOptions(open: boolean): {
  facultyList: RosterUser[];
  taList: RosterUser[];
} {
  const facultyQuery = useQuery({
    queryKey: queryKeys.admin.usersFaculty(),
    queryFn: async () => {
      const res = await fetch(apiPaths.admin.users({ role: 'FACULTY' }));
      if (!res.ok) throw new Error('Failed to load faculty');
      const data = await res.json();
      return (Array.isArray(data) ? data : []) as RosterUser[];
    },
    enabled: open,
    staleTime: 30_000,
  });
  useEffect(() => {
    if (facultyQuery.isError)
      showToast.error('Could not load the faculty list. Refresh the page to try again.');
  }, [facultyQuery.isError]);

  const taQuery = useQuery({
    queryKey: queryKeys.admin.usersTa(),
    queryFn: async () => {
      const res = await fetch(apiPaths.admin.users({ role: 'TA' }));
      if (!res.ok) throw new Error('Failed to load TAs');
      const data = await res.json();
      return (Array.isArray(data) ? data : []) as RosterUser[];
    },
    enabled: open,
    staleTime: 30_000,
  });
  useEffect(() => {
    if (taQuery.isError)
      showToast.error('Could not load the TA list. Refresh the page to try again.');
  }, [taQuery.isError]);

  return { facultyList: facultyQuery.data ?? [], taList: taQuery.data ?? [] };
}
