'use client';

import { Circle, MousePointer, MoveRight, Type, type LucideIcon } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { ViewerCapabilities } from './viewer-capabilities';
import { viewerShortcut, type ViewerShortcutId } from '@/lib/viewer-shortcuts';

/**
 * What clicking the canvas means.
 *
 * A union rather than a boolean, because this is four of a longer list. Everything that reads
 * the mode switches on this one value, so adding the next tool is a case in TOOLS below plus a
 * case wherever the canvas acts on it.
 *
 * One value, never a set of flags. Transition takes two clicks to finish rather than one, and
 * it is still one value: `activeTool` stays `'transition'` from the click that anchors a source
 * to the one that picks a target, and how far the gesture has got is held beside it, in the
 * layer that owns the graph. Stages are not tools. `transition-source-picked` as a fifth value
 * would multiply with every tool added after it, and every switch on this union would have to
 * know about a stage it does not care about. See useCanvasTools and `onStateLink` in
 * useJffCytoscape.
 */
export type CanvasTool = 'select' | 'state' | 'transition' | 'text';

/** The default, and what Escape returns to: the viewer as it has always behaved. */
export const DEFAULT_CANVAS_TOOL: CanvasTool = 'select';

const TOOLS: ReadonlyArray<{
  tool: CanvasTool;
  label: string;
  icon: LucideIcon;
  /** What it does, for the tooltip. No key hints: there are no shortcuts for these. */
  description: string;
  /**
   * The capability without which this tool cannot do anything. Absent means it always works.
   *
   * A field on the tool rather than a check at each button, so the list stays the one place
   * that describes the palette and a new tool declares what it needs in the same line that
   * gives it a name.
   */
  requires?: keyof ViewerCapabilities;
  /**
   * The key that chooses this tool, named rather than spelled out: the shortcut's own
   * definition says what it is and what it looks like, and this only says which one.
   */
  shortcut: ViewerShortcutId;
}> = [
  {
    tool: 'select',
    label: 'Select',
    icon: MousePointer,
    description: 'Select and move elements',
    shortcut: 'selectTool',
  },
  {
    tool: 'state',
    label: 'State',
    icon: Circle,
    description: 'Add a state',
    requires: 'editMachine',
    shortcut: 'stateTool',
  },
  // The same arrow the transition inspector wears in its header, so the tool that draws one and
  // the panel that describes one are plainly about the same thing.
  {
    tool: 'transition',
    label: 'Transition',
    icon: MoveRight,
    description: 'Add a transition',
    requires: 'editMachine',
    shortcut: 'transitionTool',
  },
  // A comment is not part of the machine: it writes a note over the drawing and changes nothing
  // about the automaton. Called Comment here and ViewerTextBox in the code, because renaming the
  // stored shape would strand every note anybody has already written. See useViewerTextBoxes.
  {
    tool: 'text',
    label: 'Comment',
    icon: Type,
    description: 'Add a comment',
    requires: 'annotate',
    shortcut: 'commentTool',
  },
];

/**
 * The tools this viewer can actually offer.
 *
 * A tool that cannot work is not shown rather than shown greyed out: a disabled State button on
 * a machine nobody may redraw is an invitation followed by a refusal, and there is nothing the
 * reader could do to earn it.
 */
export function availableCanvasTools(capabilities: ViewerCapabilities): CanvasTool[] {
  return TOOLS.filter((t) => !t.requires || capabilities[t.requires]).map((t) => t.tool);
}

/**
 * The canvas's own tools, floating over the top-left of the drawing.
 *
 * Deliberately the same treatment as the properties inspector opposite: same surface, same
 * border, same corner, a lighter version of the same shadow. The two are the viewer's floating
 * furniture and reading as a pair is what says neither of them is part of the machine.
 *
 * Which tool is active is said twice over, by `aria-pressed` and by a background, a border and
 * a colour together, so it does not rest on colour alone.
 */
export function CanvasToolPalette({
  activeTool,
  onSelectTool,
  tools,
  className,
}: {
  activeTool: CanvasTool;
  onSelectTool: (tool: CanvasTool) => void;
  /** Which tools to show, in the order given here. See `availableCanvasTools`. */
  tools: readonly CanvasTool[];
  className?: string;
}) {
  const shown = TOOLS.filter((t) => tools.includes(t.tool));
  // Select on its own is not a palette: it is the way the viewer already behaves, and a single
  // pressed button that changes nothing is furniture over the drawing.
  if (shown.length < 2) return null;

  return (
    <div
      className={cn(
        'bg-card absolute top-3 left-3 z-10 flex flex-col gap-1 rounded-lg border p-1',
        'shadow-[0_2px_10px_rgba(15,23,42,0.08)] dark:shadow-[0_2px_10px_rgba(0,0,0,0.4)]',
        className,
      )}
      role="toolbar"
      aria-orientation="vertical"
      aria-label="Canvas tools"
      data-testid="viewer-tool-palette"
    >
      {shown.map(({ tool, label, icon: Icon, description, shortcut }) => {
        const active = tool === activeTool;
        return (
          <Tooltip key={tool}>
            <TooltipTrigger asChild>
              <button
                type="button"
                // The tooltip is the explanation, not the name: a tooltip is not read out
                // everywhere, and the visible word under the icon is the accessible name.
                aria-pressed={active}
                // The key is announced as a shortcut rather than folded into the name, so the
                // button is still called "Select".
                aria-keyshortcuts={viewerShortcut(shortcut).aria}
                onClick={() => onSelectTool(tool)}
                className={cn(
                  'focus-visible:ring-ring/70 flex h-14 w-14 flex-col items-center justify-center gap-1 rounded-md text-[11px] font-medium focus-visible:ring-[3px] focus-visible:outline-none',
                  active
                    ? // Three signals at once, so the active tool is not told by colour alone.
                      'bg-primary/10 text-primary ring-primary/30 ring-1'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon className="size-5" aria-hidden="true" />
                {label}
              </button>
            </TooltipTrigger>
            {/* The key beside what the tool does, from the shortcut's own definition. Not part
                of the accessible name: `aria-keyshortcuts` above says it properly. */}
            <TooltipContent side="right">
              <span>{description}</span>
              <kbd className="bg-background/20 ml-2 rounded px-1 py-0.5 font-mono text-[10px] leading-none">
                {viewerShortcut(shortcut).keys}
              </kbd>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
