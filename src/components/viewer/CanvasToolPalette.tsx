'use client';

import { Circle, MousePointer, Type, type LucideIcon } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * What clicking the canvas means.
 *
 * A union rather than a boolean, because this is three of a longer list: a transition tool and
 * a comment tool belong here eventually too, and each of them is another answer to the same
 * question. Everything that reads the mode switches on this one value, so adding the next tool
 * is a case in TOOLS below plus a case wherever the canvas acts on it.
 */
export type CanvasTool = 'select' | 'state' | 'text';

/** The default, and what Escape returns to: the viewer as it has always behaved. */
export const DEFAULT_CANVAS_TOOL: CanvasTool = 'select';

const TOOLS: ReadonlyArray<{
  tool: CanvasTool;
  label: string;
  icon: LucideIcon;
  /** What it does, for the tooltip. No key hints: there are no shortcuts for these. */
  description: string;
}> = [
  {
    tool: 'select',
    label: 'Select',
    icon: MousePointer,
    description: 'Select and move elements',
  },
  { tool: 'state', label: 'State', icon: Circle, description: 'Add a state' },
  // Text is not part of the machine: it writes a note over the drawing and changes nothing
  // about the automaton. See useViewerTextBoxes.
  { tool: 'text', label: 'Text', icon: Type, description: 'Add a text box' },
];

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
  className,
}: {
  activeTool: CanvasTool;
  onSelectTool: (tool: CanvasTool) => void;
  className?: string;
}) {
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
      {TOOLS.map(({ tool, label, icon: Icon, description }) => {
        const active = tool === activeTool;
        return (
          <Tooltip key={tool}>
            <TooltipTrigger asChild>
              <button
                type="button"
                // The tooltip is the explanation, not the name: a tooltip is not read out
                // everywhere, and the visible word under the icon is the accessible name.
                aria-pressed={active}
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
            <TooltipContent side="right">{description}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
