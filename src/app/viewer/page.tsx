import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { auth } from '@/lib/auth';
import QueryProvider from '@/components/providers/QueryProvider';
import SessionWatcher from '@/components/session/SessionWatcher';
import { loadViewerProperties, type ViewerProperties } from '@/lib/viewer-properties';
import { canOpenViewerFile } from '@/lib/viewer-access';
import { isSafeUploadName } from '@/lib/upload-names';
import { isViewerFileKind } from '@/lib/viewer-link';
import { tabKey } from '@/lib/viewer-tabs';
import { readLayout, settleLayout } from '@/lib/viewer-panes';
import { ViewerWindow } from './ViewerWindow';

export const metadata: Metadata = { title: 'AFCT Viewer' };

/** The types the viewer can render, so a mangled link is refused before anything loads. */
const KNOWN_TYPES = ['FA', 'PDA', 'TM', 'RE', 'CFG'];

/** A refusal that reads as an answer rather than an error page. */
function Refusal({ message }: { message: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="max-w-md text-center">
        <h1 className="text-foreground mb-2 text-lg font-semibold">Nothing to show</h1>
        <p className="text-muted-foreground text-sm">{message}</p>
      </div>
    </main>
  );
}

/**
 * Say which part of a link is wrong, because these URLs get bookmarked, pasted into mail and
 * hand-edited, and "something went wrong" would leave somebody with no idea whether to blame
 * the link or the file.
 *
 * Only the single-file form can be diagnosed this way. A `tabs` list is written by the viewer
 * itself, so a broken one is truncation or an edit rather than a part somebody left out.
 */
function badLinkMessage(params: URLSearchParams): string {
  if (params.get('tabs') || params.get('panes'))
    return 'This link is damaged, and does not name any file to open.';
  if (!isViewerFileKind(params.get('kind')))
    return 'This link does not say which kind of file to open.';
  if (!isSafeUploadName(params.get('file')))
    return 'This link does not name a file the viewer can open.';
  return 'This link does not say what kind of machine the file holds.';
}

/**
 * The standalone machine viewer, opened in its own window from a viewer dialog.
 *
 * Outside `/dashboard` on purpose: that layout supplies the sidebar and navbar, and a window
 * whose whole job is to show machines should have neither. The providers the viewers need
 * (theme, session, toasts) come from the root layout, so this route re-adds only the
 * idle-session watcher and a query client, which `SessionWatcher` needs to read the timeout.
 *
 * It grants no access of its own. Each file is fetched from the same route the dialog uses,
 * which authorises per file and writes the audit record; this page decides only that the link
 * is well formed and that somebody is signed in.
 */
export default async function ViewerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  // Same two conditions the dashboard layout applies: a session, and an account that has not
  // been marked inactive since it was issued.
  if (!session?.user?.id || session.user.inactive) {
    redirect('/login');
  }

  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') params.set(key, value);
    else if (Array.isArray(value) && value[0] !== undefined) params.set(key, value[0]);
  }

  const read = readLayout(params);
  const drawable = read.tabs.filter((tab) => KNOWN_TYPES.includes(tab.type.toUpperCase()));
  /**
   * Course staff only, decided here rather than by leaving the link off a student's page.
   * This URL is guessable, bookmarkable and shareable, so a button that is not offered is not
   * a rule. A student reading their own work has the preview in the assignment page instead,
   * which is what they need to check they sent the right file.
   *
   * Per file, because staffness is per course: somebody can be faculty in one and a student in
   * another, and a link carrying several files can mix the two.
   */
  const openable = await Promise.all(
    drawable.map((tab) => canOpenViewerFile(tab.kind, tab.file, session.user)),
  );
  const allowedTabs = drawable.filter((_, i) => openable[i]);
  const refused = allowedTabs.length < drawable.length;
  // A type the viewer cannot draw is dropped rather than opened as a broken tab. Settled
  // afterwards, because dropping one can leave a pane empty or showing nothing.
  const layout = settleLayout({ ...read, tabs: allowedTabs });
  if (layout.tabs.length === 0) {
    return (
      <Refusal
        message={
          refused
            ? 'This viewer is for course staff. If this is your own work, open it from the assignment page.'
            : badLinkMessage(params)
        }
      />
    );
  }

  // Only for the tabs the window opens with. One added later has never been near the server,
  // and fetches its own from /api/viewer/properties.
  const properties: Record<string, ViewerProperties | null> = {};
  for (const tab of layout.tabs) {
    properties[tabKey(tab)] = await loadViewerProperties(tab.kind, tab.file, session.user);
  }

  return (
    <QueryProvider>
      <SessionWatcher />
      <ViewerWindow initialLayout={layout} initialProperties={properties} />
    </QueryProvider>
  );
}
