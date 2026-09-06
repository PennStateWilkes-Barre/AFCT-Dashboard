'use client';

import { JffCytoscapeViewer } from '@/components/JffViewerDialog';
import { CfgViewerContent } from '@/components/dialogs/CfgViewerDialog';
import { RegexViewerContent } from '@/components/dialogs/RegexViewerDialog';
import type { ViewerViewport } from '@/lib/viewer-view-state';

/** Problem types drawn by the JFLAP (cytoscape) viewer; the rest have their own. */
const JFF_PROBLEM_TYPES = ['FA', 'PDA', 'TM'];

/**
 * The standalone viewer's contents.
 *
 * Deliberately the same three components the dialogs use, rather than a second rendering
 * path: the dialog and this window must never disagree about what a machine looks like.
 * All three were already exported apart from their dialog chrome, which is what makes a
 * separate window this small a change.
 */
export function ViewerClient({
  src,
  problemType,
  title,
  epsSymbol,
  viewStateKey,
  showInspector = true,
  onViewportChange,
  linkedViewport,
}: {
  src: string;
  problemType: string;
  title: string;
  epsSymbol?: string;
  /**
   * Remember this file's zoom, pan and arrangement under this key, so a refresh comes back to
   * where the reader was. Only the drawn machines have anything to remember.
   */
  viewStateKey?: string | null;
  /** Whether this pane may show its properties panel. See JffCytoscapeViewer. */
  showInspector?: boolean;
  /** Report where this machine is being looked at, for a linked pane. */
  onViewportChange?: ((viewport: ViewerViewport) => void) | null;
  /** Follow another pane's camera. */
  linkedViewport?: ViewerViewport | null;
}) {
  if (JFF_PROBLEM_TYPES.includes(problemType)) {
    return (
      <JffCytoscapeViewer
        src={src}
        title={title}
        fill
        epsSymbol={epsSymbol}
        showGridDefault
        honorPositionsDefault
        // Fit, so a file opens showing the whole machine however the window is sized. It used
        // to open at 1:1, matching JFLAP, which is the right scale for reading a machine and
        // the wrong one for meeting it: a large automaton arrived with a corner of itself on
        // screen and the rest to be found by panning.
        //
        // Only the FIRST time. This is the fallback for a file with nothing remembered about
        // it; a file already opened in this window comes back at the zoom the reader left it
        // at, because the remembered view wins over this.
        initialZoom="fit"
        viewStateKey={viewStateKey}
        showInspector={showInspector}
        onViewportChange={onViewportChange}
        linkedViewport={linkedViewport}
      />
    );
  }

  if (problemType === 'RE') {
    return (
      <div className="mx-auto w-full max-w-3xl p-6">
        <RegexViewerContent src={src} />
      </div>
    );
  }

  if (problemType === 'CFG') {
    return (
      <div className="mx-auto w-full max-w-3xl p-6">
        <CfgViewerContent src={src} epsSymbol={epsSymbol} />
      </div>
    );
  }

  return (
    <p className="text-muted-foreground p-6 text-sm">
      This viewer does not know how to show a {problemType} file.
    </p>
  );
}
