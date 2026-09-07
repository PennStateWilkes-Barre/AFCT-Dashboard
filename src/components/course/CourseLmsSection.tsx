'use client';

import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Unlink } from 'lucide-react';
import { RosterSyncDialog } from '@/components/course/RosterSyncDialog';
import { Button } from '@/components/ui/button';
import { SettingsAsideCard } from '@/components/settings/settings-layout';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog';
import { showToast } from '@/lib/toast';
import { formatDateTimeInTimeZone } from '@/lib/date-format';
import { useEffectiveTimezone } from '@/hooks/use-effective-timezone';
import { queryKeys } from '@/lib/query-keys';

type Link = {
  id: string;
  platformName: string;
  contextTitle: string | null;
  contextId: string;
  linkedAt: string;
  canSendGrades: boolean;
  linkedBy: string | null;
};

/**
 * Which LMS courses open this one.
 *
 * Until this existed the link was invisible once made, and could only be changed in the
 * database. Several links is normal: cross-listed sections are separate courses in the LMS.
 *
 * Its own card in the Settings tab's rail, under Course Status, because that is what it is:
 * a standing fact about the course rather than something the form below edits. Nothing here
 * is saved by Save, and a panel sitting in the form column implied otherwise.
 *
 * The rail is 288px, so each connection STACKS rather than putting its Disconnect button out
 * to the right of its name. That is the whole reason this once lived in the main column: a
 * row of four things does not survive that width without truncating all of them, and an LMS
 * course title is the one thing here nobody can afford to have cut off. Wrapping the title
 * and putting the buttons under it costs a little height and keeps every word.
 *
 * The component still decides whether it appears at all, so the card is never drawn empty.
 */
export function CourseLmsSection({ courseId }: { courseId: string }) {
  const { timezone, hour12 } = useEffectiveTimezone();
  const [removing, setRemoving] = useState<Link | null>(null);
  const [syncing, setSyncing] = useState(false);

  /**
   * Cached under the course prefix, so it refetches with the rest of the course rather than on
   * every visit to the Settings tab, and so `invalidateQueries(['course', courseId])` after a
   * roster sync or an LMS change reaches it.
   */
  const queryClient = useQueryClient();
  const linksQuery = useQuery({
    queryKey: queryKeys.course.lmsLink(courseId),
    queryFn: async () => {
      const res = await fetch(`/api/courses/${courseId}/lti-link`);
      if (!res.ok) throw new Error('Failed to load LMS links');
      return ((await res.json()) as { links: Link[] }).links;
    },
  });
  // `null` while loading; a failed read resolves to none, so the card stays hidden rather
  // than sitting on a spinner, which is what the old catch did.
  const links: Link[] | null = linksQuery.isPending ? null : (linksQuery.data ?? []);

  const load = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.course.lmsLink(courseId) }),
    [queryClient, courseId],
  );

  const unlink = async () => {
    if (!removing) return;
    try {
      const res = await fetch(`/api/courses/${courseId}/lti-link?linkId=${removing.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error();
      showToast.success('Disconnected from that LMS course');
      setRemoving(null);
      await load();
    } catch {
      showToast.error('Could not disconnect that LMS course. Check your connection and try again.');
    }
  };

  // Nothing to say for a course nobody opens from an LMS.
  if (!links || links.length === 0) return null;

  return (
    <SettingsAsideCard title="Connected to your LMS" headingLevel={3}>
      <div className="space-y-3">
        <p className="text-muted-foreground text-xs leading-4.5">
          Students open this course from your LMS. Sending grades back is set up on each assignment,
          under its Settings tab.
        </p>

        {/* One block per LMS course, each stacked: name, then where it came from, then what
            you can do about it. A cross-listed course is genuinely several of these. */}
        <ul className="space-y-3">
          {links.map((link) => (
            <li key={link.id} className="space-y-2 border-t pt-3 first:border-t-0 first:pt-0">
              {/* Wrapped, not truncated. This is the name the professor recognises the
                  connection by, and half of it is no use. */}
              <p className="text-sm font-medium break-words">
                {link.contextTitle ?? `Course ${link.contextId}`}
              </p>
              <p className="text-muted-foreground text-xs leading-4.5">
                {link.platformName}
                {link.linkedBy ? `, connected by ${link.linkedBy}` : ''}
                {' on '}
                {formatDateTimeInTimeZone(link.linkedAt, timezone, hour12)}
              </p>
              {!link.canSendGrades && (
                <p className="text-muted-foreground text-xs leading-4.5">
                  Grades cannot be sent yet. Somebody needs to open AFCT from this LMS course once,
                  so it can tell AFCT where its gradebook is.
                </p>
              )}
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setRemoving(link)}
              >
                <Unlink className="mr-2 h-4 w-4" aria-hidden="true" />
                Disconnect
              </Button>
            </li>
          ))}
        </ul>

        {/* Under the connections it acts on, and full width like them, so the card reads as
            one column of controls rather than a list with a stray button beside it. */}
        <Button variant="outline" size="sm" className="w-full" onClick={() => setSyncing(true)}>
          <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
          Sync roster from your LMS
        </Button>
      </div>

      <RosterSyncDialog courseId={courseId} open={syncing} onOpenChange={setSyncing} />

      <ConfirmDialog
        open={removing !== null}
        onCancel={() => setRemoving(null)}
        title="Disconnect this LMS course?"
        description="Nobody will be able to open this course from your LMS, and grades will stop being sent. Grades already in your LMS stay there, and the course can be connected again."
        confirmText="Disconnect"
        variant="destructive"
        onConfirm={unlink}
      />
    </SettingsAsideCard>
  );
}
