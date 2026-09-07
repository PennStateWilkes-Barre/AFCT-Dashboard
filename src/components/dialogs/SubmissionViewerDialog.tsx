'use client';

import JffViewerDialog from '@/components/JffViewerDialog';
import { RegexViewerDialog } from '@/components/dialogs/RegexViewerDialog';
import { CfgViewerDialog } from '@/components/dialogs/CfgViewerDialog';
import { viewerWindowTarget } from '@/lib/viewer-tabs';

// Problem types rendered by the JFLAP (cytoscape) viewer; the rest map to their own
// dedicated viewers.
const JFF_PROBLEM_TYPES = ['FA', 'PDA', 'TM'];

type SubmissionViewerDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The problem's type: selects which viewer to render. */
  problemType: string | null | undefined;
  /** URL of the file to view (submission or solution). */
  src: string;
  title?: string;
  /**
   * The file's own name, when the caller has it.
   *
   * Only used to label the tab in the standalone window. Without it that tab falls back to the
   * composed title, which is correct but longer than it needs to be.
   */
  fileName?: string;
  /** Empty-string symbol (ε / λ) for the JFLAP and grammar viewers. */
  epsSymbol?: string;
  width?: string;
  height?: string;
  showGridDefault?: boolean;
  /**
   * Offer "Open in viewer", which detaches the machine into the standalone viewer window.
   *
   * On by default, which is the staff surfaces. A student is reading one submission of their
   * own and the preview is the whole job; the separate window brings a tab strip, a menu bar
   * and an arrangement to keep, none of which is theirs to want.
   */
  allowOpenInWindow?: boolean;
};

/**
 * Picks the right viewer dialog for a problem's type: JFLAP for FA/PDA/TM, the regex
 * viewer for RE, the grammar viewer for CFG. Replaces the three near-identical
 * type-switch blocks that were copy-pasted across the assignment/submission views.
 * Renders nothing for an unknown type.
 */
export function SubmissionViewerDialog({
  open,
  onOpenChange,
  problemType,
  src,
  title,
  fileName,
  epsSymbol,
  width = '70vw',
  height = '70vh',
  showGridDefault,
  allowOpenInWindow = true,
}: SubmissionViewerDialogProps) {
  const type = problemType ?? '';
  // Null when the file is not one this viewer can build a safe link to, in which case no
  // button is offered rather than one that would fail at the far end. Null too when the
  // caller does not offer the window at all: every viewer already treats a null target as
  // "no button", so there is one way of not showing it rather than two.
  const windowTarget = allowOpenInWindow
    ? viewerWindowTarget({ src, problemType: type, title, fileName, epsSymbol })
    : null;

  if (JFF_PROBLEM_TYPES.includes(type)) {
    return (
      <JffViewerDialog
        open={open}
        onOpenChange={onOpenChange}
        src={src}
        title={title}
        width={width}
        height={height}
        showGridDefault={showGridDefault}
        epsSymbol={epsSymbol}
        windowTarget={windowTarget}
      />
    );
  }

  if (type === 'RE') {
    return (
      <RegexViewerDialog
        open={open}
        onOpenChange={onOpenChange}
        src={src}
        title={title}
        windowTarget={windowTarget}
      />
    );
  }

  if (type === 'CFG') {
    // Grammars show epsilon too, so they follow the course's notation like the others do.
    return (
      <CfgViewerDialog
        open={open}
        onOpenChange={onOpenChange}
        src={src}
        title={title}
        epsSymbol={epsSymbol}
        windowTarget={windowTarget}
      />
    );
  }

  return null;
}
