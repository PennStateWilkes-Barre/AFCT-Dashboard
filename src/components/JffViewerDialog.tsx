'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
// `Tooltip` brings its own provider, so there is nothing to wrap the panel in.
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import LoadingSpinner from '@/components/ui/loading-spinner';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  describeMachine,
  transitionFields,
  type MachineDescription,
  type MachineType,
  type EdgeDescription,
  type StateDescription,
} from '@/lib/jflap-parse';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import {
  sliderToZoom,
  zoomPercentLabel,
  zoomPercentSpoken,
  zoomToSlider,
  ZOOM_SLIDER_MAX,
  ZOOM_SLIDER_MIN,
} from '@/lib/zoom-scale';
import { useJffCytoscape, DEFAULT_EPS } from './useJffCytoscape';
import { OpenInWindowButton } from '@/components/dialogs/OpenInWindowButton';
import type { ViewerWindowTarget } from '@/lib/viewer-tabs';
import type { ViewerViewport } from '@/lib/viewer-view-state';
import {
  useRegisterViewerActions,
  useViewerChromePresent,
} from '@/components/viewer/viewer-actions';
import {
  CanvasToolPalette,
  DEFAULT_CANVAS_TOOL,
  type CanvasTool,
} from '@/components/viewer/CanvasToolPalette';
import {
  Grid,
  Copy,
  Minus,
  Plus,
  ChevronDown,
  ChevronRight,
  Trash2,
  Circle,
  MoveRight,
  Crosshair,
  Scan,
  Undo2,
  Redo2,
  RotateCcw,
  PencilLine,
  FileDown,
  X,
} from 'lucide-react';

/**
 * Fallback grid colour, used only if `--grid-color` is somehow absent.
 *
 * A plain constant, deliberately. It used to read the computed value off the document behind
 * a `typeof window` check, which meant the server rendered one colour and the browser
 * another: React reported a hydration mismatch on the first page that server-renders this
 * viewer, which the dialogs never did because they only ever mount after a click. Reading
 * computed styles during render is the thing that cannot be done here; the CSS variable does
 * the theming anyway, live, without any of this.
 */
const GRID_COLOR_FALLBACK = '#0f172a';

/**
 * What each step of opening a machine is called on screen.
 *
 * Three of them because they fail for different reasons and take different lengths of time: a
 * large submission spends most of its wait in the fetch, and a large machine most of it in the
 * layout. "Loading" for both tells the reader nothing about which.
 */
const PHASE_LABEL = {
  fetching: 'Loading the file',
  parsing: 'Reading the machine',
  drawing: 'Drawing the machine',
  ready: '',
} as const;

/**
 * The machine written out: states, transitions and any notes.
 *
 * One component because it now appears in two places and must not drift between them. In a
 * dialog it sits in a panel under the graph; in the standalone window the View menu opens it
 * in a window of its own, so the graph keeps the whole height.
 */
function MachineDescriptionList({ description }: { description: MachineDescription }) {
  return (
    <>
      {description.isEmpty ? (
        <p className="text-muted-foreground">
          This file contains no states or notes, so there is nothing to describe.
        </p>
      ) : (
        <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">States</dt>
          <dd>{description.stateNames.join(', ')}</dd>

          <dt className="text-muted-foreground">Initial state</dt>
          <dd>{description.initialState ?? 'Not set'}</dd>

          <dt className="text-muted-foreground">Final states</dt>
          <dd>{description.finalStates.length ? description.finalStates.join(', ') : 'None'}</dd>

          <dt className="text-muted-foreground">Transitions</dt>
          <dd>
            {description.transitionLines.length === 0 ? (
              'None'
            ) : (
              <ul className="list-none space-y-0.5">
                {description.transitionLines.map((line, i) => (
                  <li key={`${line}-${i}`}>{line}</li>
                ))}
              </ul>
            )}
          </dd>

          {/* Only when there are any: an empty Notes row on every machine would be
              noise, and most files have none. Notes are drawn on the canvas only in
              "As drawn", so this is where they are always readable. */}
          {description.noteLines.length > 0 ? (
            <>
              <dt className="text-muted-foreground">Notes</dt>
              <dd>
                <ul className="list-none space-y-0.5">
                  {description.noteLines.map((line, i) => (
                    <li key={`${line}-${i}`}>{line}</li>
                  ))}
                </ul>
              </dd>
            </>
          ) : null}
        </dl>
      )}
    </>
  );
}

/**
 * Where a clicked state or transition is described.
 *
 * One panel in two places, and which one is decided by the width of this pane rather than of
 * the window. Wide enough for a column beside the machine and it docks down the right-hand
 * side, in the flow, so the drawing gives up the width rather than being covered by it.
 * Narrower and it slides up from the bottom of the drawing instead, out of the flow, so the
 * machine keeps the whole width and stays visible above it.
 *
 * A container query rather than a screen breakpoint, matching the rest of the app, because the
 * pane is what has the room: a split window on a wide screen gives each machine half of it, and
 * one half can want the drawer while the other has space for the sidebar. It also means the two
 * layouts are one element and one copy of the content, so there is nothing to keep in step.
 *
 * The `@container` it answers to is on the row below, whose width does not change when this
 * opens. Putting it on something this panel takes width from would make the query flip back and
 * forth: docking would narrow the container, which would ask for the drawer, which would widen
 * it again.
 *
 * Non-modal on purpose. It says what was just clicked while the reader carries on with the
 * machine, so it takes no focus, dims nothing, and traps nothing. Escape closes it for somebody
 * who has tabbed into it, and everything it shows is also in the text representation, which is
 * the keyboard and screen-reader route to the same facts.
 */
/**
 * What each kind of machine is called, in the words the reader sees.
 *
 * One place for them, because two now say it: the badge above the drawing and the inspector's
 * own subtitle. `lib/jflap-parse` has its own nouns for the text representation, which are
 * sentence case for running prose; these are the titles.
 */
const MACHINE_TYPE_LABEL: Record<MachineType, string> = {
  fa: 'Finite Automaton',
  pda: 'Pushdown Automaton',
  tm: 'Turing Machine',
  unknown: 'Unknown',
};

/**
 * How long the properties panel takes to slide away.
 *
 * The classes on the panel animate for this long and the panel is taken down after it, so the
 * two have to agree: unmount it sooner and it disappears mid-slide.
 */
const PANEL_EXIT_MS = 200;

/**
 * Where the properties panel sits, and how it comes and goes.
 *
 * Separate from the panel's contents, and rendered by the viewer rather than by either kind of
 * panel, so that clicking from one state to another swaps what is inside without this element
 * being replaced. A remount would restart the animation below, which looks like the panel
 * leaping off the screen and sliding back for every click.
 */
function PanelFrame({
  open,
  children,
}: {
  /** False while it is sliding away; see PANEL_EXIT_MS. */
  open: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      data-state={open ? 'open' : 'closed'}
      data-testid="viewer-properties-panel"
      // Nothing inside is reachable while it is leaving: not by tab, not by a click, and not by
      // a screen reader. Without this the reader could land in a panel on its way off screen.
      inert={!open}
      className={cn(
        // Over the drawing, never beside it. It used to take its width out of the flow at the
        // wider size, which meant opening it narrowed the canvas and the machine shifted under
        // the reader's eye: they clicked a state and the thing they clicked moved. Floating it
        // costs a strip of the drawing, which they can pan out from and which closing gives
        // back, and that is the cheaper of the two.
        // Opaque, never translucent: a machine showing through the panel makes both unreadable.
        'bg-card absolute z-10 flex flex-col',
        // The drawer: across the foot of the drawing, and never more than a little over half of
        // it, so a hub state with twenty transitions scrolls rather than swallowing the machine.
        // Flush to the three edges it touches, which is what a sheet on a phone is, and its
        // shadow falls upward, onto the canvas it is covering.
        'inset-x-0 bottom-0 max-h-[min(60%,20rem)] rounded-t-lg border-t',
        'shadow-[0_-6px_16px_rgba(15,23,42,0.06)] dark:shadow-[0_-6px_16px_rgba(0,0,0,0.35)]',
        // The inspector: a panel resting on the drawing rather than a wall built against the
        // edge of it. Inset on all three sides so the canvas runs behind and around it, which
        // is what says it is floating; bordered the whole way round and rounded, because a
        // panel that stops short of the edges has four of them now. 20rem leaves a usable
        // canvas at the width this switches on and matches the app's other side panels.
        //
        // The shadow is soft and wide rather than the deep drop a dialog gets: enough to lift
        // it off the grid, not enough to read as a sheet over the page. Dark mode needs a
        // heavier alpha for the same reading, since a near-black shadow on a near-black ground
        // is no shadow at all. The tool palette opposite uses a lighter version of it.
        // As tall as it needs to be, not as tall as the pane. A state with two transitions was
        // a full-height column of empty card, which is what a docked sidebar looks like and the
        // opposite of a panel resting on the drawing. It grows with its contents and stops one
        // gutter short of the foot, after which the body inside it scrolls.
        '@[48rem]/viewer:top-3 @[48rem]/viewer:right-3 @[48rem]/viewer:bottom-auto @[48rem]/viewer:left-auto @[48rem]/viewer:max-h-[calc(100%-1.5rem)] @[48rem]/viewer:w-80 @[48rem]/viewer:rounded-lg @[48rem]/viewer:border',
        '@[48rem]/viewer:shadow-[0_4px_18px_rgba(15,23,42,0.10)] @[48rem]/viewer:dark:shadow-[0_4px_18px_rgba(0,0,0,0.45)]',
        // It arrives and leaves as a drawer, from whichever edge it is attached to: up from the
        // foot of the drawing when it is one, in from the right when it is the sidebar. The
        // sidebar case cancels the vertical slide rather than adding to it, or it would arrive
        // diagonally. `fill-mode-forwards` on the way out holds it off screen until it is taken
        // down; without it the panel snaps back into view for the last moment of its own exit.
        // The page-wide reduced-motion rule already flattens all of this to nothing.
        'duration-200 ease-out',
        'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-bottom data-[state=closed]:fill-mode-forwards',
        '@[48rem]/viewer:data-[state=open]:slide-in-from-bottom-0 @[48rem]/viewer:data-[state=open]:slide-in-from-right',
        '@[48rem]/viewer:data-[state=closed]:slide-out-to-bottom-0 @[48rem]/viewer:data-[state=closed]:slide-out-to-right',
      )}
    >
      {children}
    </div>
  );
}

/**
 * The shell every inspector shares: a header that stays put, and a body that scrolls under it.
 *
 * Two lines in the header rather than one. The first says what is selected, the second what
 * kind of machine it belongs to, which is the question a reader has when a window is showing
 * four files at once and the transition fields differ between them.
 *
 * The body scrolls on its own so a state with thirty transitions moves the list and nothing
 * else. Sections inside it are divided by a hairline rather than boxed, because a stack of
 * cards in a 320px column reads as clutter; see InspectorSection.
 */
function PropertiesPanel({
  label,
  icon: Icon,
  heading,
  subtitle,
  closeLabel,
  closeTooltip,
  onClose,
  children,
}: {
  label: string;
  icon: LucideIcon;
  heading: React.ReactNode;
  subtitle: string;
  closeLabel: string;
  closeTooltip: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    // Fills the frame above, which is what carries the position and the animation.
    // The Escape handler below is on the group rather than on a control. The rule this turns
    // off guards against divs pretending to be buttons; this adds a shortcut to a container
    // whose controls all remain reachable and operable on their own, which is what Radix does
    // for its own dismissable layers.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      className="flex min-h-0 w-full flex-1 flex-col"
      role="group"
      aria-label={label}
      // Escape from anywhere in the panel, not just from the close button. It used to be on
      // that button alone, which was defensible when the button was the only thing in here
      // that took focus and is not now: a reader in the Name box, a coordinate box or a
      // transition row pressed Escape and nothing happened. In the standalone window nothing
      // else is listening, so this closes the panel alone; inside a dialog Radix's own handler
      // is on the document, so the dialog closes too, which is what anybody would expect of
      // Escape in a dialog.
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div className="flex items-start gap-2.5 border-b px-3 py-2.5">
        <span
          className="bg-muted text-muted-foreground mt-px flex size-6 shrink-0 items-center justify-center rounded-md"
          aria-hidden="true"
        >
          <Icon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{heading}</div>
          <div className="text-muted-foreground truncate text-xs">{subtitle}</div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              // Bigger than the toolbar's buttons, because in the drawer it is a thumb that
              // reaches for it.
              className="-mt-0.5 -mr-1 h-8 w-8 shrink-0 p-0 @[48rem]/viewer:h-7 @[48rem]/viewer:w-7"
              onClick={onClose}
              aria-label={closeLabel}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{closeTooltip}</TooltipContent>
        </Tooltip>
      </div>
      {/* The scrolling part, so the header stays put while a long list of transitions moves.
          `divide-y` is what separates the sections, so no section has to know its neighbours. */}
      <div className="divide-border/60 min-h-0 flex-1 divide-y overflow-y-auto">{children}</div>
    </div>
  );
}

/**
 * One band of the inspector.
 *
 * A heading only where the contents do not name themselves: the first band is a labelled Name
 * box and a pair of tick boxes, and a word over it would say nothing the boxes do not.
 */
function InspectorSection({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 px-3 py-2.5">
      {title ? (
        <h3 className="text-muted-foreground text-xs font-medium tracking-wide">{title}</h3>
      ) : null}
      {children}
    </section>
  );
}

/**
 * What a clicked state is, and the one thing about it a reader can change.
 *
 * The name is editable and takes effect as it is typed: the label on the drawing, every panel
 * that mentions the state and the text representation all follow. It changes nothing about the
 * submitted file, which is why the toolbar says the file has changed on screen once one has
 * been renamed.
 *
 * The box holds its own copy of what has been typed rather than reading it back from the
 * machine, so that emptying it leaves it empty: a state with no name is described by its id, and
 * a box that filled itself with `q0` the moment the last character was deleted would be
 * impossible to type in.
 */
function StateProperties({
  state,
  machineType,
  advancedOpen,
  onAdvancedOpenChange,
  onRename,
  onSetInitial,
  onSetFinal,
  onOpenTransition,
  position,
  onBeginEdit,
  onMove,
  onDelete,
  onClose,
}: {
  state: StateDescription;
  /** Named under the title, so a window showing four files says which one this belongs to. */
  machineType: MachineType;
  /** Held by the viewer, not here: this component is remounted for every state clicked. */
  advancedOpen: boolean;
  onAdvancedOpenChange: (open: boolean) => void;
  onRename: (id: string, name: string) => void;
  onSetInitial: (id: string | null) => void;
  onSetFinal: (id: string, final: boolean) => void;
  onOpenTransition: (from: string, to: string) => void;
  /** Where the state is on the canvas now, which is not where the file has it once dragged. */
  position: { x: number; y: number } | null;
  onBeginEdit: () => void;
  onMove: (id: string, at: { x: number; y: number }) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  // Seeded once per state: the call site keys this component by id, so moving to another state
  // remounts it rather than leaving the previous name in the box.
  const [name, setName] = useState(state.name);
  // Unique per rendered panel, not per state: both halves of a split window can be showing the
  // same file, and two boxes with the same id would leave one label pointing at the other's.
  const nameFieldId = useId();
  const initialFieldId = useId();
  const finalFieldId = useId();

  return (
    <PropertiesPanel
      label={`Properties of state ${state.name}`}
      icon={Circle}
      // What was clicked, said in the header rather than left to be inferred from a bare name.
      heading={
        <>
          State <span className="font-mono">{state.name}</span>
        </>
      }
      subtitle={MACHINE_TYPE_LABEL[machineType]}
      closeLabel="Close state properties"
      closeTooltip="Close the inspector"
      onClose={onClose}
    >
      <InspectorSection>
        <div className="space-y-1.5">
          <Label htmlFor={nameFieldId} className="text-muted-foreground text-xs">
            Name
          </Label>
          <Input
            id={nameFieldId}
            value={name}
            // Focus, not the first keystroke, is where an undo step for this box begins.
            onFocus={onBeginEdit}
            onChange={(event) => {
              setName(event.target.value);
              onRename(state.id, event.target.value);
            }}
            className="h-8 font-mono text-sm"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {/* Two independent answers, side by side because they are one question about the state
            and stacking them spent a whole row each. A state can be both: the machine's only
            state is initial and final at once, and nothing here stops that.

            A machine has one initial state, so ticking Initial moves the arrow off whichever
            state had it rather than giving the machine two. Unticking leaves it with none,
            which is a machine that cannot run: allowed here because this is a drawing being
            marked up, and the submitted file is not being touched either way. Final says
            nothing about the others; it is the double circle JFLAP draws. */}
        <div className="space-y-1.5">
          <span className="text-muted-foreground block text-xs">State type</span>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id={initialFieldId}
                checked={state.initial}
                onCheckedChange={(checked) => onSetInitial(checked === true ? state.id : null)}
              />
              <Label htmlFor={initialFieldId} className="text-xs font-normal">
                Initial
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id={finalFieldId}
                checked={state.final}
                onCheckedChange={(checked) => onSetFinal(state.id, checked === true)}
              />
              <Label htmlFor={finalFieldId} className="text-xs font-normal">
                Final
              </Label>
            </div>
          </div>
        </div>
      </InspectorSection>

      {/* Everything that touches this state, in two lists rather than one mixed one. Which way a
          transition runs is the first thing you want of it, and reading that off a prefix on
          every row made the reader do the sorting. A self-loop is listed once, under Outgoing:
          it is something the state does, not something done to it.

          Each row is a way into that transition's own properties, because the canvas is the
          only other way to reach one and a canvas cannot be tabbed into. */}
      <InspectorSection title="Transitions">
        {state.links.length === 0 ? (
          <p className="text-muted-foreground text-xs">Nothing touches this state</p>
        ) : (
          <div className="space-y-2.5">
            <TransitionLinkList
              heading="Outgoing"
              links={state.links.filter((link) => link.direction === 'out')}
              stateName={state.name}
              onOpenTransition={onOpenTransition}
            />
            <TransitionLinkList
              heading="Incoming"
              links={state.links.filter((link) => link.direction === 'in')}
              stateName={state.name}
              onOpenTransition={onOpenTransition}
            />
          </div>
        )}
      </InspectorSection>

      {/* Where it sits on the canvas. Under Advanced to keep it out of the way of the two
          questions a reader usually has, and open by default because putting it away is not the
          same as hiding it: somebody who came here to line two states up must not have to find
          it first.

          The drawing's own coordinates, the ones a drag moves it through and the ones a
          downloaded arrangement carries, rather than the file's: those are where its author put
          it and do not change when the reader moves it. Typed rather than nudged, because the
          reason to type a coordinate at all is to line two states up exactly, which dragging
          cannot do. */}
      {position ? (
        <AdvancedSection open={advancedOpen} onOpenChange={onAdvancedOpenChange}>
          <div className="grid grid-cols-2 gap-2">
            <CoordinateField
              label="X"
              value={position.x}
              onBeginEdit={onBeginEdit}
              onCommit={(x) => onMove(state.id, { x, y: position.y })}
            />
            <CoordinateField
              label="Y"
              value={position.y}
              onBeginEdit={onBeginEdit}
              onCommit={(y) => onMove(state.id, { x: position.x, y })}
            />
          </div>
        </AdvancedSection>
      ) : null}

      <InspectorDeleteRow label="Delete state" onDelete={() => onDelete(state.id)} />
    </PropertiesPanel>
  );
}

/**
 * The disclosure at the foot of an inspector.
 *
 * Open by default, and the point of it is order rather than concealment: the coordinates are a
 * legitimate reason to open this panel at all, so they are one glance away and not one click.
 * Whoever wants the room can close it, and it stays closed for the rest of the session because
 * the open flag is held by the viewer, not by the panel that is rebuilt on every click.
 *
 * `CollapsibleTrigger` carries `aria-expanded` and the `data-state` the chevron turns on, so
 * neither has to be wired here.
 */
function AdvancedSection({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="px-3 py-2.5">
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/70 group -mx-1 flex w-[calc(100%+0.5rem)] items-center gap-1.5 rounded-md px-1 py-0.5 text-xs font-medium tracking-wide focus-visible:ring-[3px] focus-visible:outline-none">
        <ChevronDown
          className="size-3.5 shrink-0 transition-transform group-data-[state=closed]:-rotate-90"
          aria-hidden="true"
        />
        Advanced
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}

/**
 * The one destructive thing an inspector offers, at the foot of the panel.
 *
 * Below everything else and separated from it, because it is the only control here that takes
 * something away: the rest of the panel changes what an element says, and putting this in with
 * them would make it one more field. Quiet rather than red-filled, since it is not the reason
 * anybody opened the panel; the dialog it raises is where the warning belongs.
 */
function InspectorDeleteRow({ label, onDelete }: { label: string; onDelete: () => void }) {
  return (
    <div className="px-3 py-2.5">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-destructive hover:bg-destructive/10 hover:text-destructive h-8 w-full justify-start gap-2 px-2 text-xs"
        onClick={onDelete}
      >
        <Trash2 className="size-3.5" aria-hidden="true" />
        {label}
      </Button>
    </div>
  );
}

/**
 * One coordinate box.
 *
 * It keeps what has been typed rather than reading the number back off the canvas, and that is
 * the whole reason it exists. Reading it back meant a half-typed value could not survive:
 * clearing the box sent `Number('')`, which is 0 and perfectly finite, so the state shot to the
 * left edge of the drawing; and typing a minus sign sent `NaN`, which was rejected, so the box
 * put the old number straight back and the keystroke vanished. Neither is something a reader
 * can work around, because both happen on the way to a value they were about to finish typing.
 *
 * So: the draft is whatever is in the box, the state only moves when the draft is a number, and
 * the box is re-seeded whenever the state moves for any other reason, which is what keeps it in
 * step with a drag.
 */
function CoordinateField({
  label,
  value,
  onBeginEdit,
  onCommit,
}: {
  label: 'X' | 'Y';
  value: number;
  onBeginEdit: () => void;
  onCommit: (next: number) => void;
}) {
  const fieldId = useId();
  const [draft, setDraft] = useState(() => String(Math.round(value)));
  // Adjusting state during render rather than in an effect: the box has to show the new number
  // in the same paint the state moved in, or a drag would leave it a frame behind.
  const [seededFrom, setSeededFrom] = useState(value);
  if (seededFrom !== value) {
    setSeededFrom(value);
    setDraft(String(Math.round(value)));
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={fieldId} className="text-muted-foreground text-xs font-normal">
        {label}
      </Label>
      <Input
        id={fieldId}
        type="number"
        value={draft}
        onFocus={onBeginEdit}
        onChange={(event) => {
          const typed = event.target.value;
          setDraft(typed);
          // An empty box, a lone minus sign, and anything else that is not yet a number are all
          // stages of typing one. The state waits.
          if (typed.trim() === '') return;
          const next = Number(typed);
          if (Number.isFinite(next)) onCommit(next);
        }}
        className="h-8 font-mono text-sm"
      />
    </div>
  );
}

/**
 * One direction's worth of the transitions touching a state.
 *
 * Left out entirely when there are none rather than shown empty: a state that nothing points at
 * says more by having no Incoming heading than by having one over the words "none". The whole
 * block is only reached when the state has at least one transition either way, so this can
 * never leave the panel with nothing under the coordinates.
 */
function TransitionLinkList({
  heading,
  links,
  stateName,
  onOpenTransition,
}: {
  heading: 'Outgoing' | 'Incoming';
  links: StateDescription['links'];
  /** For the list's accessible name, since the visible heading alone says "Outgoing" of what. */
  stateName: string;
  onOpenTransition: (from: string, to: string) => void;
}) {
  if (links.length === 0) return null;

  return (
    <div className="space-y-1">
      {/* The count sits against its heading, not against the far edge. Right-aligned it landed
          in the same column as the rows' chevrons and read as one more column of the list, so
          the right edge of the section carried two unrelated things. Beside the word it is
          plainly a property of the word. */}
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <span className="font-medium">{heading}</span>
        <span className="bg-muted rounded px-1.5 py-0.5 text-[10px] tabular-nums">
          {links.length}
        </span>
      </div>
      {/* No box around the rows. Boxing each direction put two frames inside a 320px column,
          which reads as clutter; the heading above and the hover under the cursor are enough to
          say where the list starts and that its rows can be clicked.

          The negative margin is the row padding, so the hover background reaches a little wider
          than the text while the text itself lines up with the heading above it. */}
      <ul className="-mx-1.5" aria-label={`${heading} transitions of state ${stateName}`}>
        {links.map((link, i) => (
          <li key={`${link.from}-${link.to}-${link.label}-${i}`}>
            <button
              type="button"
              onClick={() => onOpenTransition(link.from, link.to)}
              // A grid rather than a flex row, so the chevrons share one fixed column and form
              // a single line down the list however long or short the labels beside them are.
              className="hover:bg-muted focus-visible:ring-ring/70 grid w-full grid-cols-[minmax(0,1fr)_1.25rem] items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs focus-visible:ring-[3px] focus-visible:outline-none"
            >
              <span className="min-w-0 font-mono break-all">
                {link.direction === 'out' ? (
                  <>
                    on {link.label} <span aria-hidden="true">&rarr;</span>
                    <span className="sr-only">to</span> {link.other}
                  </>
                ) : (
                  <>
                    {link.other} <span aria-hidden="true">&rarr;</span> on {link.label}
                  </>
                )}
              </span>
              {/* A real button, so it is reachable by Tab and answers Enter and Space. The
                  chevron says the row leads somewhere; it is not the only thing that does. */}
              <ChevronRight
                className="text-muted-foreground size-3.5 justify-self-end"
                aria-hidden="true"
              />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What a clicked transition is.
 *
 * Plural on purpose: parallel transitions between the same two states are drawn as one line, so
 * clicking it asks about all of them.
 */
const TRANSITION_FIELD_LABEL: Record<string, string> = {
  read: 'Reads',
  pop: 'Pops',
  push: 'Pushes',
  write: 'Writes',
  move: 'Moves',
};

function TransitionProperties({
  edge,
  machineType,
  fields,
  onBeginEdit,
  onEdit,
  onDelete,
  onClose,
}: {
  edge: EdgeDescription;
  /** Named under the title, the same way the state inspector names it. */
  machineType: MachineType;
  /** The parts a transition of this machine has: a PDA pops and pushes, a TM writes and moves. */
  fields: Array<'read' | 'pop' | 'push' | 'write' | 'move'>;
  onBeginEdit: () => void;
  onEdit: (index: number, field: 'read' | 'pop' | 'push' | 'write' | 'move', value: string) => void;
  onDelete: (indices: number[]) => void;
  onClose: () => void;
}) {
  const fieldIdPrefix = useId();

  return (
    <PropertiesPanel
      label={`Properties of the transition from ${edge.from} to ${edge.to}`}
      icon={MoveRight}
      heading="Transition"
      // The pair, under the title rather than beside it: two long state names would otherwise
      // push the machine type off the end of a 320px column.
      subtitle={`${edge.from} → ${edge.to}`}
      closeLabel="Close transition properties"
      closeTooltip="Close the inspector"
      onClose={onClose}
    >
      {/* Which two states, said as a pair of read-only rows rather than left to the subtitle
          alone: the subtitle truncates when the names are long, and these are the transition's
          two defining properties. The machine type joins them, since it is what decides which
          boxes appear below. */}
      <InspectorSection>
        <dl className="grid grid-cols-2 gap-x-2 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">From</dt>
          <dt className="text-muted-foreground">To</dt>
          {/* Not truncated, unlike the subtitle above: long state names have to be readable
              somewhere, and this is the panel's canonical copy of the pair. */}
          <dd className="font-mono break-all">{edge.from}</dd>
          <dd className="font-mono break-all">{edge.to}</dd>
        </dl>
        <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
          <span>{MACHINE_TYPE_LABEL[machineType]}</span>
          {edge.selfLoop ? (
            <Badge variant="outline" className="text-xs">
              Self-loop
            </Badge>
          ) : null}
        </div>
      </InspectorSection>

      {/* One block per transition, because parallel transitions between the same two states are
          drawn as a single line: clicking it asks about all of them, and each is edited on its
          own. The boxes offered are the ones the machine type has, so a Turing machine gets what
          it writes and which way it moves and a finite automaton does not.

          Laid out like the state panel's Name, label over box: this is the same kind of thing,
          and a second shape for it would read as a different one. */}
      <InspectorSection title={edge.transitions.length > 1 ? 'Labels' : 'Label'}>
        {edge.transitions.map((transition, i) => (
          <div key={transition.index} className={cn('space-y-2', i > 0 && 'border-t pt-2.5')}>
            {/* Only when there is more than one to tell apart, and it says which line of the
                label on the drawing this block is. */}
            {edge.transitions.length > 1 ? (
              <div className="text-muted-foreground text-xs">
                Transition {i + 1} of {edge.transitions.length}
              </div>
            ) : null}
            {fields.map((field) => {
              const fieldId = `${fieldIdPrefix}-${transition.index}-${field}`;
              return (
                <div key={field} className="space-y-1.5">
                  <Label htmlFor={fieldId} className="text-muted-foreground text-xs font-normal">
                    {TRANSITION_FIELD_LABEL[field]}
                  </Label>
                  <Input
                    id={fieldId}
                    value={transition[field] ?? ''}
                    // Where this box's undo step begins; see the state panel's name field.
                    onFocus={onBeginEdit}
                    onChange={(event) => onEdit(transition.index, field, event.target.value)}
                    className="h-8 font-mono text-sm"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
              );
            })}
          </div>
        ))}
      </InspectorSection>
      {/* No Advanced here. A transition has no coordinates of its own, and a disclosure over an
          empty box is furniture. */}

      {/* The whole line, which is what the panel is about: parallel transitions between the same
          two states are drawn as one and edited here together, so they go together too. The
          label says how many when there is more than one, since "Delete transition" over three
          of them would be a surprise. */}
      <InspectorDeleteRow
        label={
          edge.transitions.length > 1
            ? `Delete ${edge.transitions.length} transitions`
            : 'Delete transition'
        }
        onDelete={() => onDelete(edge.transitions.map((transition) => transition.index))}
      />
    </PropertiesPanel>
  );
}

/**
 * The machine type, as a coloured chip.
 *
 * At module scope, not inside the viewer. Defined in the body it got a fresh identity on
 * every render, so React unmounted and remounted it each time and the badge element was
 * replaced rather than updated. Harmless to look at and quietly wasteful, and it made any
 * test that held a reference to the badge fail the moment anything else re-rendered.
 */
function TypeBadge({ t }: { t: MachineType }) {
  const label = MACHINE_TYPE_LABEL[t];
  const cls =
    t === 'fa'
      ? 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-200'
      : t === 'pda'
        ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-200'
        : t === 'tm'
          ? 'bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-200'
          : 'bg-muted text-muted-foreground';
  return (
    <Badge variant="outline" className={cls}>
      {label}
    </Badge>
  );
}

/* ───────────────────────────── Viewer component ────────────────────────── */

export function JffCytoscapeViewer({
  src,
  title,
  height = '72vh',
  fill = false,
  epsSymbol = DEFAULT_EPS,
  darkMode,
  showGridDefault = false,
  honorPositionsDefault = false,
  initialZoom = 'fit',
  viewStateKey = null,
  showInspector = true,
  windowTarget,
  onOpenedInWindow,
  onViewportChange,
  linkedViewport,
}: {
  src: string;
  title?: string;
  height?: number | string;
  /** Fill the parent instead of using `height`, for a viewer inside a sized container. */
  fill?: boolean;
  epsSymbol?: string;
  /**
   * Draw for a dark background. Defaults to the page's own theme.
   *
   * It used to default to `false`, and no caller ever passed it, so every diagram was drawn
   * with the light-theme edge and label colour whatever the page was set to. Left overridable
   * because the value has to be forced in tests, where there is no theme provider.
   */
  darkMode?: boolean;
  showGridDefault?: boolean;
  honorPositionsDefault?: boolean;
  /** `fit` scales to the space available; `actual` opens at 100%. See useJffCytoscape. */
  initialZoom?: 'fit' | 'actual';
  /** Remember the zoom, pan and arrangement under this key. See useJffCytoscape. */
  viewStateKey?: string | null;
  /**
   * Whether this viewer may show its properties panel.
   *
   * For the split window, where two machines are on screen and two inspectors would take a
   * third of it between them. The selection itself is untouched: the pane keeps whatever was
   * clicked in it and shows the panel again the moment the reader goes back to that side.
   */
  showInspector?: boolean;
  /** Where the pop-out sends this file, or absent when a link cannot be built for it. */
  windowTarget?: ViewerWindowTarget | null;
  /** Called once the file is on its way to the standalone window. */
  onOpenedInWindow?: () => void;
  /** Report where this machine is being looked at, for a linked pane. See useJffCytoscape. */
  onViewportChange?: ((viewport: ViewerViewport) => void) | null;
  /** Follow another pane's camera. See useJffCytoscape. */
  linkedViewport?: ViewerViewport | null;
}) {
  // `resolvedTheme` rather than `theme`: the latter is "system" for most people, which says
  // nothing about which colours are actually on screen.
  const [resetOpen, setResetOpen] = useState(false);
  const { resolvedTheme } = useTheme();
  const isDark = darkMode ?? resolvedTheme === 'dark';
  // The cytoscape engine (fetch/parse/layout/interaction + zoom/export actions) lives in
  // a hook; this component owns only the toolbar chrome and the grid overlay.
  /**
   * What clicking the canvas means, and the only place that answer lives.
   *
   * The hook is told the consequence rather than the tool (it takes a callback for a click on
   * empty canvas), so it stays about the machine and the palette stays about the palette.
   * Adding a tool later is a case in the palette's own list plus whatever it makes a click do.
   */
  const [activeTool, setActiveTool] = useState<CanvasTool>(DEFAULT_CANVAS_TOOL);
  /**
   * The click handler itself, filled in below once the hook has handed back what it needs.
   *
   * A ref because the answer depends on the hook and the hook depends on the answer. Assigned
   * during render rather than in an effect, so the very first click after a tool changes
   * already means the new thing.
   */
  const backgroundClickRef = useRef<((at: { x: number; y: number }) => boolean) | null>(null);
  const onBackgroundClick = useCallback(
    (at: { x: number; y: number }) => backgroundClickRef.current?.(at) ?? false,
    [],
  );
  /**
   * What the reader has asked to delete, held until they say yes.
   *
   * The element itself rather than a boolean, so the dialog can name what is about to go: "the
   * state q3" tells somebody who clicked the wrong row that they clicked the wrong row, and
   * "Are you sure?" does not.
   */
  const [pendingDelete, setPendingDelete] = useState<
    { kind: 'state'; id: string; name: string } | { kind: 'transitions'; indices: number[] } | null
  >(null);

  /**
   * Escape leaves the State tool.
   *
   * On the window rather than on the viewer, because placing a state leaves focus nowhere in
   * particular: a click on a canvas focuses no element, so a handler on the container would
   * never hear the key that is meant to get the reader out of placement mode. Bound only while
   * a tool other than Select is up, so an ordinary viewer listens for nothing.
   *
   * Not while they are typing. The inspector's boxes are inside this viewer, and Escape there
   * closes the panel; taking the tool away as well would be two answers to one key.
   */
  useEffect(() => {
    if (activeTool === DEFAULT_CANVAS_TOOL) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input, textarea, select')) return;
      setActiveTool(DEFAULT_CANVAS_TOOL);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeTool]);

  const {
    containerRef,
    settled,
    failure,
    phase,
    retry,
    viewModified,
    type,
    honorPositions,
    toggleHonorPositions,
    resetMachine,
    showNotes,
    toggleNotes,
    snapToGrid,
    toggleSnapToGrid,
    canUndo,
    canRedo,
    undo,
    redo,
    selectedState,
    selectedTransition,
    clearSelectedState,
    renameState,
    setInitialState,
    setFinalState,
    setTransitionField,
    selectTransition,
    addState,
    removeState,
    removeTransitions,
    selectedStatePosition,
    beginEdit,
    moveState,
    zoomIn,
    zoomOut,
    zoom,
    setZoom,
    zoomRange,
    fit,
    center,
    downloadSVG,
    downloadPNG,
    downloadCurrent,
    copyPNG,
    copySVG,
    copyDescription,
    parsed,
  } = useJffCytoscape({
    src,
    title,
    epsSymbol,
    darkMode: isDark,
    honorPositionsDefault,
    onBackgroundClick,
    initialZoom,
    viewStateKey,
    onViewportChange,
    linkedViewport,
  });

  // What empty canvas is for, at this moment. Returning false leaves the click alone, which is
  // how the Select tool goes on clearing the selection.
  backgroundClickRef.current = (at) => {
    if (activeTool === 'state') {
      addState(at);
      return true;
    }
    return false;
  };

  /**
   * What the panel is about, and whether it is still wanted.
   *
   * One at a time: a click selects a state or a transition, never both. The panel has to
   * outlive its selection for as long as it takes to slide away, so the last subject is kept
   * and drawn while `open` is false. While it IS open the live one is used instead, or a state
   * renamed with the panel in front of you would go on showing the old name.
   */
  const panelSubject = selectedState
    ? ({ kind: 'state', state: selectedState } as const)
    : selectedTransition
      ? ({ kind: 'transition', edge: selectedTransition } as const)
      : null;
  const panelOpen = panelSubject !== null && showInspector;
  const lastPanelSubject = useRef(panelSubject);
  if (panelSubject) lastPanelSubject.current = panelSubject;
  const [panelMounted, setPanelMounted] = useState(panelOpen);
  /**
   * Whether the inspector's Advanced disclosure is open. Open to begin with: it holds the
   * coordinates, and putting them in a section is about order, not about hiding them.
   *
   * Held here rather than in the panel because the panel is rebuilt for every state clicked, so
   * a flag living there would spring back open each time and the reader's answer would never
   * stick. It lasts as long as this viewer does and is written nowhere.
   */
  const [advancedOpen, setAdvancedOpen] = useState(true);
  useEffect(() => {
    if (panelOpen) {
      setPanelMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setPanelMounted(false), PANEL_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [panelOpen]);
  const panel = panelMounted ? (panelSubject ?? lastPanelSubject.current) : null;

  // Non-visual alternative. The canvas is unreadable to a screen reader, and reading
  // automata is the point of this viewer, so the same machine is also published as text:
  // a one-line summary attached to the graph, plus the full state/transition listing.
  const description = parsed ? describeMachine(parsed, epsSymbol) : null;
  const summaryId = 'jff-graph-summary';
  const [showText, setShowText] = useState(false);

  const [grid, setGrid] = useState(showGridDefault);

  // In the standalone window a menu bar offers the grid and the layout, so the toolbar drops
  // them rather than showing the same two controls twice. False in every dialog, where the
  // toolbar is the only place they exist.
  const chromeHasViewControls = useViewerChromePresent();

  // Offered to any chrome around this viewer, which today means the standalone window's menu
  // bar. Registers nothing when there is no provider, so a dialog is unaffected. Declared
  // after the grid state because it publishes it: the menu shows the grid ticked or not, and
  // the toolbar button below stays the same control on the same state.
  useRegisterViewerActions(
    {
      downloadSVG,
      downloadPNG,
      downloadCurrent,
      copyPNG,
      copySVG,
      undo,
      redo,
      toggleGrid: () => setGrid((on) => !on),
      toggleNotes,
      toggleSnapToGrid,
      fitToWindow: fit,
      centerInWindow: center,
      showTextRepresentation: () => setShowText(true),
      // Set rather than toggled, so the menu's two options are a choice between states and
      // selecting the one already showing does nothing.
      setAsDrawn: () => {
        if (!honorPositions) toggleHonorPositions();
      },
      setAutoArranged: () => {
        if (honorPositions) toggleHonorPositions();
      },
      resetMachine,
    },
    {
      grid,
      notes: showNotes,
      snapToGrid,
      layout: honorPositions ? 'as-drawn' : 'auto',
      canUndo,
      canRedo,
    },
  );

  // Grid lines read the theme var live (subtle light gray in light mode, subtle dark line in
  // dark mode). The literal is only a fallback, and being a literal is what keeps the server
  // and client markup identical.
  const gridLine = `var(--grid-color, ${GRID_COLOR_FALLBACK})`;
  // Only the lines. Their SIZE and POSITION are written straight to the element by the engine,
  // which keeps them in step with the graph's zoom and pan; listing them here as well would
  // have React reset them to these values on every render and the grid would stop tracking.
  const backgroundStyle: React.CSSProperties = grid
    ? {
        backgroundImage: `linear-gradient(${gridLine} 1px, transparent 1px), linear-gradient(90deg, ${gridLine} 1px, transparent 1px)`,
      }
    : {};

  // White fill so the outline/idle buttons stand out against the gray toolbar.
  const controlBtnClass = 'bg-card';

  return (
    <div
      className={cn(
        'bg-card w-full overflow-hidden border',
        // Rounded and fully bordered as a card inside a dialog. In the standalone window it is
        // the window's content rather than a card in it, and the rounding would put a gap
        // between the title tab and the toolbar it is meant to sit on.
        chromeHasViewControls ? 'rounded-none border-0' : 'rounded-md',
        fill && 'flex h-full flex-col',
      )}
    >
      {/* Toolbar: muted gray so it reads as a distinct control strip above the white body */}
      {/* Wraps rather than overflowing: in the Similarity tab's side-by-side comparison this
          toolbar sits in a half-width pane, where a single row ran its controls into each
          other. At full width it still fits on one line. */}
      <div className="bg-background flex shrink-0 flex-wrap items-center justify-between gap-2 border-b p-2">
        <div className="flex min-w-0 items-center gap-2">
          {/* Title is shown in the dialog header above; only the type label lives here. */}
          <TypeBadge t={type} />
          {/*
            Whether the drawing has been changed, and what to do about it.

            Quiet on purpose: it sits beside the type label rather than announcing itself, and
            it is only there once something has actually been moved. What it answers is a
            question nobody asks out loud: dragging three states apart to read an edge looks
            like editing, and a reader has no way of knowing from the screen that the file they
            were sent is untouched. It says so, and offers the two things they might want next.
          */}
          {viewModified ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground h-6 gap-1 px-2 text-xs font-normal"
                >
                  <PencilLine className="h-3 w-3" aria-hidden="true" />
                  File changed
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-w-xs">
                <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
                  You have changed how this is shown, by moving states about or renaming one. The
                  submitted file is unchanged, and nothing here writes to it.
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void downloadCurrent()}>
                  <FileDown aria-hidden="true" />
                  Download this arrangement
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setResetOpen(true)}>
                  <RotateCcw aria-hidden="true" />
                  Put it back
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {/* View controls */}
          <div className="flex items-center gap-1" role="group" aria-label="View controls">
            {chromeHasViewControls ? null : (
              <>
                <Button
                  size="sm"
                  variant={grid ? 'default' : 'outline'}
                  className={grid ? undefined : controlBtnClass}
                  onClick={() => setGrid((s) => !s)}
                  title="Toggle grid"
                  aria-label="Toggle grid"
                  aria-pressed={grid}
                >
                  <Grid className="mr-2 h-4 w-4" /> Grid
                </Button>
              </>
            )}
            {/* Only in the standalone window. Disabled rather than hidden there, so the
                toolbar keeps its shape and their position stays learnable. A panel over the
                page is for a look rather than for rearranging a machine, and it has no menu
                to pair them with. They step through arrangement changes only; see
                useJffCytoscape. */}
            {chromeHasViewControls ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className={controlBtnClass}
                  onClick={undo}
                  disabled={!canUndo}
                  title="Undo"
                  aria-label="Undo"
                >
                  <Undo2 className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className={controlBtnClass}
                  onClick={redo}
                  disabled={!canRedo}
                  title="Redo"
                  aria-label="Redo"
                >
                  <Redo2 className="h-4 w-4" />
                </Button>
                <div
                  className="bg-muted-foreground/40 mx-0.5 h-6 w-px shrink-0"
                  aria-hidden="true"
                />
              </>
            ) : null}
            {/* One bordered group holding the two buttons, the value they change, and the
                slider that changes it continuously. Four separate controls in a row read as
                four unrelated things; a single container says they are one. */}
            <div
              className="border-input bg-card flex h-8 items-center gap-0.5 rounded-md border px-0.5"
              role="group"
              aria-label="Zoom"
            >
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 shrink-0 p-0"
                onClick={zoomOut}
                title="Zoom out"
                aria-label="Zoom out"
              >
                <Minus className="h-4 w-4" />
              </Button>
              {/* Fixed width and tabular numerals, so the toolbar does not shift sideways as
                  the value moves between 50% and 200%. State rather than a control: it is not
                  focusable and does nothing when clicked, and the slider beside it carries the
                  same value for anybody who cannot see this. */}
              <span className="text-muted-foreground w-11 shrink-0 text-center text-xs tabular-nums">
                {zoomPercentLabel(zoom)}
              </span>
              {/* Log scale, so 100% sits near the middle of the track rather than against the
                  left end; see lib/zoom-scale. Shortest thing here, and the first to give way
                  when the toolbar is tight. */}
              <Slider
                className="w-14 shrink-0 sm:w-20"
                min={ZOOM_SLIDER_MIN}
                max={ZOOM_SLIDER_MAX}
                step={1}
                value={[zoomToSlider(zoom, zoomRange().min, zoomRange().max)]}
                onValueChange={([next]) => {
                  const { min, max } = zoomRange();
                  if (next !== undefined) setZoom(sliderToZoom(next, min, max));
                }}
                aria-label="Zoom level"
                aria-valuetext={zoomPercentSpoken(zoom)}
              />
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 shrink-0 p-0"
                onClick={zoomIn}
                title="Zoom in"
                aria-label="Zoom in"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            {/* The same rule the toolbar uses elsewhere, so the zoom controls read as one group
                and Fit and Center as another rather than as one long row of buttons. */}
            <div className="bg-muted-foreground/40 mx-0.5 h-6 w-px shrink-0" aria-hidden="true" />
            {/* Outside the group: it sets the zoom rather than nudging it, and it is the one
                control here somebody reaches for without knowing what the current value is.
                The label drops below `sm`, where the icon and the tooltip carry it. */}
            <Button
              size="sm"
              variant="outline"
              className={cn(controlBtnClass, 'h-8 shrink-0')}
              onClick={fit}
              title="Fit automaton to view"
              aria-label="Fit automaton to view"
            >
              <Scan className="h-4 w-4 sm:mr-2" />
              <span className="sr-only sm:not-sr-only">Fit</span>
            </Button>
            {/* Beside Fit because they answer the same question, "I have lost the machine",
                differently: Fit brings all of it back and gives up the reader's magnification,
                this brings it back at the scale they chose. */}
            <Button
              size="sm"
              variant="outline"
              className={cn(controlBtnClass, 'h-8 shrink-0')}
              onClick={center}
              title="Center automaton in view"
              aria-label="Center automaton in view"
            >
              <Crosshair className="h-4 w-4 sm:mr-2" />
              <span className="sr-only sm:not-sr-only">Center</span>
            </Button>
          </div>

          {/* The exports and the layout choice are not offered here. In a panel over the
              page they crowded a strip that has to fit beside another one in the Similarity
              comparison, and everything they did is in the standalone window's menus. This
              is the way there, so what was a row of buttons is one. */}
          {windowTarget ? (
            <>
              {/* Separator between control groups */}
              <div className="bg-muted-foreground/40 mx-0.5 h-6 w-px shrink-0" aria-hidden="true" />
              <OpenInWindowButton
                href={windowTarget.href}
                tab={windowTarget.tab}
                onOpened={onOpenedInWindow}
              />
            </>
          ) : null}
        </div>
      </div>

      {/*
        A render failure, outside the graph container.
        `role="img"` makes everything inside the container presentational, so an error message
        placed in there was never reachable: a file that failed to parse announced as "Diagram
        of x.jff, image" and nothing else, with no text alternative either, because there is
        nothing parsed to describe.
      */}
      {/* The same question the standalone window's menu asks, for the same reason: a reader can
          spend a while pulling a crowded machine apart and there is no undo once the history
          has gone with it. */}
      {/* Deleting is the one thing in this panel that cannot be seen coming: a name typed wrong
          is typed again, and a tick box is ticked back, but a state and its transitions leaving
          the drawing at a click is worth a question first. Undo takes it back either way. */}
      <ConfirmDialog
        open={pendingDelete !== null}
        variant="destructive"
        // The title names what is going, so somebody who clicked the wrong row is told which
        // row they clicked.
        title={
          pendingDelete?.kind === 'state'
            ? `Delete state ${pendingDelete.name}?`
            : pendingDelete && pendingDelete.indices.length > 1
              ? `Delete ${pendingDelete.indices.length} transitions?`
              : 'Delete this transition?'
        }
        description={
          pendingDelete?.kind === 'state'
            ? 'Are you sure you want to delete this state?'
            : 'Are you sure you want to delete this transition?'
        }
        confirmText="Delete"
        onConfirm={() => {
          if (pendingDelete?.kind === 'state') removeState(pendingDelete.id);
          else if (pendingDelete) removeTransitions(pendingDelete.indices);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        open={resetOpen}
        title="Put the machine back?"
        description="The states return to where the file has them, and the layout, the zoom and the undo history for this machine are forgotten. The submitted file is not changed."
        confirmText="Put it back"
        onConfirm={() => {
          resetMachine();
          setResetOpen(false);
        }}
        onCancel={() => setResetOpen(false)}
      />

      {failure ? (
        <div role="alert" className="px-4 py-6 text-sm" data-testid="viewer-failure">
          <p className="text-foreground font-semibold">{failure.title}</p>
          <p className="text-muted-foreground mt-1 max-w-prose">{failure.detail}</p>
          {failure.retryable ? (
            <Button size="sm" variant="outline" className="mt-3" onClick={retry}>
              <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* The rendered graph. role="img" + a description keeps a screen reader from
          wandering into cytoscape's internals while still conveying what it shows. */}
      {/*
        The machine and, when something is selected, the panel describing it.

        A row rather than a single box, because on a wide pane the properties dock beside the
        drawing and the drawing gives up the width: the canvas is the flexible half and the
        panel is a fixed column. On a narrow one the panel takes itself out of the flow and the
        row has a single child again. `@container/viewer` is what the panel's own query reads,
        and it is here rather than on the canvas because this width does not change when the
        panel opens.

        Still positioned, because cytoscape owns the container's children and anything laid over
        the drawing has to be a sibling of it.
      */}
      <div
        // The row owns the height when the caller gave one, rather than the canvas inside it.
        // With it on the canvas, a docked panel taller than the drawing stretched the row and
        // left a strip of nothing under the machine. In fill mode the flex track supplies it.
        style={fill ? undefined : { height }}
        className={cn('@container/viewer relative flex', fill ? 'min-h-0 flex-1' : undefined)}
      >
        {/* The drawing's own column. The overlays below belong to the machine, not to the pane,
            so they are positioned against this rather than against the row: a loading message
            centred over the row would drift sideways as the panel opened. */}
        <div className={cn('relative flex min-w-0 flex-1 flex-col', fill ? 'min-h-0' : undefined)}>
          <div
            ref={containerRef}
            style={backgroundStyle}
            // The ordinary arrow at rest, a closed hand while the button is down and the graph is
            // being dragged. Not an open hand throughout: that reads as "this whole surface is a
            // handle" over a diagram whose states and transitions are the things worth pointing
            // at. `cursor` inherits, so the canvases cytoscape puts inside pick this up without
            // being styled themselves.
            className={cn(
              // Fills its column in both modes now that the row carries the height.
              'bg-card relative min-h-0 flex-1 cursor-default overflow-hidden active:cursor-grabbing',
              // The CANVASES are held back, not this container. Cytoscape paints the moment it
              // is constructed, at whatever scale the file's own coordinates imply, and the fit
              // runs after: unhidden, the machine arrives at the wrong size and visibly jumps.
              //
              // Hiding the container instead (which is what this was) took the grid and the
              // surface with it, so the toolbar sat fully drawn above a blank white rectangle
              // for about half a second and then everything appeared at once. Keeping the
              // prepared canvas visible and fading in only the drawing is the difference
              // between a panel that is loading and a panel that looks broken.
              '[&_canvas]:transition-opacity [&_canvas]:duration-150',
              'motion-reduce:[&_canvas]:transition-none',
              settled ? '[&_canvas]:opacity-100' : '[&_canvas]:opacity-0',
            )}
            role="img"
            aria-label={
              failure
                ? 'The diagram could not be drawn'
                : title
                  ? `Diagram of ${title}`
                  : 'Automaton diagram'
            }
            aria-describedby={description ? summaryId : undefined}
          />
          {/* What this pane is doing, over the prepared canvas rather than instead of it. Named
            steps rather than one spinner: with two machines on screen, one can still be
            fetching while the other is already drawing, and "loading" for both says less than
            either of them could. */}
          {!failure && phase !== 'ready' ? (
            <div
              className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
              data-testid="viewer-loading"
            >
              <LoadingSpinner label={PHASE_LABEL[phase]} fullScreen={false} className="min-h-0" />
            </div>
          ) : null}
        </div>

        {/* The canvas's own tools, opposite the inspector and treated the same way: floating over
            the drawing, never taking width from it. Only where the inspector would show, which
            in a split window is the side being worked in: two palettes would be two answers to
            "which machine does this draw on".

            A click on it never reaches cytoscape, so it cannot draw a state under itself. That
            is true of the toolbar, the tabs and the menus for the same reason: only the canvas
            fires the tap that places one. */}
        {showInspector ? (
          <CanvasToolPalette activeTool={activeTool} onSelectTool={setActiveTool} />
        ) : null}

        {panel === null ? null : (
          <PanelFrame open={panelOpen}>
            {panel.kind === 'state' ? (
              <StateProperties
                // By id, so the name box is re-seeded when the reader clicks a different state.
                key={panel.state.id}
                state={panel.state}
                machineType={type}
                advancedOpen={advancedOpen}
                onAdvancedOpenChange={setAdvancedOpen}
                onRename={renameState}
                onSetInitial={setInitialState}
                onSetFinal={setFinalState}
                onOpenTransition={selectTransition}
                position={selectedStatePosition}
                onBeginEdit={beginEdit}
                onMove={moveState}
                onDelete={(id) => setPendingDelete({ kind: 'state', id, name: panel.state.name })}
                onClose={clearSelectedState}
              />
            ) : (
              <TransitionProperties
                edge={panel.edge}
                machineType={type}
                fields={transitionFields(type)}
                onBeginEdit={beginEdit}
                onEdit={setTransitionField}
                onDelete={(indices) => setPendingDelete({ kind: 'transitions', indices })}
                onClose={clearSelectedState}
              />
            )}
          </PanelFrame>
        )}
      </div>

      {description ? (
        chromeHasViewControls ? (
          <>
            {/* The summary is still here, just not on screen. It is what `aria-describedby` on
          the canvas points at, and a canvas with no text alternative is unreadable to a
          screen reader, so it is hidden visually rather than removed. */}
            <p id={summaryId} className="sr-only">
              {description.summary}
            </p>
            <Dialog open={showText} onOpenChange={setShowText}>
              <DialogContent className="max-h-[80vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Text representation</DialogTitle>
                  <DialogDescription>{description.summary}</DialogDescription>
                </DialogHeader>
                {/* Beside the thing it copies, rather than in a menu two levels away. This is
                    the only export that can be quoted in a reply, and it is most obviously
                    wanted while looking at the text it produces. */}
                <div className="flex justify-end">
                  <Button type="button" size="sm" variant="outline" onClick={copyDescription}>
                    <Copy className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                    Copy as text
                  </Button>
                </div>
                <div className="text-sm">
                  <MachineDescriptionList description={description} />
                </div>
              </DialogContent>
            </Dialog>
          </>
        ) : (
          // Capped and scrollable on its own: the listing can be long, and it must not steal
          // height from the graph or grow the dialog. Focusable with it, because past the
          // toggle there is nothing tabbable, so the states and transitions this panel exists
          // to expose could not be scrolled to by keyboard.
          <div
            className="max-h-40 shrink-0 overflow-y-auto border-t px-3 py-2"
            tabIndex={0}
            role="group"
            aria-label="Description of this file"
          >
            <p id={summaryId} className="text-muted-foreground text-xs">
              {description.summary}
            </p>

            <button
              type="button"
              onClick={() => setShowText((v) => !v)}
              aria-expanded={showText}
              aria-controls="jff-text-representation"
              className="text-foreground focus-visible:ring-ring mt-1 rounded text-xs underline focus-visible:ring-2 focus-visible:outline-none"
            >
              {showText ? 'Hide text representation' : 'Show text representation'}
            </button>

            {/* Kept mounted so aria-controls always resolves. */}
            <div id="jff-text-representation" hidden={!showText} className="mt-2 text-xs">
              <MachineDescriptionList description={description} />
            </div>
          </div>
        )
      ) : null}
    </div>
  );
}

/* ───────────────────────────── Dialog wrapper ──────────────────────────── */

export default function JffViewerDialog({
  open,
  onOpenChange,
  src,
  title,
  width = '80vw',
  height = '85vh',
  epsSymbol = DEFAULT_EPS,
  darkMode,
  showGridDefault = true,
  honorPositionsDefault = true,
  windowTarget,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  src: string;
  title?: string;
  width?: string;
  height?: number | string;
  epsSymbol?: string;
  darkMode?: boolean;
  showGridDefault?: boolean;
  honorPositionsDefault?: boolean;
  /** Where the pop-out sends this file, or absent when a link cannot be built for it. */
  windowTarget?: ViewerWindowTarget | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* A column bounded by the viewport, so the graph takes whatever is left after the
          header and never pushes the dialog past the screen. It used to be a fixed 85vh
          canvas inside an `overflow-auto` box that was itself capped at the viewport, so
          the two scrollbars were guaranteed: the parts simply added up to more than the
          screen. Nothing here scrolls now; the graph pans and zooms instead. */}
      <DialogContent
        className="flex h-[calc(100vh-2rem)] max-h-[calc(100vh-2rem)] !max-w-none flex-col overflow-hidden p-0"
        style={{ width }}
      >
        <DialogHeader className="shrink-0 px-4 pt-4">
          {/* Wraps to a second line rather than truncating. These titles are a file name
              followed by the problem's own title, so the ellipsis landed mid-name and cut
              off the part that identifies the file. Two lines, then it clips.

              `leading-snug` overrides the shared title's `leading-none`: a line-height of
              exactly 1 leaves no room below the baseline, and clamping adds the
              `overflow: hidden` that turns that into a visible cut, beheading the
              descender of the j in every `.jff`. */}
          <div className="flex items-start justify-between gap-4 pr-6">
            <DialogTitle className="line-clamp-2 leading-snug break-words">
              {title ?? 'JFLAP Viewer'}
            </DialogTitle>
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 p-4 pt-2">
          {open ? (
            <JffCytoscapeViewer
              src={src}
              title={title}
              fill
              height={height}
              epsSymbol={epsSymbol}
              darkMode={darkMode}
              showGridDefault={showGridDefault}
              honorPositionsDefault={honorPositionsDefault}
              windowTarget={windowTarget}
              // The reader asked for this machine somewhere else. Leaving the panel up would
              // mean dismissing it before they could use the window, with the same file
              // showing twice in the meantime.
              onOpenedInWindow={() => onOpenChange(false)}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
