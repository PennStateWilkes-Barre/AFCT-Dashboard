/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  bestLoopDirection,
  bestStartMarkerDirection,
  edgeLabelOffset,
  loopLabelOffset,
  startMarkerPolygon,
  startMarkerPosition,
  FINAL_STATE_BORDER_WIDTH,
  LABEL_LINE_HEIGHT,
  LOOP_REACH,
  NODE_DIAMETER,
  stateFontSize,
  NOTE_FONT_SIZE,
  NOTE_MAX_WIDTH,
  START_MARKER_SIZE,
  STATE_BORDER_WIDTH,
} from '@/lib/jflap-layout';
import { toJflapXml } from '@/lib/jflap-write';
import {
  failureForContent,
  failureForNetwork,
  failureForStatus,
  type ViewerLoadFailure,
} from '@/lib/viewer-load-failure';
import {
  clearViewState,
  readViewState,
  writeViewState,
  viewStateFits,
  historyFits,
  VIEWER_HISTORY_LIMIT,
  type ViewerHistoryStep,
  type ViewerSelection,
  type ViewerViewport,
  type ViewerViewState,
} from '@/lib/viewer-view-state';
import {
  bundleEdges,
  describeMachine,
  describeEdge,
  describeState,
  machineDescriptionText,
  parseJflap,
  toElements,
  type MachineType,
  type Parsed,
} from '@/lib/jflap-parse';

/* ───────────────────────────── Types & consts ───────────────────────────── */

/*
 * JFLAP's own palette, read out of the `gui` classes in `jars/afct-evaluator.jar` rather
 * than eyeballed, so a student sees the same automaton here as in the desktop tool:
 *
 *   gui/viewer/StateDrawer.STATE_COLOR      = Color(255, 255, 150)  the state fill
 *   gui/viewer/StateDrawer.HIGHLIGHT_COLOR  = Color(100, 200, 200)
 *   gui/Globals.FROM_COLOR                  = Color( 37,  99, 235)  the selection blue
 *
 * JFLAP draws the outline and the state's own name in black on that fill, which reads
 * correctly on either theme because it sits INSIDE the yellow circle.
 *
 * These are literals, not `var(--node-color)`. Cytoscape renders to canvas and parses
 * colours itself; it does not understand the `oklch()` this app's tokens are written in,
 * so every one of those custom properties was silently rejected and the states fell back
 * to cytoscape's default grey. That is why they were grey rather than the yellow the
 * token already specified.
 */
const STATE_FILL = '#ffff96';
const STATE_STROKE = '#000000';
const STATE_TEXT = '#000000';
const HIGHLIGHT_COLOR = '#2563eb';

const NODE_FILL = STATE_FILL;

const EDGE_WIDTH = 1.6;
export const DEFAULT_EPS = 'ε';

/* ─────────────────────── Cytoscape + ELK (lazy load) ───────────────────── */

let cyPkg: any = null;
let initDone = false;

async function ensureCytoscapeReady() {
  if (!cyPkg) {
    const cytoscape = (await import('cytoscape')).default;
    cyPkg = cytoscape;
  }
  if (!initDone) {
    const elk = (await import('cytoscape-elk')).default;
    const svgExt = (await import('cytoscape-svg')).default;
    cyPkg.use(elk);
    cyPkg.use(svgExt);
    initDone = true;
  }
  return cyPkg;
}

/* ────────────────────────────── Export helpers ─────────────────────────── */

async function downloadDataUrl(filename: string, dataUrl: string) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

// Debounce utility for resize
function debounce(fn: () => void, ms: number) {
  let timer: any;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

// Where every transition label has ended up, for the things that have to dodge them.
// Only meaningful once `updateEdgeLabelMargins` has run.
function edgeLabelAnchors(cy: any): { x: number; y: number }[] {
  return cy
    .edges()
    .filter((e: any) => e.data('isLoop') !== 1 && String(e.data('label') ?? '') !== '')
    .map((e: any) => {
      const mid = e.midpoint();
      const off = edgeLabelOffset(e.source().position(), e.target().position(), mid);
      return { x: mid.x + off.x, y: mid.y + off.y };
    });
}

// The ground this state's self-loops cover: the far side of each loop and where its label
// sits. A loop is a wide arc rather than a line, so an angle alone describes it badly and
// left the initial-state marker grazing one; these are the two points it actually has to
// keep away from. `selfLoopGeometry` records the direction it chose, so this is only
// meaningful once that has run.
function selfLoopObstacles(node: any): { x: number; y: number }[] {
  const nodePos = node.position();
  const points: { x: number; y: number }[] = [];

  node
    .connectedEdges()
    .filter((e: any) => e.data('isLoop') === 1 && typeof e.data('loopDirection') === 'number')
    .forEach((e: any) => {
      const degrees = e.data('loopDirection');
      const angle = ((degrees - 90) * Math.PI) / 180;
      const apex = {
        x: nodePos.x + Math.cos(angle) * LOOP_REACH,
        y: nodePos.y + Math.sin(angle) * LOOP_REACH,
      };
      const lines = String(e.data('label') ?? '').split('\n').length;
      const labelOffset = loopLabelOffset(degrees, lines);
      points.push(apex, { x: apex.x + labelOffset.x, y: apex.y + labelOffset.y });
    });

  return points;
}

// The screen angles of the transitions at a state, ignoring its own loops: a loop has no
// direction to speak of, since its two ends are the same point.
function incidentEdgeAngles(node: any): number[] {
  const nodePos = node.position();
  return node
    .connectedEdges()
    .filter((e: any) => e.source().id() !== e.target().id())
    .map((e: any) => {
      const other = e.source().id() === node.id() ? e.target() : e.source();
      const p = other.position();
      return Math.atan2(p.y - nodePos.y, p.x - nodePos.x);
    });
}

// Utility: put the initial-state marker beside each initial state, creating it once.
function repositionStartNodes(cy: any) {
  const labelAnchors = edgeLabelAnchors(cy);

  cy.nodes()
    .filter((n: any) => n.data('initial'))
    .forEach((node: any, idx: number) => {
      const obstacles = cy
        .nodes()
        .filter((n: any) => n.id() !== node.id() && !n.hasClass('start'))
        .map((n: any) => n.position())
        .concat(labelAnchors)
        .concat(selfLoopObstacles(node));

      const angle = bestStartMarkerDirection(node.position(), obstacles, incidentEdgeAngles(node));
      // A final state carries the wider double border, and the marker has to clear its
      // outer circle rather than stopping at the nominal radius, which put the arrow's
      // point in the gap between the two circles.
      const pos = startMarkerPosition(
        node.position(),
        angle,
        NODE_DIAMETER,
        node.hasClass('final') ? FINAL_STATE_BORDER_WIDTH : STATE_BORDER_WIDTH,
      );
      const startNodeId = `__start${idx}`;
      let startNode = cy.getElementById(startNodeId);

      if (!startNode || startNode.empty()) {
        cy.add({
          group: 'nodes',
          // An explicit empty label: the node style maps `label` from data, and a node
          // without the field makes cytoscape warn about a mapping it cannot resolve.
          // This marker is the initial-state triangle and never shows text.
          data: { id: startNodeId, label: '' },
          position: pos,
          classes: 'start',
        });
        startNode = cy.getElementById(startNodeId);
      } else {
        startNode.position(pos);
      }
      // Turn the triangle to point back at its state, which only matters when the
      // marker has had to leave the state's left side.
      startNode.style({ 'shape-polygon-points': startMarkerPolygon(angle) });
    });
}

/* ─────────────────────────────── The hook ──────────────────────────────── */

export type UseJffCytoscapeOptions = {
  src: string;
  title?: string;
  epsSymbol?: string;
  /**
   * What the viewer opens at.
   *
   * `fit` scales the machine to the space available, which is right in a dialog where the
   * space is small and arbitrary. `actual` opens at 100%, so the drawing appears at the size
   * its author gave it, the way JFLAP shows it. The standalone window uses `actual`: it has
   * the whole screen, and a reader comparing what they see against JFLAP should be looking at
   * the same thing.
   */
  initialZoom?: 'fit' | 'actual';
  darkMode?: boolean;
  honorPositionsDefault?: boolean;
  /**
   * Remember the zoom, the pan and where the states were put, under this key.
   *
   * Set only by the standalone window, which passes the tab's own key. A viewer in a dialog
   * passes nothing and stays what it was: a look at a file, forgotten when it closes.
   */
  viewStateKey?: string | null;
  /**
   * Say where this machine is being looked at, so another pane can follow it.
   *
   * Set only on the pane the reader is working in, and only while the two are linked. The
   * follower receives `linkedViewport` instead; one direction at a time, so there is no
   * argument about which pane wins and no chance of the two chasing each other.
   */
  onViewportChange?: ((viewport: ViewerViewport) => void) | null;
  /** Follow this camera. Set only on the pane that is not driving. */
  linkedViewport?: ViewerViewport | null;
};

/**
 * Owns the JFLAP viewer's cytoscape engine: fetching + parsing the .jff, initializing
 * the graph, laying it out (ELK / preset), wiring interaction, and the zoom/fit/export
 * actions. Extracted from JffViewerDialog so that component is just the toolbar + canvas
 * chrome. Returns the container ref to mount the graph into, the load `error` and parsed
 * machine `type`, the `honorPositions` toggle (a layout input), and the action handlers.
 */
/**
 * Wait for the next paint.
 *
 * Guarded, because a test environment without `requestAnimationFrame` would otherwise hang
 * here forever, and this is on the path that makes the graph visible at all.
 */
function nextFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return Promise.resolve();
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Where every state sits, and which layout produced it. */
type Arrangement = {
  positions: Record<string, { x: number; y: number }>;
  honorPositions: boolean;
};

/**
 * Everything one undo step has to put back.
 *
 * The arrangement, plus the four things a reader can change about the machine itself. They
 * travel together because they are one history: a reader who renames a state, drags it, then
 * presses undo twice expects the drag back and then the name, in that order, and two stacks
 * could not give them that.
 *
 * The maps are copied on the way in, not referenced. Every handler replaces the entries it
 * changes rather than mutating them, so a shallow copy is enough to freeze what a snapshot
 * saw. `initialOverride` is deliberately three-valued: `undefined` means the reader has not
 * touched it and the file's own answer stands, `null` means they took the marker away.
 */
type ViewerSnapshot = Arrangement & {
  renames: Record<string, string>;
  initialOverride: string | null | undefined;
  finalOverrides: Record<string, boolean>;
  transitionEdits: Record<number, Partial<Parsed['transitions'][number]>>;
};

/**
 * A snapshot on its way to storage, and back.
 *
 * Two shapes rather than one because the stored record is a public contract, versioned and
 * validated, while the snapshot in memory is this file's own business. `initialOverride` is the
 * only awkward part: it is three-valued, and `JSON.stringify` drops an `undefined` field
 * entirely, which is exactly the encoding wanted here (absent means the file's own answer).
 */
function toStoredStep(snapshot: ViewerSnapshot): ViewerHistoryStep {
  return {
    positions: snapshot.positions,
    honorPositions: snapshot.honorPositions,
    renames: snapshot.renames,
    initialState: snapshot.initialOverride,
    finals: snapshot.finalOverrides,
    transitions: snapshot.transitionEdits,
  };
}

function fromStoredStep(step: ViewerHistoryStep): ViewerSnapshot {
  return {
    positions: step.positions,
    honorPositions: step.honorPositions,
    renames: step.renames ?? {},
    initialOverride: step.initialState,
    finalOverrides: step.finals ?? {},
    transitionEdits: step.transitions ?? {},
  };
}

/** The reader's changes laid over the file as parsed, which is how every load draws them. */
function deriveParsed(
  pristine: Parsed,
  edits: Pick<ViewerSnapshot, 'renames' | 'initialOverride' | 'finalOverrides' | 'transitionEdits'>,
): Parsed {
  return applyTransitionEdits(
    applyFinalStates(
      applyInitialState(applyRenames(pristine, edits.renames), edits.initialOverride),
      edits.finalOverrides,
    ),
    edits.transitionEdits,
  );
}

/**
 * The pan that keeps whatever was in the middle of the viewport in the middle of it.
 *
 * Resizing changes how much canvas there is, not what the reader is looking at. Recentring the
 * whole machine instead moves them somewhere they never asked to be: somebody examining one
 * corner of a large automaton drags the window, or splits the pane, and finds themselves back
 * at the middle of a machine they had deliberately scrolled away from.
 *
 * Cytoscape's pan is in rendered pixels and its zoom scales model units, so the model point at
 * the centre is `(size / 2 - pan) / zoom`. Putting the same point back at the centre of the
 * new size is that solved the other way round. Zoom is untouched.
 */
function panKeepingCentre(
  before: { width: number; height: number },
  after: { width: number; height: number },
  zoom: number,
  pan: { x: number; y: number },
): { x: number; y: number } | null {
  if (!(zoom > 0) || !isFinitePoint(pan)) return null;
  // Every dimension has to be a real, positive size. A zero one means the canvas was measured
  // while it had no box, and treating that as the old size would shove the view half a
  // container sideways the first time the reader saw the machine.
  if (![before.width, before.height, after.width, after.height].every((n) => n > 0)) {
    return null;
  }
  return panPuttingCentre(centreOfView(before, zoom, pan), after, zoom);
}

/** The model point under the middle of the canvas. */
function centreOfView(
  size: { width: number; height: number },
  zoom: number,
  pan: { x: number; y: number },
): { x: number; y: number } {
  return { x: (size.width / 2 - pan.x) / zoom, y: (size.height / 2 - pan.y) / zoom };
}

/** The pan that puts a model point under the middle of the canvas. */
function panPuttingCentre(
  centre: { x: number; y: number },
  size: { width: number; height: number },
  zoom: number,
): { x: number; y: number } {
  return { x: size.width / 2 - centre.x * zoom, y: size.height / 2 - centre.y * zoom };
}

/** A point cytoscape will accept: both halves present and real numbers. */
function isFinitePoint(value: any): value is { x: number; y: number } {
  return !!value && Number.isFinite(value.x) && Number.isFinite(value.y);
}

/**
 * Dim the machine around one element and light up that element alone.
 *
 * The neighbourhood used to come up with it: clicking a state lit the transitions running out of
 * it too. That answers a different question from the one a click asks. What the panel then opens
 * on is the state, what undo and the properties boxes act on is the state, and lighting four
 * lines beside it left the reader picking their selection out of a group rather than seeing it.
 * One click, one thing.
 *
 * Shared by the click that selects something and the restore that puts a selection back after a
 * refresh, so the drawing looks the same either way round rather than coming back with an open
 * properties panel and nothing marked on the canvas.
 */
function highlightElement(cy: any, ele: any): void {
  cy.elements().addClass('faded');
  ele.addClass?.('highlighted');
  ele.removeClass?.('faded');
}

/**
 * The machine with the reader's renamings applied.
 *
 * Renamings live beside the parsed file rather than in it, because every rebuild re-reads the
 * file: switching the layout or the theme would otherwise put the author's names back. Applied
 * on the way out of each parse instead, so the drawing, the panels, the text representation and
 * the downloaded arrangement all say the same thing.
 *
 * Nothing here writes to the submitted file. It is a view of it, as the whole viewer is.
 */
function applyRenames(parsed: Parsed, renames: Record<string, string>): Parsed {
  if (Object.keys(renames).length === 0) return parsed;
  return {
    ...parsed,
    states: parsed.states.map((state) =>
      state.id in renames ? { ...state, name: renames[state.id]! } : state,
    ),
  };
}

/**
 * The machine with the reader's choice of initial state applied.
 *
 * A machine has one initial state, which is what JFLAP draws the arrow into and what everything
 * here already assumes: the summary says "Initial state: q0", not a list. So choosing one takes
 * it away from whichever state had it, and `null` leaves the machine without one, which is what
 * unticking the box asks for.
 *
 * `undefined` means the reader has not said, and the file's own answer stands.
 */
function applyInitialState(parsed: Parsed, initial: string | null | undefined): Parsed {
  if (initial === undefined) return parsed;
  return {
    ...parsed,
    states: parsed.states.map((state) =>
      state.initial === (state.id === initial)
        ? state
        : { ...state, initial: state.id === initial },
    ),
  };
}

/**
 * The machine with the reader's choice of final states applied.
 *
 * Unlike the initial state there is nothing to take away from anybody: any number of states can
 * be final, and a machine with none is a perfectly ordinary one that accepts nothing. So this is
 * a map of the states the reader has changed, and every state it does not name keeps the file's
 * own answer.
 */
function applyFinalStates(parsed: Parsed, finals: Record<string, boolean>): Parsed {
  if (Object.keys(finals).length === 0) return parsed;
  return {
    ...parsed,
    states: parsed.states.map((state) =>
      state.id in finals ? { ...state, final: finals[state.id]! } : state,
    ),
  };
}

/**
 * The machine with the reader's changes to transitions applied.
 *
 * Keyed by a transition's place in the file, which is the only stable thing about it: two
 * transitions between the same pair of states are told apart by nothing else, and they are drawn
 * as one line.
 */
function applyTransitionEdits(
  parsed: Parsed,
  edits: Record<number, Partial<Parsed['transitions'][number]>>,
): Parsed {
  if (Object.keys(edits).length === 0) return parsed;
  return {
    ...parsed,
    transitions: parsed.transitions.map((transition) => {
      const edit = edits[transition.__idx];
      return edit ? { ...transition, ...edit } : transition;
    }),
  };
}

/** Read the current arrangement out of the graph. */
function readArrangement(cy: any, honorPositions: boolean): Arrangement | null {
  try {
    const positions: Record<string, { x: number; y: number }> = {};
    cy.nodes().forEach((node: any) => {
      // Notes and start markers are placed relative to what they annotate, so restoring them
      // directly would fight the code that keeps them attached.
      if (node.hasClass?.('note') || node.hasClass?.('start')) return;
      const p = node.position();
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y))
        positions[node.id()] = { x: p.x, y: p.y };
    });
    return { positions, honorPositions };
  } catch {
    return null;
  }
}

/** Put a remembered arrangement back. */
function applyArrangement(cy: any, snapshot: Arrangement): void {
  try {
    for (const [id, position] of Object.entries(snapshot.positions)) {
      const node = cy.getElementById(id);
      if (node && !node.empty?.()) node.position(position);
    }
  } catch {
    // A graph mid-teardown. Nothing to restore onto.
  }
}

/**
 * Redraw what the reader can change, from the machine as it now stands.
 *
 * The handlers below each patch the one thing they touched, which is right when a reader ticks
 * a box: rebuilding the graph for it would throw away the arrangement, the zoom and this very
 * history. Undo cannot work that way, because one step can move several things at once, so it
 * puts the whole lot back instead. Same idea, wider net.
 *
 * Positions are not here. They are the arrangement's business, and `applyArrangement` has
 * already dealt with them by the time this runs.
 */
function syncGraph(cy: any, parsed: Parsed, epsSymbol: string): void {
  try {
    const byId = new Map(parsed.states.map((state) => [state.id, state]));
    let initialId: string | null = null;

    cy.nodes().forEach((node: any) => {
      if (node.hasClass?.('start') || node.hasClass?.('note')) return;
      const state = byId.get(node.id());
      if (!state) return;
      if (state.initial) initialId = state.id;
      node.data('label', state.name);
      node.data('initial', state.initial ? 1 : 0);
      node.data('final', state.final ? 1 : 0);
      if (state.final) node.addClass('final');
      else node.removeClass('final');
    });

    // Transitions between the same two states share one line, so a line's label is worked out
    // again from all of them rather than patched from the one that changed.
    cy.edges().forEach((edge: any) => {
      const from = edge.data('source');
      const to = edge.data('target');
      const bundled = bundleEdges(
        parsed.transitions.filter((t) => t.from === from && t.to === to),
        parsed.type,
        epsSymbol,
      )[0];
      if (bundled !== undefined) edge.data('label', bundled.label);
    });

    if (initialId === null) {
      // The markers are made one per initial state, so with none left there is nothing to move
      // the old one to: it has to go. Undoing back to an initial state makes a new one, which
      // is what repositionStartNodes does when it finds none.
      cy.nodes()
        .filter((node: any) => node.hasClass?.('start'))
        .forEach((node: any) => node.remove?.());
    } else {
      repositionStartNodes(cy);
    }
  } catch {
    // A graph mid-teardown. The reader's answers are kept either way, and the next load draws
    // them: every load derives the machine from the file plus exactly these.
  }
}

/**
 * Show or hide the notes a student wrote on the canvas.
 *
 * A style change rather than a rebuild: the notes are ordinary nodes carrying the `note`
 * class, so `display: none` takes them out of the drawing and out of the layout without
 * touching the machine itself. They only exist at all in the "As drawn" layout, since an
 * auto-arranged graph has moved every state and a note left where its author put it would
 * end up annotating whatever happened to land there.
 */
function applyNoteVisibility(cy: any, visible: boolean): void {
  try {
    cy.$('node.note').style('display', visible ? 'element' : 'none');
  } catch {
    // A graph mid-teardown. Nothing to show or hide, and nothing worth reporting.
  }
}

export function useJffCytoscape({
  src,
  title,
  epsSymbol = DEFAULT_EPS,
  initialZoom = 'fit',
  darkMode = false,
  honorPositionsDefault = false,
  viewStateKey = null,
  onViewportChange = null,
  linkedViewport = null,
}: UseJffCytoscapeOptions) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<any | null>(null);

  /**
   * Why this machine did not open, or null while nothing is wrong.
   *
   * A failure rather than a message, because the chrome has to decide whether to offer a
   * retry, and "was it worth trying again" is not something to work out by reading a string.
   */
  const [failure, setFailure] = useState<ViewerLoadFailure | null>(null);
  /**
   * How far the load has got, so a pane can say what it is doing.
   *
   * Worth naming the steps rather than showing one spinner: fetching a file and reading a
   * machine out of it fail for different reasons, and with two panes on screen one can be
   * still fetching while the other has already given up.
   */
  const [phase, setPhase] = useState<'fetching' | 'parsing' | 'drawing' | 'ready'>('fetching');
  /**
   * What was remembered about this file, read once.
   *
   * Through `useState` rather than `useRef` because `useRef` has no lazy initializer: its
   * argument is evaluated on every render, and this one parses a machine's worth of positions
   * out of storage. Zoom re-renders on every tick of the wheel.
   */
  const [savedView] = useState<ViewerViewState | null>(() => readViewState(viewStateKey));
  /**
   * Seeded from the saved view so the first load builds the layout the reader left, rather
   * than building the other one and then rebuilding when it is corrected. This is in `load`'s
   * dependencies, so a correction after mount costs a whole second load.
   *
   * Reading storage during render is safe here only because of who passes a key. A dialog
   * passes none, and mounts after a click in any case. The standalone window passes one, and
   * hides the layout control behind the menu, so no server-rendered markup depends on this
   * value and there is nothing for hydration to disagree about. A new caller that renders the
   * layout control on the server would have to think about that again.
   */
  const [honorPositions, setHonorPositions] = useState(
    savedView?.honorPositions ?? honorPositionsDefault,
  );
  const [type, setType] = useState<MachineType>('unknown');
  // Kept so the viewer can render a text description of the machine; the canvas alone
  // is not a usable representation for a screen reader.
  const [parsed, setParsed] = useState<Parsed | null>(null);
  // The live zoom level, mirrored into state so a slider can show it. Cytoscape owns the
  // real value; this follows it, including when the wheel or the Fit button changes it.
  const [zoom, setZoomState] = useState(1);
  // Notes the student wrote on the canvas. On by default: they are the author's own words and
  // part of the answer, not decoration. Turned off when they crowd a busy machine.
  const [showNotes, setShowNotes] = useState(true);
  // Off by default: a machine arrives with the positions its author chose, and quietly moving
  // every state the first time one is nudged would be a change nobody asked for.
  const [snapToGrid, setSnapToGrid] = useState(false);
  // The state a reader has clicked, if any. Held as an id rather than a described object so it
  // survives a reload of the same file and cannot go stale against a re-parsed machine.
  const [selectedStateId, setSelectedStateId] = useState<string | null>(null);
  /**
   * Whether the first layout has finished and the graph is worth showing.
   *
   * Cytoscape paints as soon as it is constructed, at whatever scale the file's coordinates
   * happen to imply, and only then does the fit run and the zoom settle. The reader saw the
   * machine arrive at the wrong size and jump. Nothing is drawn until this is true.
   */
  const [settled, setSettled] = useState(false);
  // The edge a reader has clicked, as its two endpoints rather than an element id: the id is
  // assigned by the bundler and would not survive a re-parse, while the pair is the machine's
  // own identity for it.
  const [selectedEdge, setSelectedEdge] = useState<{ from: string; to: string } | null>(null);
  /**
   * Where the selected state is on the canvas right now.
   *
   * Not read from the parsed file: that says where its author put it, and the reader may have
   * dragged it since. Kept in step by the same `position` event that moves the labels and the
   * initial-state marker, so the boxes in the panel follow a drag rather than going stale.
   */
  const [selectedPosition, setSelectedPosition] = useState<{ x: number; y: number } | null>(null);
  /**
   * What is selected, in the shape the remembered view stores.
   *
   * A ref because the writer reads only refs: it runs from a debounce and from `pagehide`, and
   * a closure from the first render would always write "nothing selected".
   */
  /**
   * Whether the graph on screen has had its remembered view put back.
   *
   * False from the moment a load starts until that load has restored (or decided not to), which
   * is the window in which a write would record a view nobody asked for.
   */
  /**
   * The names the reader has given states, by state id.
   *
   * Not in `load`'s dependencies on purpose: renaming a state changes one label on a graph that
   * is already drawn, and rebuilding the machine to do it would throw away the arrangement, the
   * zoom and the undo history for the sake of a word.
   *
   * Seeded from the remembered view rather than restored after the fact: every load applies
   * these on its way out of the parse, so the first drawing already carries them. Without this
   * a refresh put the author's names back while the toolbar still said the file had changed on
   * screen, which was a claim about nothing.
   */
  const [renames, setRenames] = useState<Record<string, string>>(savedView?.renames ?? {});
  const renamesRef = useRef(renames);
  renamesRef.current = renames;
  /**
   * Which state the reader has made initial, held the same way as the renamings and for the
   * same reasons: outside the parsed file, so a rebuild keeps it, and written down with the
   * view, so a refresh does.
   */
  const [initialOverride, setInitialOverride] = useState<string | null | undefined>(
    savedView?.initialState,
  );
  const initialOverrideRef = useRef(initialOverride);
  initialOverrideRef.current = initialOverride;
  /**
   * What the reader has changed about transitions, by the transition's place in the file.
   *
   * Held outside the parsed machine like the renamings, so a rebuild keeps it, and written down
   * with the view, so a refresh does.
   */
  const [transitionEdits, setTransitionEdits] = useState<
    Record<number, Partial<Parsed['transitions'][number]>>
  >(savedView?.transitions ?? {});
  const transitionEditsRef = useRef(transitionEdits);
  transitionEditsRef.current = transitionEdits;
  /** Which states the reader has made final, or unmade. Same handling as the two above. */
  const [finalOverrides, setFinalOverrides] = useState<Record<string, boolean>>(
    savedView?.finals ?? {},
  );
  const finalOverridesRef = useRef(finalOverrides);
  finalOverridesRef.current = finalOverrides;
  const viewRestored = useRef(false);
  /**
   * Which load owns the graph.
   *
   * Two can be in flight at once: a theme change or a layout switch starts one while the last
   * is still fetching or still in its final frame. Without a way to tell them apart the older
   * one carried on and acted on the newer one's graph, and the sequence that showed it was
   * ordinary use: it wrote the fit the new graph had opened at over the remembered view, and
   * the restore that came a moment later read it back and stayed there.
   */
  const loadGeneration = useRef(0);
  // Read by the graph's own event handlers, which are built once per load.
  const selectedStateIdRef = useRef<string | null>(null);
  selectedStateIdRef.current = selectedStateId;
  const selectionRef = useRef<ViewerSelection | null>(null);
  selectionRef.current = selectedStateId
    ? { kind: 'state', id: selectedStateId }
    : selectedEdge
      ? { kind: 'transition', from: selectedEdge.from, to: selectedEdge.to }
      : null;
  // Read by the load path, which runs outside React's render and would otherwise capture the
  // value from whenever the effect that started it was created.
  const showNotesRef = useRef(showNotes);
  showNotesRef.current = showNotes;
  const snapToGridRef = useRef(snapToGrid);
  snapToGridRef.current = snapToGrid;
  const initialZoomRef = useRef(initialZoom);
  initialZoomRef.current = initialZoom;
  const honorPositionsRef = useRef(honorPositions);
  honorPositionsRef.current = honorPositions;

  /**
   * Undo history.
   *
   * The viewer is read only about the file: nothing here changes what the student submitted.
   * What a reader CAN change is the drawing in front of them, and all of it is undoable: the
   * arrangement (dragging a state, or switching between the drawn and the auto-arranged
   * layout) and the machine's own labels (a state's name, which state is initial, which are
   * final, what a transition reads). Zoom and pan are not in it: they move the camera, not the
   * machine, and an undo that rewound the viewport would fight the scroll wheel.
   *
   * Each entry is a whole snapshot rather than a diff. A machine has tens of states, not
   * thousands, so copying every position and every override is cheaper than the bookkeeping a
   * diff would need, and it means one step can put back several things at once.
   */
  /**
   * Whether anything about the drawing has been changed since it was opened.
   *
   * Kept because the difference between "this is the file" and "this is the file after I moved
   * things about" is not visible, and a reader who has dragged three states apart to read an
   * edge can reasonably wonder whether they have altered what a student submitted. They have
   * not, and nothing here writes to the file.
   *
   * Derived from the undo history, plus whatever a refresh restored: undo everything and it
   * goes quiet again. Switching the layout out and back leaves it on, which over-reports by
   * one case and is not worth a position-by-position comparison to avoid.
   */
  const [restoredModified, setRestoredModified] = useState(false);
  const [undoDepth, setUndoDepth] = useState(0);
  const [redoDepth, setRedoDepth] = useState(0);
  const undoStack = useRef<ViewerSnapshot[]>([]);
  const redoStack = useRef<ViewerSnapshot[]>([]);
  /**
   * How things stood when an edit began, held until the reader actually changes something.
   *
   * Clicking a state selects it and opens its properties, and picking one up is how a click
   * starts, so recording the snapshot straight onto the undo stack made every click look like
   * a rearrangement: the window said the drawing had been moved when nothing had. The snapshot
   * still has to be taken at that moment, while the old positions are readable, so it waits
   * here and is only committed if something moved.
   *
   * The panel's text boxes use the same bargain, and it is what makes typing a name one undo
   * step rather than one per keystroke: the snapshot is taken when the box takes focus and
   * committed by the first keystroke, and every keystroke after that finds nothing waiting.
   */
  const pendingSnapshot = useRef<ViewerSnapshot | null>(null);
  /**
   * An arrangement waiting for the graph to be rebuilt before it can be applied.
   *
   * Stepping across a layout switch changes `honorPositions`, which `load` depends on, so the
   * graph is torn down and built again. Applying the snapshot before that happened put the
   * positions onto a graph that was about to be discarded, and the step appeared to restore
   * the layout while silently losing every state the reader had moved under it. The camera
   * rides along for the same reason: the rebuild refits, and an undo should not move the view.
   */
  /** The file the graph currently holds, so a rebuild of the same one is recognised. */
  const loadedSrc = useRef<string | null>(null);
  /**
   * The machine as the file has it, before any of the reader's changes.
   *
   * Undo needs this and cannot get it from `parsed`, which already carries every change made
   * so far: putting a renamed state back means writing the AUTHOR's name, and by then nothing
   * else remembers it. Every load fills this in on its way past the parse.
   */
  const pristineParsed = useRef<Parsed | null>(null);
  const pendingArrangement = useRef<{
    snapshot: Arrangement;
    zoom: number;
    pan: { x: number; y: number };
  } | null>(null);

  // Customization variables
  const FIT_PADDING = 80;
  /**
   * The grid's spacing, in model units.
   *
   * The same number the CSS background uses for its lines, which is what lets the two agree:
   * the background is kept in step with the graph's zoom and pan below, so a state snapped to
   * this lattice lands on a line the reader can actually see.
   */
  const GRID_STEP = 24;
  // Ceiling on the zoom the initial fit may choose. Without one, fitting fills the canvas
  // whatever is in it, and a two-state machine arrived at roughly 4x. 1:1 turned out to
  // read as too distant on a large screen, so allow a moderate enlargement and no more.
  const MAX_INITIAL_ZOOM = 1.5;
  // How far the self-loop arcs out from the state. The label geometry that goes with it
  // lives in lib/jflap-layout, which is where LOOP_REACH records what this produces.
  const LOOP_STEP_SIZE = 48;

  // Expose onResize for Fit button
  const onResizeRef = useRef<(() => void) | null>(null);
  /**
   * Put the label geometry back in step, for a change that is not a drag.
   *
   * The offsets that keep a transition's label clear of its line, and a self-loop's of its
   * state, are worked out from the label itself, so editing what a transition reads has to run
   * them again. The functions belong to the graph currently loaded, which is why this is a ref
   * the load fills in rather than something callable from out here.
   */
  const refreshLabelGeometryRef = useRef<(() => void) | null>(null);
  /**
   * The size the canvas had when it was last drawn.
   *
   * Kept here rather than read from cytoscape when a resize arrives, because by then it is no
   * longer the old size: cytoscape watches the container itself and calls its own `resize`
   * about half a debounce ahead of this one, so both readings came back the same and the pan
   * that keeps the reader's spot in the middle worked out to no move at all. Splitting the
   * window left each machine sitting where it had been in the full width, half of it off the
   * side of its pane.
   */
  const canvasSize = useRef<{ width: number; height: number } | null>(null);

  /* ── remembering the view across a refresh ──────────────────────────── */

  const viewStateKeyRef = useRef(viewStateKey);
  viewStateKeyRef.current = viewStateKey;
  // Read by the writer, which runs from a cytoscape event rather than from a render.
  const viewModifiedRef = useRef(false);
  viewModifiedRef.current =
    undoDepth > 0 ||
    restoredModified ||
    Object.keys(renames).length > 0 ||
    initialOverride !== undefined ||
    Object.keys(finalOverrides).length > 0 ||
    Object.keys(transitionEdits).length > 0;

  /* ── following another pane's camera ────────────────────────────────── */

  const onViewportChangeRef = useRef(onViewportChange);
  onViewportChangeRef.current = onViewportChange;
  /**
   * True while a camera from elsewhere is being applied.
   *
   * Cytoscape reports a viewport change whether a person or this code caused it, so without
   * this the follower would report the camera it was just given and the two panes would talk
   * past each other.
   */
  const applyingViewport = useRef(false);

  /** Tell whoever is listening where this machine is being looked at. */
  const reportViewport = () => {
    const report = onViewportChangeRef.current;
    const cy = cyRef.current;
    if (!report || !cy || applyingViewport.current) return;
    try {
      const zoom = cy.zoom();
      const pan = cy.pan();
      if (!Number.isFinite(zoom) || zoom <= 0 || !isFinitePoint(pan)) return;
      report({ zoom, pan: { x: pan.x, y: pan.y } });
    } catch {
      // A graph mid-teardown. There is nothing to report about it.
    }
  };

  // Take the other pane's camera. Not while this pane is the one driving, which is what the
  // caller decides by giving one of the two props and not the other.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !linkedViewport) return;
    applyingViewport.current = true;
    try {
      cy.zoom(linkedViewport.zoom);
      cy.pan(linkedViewport.pan);
    } catch {
      // A graph mid-teardown.
    } finally {
      applyingViewport.current = false;
    }
  }, [linkedViewport]);

  // Say where this pane is as soon as it becomes the one driving, so linking the two takes
  // effect immediately rather than on the reader's next scroll.
  useEffect(() => {
    if (onViewportChange) reportViewport();
  }, [onViewportChange]);

  /** Write down where the reader is looking and where they have put the states. */
  const rememberView = useCallback(() => {
    if (!viewStateKeyRef.current) return;
    // Not while a graph is being built. The writer is debounced, so a wheel or a drag from just
    // before a rebuild can come due after the new graph exists and before its remembered view
    // has been put back: it would then write the fit the rebuild opened at, and the restore a
    // moment later would read that and stay there. What is in storage is already this machine's
    // view; the load writes it again when it has finished.
    if (!viewRestored.current) return;
    const cy = cyRef.current;
    if (!cy) return;
    try {
      const arrangement = readArrangement(cy, honorPositionsRef.current);
      const pan = cy.pan();
      const zoom = cy.zoom();
      if (!arrangement || !isFinitePoint(pan) || !Number.isFinite(zoom) || zoom <= 0) return;
      const size = { width: cy.width(), height: cy.height() };
      writeViewState(viewStateKeyRef.current, {
        v: 1,
        zoom,
        pan: { x: pan.x, y: pan.y },
        // What the restore actually uses. See the note on the type: the pan alone belongs to the
        // canvas size it was taken at, and the canvas is not that size when it comes back.
        centre:
          size.width > 0 && size.height > 0
            ? centreOfView(size, zoom, { x: pan.x, y: pan.y })
            : undefined,
        positions: arrangement.positions,
        honorPositions: arrangement.honorPositions,
        modified: viewModifiedRef.current,
        selection: selectionRef.current,
        renames: renamesRef.current,
        initialState: initialOverrideRef.current,
        finals: finalOverridesRef.current,
        transitions: transitionEditsRef.current,
        // The most recent steps a side. Trimmed from the front, so what is dropped is the
        // oldest history, which is the part a reader is least likely to walk back to.
        history: {
          undo: undoStack.current.slice(-VIEWER_HISTORY_LIMIT).map(toStoredStep),
          redo: redoStack.current.slice(-VIEWER_HISTORY_LIMIT).map(toStoredStep),
        },
      });
    } catch {
      // A graph mid-teardown, or storage refusing. Neither is worth interrupting a reader.
    }
    // Everything it touches is a ref, so it never needs rebuilding.
  }, []);

  /**
   * Put a remembered view back, and say whether it was used.
   *
   * False when there is nothing saved, or when what is saved names states this machine does
   * not have. The caller then opens the file the ordinary way.
   */
  /**
   * Skip the next restore, once.
   *
   * Reset throws the remembered view away and rebuilds, but a debounced write from a drag a
   * moment earlier can still be in flight and would put the entry back between the two. This
   * says "the rebuild you are about to do was asked for, do not restore anything into it".
   */
  const skipRestore = useRef(false);

  /**
   * Bumped to rebuild the graph when nothing `load` depends on has changed.
   *
   * Reset is the only user of it: resetting a machine that is already on its own layout has
   * to re-read the file anyway, because the states have been dragged since.
   */
  const [reloadNonce, setReloadNonce] = useState(0);

  /**
   * Put the properties panel back on whatever it was open on.
   *
   * The panel answers a click, and a refresh is not a click, so without this a reader who
   * reloaded came back to the machine they had left and no panel: the one thing on screen that
   * had said which state they were reading about. Silent when the machine no longer has what
   * was selected, which is what a file replaced under the same name would give.
   */
  const restoreSelection = useCallback((cy: any, selection: ViewerSelection | null) => {
    if (!selection) return;
    try {
      if (selection.kind === 'state') {
        const node = cy.getElementById(selection.id);
        if (!node || node.empty?.() || node.length === 0) return;
        setSelectedStateId(selection.id);
        setSelectedEdge(null);
        const at = node.position?.();
        setSelectedPosition(isFinitePoint(at) ? { x: at.x, y: at.y } : null);
        highlightElement(cy, node);
        return;
      }
      // By its two ends, since that is how it was written down. Works on a cytoscape collection
      // and on a plain array alike: both filter, both index.
      const match = cy
        .edges()
        .filter(
          (edge: any) =>
            edge.data('source') === selection.from && edge.data('target') === selection.to,
        );
      const edge = match?.[0];
      if (!edge) return;
      setSelectedStateId(null);
      setSelectedPosition(null);
      setSelectedEdge({ from: selection.from, to: selection.to });
      highlightElement(cy, edge);
    } catch {
      // An engine mid-teardown, or one a test has not told about selections. The machine is
      // still there; only the panel is missing.
    }
  }, []);

  /**
   * Turn the snapshot taken when a move began into an undo step.
   *
   * Shared by the two ways a state moves: dragging it, where the snapshot is taken as it is
   * picked up, and typing its coordinates, where it is taken as the box takes focus. Both hold
   * the snapshot until something actually moves, so a click or a stray focus records nothing.
   */
  /** Everything one undo step has to put back, as things stand right now. */
  const readSnapshot = useCallback((): ViewerSnapshot | null => {
    const cy = cyRef.current;
    if (!cy) return null;
    const arrangement = readArrangement(cy, honorPositionsRef.current);
    if (!arrangement) return null;
    return {
      ...arrangement,
      renames: { ...renamesRef.current },
      initialOverride: initialOverrideRef.current,
      finalOverrides: { ...finalOverridesRef.current },
      transitionEdits: { ...transitionEditsRef.current },
    };
  }, []);

  /** Make a snapshot the step that undo will return to. */
  const pushUndoStep = useCallback((before: ViewerSnapshot | null) => {
    if (!before) return;
    undoStack.current.push(before);
    // A new action makes the redo branch unreachable, as in any editor.
    redoStack.current = [];
    setUndoDepth(undoStack.current.length);
    setRedoDepth(0);
  }, []);

  /** Record where a change began, for the handlers that know before they act. */
  const recordStep = useCallback(() => pushUndoStep(readSnapshot()), [pushUndoStep, readSnapshot]);

  const commitPendingMove = useCallback(() => {
    const before = pendingSnapshot.current;
    pendingSnapshot.current = null;
    pushUndoStep(before);
  }, [pushUndoStep]);

  const restoreSavedView = useCallback(
    (cy: any): boolean => {
      if (skipRestore.current) {
        skipRestore.current = false;
        return false;
      }
      // Read now rather than at mount, because the graph is rebuilt for more reasons than a
      // refresh: React replays effects in development, and switching the theme rebuilds too.
      // Restoring only on the very first load meant the second one landed on the plain fit and
      // then wrote that over the reader's remembered view, so a refresh lost the zoom and the
      // positions in development and after any theme change.
      const saved = readViewState(viewStateKeyRef.current);
      if (!saved) return false;
      // The positions belong to the layout they were saved from. Switching between the drawn
      // and the auto-arranged layout is a rebuild too, and dropping the other layout's
      // positions over the engine's work made Auto-arranged look like it did nothing.
      if (saved.honorPositions !== honorPositionsRef.current) return false;
      try {
        const ids = cy.nodes().map((node: any) => node.id());
        if (!viewStateFits(saved, ids)) return false;
        applyArrangement(cy, { positions: saved.positions, honorPositions: saved.honorPositions });
        // A refresh does not undo the reader's rearranging, so it must not quietly forget it
        // happened either.
        if (saved.modified) setRestoredModified(true);
        // Nor should it leave Undo greyed out over work that is plainly still there. Only when
        // every step names states this machine has: see historyFits.
        if (saved.history && historyFits(saved.history, ids)) {
          undoStack.current = saved.history.undo.map(fromStoredStep);
          redoStack.current = saved.history.redo.map(fromStoredStep);
          setUndoDepth(undoStack.current.length);
          setRedoDepth(redoStack.current.length);
        }
        cy.zoom(saved.zoom);
        // The point that was in the middle, put back in the middle of whatever width the canvas
        // has now. Falling back to the raw pan for an entry written before that was recorded.
        const size = { width: cy.width(), height: cy.height() };
        const centred =
          saved.centre && size.width > 0 && size.height > 0
            ? panPuttingCentre(saved.centre, size, saved.zoom)
            : null;
        cy.pan(centred ?? saved.pan);
        restoreSelection(cy, saved.selection ?? null);
        return true;
      } catch {
        // An engine that does not offer these, which is every one of them in a test that has
        // not been told about this. Opening at the fit is the right answer either way.
        return false;
      }
    },
    // Refs only, plus a callback that is itself built once.
    [restoreSelection],
  );

  const load = useMemo(
    () => async () => {
      setFailure(null);
      setPhase('fetching');
      // Nothing is written down again until this load has decided what the view should be.
      viewRestored.current = false;
      const generation = ++loadGeneration.current;
      /** False once a later load has taken over: this one must then touch nothing. */
      const isCurrent = () => generation === loadGeneration.current;
      // Before anything else, and before any await. A second load onto a viewer that is
      // already showing something (React re-running effects in development, or the source
      // changing) would otherwise start with the graph visible, and the new machine would be
      // painted un-fitted for the moment before its own layout settles. That is the flash.
      setSettled(false);
      try {
        // Told apart on purpose: a request that never got an answer is worth trying again,
        // and one that was refused is not.
        let res: Response;
        try {
          res = await fetch(src);
        } catch {
          setFailure(failureForNetwork());
          return;
        }
        if (!res.ok) {
          setFailure(failureForStatus(res.status));
          return;
        }
        const text = await res.text();

        setPhase('parsing');
        let parsed: Parsed;
        try {
          parsed = parseJflap(text);
        } catch {
          // The bytes arrived and are not a machine. Reading them again will not change that.
          setFailure(failureForContent());
          return;
        }
        // The file's own answers, kept aside before the reader's go over them: undo has to be
        // able to put an author's name back, and after the next line nothing else remembers it.
        pristineParsed.current = parsed;
        // Whatever the reader has renamed, put back over the file's own names. Every load
        // re-reads the file, so this is where a rename survives a rebuild.
        parsed = deriveParsed(parsed, {
          renames: renamesRef.current,
          initialOverride: initialOverrideRef.current,
          finalOverrides: finalOverridesRef.current,
          transitionEdits: transitionEditsRef.current,
        });
        setPhase('drawing');
        setType(parsed.type);
        setParsed(parsed);
        setSelectedStateId(null);
        setSelectedEdge(null);
        setSelectedPosition(null);
        // A different file is a different machine. Keeping the old history would let undo
        // apply one machine's positions to another's states.
        //
        // Only for a different file, though. Switching between the drawn and the auto-arranged
        // layout rebuilds this same machine, and clearing here made the switch itself
        // impossible to undo: the step that recorded it was thrown away by the rebuild it
        // caused. Reset clears the history itself, since there it is the point.
        if (loadedSrc.current !== src) {
          loadedSrc.current = src;
          undoStack.current = [];
          redoStack.current = [];
          // A snapshot held from a state picked up in the old machine belongs to that machine.
          pendingSnapshot.current = null;
          setUndoDepth(0);
          setRedoDepth(0);
        }
        const elements = toElements(parsed, epsSymbol, honorPositions);

        if (!containerRef.current) {
          return;
        }

        const cytoscape = await ensureCytoscapeReady();
        // A newer load is already building. Constructing a second engine here would leave one
        // of them unowned, still listening to the container and never destroyed.
        if (!isCurrent()) return;

        if (cyRef.current) {
          cyRef.current.destroy();
          cyRef.current = null;
        }

        // Canvas labels need a concrete font-family string, and next/font
        // registers Geist under a hashed name, so read it off the body.
        const uiFontFamily =
          (typeof window !== 'undefined' && getComputedStyle(document.body).fontFamily) ||
          'ui-sans-serif, system-ui';

        // Edges and their labels sit on the canvas, not inside a state, so unlike the
        // state fill they cannot be JFLAP's flat black: that is invisible on a dark
        // background. They follow the theme; everything on the state stays JFLAP's.
        const STROKE = darkMode ? '#e2e8f0' : '#000000';
        const TEXT_COLOR = STROKE;

        // A note is the student's own words rather than part of the machine, so it is drawn as
        // a piece of paper laid on the canvas: a pale panel in light, a raised one in dark.
        // Hex literals for the same reason as everything else here, see the note at the top.
        const NOTE_FILL = darkMode ? '#1e293b' : '#fefce8';
        const NOTE_BORDER = darkMode ? '#475569' : '#d6d3a8';
        const NOTE_TEXT = darkMode ? '#e2e8f0' : '#1f2937';

        // The canvas behind the drawing, used to fill the start marker. Unfilled, the grid
        // and any edge behind it showed straight through the triangle, which made it read as
        // an outline rather than a piece of the machine. Filling it with the canvas colour
        // keeps the shape JFLAP draws while making it opaque.
        const CANVAS_FILL = darkMode ? '#141d33' : '#ffffff';

        const cy = cytoscape({
          container: containerRef.current!,
          elements,
          minZoom: 0.2,
          maxZoom: 6,
          style: [
            /* nodes */
            {
              selector: 'node',
              style: {
                // Above a note; see the note style below for why.
                'z-index': 1,
                'background-color': NODE_FILL,
                'border-color': STATE_STROKE,
                'border-width': STATE_BORDER_WIDTH,
                label: 'data(label)',
                'font-family': uiFontFamily,
                // Shrinks to fit rather than running out over the circle. A function of the
                // element, so a state renamed from the properties panel is re-measured: setting
                // `data` marks the style dirty and cytoscape asks again.
                'font-size': (node: any) => stateFontSize(String(node.data('label') ?? '')),
                color: STATE_TEXT,
                'text-valign': 'center',
                'text-halign': 'center',
                width: 58,
                height: 58,
                shape: 'ellipse',
              },
            },
            // JFLAP marks a final state with a second, inner circle. A double border is
            // the same picture without a second element per state.
            {
              selector: 'node.final',
              style: { 'border-width': FINAL_STATE_BORDER_WIDTH, 'border-style': 'double' },
            },
            // The initial-state marker, drawn the way JFLAP draws it: an unfilled
            // triangle on its side with its point against the state. It follows the theme
            // rather than JFLAP's flat black, for the same reason the edges do: it sits on
            // the canvas, not inside a state, so black disappears on a dark background.
            {
              selector: 'node.start',
              style: {
                shape: 'polygon',
                'shape-polygon-points': startMarkerPolygon(),
                width: START_MARKER_SIZE,
                height: START_MARKER_SIZE,
                'background-color': CANVAS_FILL,
                'background-opacity': 1,
                'border-color': STROKE,
                'border-width': 2,
                events: 'no',
              },
            },

            /* edges (default) */
            {
              selector: 'edge',
              style: {
                'z-index': 1,
                'curve-style': 'bezier',
                'line-color': STROKE,
                width: EDGE_WIDTH,
                'target-arrow-color': STROKE,
                'source-arrow-color': STROKE,
                'source-arrow-shape': 'none',
                'target-arrow-shape': 'triangle',
                'arrow-scale': 1.1,
                label: 'data(label)',
                'font-family': uiFontFamily,
                'font-size': 16,
                'min-zoomed-font-size': 7,
                color: TEXT_COLOR,
                'text-wrap': 'wrap',
                'text-max-width': 140,
                // Lay each label along its own edge, as JFLAP does. This was previously
                // 'none', on the grounds that autorotate rendered a right-to-left edge's
                // label upside down; on the cytoscape this now ships, it does not, and
                // keeps every label the right way up whichever way its edge runs.
                'text-rotation': 'autorotate',
              },
            },
            /* self-loops on TOP with arrow at start */
            {
              selector: 'edge[isLoop = 1]',
              style: {
                // `bezier`, not `loop`. Cytoscape has no `loop` curve-style: it recognises
                // a self-loop on its own and shapes it from `loop-direction`, `loop-sweep`
                // and `control-point-step-size` below. Naming one made cytoscape reject
                // the property and log an error per loop on every single render.
                'curve-style': 'bezier',
                'loop-direction': '0deg',
                'loop-sweep': '50deg',
                'control-point-step-size': 48,
                'source-arrow-shape': 'triangle',
                'target-arrow-shape': 'none',
                'arrow-scale': 0.95,
                'line-cap': 'round',
                'text-rotation': 'none',
              },
            },

            /*
             * A note the student wrote on the canvas.
             *
             * Deliberately unlike a state: a soft rectangle rather than JFLAP's yellow circle,
             * so nobody reads it as part of the machine. Sized from the text by `noteBox`,
             * which is also what positioned it, so the box and the wrap agree.
             */
            {
              selector: 'node.note',
              style: {
                shape: 'round-rectangle',
                'background-color': NOTE_FILL,
                'background-opacity': 0.95,
                'border-color': NOTE_BORDER,
                'border-width': 1,
                width: 'data(width)',
                height: 'data(height)',
                label: 'data(label)',
                color: NOTE_TEXT,
                'font-size': NOTE_FONT_SIZE,
                'font-family': uiFontFamily,
                'text-wrap': 'wrap',
                'text-max-width': `${NOTE_MAX_WIDTH}px`,
                'text-valign': 'center',
                'text-halign': 'center',
                'text-justification': 'left',
                /**
                 * Behind the machine.
                 *
                 * A note sits wherever the student dropped it and nothing moves aside for it,
                 * so it can overlap a state. When it does, the answer has to win: a note is
                 * the student's aside, and losing sight of a state behind an opaque panel
                 * would be a worse reading of the file than a note partly covered. JFLAP draws
                 * its notes on top, because there they are live Swing components the student
                 * is editing; here nobody is editing anything.
                 */
                'z-index': 0,
                // Not part of the machine, so a tap must not pick it up and fade everything
                // else out around it.
                events: 'no',
              },
            },

            /* interaction: JFLAP's own selection blue (gui/Globals.FROM_COLOR) */
            {
              selector: '.highlighted',
              style: {
                'line-color': HIGHLIGHT_COLOR,
                'target-arrow-color': HIGHLIGHT_COLOR,
                'source-arrow-color': HIGHLIGHT_COLOR,
                'border-color': HIGHLIGHT_COLOR,
                // The fill stays JFLAP's yellow so a highlighted state still reads as a
                // state; only its outline and its edges change.
                'background-color': NODE_FILL,
              },
            },
            { selector: '.faded', style: { opacity: 0.25 } },
          ],
          layout: { name: 'preset' },
        });

        // Function to lay each transition label along its edge and lift it clear of the line.
        async function updateEdgeLabelMargins() {
          cy.edges().forEach((edge: any) => {
            // Self-loops are handled by `selfLoopGeometry`, which lifts the label past the
            // loop and leaves it horizontal, as JFLAP does. Source and target coincide, so
            // there is no edge direction here to work from anyway.
            if (edge.data('isLoop') === 1) return;
            const { x, y } = edgeLabelOffset(
              edge.source().position(),
              edge.target().position(),
              edge.midpoint(),
            );
            // The angle comes from `text-rotation: autorotate` in the stylesheet. These
            // margins are in screen space, not the label's own rotated frame, so the
            // standoff stays perpendicular to the edge whatever angle the label is at.
            edge.style({ 'text-margin-x': x, 'text-margin-y': y });
          });
        }

        // Function to aim each self-loop and put its label beyond it. Runs after
        // `updateEdgeLabelMargins`, so where every other transition label sits is already
        // settled and a loop can be steered clear of them.
        async function selfLoopGeometry() {
          const labelAnchors = edgeLabelAnchors(cy);

          cy.edges('[isLoop = 1]').forEach((e: any) => {
            const node = e.source();
            const nodePos = node.position();
            const obstacles = cy
              .nodes()
              .filter((n: any) => n.id() !== node.id() && !n.hasClass('start'))
              .map((n: any) => n.position())
              .concat(labelAnchors);

            const direction = bestLoopDirection(nodePos, obstacles, incidentEdgeAngles(node));
            // Remembered so the initial-state marker, which is placed after this, can be
            // steered clear of the loop.
            e.data('loopDirection', direction);
            const lines = String(e.data('label') ?? '').split('\n').length;
            const offset = loopLabelOffset(direction, lines);

            e.style({
              // See the stylesheet above: cytoscape has no `loop` curve-style.
              'curve-style': 'bezier',
              'loop-direction': `${direction}deg`,
              'loop-sweep': '50deg',
              'control-point-step-size': LOOP_STEP_SIZE,
              'source-arrow-shape': 'triangle',
              'target-arrow-shape': 'none',
              'arrow-scale': 0.95,
              'line-cap': 'round',
              'text-rotation': 'none',
              'text-margin-x': offset.x,
              'text-margin-y': offset.y,
            });
          });
        }

        // Function to fit and resize frame
        async function fitAndResize() {
          if (!cyRef.current) return;

          const cy = cyRef.current;
          try {
            cy.resize();
            const elkAspectRatio =
              !containerRef.current?.clientWidth || !containerRef.current?.clientHeight
                ? '1.6f'
                : `${containerRef.current.clientWidth / containerRef.current.clientHeight}f`;
            let layoutOptions;
            if (!honorPositions) {
              /*
               * Give the layout room for the LABELS, not just the states.
               *
               * ELK lays out nodes and edges; it knows nothing about the text cytoscape
               * later draws on an edge. With a flat 50px node spacing that was fine for an
               * FA whose labels are one character, and hopeless for a PDA or TM, where
               * `0 → 0, R` or eight stacked stack-operations end up longer than the edge
               * they sit on. Adjacent labels then landed on top of each other.
               *
               * So measure the widest and tallest label actually present and ask for edges
               * long enough to hold one. A machine of single-character labels keeps a
               * compact layout; a wordy one spreads out only as much as it has to.
               */
              let widestLabel = 0;
              let tallestLabel = 1;
              cy.edges().forEach((e: any) => {
                const lines = String(e.data('label') ?? '').split('\n');
                tallestLabel = Math.max(tallestLabel, lines.length);
                for (const line of lines) {
                  widestLabel = Math.max(widestLabel, line.length);
                }
              });
              // ~8px per character at the 16px edge font, capped so one pathological label
              // can't push the whole machine apart.
              const labelWidth = Math.min(widestLabel * 8, 220);
              const labelHeight = Math.min(tallestLabel * LABEL_LINE_HEIGHT, 220);

              layoutOptions = {
                name: 'elk',
                nodeDimensionsIncludeLabels: true,
                elk: {
                  // `stress` over `force`: it honours a desired edge length, which is the
                  // one lever that actually buys space for a label, and it produces a
                  // stable, symmetric result for the small cyclic graphs automata are.
                  algorithm: 'stress',
                  'elk.aspectRatio': elkAspectRatio,
                  'elk.stress.desiredEdgeLength': String(160 + labelWidth),
                  'elk.spacing.nodeNode': String(60 + labelHeight),
                  // Deterministic: the same machine should lay out the same way every time
                  // it is opened, so a student and an instructor discuss the same picture.
                  'elk.randomSeed': '1',
                },
              };
            } else {
              layoutOptions = {
                name: 'preset',
                positions: undefined,
              };
            }

            // Load the new layout properly based on the layout option
            if (layoutOptions.name === 'preset') {
              // honorPositions
              cy.layout(layoutOptions).run();
            } else {
              await new Promise((resolve) => {
                // !honorPositions
                const layout = cy.layout(layoutOptions);
                layout.run();
                layout.on('layoutstop', resolve);
              });
            }

            await updateEdgeLabelMargins();
            await selfLoopGeometry();
            repositionStartNodes(cy);

            if (cy.nodes().length === 0) return;

            // Fit to the real extent of everything, LABELS INCLUDED. The old maths took the
            // min/max of node CENTRES, so each node's own radius and every edge label lay
            // outside the box it fitted to, and a tall self-loop label or a wide transition
            // label was reliably cut off at the edge of the canvas. `fit` measures the
            // rendered bounding box, which is what the reader actually has to see.
            cy.fit(cy.elements(), FIT_PADDING);

            // Then back off if that magnified a small machine. Fitting alone fills the
            // canvas whatever is in it, so a two-state automaton arrived at 4x with states
            // the size of a fist and no context around them. Above 1:1 there is nothing
            // more to see, only bigger circles, so cap it and re-centre.
            if (cy.zoom() > MAX_INITIAL_ZOOM) {
              cy.zoom(MAX_INITIAL_ZOOM);
              cy.center(cy.elements());
            }
          } catch {}
        }

        cyRef.current = cy;

        // Follow cytoscape rather than tracking zoom in parallel: the wheel, a pinch, Fit and
        // the buttons all change it, and a second source of truth would drift from whichever
        // of those the user reached for last.
        setZoomState(cy.zoom());
        cy.on('zoom', () => setZoomState(cy.zoom()));

        // make sure zooming/panning are enabled
        cy.userZoomingEnabled(true);
        cy.panningEnabled(true);
        cy.userPanningEnabled(true);

        // The notes are elements like any other, so hiding them is a style change rather than
        // a rebuild. Applied here as well as in the effect below because the elements only
        // exist from this point, and an effect that ran before them would do nothing.
        applyNoteVisibility(cy, showNotesRef.current);

        // Expose fitAndResize for Fit button and initial layout
        onResizeRef.current = () => void fitAndResize();
        refreshLabelGeometryRef.current = () => {
          void (async () => {
            await updateEdgeLabelMargins();
            await selfLoopGeometry();
            repositionStartNodes(cy);
          })();
        };
        setTimeout(() => {
          void (async () => {
            try {
              if (!isCurrent()) return;
              // Fit first either way: it sizes the canvas and settles the layout, and the
              // centring it does is what keeps the machine in view at 100% rather than off in
              // a corner. Only then is the scale set back to 1:1, if that was asked for.
              await fitAndResize();
              const current = cyRef.current;
              if (!current || !isCurrent()) return;
              // An undo that crossed a layout switch, waiting for this rebuild. It wins over
              // everything else here: it is the reader asking for a particular arrangement
              // back, and for the view not to move while they get it.
              const pending = pendingArrangement.current;
              if (pending) {
                pendingArrangement.current = null;
                applyArrangement(current, pending.snapshot);
                current.zoom(pending.zoom);
                current.pan(pending.pan);
                return;
              }
              // A remembered view wins over both, because it is where the reader was.
              if (restoreSavedView(current)) return;
              if (initialZoomRef.current !== 'actual') return;
              current.zoom(1);
              current.center(current.nodes());
            } catch (err) {
              // Reported rather than swallowed: the graph still appears, thanks to the
              // `finally` below, so nothing here is worth failing a load over, but a scale
              // step that has started throwing is a bug somebody should see.
              console.error('[viewer] could not set the initial scale:', err);
            } finally {
              // One frame first. Revealing in the same tick as the last change uncovers the
              // canvas while cytoscape may still be redrawing it, which is the tail of the
              // flash rather than its cause.
              await nextFrame();
              // Not if a newer load has taken over in the meantime: revealing, and above all
              // writing the view down, belong to whichever load owns the graph now.
              if (!isCurrent()) return;
              // In a `finally` so a layout that throws still reveals the graph. A machine
              // drawn wrongly is recoverable; one that never appears is not.
              setSettled(true);
              setPhase('ready');
              viewRestored.current = true;
              // Write the opening view down now, so a reader who changes nothing and refreshes
              // still comes back to the same picture. Whatever the step above decided is
              // already on the graph, so this records that rather than overwriting it.
              rememberView();
              // And, if this pane is driving a linked one, where it ended up. The effect that
              // reports when the link is switched on cannot: at mount there is no graph yet.
              reportViewport();
            }
          })();
        }, 0);

        // Everything that changes the view, in one place. `viewport` covers the zoom and the
        // pan, whichever of the wheel, the slider, Fit or a drag of the background caused
        // them; `position` covers a state being moved, including by undo and redo. Debounced,
        // because both fire continuously while a reader is dragging. Written as it happens
        // rather than on the way out, so a browser that is closed or killed still leaves the
        // view it had.
        const rememberViewSoon = debounce(rememberView, 400);
        cy.on('viewport position', rememberViewSoon);

        // Undebounced, unlike remembering: a linked pane that lagged a fraction of a second
        // behind the one being dragged would read as broken rather than as linked.
        cy.on('viewport', reportViewport);

        /**
         * Keep the canvas in step with its container without touching the zoom.
         *
         * This used to refit on a window resize, which threw away whatever magnification the
         * reader had set: they would zoom in on one corner of a large machine, drag the window
         * wider, and find themselves looking at the whole thing again. It re-centres instead,
         * so the same detail is still on screen at the same size.
         *
         * A `ResizeObserver` on the container rather than a listener on the window, because
         * the container is what actually matters and it can change without the window doing
         * anything: the standalone viewer's panes are half-width, and a dialog can be resized
         * by things other than the window. A window resize reaches this too, since it changes
         * the container.
         */
        const resizeKeepingZoom = debounce(() => {
          const current = cyRef.current;
          if (!current) return;
          try {
            const before = canvasSize.current;
            const zoom = current.zoom();
            const pan = { ...current.pan() };
            current.resize();
            const after = { width: current.width(), height: current.height() };
            canvasSize.current = after;
            if (!before) return;
            const next = panKeepingCentre(before, after, zoom, pan);
            if (next) current.pan(next);
          } catch {
            // A graph mid-teardown. Nothing to resize.
          }
        }, 160);
        if (typeof ResizeObserver === 'function' && containerRef.current) {
          // The size to compare the next one against. Read now, while it is still the size the
          // machine was drawn at.
          canvasSize.current = { width: cy.width(), height: cy.height() };
          const observer = new ResizeObserver(resizeKeepingZoom);
          observer.observe(containerRef.current);
          (cy as any).__resizeObserver = observer;
        }

        // Adjust the layout of the transitions
        await updateEdgeLabelMargins();

        // keep zooming/panning enabled after layout
        cy.userZoomingEnabled(true);
        cy.panningEnabled(true);
        cy.userPanningEnabled(true);

        // highlight on click
        cy.on('tap', (evt: any) => {
          if (evt.target === cy) {
            cy.elements().removeClass('faded highlighted');
            // A click on empty canvas means "never mind", so the properties panel goes too.
            setSelectedStateId(null);
            setSelectedEdge(null);
            setSelectedPosition(null);
            return;
          }
          const ele = evt.target;
          // Scenery, not machine: a note is the author's words laid on the canvas, and the
          // start marker is a decoration hanging off the initial state. Clicking either does
          // nothing at all rather than dimming the machine around it. (`events: 'no'` should
          // already stop a note being a tap target; this is the belt to that brace, since a
          // note has no neighbourhood and would otherwise fade everything.)
          if (ele.hasClass?.('note') || ele.hasClass?.('start')) return;
          // One panel at a time: a state and an edge cannot both be what was just clicked.
          const isNode = ele.isNode?.() ?? false;
          setSelectedStateId(isNode ? (ele.id?.() ?? null) : null);
          // Where it is now, for the panel's coordinate boxes. From the graph rather than the
          // file: this is the point a drag moves, and the file's is where its author put it.
          const at = isNode ? ele.position?.() : null;
          setSelectedPosition(isFinitePoint(at) ? { x: at.x, y: at.y } : null);
          setSelectedEdge(
            isNode ? null : { from: ele.data?.('source') ?? '', to: ele.data?.('target') ?? '' },
          );
          highlightElement(cy, ele);
        });

        /**
         * Keep the painted grid in step with the graph.
         *
         * The lines are a CSS background on the container, so without this they stay put while
         * the machine pans and zooms underneath them: decoration rather than a grid. Written
         * straight to the element rather than through state, because it changes on every frame
         * of a pan and re-rendering React that often would be absurd. The component sets only
         * `background-image`, so it never clobbers these two.
         */
        const syncGridToGraph = () => {
          try {
            const el = containerRef.current;
            if (!el) return;
            const scale = cy.zoom();
            const offset = cy.pan();
            if (!Number.isFinite(scale) || !Number.isFinite(offset?.x)) return;
            el.style.backgroundSize = `${GRID_STEP * scale}px ${GRID_STEP * scale}px`;
            el.style.backgroundPosition = `${offset.x}px ${offset.y}px`;
          } catch {
            // The grid is decoration. It is drawn during the same load that draws the machine,
            // and a viewer that refused to show a machine because it could not place a
            // background line would be trading the whole feature for the trim on it.
          }
        };
        cy.on('zoom pan resize', syncGridToGraph);
        syncGridToGraph();

        // A drag is one undoable step, so the snapshot is taken when the state is picked up
        // rather than on every pixel of movement. `grab` fires once, at the start, and on a
        // plain click as well, which is why the snapshot is only held here.
        cy.on('grab', 'node', () => {
          pendingSnapshot.current = readSnapshot();
        });

        // Release. Two things happen here, both only when the state really moved: cytoscape
        // fires `dragfree` on a drag and not on a click, so a click leaves the held snapshot
        // uncommitted and the drawing unchanged.
        //
        // Snapping is on release rather than during the drag: the state follows the pointer
        // exactly while it is held, then settles onto the lattice, which reads as landing
        // rather than as the drag fighting back.
        cy.on('dragfree', 'node', (evt: any) => {
          const moved = pendingSnapshot.current !== null;
          commitPendingMove();
          if (moved) {
            // Write the view down again now that this counts as a rearrangement. Dragging a
            // state and then holding it still schedules the write while the flag is still off,
            // and release fires nothing else, so without this the saved view would have the
            // new positions and say the drawing had not been touched.
            rememberViewSoon();
          }

          if (!snapToGridRef.current) return;
          const node = evt?.target;
          if (!node?.position || node.hasClass?.('note') || node.hasClass?.('start')) return;
          const at = node.position();
          if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return;
          node.position({
            x: Math.round(at.x / GRID_STEP) * GRID_STEP,
            y: Math.round(at.y / GRID_STEP) * GRID_STEP,
          });
        });

        // Keep the label and loop geometry, and the initial-state marker, following a
        // state the reader has dragged. Moving the marker itself fires this too, so skip
        // it: it has nothing hanging off it, and reacting would only recurse.
        cy.on('position', async (evt: any) => {
          const target = evt.target;
          if (!target?.isNode?.() || target.hasClass('start') || target.hasClass('note')) return;

          if (target.id?.() === selectedStateIdRef.current) {
            const at = target.position?.();
            if (isFinitePoint(at)) setSelectedPosition({ x: at.x, y: at.y });
          }
          await updateEdgeLabelMargins();
          await selfLoopGeometry();
          repositionStartNodes(cy);
        });
      } catch (e: any) {
        // Anything past the parse: building or laying out the graph. Logged because unlike
        // the cases above it is a bug rather than a thing that happens.
        console.error(e);
        setFailure(failureForContent());
      }
    },
    // The last four never change identity, so they cost nothing here.
    [
      src,
      epsSymbol,
      darkMode,
      honorPositions,
      rememberView,
      restoreSavedView,
      commitPendingMove,
      readSnapshot,
    ],
  );

  /**
   * Write the view down when something that is not the camera changes.
   *
   * The debounced writer answers the camera and the arrangement, which cytoscape reports; none
   * of these move either. Without this a panel opened and then refreshed away came back, a panel
   * closed came back open, and a state renamed a moment before a refresh was remembered only
   * because the flush on the way out happened to catch it.
   *
   * Only once the machine is on screen, or the clearing that every load starts with would erase
   * the selection that load is about to restore.
   */
  useEffect(() => {
    if (phase !== 'ready') return;
    rememberView();
  }, [
    phase,
    selectedStateId,
    selectedEdge,
    renames,
    initialOverride,
    finalOverrides,
    transitionEdits,
    rememberView,
  ]);

  /**
   * Write the view down on the way out.
   *
   * The writer is debounced, so a wheel or a drag in the last fraction of a second before a
   * refresh would otherwise not be saved: exactly the sequence somebody runs to check that
   * this works at all. Reads only refs, so the closure being from the first render is fine.
   */
  useEffect(() => {
    const flush = () => rememberView();
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [rememberView]);

  // `reloadNonce` is here rather than in `load` because the cleanup below is what makes a
  // rebuild safe: it destroys the previous engine and takes its resize listener with it.
  useEffect(() => {
    if (typeof window !== 'undefined') void load();
    return () => {
      const cy = cyRef.current;
      if (cy) {
        (cy as any).__resizeObserver?.disconnect();
        cy.destroy();
        cyRef.current = null;
      }
    };
  }, [load, reloadNonce]);

  /* ── undo and redo ──────────────────────────────────────────────────── */

  /**
   * Put the reader's answers about the machine back to what a snapshot saw.
   *
   * The refs are written as well as the state, because what follows reads them within this same
   * event: React has not re-rendered yet, and a load already in flight derives the machine from
   * the refs on its way past the parse.
   */
  const applySnapshotEdits = (snapshot: ViewerSnapshot) => {
    setRenames(snapshot.renames);
    setInitialOverride(snapshot.initialOverride);
    setFinalOverrides(snapshot.finalOverrides);
    setTransitionEdits(snapshot.transitionEdits);
    renamesRef.current = snapshot.renames;
    initialOverrideRef.current = snapshot.initialOverride;
    finalOverridesRef.current = snapshot.finalOverrides;
    transitionEditsRef.current = snapshot.transitionEdits;

    const pristine = pristineParsed.current;
    if (!pristine) return;
    const next = deriveParsed(pristine, snapshot);
    setParsed(next);
    const cy = cyRef.current;
    if (cy) syncGraph(cy, next, epsSymbol);
  };

  /** Move one step between the two stacks, applying whatever is on the other side. */
  const step = (from: typeof undoStack, to: typeof redoStack) => {
    const cy = cyRef.current;
    const snapshot = from.current.pop();
    if (!cy || !snapshot) return;

    const current = readSnapshot();
    if (current) to.current.push(current);

    applySnapshotEdits(snapshot);

    if (snapshot.honorPositions !== honorPositions) {
      // Switching the layout rebuilds the graph, so the positions cannot be put back on this
      // one: they are handed to the load that is about to run instead.
      try {
        pendingArrangement.current = { snapshot, zoom: cy.zoom(), pan: { ...cy.pan() } };
      } catch {
        pendingArrangement.current = { snapshot, zoom: 1, pan: { x: 0, y: 0 } };
      }
      setHonorPositions(snapshot.honorPositions);
    } else {
      applyArrangement(cy, snapshot);
    }

    setUndoDepth(undoStack.current.length);
    setRedoDepth(redoStack.current.length);
  };

  /* ── notes ──────────────────────────────────────────────────────────── */

  useEffect(() => {
    if (cyRef.current) applyNoteVisibility(cyRef.current, showNotes);
  }, [showNotes, parsed, honorPositions]);

  /* ── zoom helpers (animated, keep center fixed) ─────────────────────── */
  const animatedZoomTo = (level: number) => {
    const cy = cyRef.current;
    if (!cy) return;
    const min = typeof cy.minZoom === 'function' ? cy.minZoom() : 0.2;
    const max = typeof cy.maxZoom === 'function' ? cy.maxZoom() : 6;
    const next = Math.max(min, Math.min(max, level));
    // Use cy.center(cy.nodes()) to get the center position
    const center = cy.center(cy.nodes());
    cy.animate({ zoom: next, center }, { duration: 120, easing: 'ease-in-out' });
  };

  /** Zoom bounds, read from the instance so they cannot disagree with the config above. */
  const zoomRange = () => {
    const cy = cyRef.current;
    const min = cy && typeof cy.minZoom === 'function' ? cy.minZoom() : 0.2;
    const max = cy && typeof cy.maxZoom === 'function' ? cy.maxZoom() : 6;
    return { min, max };
  };

  /**
   * Set the zoom directly, without the easing the buttons use.
   *
   * A slider is dragged continuously, and animating each step would leave the graph chasing
   * the thumb instead of tracking it.
   */
  const setZoom = (level: number) => {
    const cy = cyRef.current;
    if (!cy) return;
    const { min, max } = zoomRange();
    cy.zoom({ level: Math.max(min, Math.min(max, level)), renderedPosition: undefined });
    cy.center(cy.nodes());
  };

  const zoomIn = () => {
    const cy = cyRef.current;
    if (!cy) return;
    animatedZoomTo(cy.zoom() * 1.2);
  };

  const zoomOut = () => {
    const cy = cyRef.current;
    if (!cy) return;
    animatedZoomTo(cy.zoom() / 1.2);
  };

  const downloadSVG = async () => {
    if (!cyRef.current) return;
    const svgStr: string = cyRef.current.svg({ scale: 1, full: true });
    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    await downloadDataUrl(`${(title ?? 'automaton').replace(/\s+/g, '_')}.svg`, url);
    URL.revokeObjectURL(url);
  };

  // Use the canvas's actual background (white in light mode) so exported/copied
  // images match the viewer instead of coming out transparent.
  const exportBackground = () => {
    const el = containerRef.current;
    if (el) {
      const bg = getComputedStyle(el).backgroundColor;
      if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') return bg;
    }
    return '#ffffff';
  };

  const downloadPNG = async () => {
    if (!cyRef.current) return;
    const dataUrl: string = cyRef.current.png({ scale: 2, full: true, bg: exportBackground() });
    await downloadDataUrl(`${(title ?? 'automaton').replace(/\s+/g, '_')}.png`, dataUrl);
  };

  /**
   * Copy the drawing as SVG, as text.
   *
   * Written to the clipboard as a string rather than as an `image/svg+xml` item, because that
   * is what the places people paste into actually accept: a text paste lands as editable
   * vector art in Illustrator or Inkscape and as markup in an editor, whereas an svg
   * clipboard item is ignored by most of them.
   */
  const copySVG = async () => {
    if (!cyRef.current) return;
    const svgStr: string = cyRef.current.svg({ scale: 1, full: true });
    try {
      await navigator.clipboard.writeText(svgStr);
    } catch {
      // No clipboard permission, or an insecure origin. Falling back to the download keeps
      // the action doing something rather than failing silently.
      await downloadSVG();
    }
  };

  /** Copy the machine as prose, the one export that can be quoted in a reply. */
  const copyDescription = async () => {
    if (!parsed) return;
    const text = machineDescriptionText(describeMachine(parsed, epsSymbol));
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Nothing to fall back to that would not be a surprise, so this stays quiet. The same
      // text is on screen behind "Show text representation" and can be selected by hand.
    }
  };

  /**
   * The machine as it currently sits, as a `.jff`.
   *
   * The point of it is the auto-arranged layout: the engine's placement is usually far more
   * readable than a hand-drawn one, and until now there was no way to keep it. Positions are
   * read from the live graph rather than from the parsed file, so what is saved is what is on
   * screen.
   *
   * The submitted file is never touched. This writes a new one, because the bytes a student
   * submitted are the record of what they did and several stored hashes are derived from them.
   */
  const downloadCurrent = async () => {
    const cy = cyRef.current;
    if (!cy || !parsed) return;

    const states = parsed.states.map((state) => {
      const node = cy.getElementById(state.id);
      // A state the graph does not have (it should not happen) keeps the position it came
      // with, rather than being moved to the origin.
      if (!node || typeof node.position !== 'function' || node.empty?.()) return state;
      const position = node.position();
      if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return state;
      // Both cytoscape and JFLAP put a state's coordinates at its centre, so this is a
      // straight copy. Notes are the ones that differ, and they are not moved here.
      return { ...state, xPos: position.x, yPos: position.y };
    });

    const xml = toJflapXml({ ...parsed, states });
    const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    await downloadDataUrl(`${(title ?? 'automaton').replace(/\s+/g, '_')}.jff`, url);
    URL.revokeObjectURL(url);
  };

  const copyPNG = async () => {
    if (!cyRef.current) return;
    try {
      const dataUrl: string = cyRef.current.png({ scale: 2, full: true, bg: exportBackground() });
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      const ClipboardItemCtor: any =
        (globalThis as any).ClipboardItem || (window as any).ClipboardItem;
      if (ClipboardItemCtor && navigator.clipboard && (navigator.clipboard as any).write) {
        const item = new ClipboardItemCtor({ [blob.type]: blob });
        await (navigator.clipboard as any).write([item]);
      } else {
        throw new Error('ClipboardItem not supported');
      }
    } catch {
      await downloadPNG();
    }
  };

  return {
    containerRef,
    settled,
    failure,
    phase,
    /** Ask for the file again. Only worth offering when the failure says it is. */
    retry: () => setReloadNonce((n) => n + 1),
    type,
    parsed,
    honorPositions,
    toggleHonorPositions: () => {
      // Recorded before the switch, so undo returns both the layout and the positions the
      // reader had arranged under it.
      pushUndoStep(readSnapshot());
      setHonorPositions((p) => !p);
    },
    /**
     * Put this machine back the way it opened.
     *
     * The states return to where the file has them, the layout returns to the one the viewer
     * opens on, and the remembered view and the undo history go. Only this machine: the other
     * tabs, the grid, the notes and snapping are all left alone.
     *
     * Nothing here touches the submitted file. It was never changed in the first place; what
     * is being discarded is the reader's own rearranging of the drawing.
     */
    resetMachine: () => {
      // The rebuild below opens the file as its author drew it, rather than restoring what is
      // being thrown away here.
      skipRestore.current = true;
      clearViewState(viewStateKeyRef.current);
      setRestoredModified(false);
      // The rebuild below keeps the history now, since it is the same file. Reset is the one
      // place that means to throw it away.
      undoStack.current = [];
      redoStack.current = [];
      pendingSnapshot.current = null;
      setUndoDepth(0);
      setRedoDepth(0);
      // Including the names and which state is initial: "the way the file opened" means the
      // author's answers, not the reader's.
      setRenames({});
      setInitialOverride(undefined);
      setFinalOverrides({});
      setTransitionEdits({});
      setHonorPositions(honorPositionsDefault);
      // The rebuild puts every state back where its author had it.
      setReloadNonce((n) => n + 1);
    },
    zoomIn,
    zoomOut,
    zoom,
    setZoom,
    showNotes,
    toggleNotes: () => setShowNotes((on) => !on),
    snapToGrid,
    toggleSnapToGrid: () => setSnapToGrid((on) => !on),
    /** Whether the drawing has been changed since it was opened. */
    viewModified: viewModifiedRef.current,
    canUndo: undoDepth > 0,
    canRedo: redoDepth > 0,
    undo: () => step(undoStack, redoStack),
    redo: () => step(redoStack, undoStack),
    selectedState:
      parsed && selectedStateId ? describeState(parsed, selectedStateId, epsSymbol) : null,
    clearSelectedState: () => {
      setSelectedStateId(null);
      setSelectedEdge(null);
      setSelectedPosition(null);
    },
    /** Where the selected state sits on the canvas now, which a drag keeps in step. */
    selectedStatePosition: selectedPosition,
    /**
     * Take a snapshot before one of the panel's boxes is typed into.
     *
     * The same bargain a drag makes: how things stand is remembered as the box takes focus and
     * only becomes an undo step if something actually changes, so tabbing through the panel
     * records nothing. It is also what makes a name one step instead of one per letter.
     */
    beginEdit: () => {
      pendingSnapshot.current = readSnapshot();
    },
    /**
     * Put a state at a given point, which is the panel's coordinate boxes.
     *
     * The drawing's own coordinates, the ones a drag moves it through and the ones "Download
     * this arrangement" writes out, not the file's: those are where its author put it, and it
     * may have been dragged since.
     */
    moveState: (id: string, at: { x: number; y: number }) => {
      if (!isFinitePoint(at)) return;
      const cy = cyRef.current;
      if (!cy) return;
      try {
        const node = cy.getElementById(id);
        if (!node || node.empty?.()) return;
        commitPendingMove();
        node.position({ x: at.x, y: at.y });
        setSelectedPosition({ x: at.x, y: at.y });
        refreshLabelGeometryRef.current?.();
        rememberView();
      } catch {
        // A graph mid-teardown. Nothing to move.
      }
    },
    /**
     * Open a transition's properties, as if its line had been clicked.
     *
     * The rows in a state's panel are the way into the transitions around it, which a canvas
     * cannot offer to somebody who is not using a mouse. Goes through the same restore path a
     * refresh does, so the drawing dims around it exactly as a click would leave it.
     */
    selectTransition: (from: string, to: string) => {
      const cy = cyRef.current;
      if (!cy) return;
      restoreSelection(cy, { kind: 'transition', from, to });
    },
    /**
     * Make a state the initial one, or take the marker away with `null`.
     *
     * One at a time: a machine has a single initial state, so this moves the arrow rather than
     * adding another. On screen only, like renaming, and the same three places follow: the
     * drawing, everything that describes the machine, and the arrangement a reader downloads.
     */
    setInitialState: (id: string | null) => {
      // A tick, not a typed word: the whole change happens at once, so the step is recorded
      // here rather than waiting on a first keystroke the way the text boxes do.
      recordStep();
      setInitialOverride(id);
      setParsed((current) => (current ? applyInitialState(current, id) : current));
      const cy = cyRef.current;
      if (!cy) return;
      try {
        cy.nodes().forEach((node: any) => {
          if (node.hasClass?.('start') || node.hasClass?.('note')) return;
          node.data('initial', node.id() === id ? 1 : 0);
        });
        if (id === null) {
          // The markers are made one per initial state, so with none left there is nothing to
          // move the old one to: it has to go.
          cy.nodes()
            .filter((node: any) => node.hasClass?.('start'))
            .forEach((node: any) => node.remove?.());
          return;
        }
        repositionStartNodes(cy);
      } catch {
        // A graph mid-teardown. The choice is kept, and the next load draws it.
      }
    },
    /**
     * Change one part of one transition, on screen only.
     *
     * Which parts there are depends on the machine: `read` for a finite automaton, plus `pop`
     * and `push` for a pushdown automaton, or `write` and `move` for a Turing machine. The panel
     * asks `transitionFields` and offers exactly those.
     *
     * Transitions between the same two states are drawn as one line carrying all their labels,
     * so the line's whole label is worked out again from the transitions behind it rather than
     * patched, and the geometry that keeps that label clear of the line is run again after.
     */
    setTransitionField: (
      index: number,
      field: 'read' | 'write' | 'move' | 'pop' | 'push',
      value: string,
    ) => {
      // Typed, so the step was taken when the box took focus: this commits it on the first
      // character and does nothing on the rest. One undo per box visited, not per keystroke.
      commitPendingMove();
      setTransitionEdits((current) => ({
        ...current,
        [index]: { ...current[index], [field]: value },
      }));
      if (!parsed) return;
      const next = applyTransitionEdits(parsed, { [index]: { [field]: value } });
      setParsed(next);

      const edited = next.transitions.find((transition) => transition.__idx === index);
      const cy = cyRef.current;
      if (!edited || !cy) return;
      try {
        const bundled = bundleEdges(
          next.transitions.filter((t) => t.from === edited.from && t.to === edited.to),
          next.type,
          epsSymbol,
        )[0];
        const edge = cy
          .edges()
          .filter(
            (e: any) => e.data('source') === edited.from && e.data('target') === edited.to,
          )?.[0];
        if (!edge || bundled === undefined) return;
        edge.data('label', bundled.label);
        refreshLabelGeometryRef.current?.();
      } catch {
        // A graph mid-teardown. The change is kept, and the next load draws it.
      }
    },
    /**
     * Make a state final, or stop it being one.
     *
     * Any number of states can be final, so this says nothing about the others. The double
     * circle JFLAP draws is a class on the node here, and the initial-state marker has to clear
     * whichever border the state ends up with, so the marker is placed again afterwards.
     */
    setFinalState: (id: string, final: boolean) => {
      recordStep();
      setFinalOverrides((current) => ({ ...current, [id]: final }));
      setParsed((current) => (current ? applyFinalStates(current, { [id]: final }) : current));
      const cy = cyRef.current;
      if (!cy) return;
      try {
        const node = cy.getElementById(id);
        if (!node || node.empty?.()) return;
        node.data('final', final ? 1 : 0);
        if (final) node.addClass('final');
        else node.removeClass('final');
        repositionStartNodes(cy);
      } catch {
        // A graph mid-teardown. The choice is kept, and the next load draws it.
      }
    },
    /**
     * Give a state a different name, on screen only.
     *
     * The label on the drawing, the panels that mention the state, the text representation and
     * the `.jff` that "Download this arrangement" writes all follow. The submitted file does
     * not: nothing in this viewer writes to it, and this is why the reader is told the file has
     * changed on screen.
     *
     * Undoable, along with everything else a reader can change here. One step per visit to the
     * box rather than one per keystroke: see `pendingSnapshot`.
     */
    renameState: (id: string, name: string) => {
      // As with a transition's fields: the snapshot was taken when the box took focus, and the
      // first character typed is what turns it into a step.
      commitPendingMove();
      setRenames((current) => ({ ...current, [id]: name }));
      setParsed((current) => (current ? applyRenames(current, { [id]: name }) : current));
      // The drawing, straight away rather than through a rebuild: the reader is typing.
      try {
        const node = cyRef.current?.getElementById(id);
        if (node && !node.empty?.()) node.data('label', name);
      } catch {
        // A graph mid-teardown. The name is kept either way, and the next load applies it.
      }
    },
    selectedTransition:
      parsed && selectedEdge
        ? describeEdge(parsed, selectedEdge.from, selectedEdge.to, epsSymbol)
        : null,
    zoomRange,
    fit: () => onResizeRef.current?.(),
    /**
     * Bring the machine back to the middle of the pane, at the scale the reader chose.
     *
     * Fit is the wrong tool when somebody has zoomed in deliberately: it takes them back out
     * to the whole machine. This moves the camera and nothing else, which is what a reader who
     * has panned off the edge of a large automaton actually wants.
     *
     * Centred on everything rather than on the states alone, which is what Fit measures too:
     * an edge label or a note hanging off one side is part of what has to be on screen.
     */
    center: () => {
      const cy = cyRef.current;
      if (!cy) return;
      try {
        cy.center(cy.elements());
      } catch {
        // A graph mid-teardown. There is nothing on screen to centre.
      }
    },
    downloadSVG,
    downloadCurrent,
    copySVG,
    copyDescription,
    downloadPNG,
    copyPNG,
  };
}
