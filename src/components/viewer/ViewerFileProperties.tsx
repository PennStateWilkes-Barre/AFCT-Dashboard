'use client';

import { Fragment, useEffect, useId, useState } from 'react';
import { Info } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { ViewerProperties } from '@/lib/viewer-properties';
import { parseViewerSrc } from '@/lib/viewer-link';

/**
 * Where the file on screen came from, a click away on the toolbar.
 *
 * Beside the machine type and the "File changed" note, because all three are about this file
 * rather than about the view of it. A popover rather than a dialog: this is a glance at a
 * handful of facts, and a modal that dims the machine to tell you whose it is asks the reader
 * to put the diagram down in order to read a label about it.
 *
 * It carries whatever the server put in `rows` and knows nothing about what those are, which is
 * what keeps the decision about what a reader may see in one place. Notably absent, and
 * deliberately: anything about grades. See `loadViewerProperties`.
 *
 * Also in the menu bar, as File, Properties. The exception to this toolbar's usual rule that an
 * action lives in one place: the File menu is where somebody goes looking for it by convention,
 * and this is the one-click way to it without leaving the machine. The two also answer about
 * different files in a split window, since the menu follows the tab on screen and this belongs
 * to the pane it sits on.
 */
/**
 * Ask the server where a file came from.
 *
 * For the surfaces that have no server render behind them: every viewer dialog in the app,
 * including the student's preview, where "which attempt is this and when did it arrive" is
 * most of the answer to the question the preview exists for. The standalone window passes its
 * own in, loaded during the page render, so it has no flash and makes no request.
 *
 * Undefined until the answer arrives, which is what keeps the button out of the toolbar rather
 * than putting a disabled one there and enabling it a moment later. Null is an answer: no such
 * file, or not this reader's to see.
 */
export function useViewerFileProperties(
  src: string,
  enabled: boolean,
): ViewerProperties | null | undefined {
  const [properties, setProperties] = useState<ViewerProperties | null | undefined>(undefined);

  useEffect(() => {
    const parsed = enabled ? parseViewerSrc(src) : null;
    if (!parsed) {
      setProperties(undefined);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/viewer/properties?kind=${encodeURIComponent(parsed.kind)}&file=${encodeURIComponent(parsed.file)}`,
        );
        const value = res.ok ? ((await res.json()) as ViewerProperties) : null;
        if (!cancelled) setProperties(value);
      } catch {
        // Offline, or a request cut short by the dialog closing. No button is a fair answer:
        // nothing here is needed to read the machine.
        if (!cancelled) setProperties(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src, enabled]);

  return properties;
}

export function ViewerFileProperties({ properties }: { properties: ViewerProperties | null }) {
  const headingId = useId();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          // Quiet, like the note it sits beside: this answers a question rather than asking to
          // be used. Disabled rather than hidden when the server had nothing to say, so the
          // toolbar keeps its shape between files and the button stays where it was learned.
          className="text-muted-foreground h-6 w-6 p-0"
          disabled={!properties}
          title="File properties"
          aria-label="File properties"
        >
          <Info className="h-4 w-4" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[60vh] w-80 overflow-y-auto"
        aria-labelledby={headingId}
      >
        <p id={headingId} className="mb-2 text-sm font-medium">
          Properties
        </p>
        <p className="text-muted-foreground mb-3 text-xs">Where this file came from.</p>
        {/* A definition list, since every row is a label and its value. The first column takes
            only the width it needs so long values get the rest of it. */}
        <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
          {(properties?.rows ?? []).map((row) => (
            <Fragment key={row.label}>
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="break-words">{row.value}</dd>
            </Fragment>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}
