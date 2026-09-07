'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

import type { CanvasTool } from './CanvasToolPalette';

/**
 * The actions a rendered machine can perform on itself, published to whatever chrome is
 * around it.
 *
 * The export actions belong to the cytoscape instance, which lives inside the viewer, while
 * the menu that offers them belongs to the window. Rather than lift the whole engine or hand
 * the viewer a menu to render, the viewer publishes its actions here and the chrome picks
 * them up. Nothing outside the standalone window provides this context, so the same viewer
 * inside a dialog registers nothing and behaves exactly as before.
 */
export type ViewerActions = {
  // The three exports are async (they rasterise or reach the clipboard). Typed to allow it
  // rather than as `() => void`, because a promise handed to a void-returning slot is a
  // floating promise the linter is right to refuse.
  downloadSVG: () => void | Promise<void>;
  downloadPNG: () => void | Promise<void>;
  copyPNG: () => void | Promise<void>;
  /** The machine as it currently sits, as a .jff, including any auto-arranged layout. */
  downloadCurrent: () => void | Promise<void>;
  /** The drawing as SVG markup, which pastes as vector art rather than a bitmap. */
  copySVG: () => void | Promise<void>;
  undo: () => void;
  redo: () => void;
  toggleGrid: () => void;
  /** Show or hide the notes the author wrote on the canvas. */
  toggleNotes: () => void;
  /** Land a dragged state on the grid, or leave it where it was dropped. */
  toggleSnapToGrid: () => void;
  /** Open the machine written out as text, for reading or checking a transition. */
  showTextRepresentation: () => void;
  /** Scale and centre the machine so all of it is on screen. */
  fitToWindow: () => void;
  /** Bring the machine back to the middle without changing the scale the reader set. */
  centerInWindow: () => void;
  /** Draw the machine where the author put the states, rather than auto-arranging it. */
  setAsDrawn: () => void;
  /** Let the layout engine place the states. */
  setAutoArranged: () => void;
  /** Put this machine back the way it opened, discarding the reader's rearranging of it. */
  resetMachine: () => void;
  /**
   * Choose a canvas tool, exactly as clicking its palette button does.
   *
   * Four commands rather than one that takes the tool, because `run` calls these by name and
   * takes no arguments, and four names is a smaller thing to carry than an argument channel
   * for one caller. Each is a no-op when its tool is not available here, so a keyboard route
   * cannot reach a tool the palette would not offer.
   */
  /**
   * Line the selected states up, or spread them out evenly.
   *
   * Named one per command, like the tools above, because `run` calls these by name and takes
   * no arguments. Each does nothing when too few states are selected to mean anything, which
   * the menu also shows by greying them.
   */
  alignLeft: () => void;
  alignCenter: () => void;
  alignRight: () => void;
  alignTop: () => void;
  alignMiddle: () => void;
  alignBottom: () => void;
  distributeHorizontally: () => void;
  distributeVertically: () => void;
  selectSelectTool: () => void;
  selectStateTool: () => void;
  selectTransitionTool: () => void;
  selectCommentTool: () => void;
};

/** View state the chrome needs to render, as opposed to actions it can invoke. */
export type ViewerViewState = {
  /** Whether the grid is currently drawn, so a menu can show it ticked. */
  grid: boolean;
  /** Whether the author's notes are being drawn. */
  notes: boolean;
  /** Whether a dragged state lands on the grid. */
  snapToGrid: boolean;
  /** Whether there is anything to step back to, or forward to. */
  canUndo: boolean;
  canRedo: boolean;
  /** Which layout is showing, so a menu can mark one of the two. */
  layout: 'as-drawn' | 'auto';
  /**
   * The tools this viewer can offer, from its own capabilities.
   *
   * Published so the chrome can tell a shortcut it will not act on from one it will, and leave
   * the key press to the browser in the first case. The capability rules stay in one place:
   * this is `availableCanvasTools` as the viewer already computed it.
   */
  tools: readonly CanvasTool[];
  /**
   * How many states are picked out, so the chrome can grey a command that needs more.
   *
   * The count rather than the ids: nothing outside the viewer acts on which states they are,
   * and a number does not re-render the menu every time the selection changes shape.
   */
  selectedStates: number;
};

/**
 * Functions, not a ref.
 *
 * The registry is deliberately a pair of stable callbacks closing over the provider's own
 * ref, rather than the ref itself: reaching into a value returned by `useContext` and
 * assigning to it is exactly what the compiler's immutability rule forbids, and the rule is
 * right. Calling in is fine; writing through is not.
 */
type Registry = {
  register: (actions: ViewerActions | null, view: ViewerViewState | null) => void;
  run: (name: keyof ViewerActions) => void;
};

/**
 * Three contexts, each answering a different question.
 *
 * The registry never changes identity, so the effect that depends on it runs on mount and
 * unmount only. Whether a viewer is present does change, so it lives on its own and cannot
 * drag the registry with it.
 *
 * Chrome presence is the third and is separate from the registry on purpose. It used to be
 * derived from it, which was right while only one viewer was ever on screen. In a split window
 * both panes are visible but only one may register, so a viewer reading the registry would
 * conclude it was in a dialog: it would grow back the grid and layout controls the menu
 * already offers, and take the card border a panel has, and the two panes would swap
 * appearance every time focus moved between them. Whether there is a menu bar and which
 * viewer it is driving are two questions.
 */
const ViewerRegistryContext = createContext<Registry | null>(null);
const ViewerChromeContext = createContext(false);
const ViewerViewContext = createContext<{
  ready: boolean;
  grid: boolean;
  notes: boolean;
  snapToGrid: boolean;
  layout: ViewerViewState['layout'];
  canUndo: boolean;
  canRedo: boolean;
  tools: readonly CanvasTool[];
  selectedStates: number;
}>({
  ready: false,
  grid: false,
  notes: true,
  snapToGrid: false,
  layout: 'as-drawn',
  canUndo: false,
  canRedo: false,
  tools: [],
  selectedStates: 0,
});

export function ViewerActionsProvider({ children }: { children: React.ReactNode }) {
  const actions = useRef<ViewerActions | null>(null);
  // Only presence is state. The functions themselves stay in the ref, because the viewer
  // rebuilds them on most renders and holding them in state would re-render the menu each
  // time for no gain.
  const [ready, setReady] = useState(false);
  // The grid flag is state, unlike the actions, because a menu has to re-render to show it
  // ticked. It changes only when somebody toggles it, so this costs nothing.
  const [grid, setGrid] = useState(false);
  const [notes, setNotes] = useState(true);
  const [snapToGrid, setSnapToGrid] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [layout, setLayout] = useState<ViewerViewState['layout']>('as-drawn');
  // A string, not the array: the viewer builds a fresh array on most renders, and comparing
  // the join is what stops this re-rendering the chrome every time it does.
  const [toolList, setToolList] = useState('');
  const [selectedStates, setSelectedStates] = useState(0);

  // `useRef` and the `useState` setter are both stable, so this is built once.
  const view = useMemo(
    () => ({
      ready,
      grid,
      notes,
      snapToGrid,
      layout,
      canUndo,
      canRedo,
      tools: toolList ? (toolList.split(' ') as CanvasTool[]) : [],
      selectedStates,
    }),
    [ready, grid, notes, snapToGrid, layout, canUndo, canRedo, toolList, selectedStates],
  );

  const registry = useMemo<Registry>(
    () => ({
      register: (next, view) => {
        actions.current = next;
        // Both setters bail when the value is unchanged, which is what makes it safe to call
        // this after every render of the viewer.
        setReady(next !== null);
        setGrid(view?.grid ?? false);
        setNotes(view?.notes ?? true);
        setSnapToGrid(view?.snapToGrid ?? false);
        setCanUndo(view?.canUndo ?? false);
        setCanRedo(view?.canRedo ?? false);
        setLayout(view?.layout ?? 'as-drawn');
        setToolList((view?.tools ?? []).join(' '));
        setSelectedStates(view?.selectedStates ?? 0);
      },
      // `void`: three of these are async, and their result is nothing the caller waits on.
      run: (name) => {
        void actions.current?.[name]();
      },
    }),
    [],
  );

  return (
    <ViewerChromeContext.Provider value={true}>
      <ViewerRegistryContext.Provider value={registry}>
        <ViewerViewContext.Provider value={view}>{children}</ViewerViewContext.Provider>
      </ViewerRegistryContext.Provider>
    </ViewerChromeContext.Provider>
  );
}

/**
 * Publish this viewer's actions. A no-op when there is no provider, which is the case in
 * every dialog.
 */
export function useRegisterViewerActions(actions: ViewerActions, view: ViewerViewState): void {
  const registry = useContext(ViewerRegistryContext);

  // After every render, so the menu always calls the current instance's actions and shows
  // its current view state. Setting an unchanged value is a no-op, so this does not loop.
  useEffect(() => {
    registry?.register(actions, view);
  });

  // Withdraw on unmount, so a closed viewer does not leave the menu offering actions that
  // would run against a torn-down graph.
  useEffect(() => {
    return () => registry?.register(null, null);
  }, [registry]);
}

/**
 * Let one of several viewers reach the chrome, and cut the rest off from it.
 *
 * The standalone window keeps every tab a reader has opened mounted, which is what preserves
 * each one's zoom, arrangement and undo history while another is on screen. Registering
 * happens after every render, so without this the menu would be driven by whichever viewer
 * rendered last rather than the one being looked at.
 *
 * Always in the tree, never conditionally around the viewer: a wrapper that came and went
 * would change the shape of the tree at that position, React would unmount the viewer, and
 * the state this exists to preserve would go with it.
 */
export function ViewerActionsGate({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  const registry = useContext(ViewerRegistryContext);
  return (
    <ViewerRegistryContext.Provider value={active ? registry : null}>
      {children}
    </ViewerRegistryContext.Provider>
  );
}

/**
 * Whether something around this viewer offers its view controls.
 *
 * Read by the viewer itself so it can drop the duplicates from its toolbar. Taken from the
 * context rather than passed as a prop on purpose: the thing that decides to show a menu is
 * the thing that provides the context, so the two cannot drift into a state where the
 * controls are offered twice or not at all. Deliberately not the registry: see above, and note
 * that the gate below never touches this one.
 */
export function useViewerChromePresent(): boolean {
  return useContext(ViewerChromeContext);
}

/** What the chrome can offer right now. */
export function useViewerActions(): {
  ready: boolean;
  grid: boolean;
  notes: boolean;
  snapToGrid: boolean;
  layout: ViewerViewState['layout'];
  canUndo: boolean;
  canRedo: boolean;
  tools: readonly CanvasTool[];
  selectedStates: number;
  run: (name: keyof ViewerActions) => void;
} {
  const registry = useContext(ViewerRegistryContext);
  const { ready, grid, notes, snapToGrid, layout, canUndo, canRedo, tools, selectedStates } =
    useContext(ViewerViewContext);
  const run = registry?.run;
  return {
    ready,
    grid,
    notes,
    snapToGrid,
    layout,
    canUndo,
    canRedo,
    tools,
    selectedStates,
    run: (name) => run?.(name),
  };
}
