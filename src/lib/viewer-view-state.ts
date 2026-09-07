/**
 * What the standalone viewer remembers about a machine across a refresh.
 *
 * A reader zooms in on a corner of an automaton, drags two states apart to see an edge, and
 * then reloads the page: without this, all of that is gone and they start again from the fit.
 *
 * `sessionStorage`, deliberately. It survives a refresh, which is what was asked for, and it
 * goes when the window does, which matches the rest of the window's behaviour: closing a tab
 * already forgets its arrangement. It also means nothing is left on a shared office machine
 * naming which students' files somebody opened.
 *
 * Nothing here is authoritative. The submitted file is unchanged and is the record; this is a
 * view of it, and losing it costs a reader one fit.
 */

/**
 * The camera: how far in, and where over the machine.
 *
 * Its own type because it travels on its own when two panes are linked, without the positions
 * that the rest of the remembered view carries.
 */
export type ViewerViewport = { zoom: number; pan: { x: number; y: number } };

/**
 * What the reader had open, so the properties panel comes back with the view.
 *
 * A transition is named by its two ends rather than by an element id, because the ids the
 * drawing uses are positional (`e3-q0-q1`) and would move if the file were reordered. The pair
 * is what the panel asks about anyway: parallel transitions between the same two states are one
 * line on the canvas.
 */
export type ViewerSelection =
  | {
      kind: 'state';
      /**
       * The state whose properties were open, or the first of several.
       *
       * Always written, even when several states were selected, so an entry from before
       * multi-select still reads and an older viewer still restores something sensible from a
       * newer one. One shape rather than a second `kind`, because this is one concept.
       */
      id: string;
      /**
       * Every selected state, when there was more than one. Absent means just `id`.
       *
       * Two or more states selected is not a panel: the inspector describes one state, so it
       * stays shut and the highlight is the whole of what comes back.
       */
      ids?: string[];
    }
  | { kind: 'transition'; from: string; to: string };

/** Where every state sits, plus the camera looking at it. */
export type ViewerViewState = {
  /** Bumped when the shape changes, so an old entry is ignored rather than misread. */
  v: 1;
  zoom: number;
  pan: { x: number; y: number };
  /**
   * The model point that was under the middle of the canvas.
   *
   * The pan above is in rendered pixels and so belongs to the size the canvas had when it was
   * written down. That size is not the size it comes back at: the properties panel docks beside
   * the drawing and takes 20rem of it, and on the way back in the panel opens a moment after the
   * view is restored. Restoring the pan therefore moved the machine left by half a panel every
   * refresh, and it accumulated. This is what the restore uses; `pan` stays for an entry written
   * before this existed.
   */
  centre?: { x: number; y: number };
  positions: Record<string, { x: number; y: number }>;
  /** Whether the reader was on the drawn layout or the auto-arranged one. */
  honorPositions: boolean;
  /**
   * Whether the reader had moved anything, as opposed to looking at the file as it came.
   *
   * Optional so an entry written before this existed still opens: the view is worth more than
   * the flag, and the worst it costs is an indicator that stays quiet for one session.
   */
  modified?: boolean;
  /**
   * The state or transition whose properties were open, if any.
   *
   * Optional for the same reason as `modified`: an entry written before this existed still
   * opens, and the worst it costs is a panel the reader has to click again.
   */
  selection?: ViewerSelection | null;
  /**
   * The names the reader has given states, by state id.
   *
   * Kept for the same reason as the positions: a reader who renames three states to follow an
   * argument and then reloads should not lose the argument. Optional, like the two above, so an
   * entry written before this existed still opens.
   */
  renames?: Record<string, string>;
  /**
   * The state the reader has made the initial one, if they have said anything about it.
   *
   * Absent means the file's own answer stands. A string is the state they chose, and null is
   * "none", which is what unticking the box asks for. Three answers rather than two, because
   * "they have not touched it" and "they have taken it away" are different things to come back
   * to after a refresh.
   */
  initialState?: string | null;
  /**
   * Which states the reader has made final, or unmade, by state id.
   *
   * A map rather than a single id, because unlike the initial state a machine can have any
   * number of final ones: this says what the reader changed, and every state it does not name
   * keeps the file's own answer.
   */
  finals?: Record<string, boolean>;
  /**
   * What the reader has changed about transitions, by a transition's place in the file.
   *
   * Only the fields they touched, and only the ones their machine type has: a finite automaton's
   * transition reads, a pushdown automaton's also pops and pushes, a Turing machine's writes and
   * moves.
   */
  transitions?: Record<number, ViewerTransitionEdit>;
  /**
   * What Undo and Redo would step back through.
   *
   * The rest of this record is where the reader got to; this is how they got there. Without it
   * a refresh brought the machine back exactly as they had left it and then refused to undo any
   * of it, which is the one thing a reader who has just moved six states and reloaded the page
   * is most likely to want.
   *
   * Trimmed to the most recent {@link VIEWER_HISTORY_LIMIT} steps a side. A step carries every
   * state's position, and a long session on a large machine would otherwise be the biggest
   * thing in storage by a wide margin, for steps nobody walks back to.
   */
  history?: ViewerHistory;
  /**
   * States the reader has added to the drawing, which the file does not have.
   *
   * Coordinates in JFLAP's units, the same as the file's own, so a downloaded arrangement puts
   * them where they are on screen. Like every other field here this is a mark-up of the file
   * rather than a change to it: the submitted `.jff` is untouched, and closing the window
   * forgets these along with everything else.
   */
  addedStates?: ViewerAddedState[];
  /**
   * Transitions the reader has drawn between two states, which the file does not have.
   *
   * Optional like the rest, so an entry written before this existed still opens: the worst it
   * costs is a viewer that comes back without the lines somebody drew before this shipped, and
   * there were none.
   */
  addedTransitions?: ViewerAddedTransition[];
  /**
   * What the reader has taken off the drawing.
   *
   * States by id and transitions by their place in the file, which is how both are named
   * everywhere else here. One field rather than two because they are one answer: a machine with
   * a state removed has no transitions into it either, and the two are always written and read
   * together.
   */
  removed?: ViewerRemoved;
};

/** A state the reader drew, in the file's own coordinate units. */
export type ViewerAddedState = { id: string; name: string; xPos: number; yPos: number };

/**
 * A transition the reader drew, which the file does not have.
 *
 * `idx` is its identity everywhere: the key `transitionEdits` is written under, the number
 * `removed.transitions` names, and the `__idx` it gets in the derived machine. Allocated once,
 * above every index the file used and above every one already handed out, so it can never mean
 * one of the file's own transitions and never comes back as a different one after an undo.
 *
 * The label fields are the same optional ones a parsed transition has, so a finite automaton
 * carries `read`, a pushdown automaton adds `pop` and `push`, and a Turing machine has `write`
 * and `move`. One shape for all three, and the machine type decides which the inspector offers.
 */
export type ViewerAddedTransition = {
  idx: number;
  from: string;
  to: string;
  read?: string;
  write?: string;
  move?: string;
  pop?: string;
  push?: string;
};

/** What the reader has taken off the drawing: state ids, and transition indices. */
export type ViewerRemoved = { states: string[]; transitions: number[] };

/** One step of the viewer's undo history: the whole drawing as it stood before a change. */
export type ViewerHistoryStep = {
  positions: Record<string, { x: number; y: number }>;
  honorPositions: boolean;
  renames?: Record<string, string>;
  /** Three-valued like the field above: absent is untouched, null is "no initial state". */
  initialState?: string | null;
  finals?: Record<string, boolean>;
  transitions?: Record<number, ViewerTransitionEdit>;
  addedStates?: ViewerAddedState[];
  /** Optional like the rest, so a step written before this existed still steps. */
  addedTransitions?: ViewerAddedTransition[];
  removed?: ViewerRemoved;
};

export type ViewerHistory = { undo: ViewerHistoryStep[]; redo: ViewerHistoryStep[] };

/** How many steps a side survive a refresh. See `history` above for why there is a limit. */
export const VIEWER_HISTORY_LIMIT = 25;

/** The parts of a transition a reader can change. */
export type ViewerTransitionEdit = {
  read?: string;
  write?: string;
  move?: string;
  pop?: string;
  push?: string;
};

const PREFIX = 'afct.viewer.view.';

const isPoint = (value: unknown): value is { x: number; y: number } => {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.x === 'number' &&
    Number.isFinite(p.x) &&
    typeof p.y === 'number' &&
    Number.isFinite(p.y)
  );
};

function isSelection(value: unknown): value is ViewerSelection {
  if (!value || typeof value !== 'object') return false;
  const sel = value as Record<string, unknown>;
  if (sel.kind === 'state') {
    if (typeof sel.id !== 'string' || sel.id.length === 0) return false;
    // Absent is the ordinary case and the only one an older entry has.
    return (
      sel.ids === undefined ||
      (Array.isArray(sel.ids) && sel.ids.every((id) => typeof id === 'string'))
    );
  }
  if (sel.kind === 'transition') return typeof sel.from === 'string' && typeof sel.to === 'string';
  return false;
}

/** Reject anything that is not ours: the key is editable, and an old shape is not. */
function isViewState(value: unknown): value is ViewerViewState {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  if (s.v !== 1) return false;
  if (typeof s.zoom !== 'number' || !Number.isFinite(s.zoom) || s.zoom <= 0) return false;
  if (!isPoint(s.pan)) return false;
  if (s.centre !== undefined && !isPoint(s.centre)) return false;
  if (typeof s.honorPositions !== 'boolean') return false;
  if (s.modified !== undefined && typeof s.modified !== 'boolean') return false;
  if (s.selection !== undefined && s.selection !== null && !isSelection(s.selection)) return false;
  if (
    s.initialState !== undefined &&
    s.initialState !== null &&
    typeof s.initialState !== 'string'
  ) {
    return false;
  }
  if (s.finals !== undefined) {
    if (!s.finals || typeof s.finals !== 'object') return false;
    if (!Object.values(s.finals as Record<string, unknown>).every((v) => typeof v === 'boolean')) {
      return false;
    }
  }
  if (s.transitions !== undefined) {
    if (!s.transitions || typeof s.transitions !== 'object') return false;
    const edits = Object.values(s.transitions as Record<string, unknown>);
    const isEdit = (edit: unknown) =>
      !!edit &&
      typeof edit === 'object' &&
      Object.entries(edit as Record<string, unknown>).every(
        ([key, value]) =>
          ['read', 'write', 'move', 'pop', 'push'].includes(key) && typeof value === 'string',
      );
    if (!edits.every(isEdit)) return false;
  }
  if (s.renames !== undefined) {
    if (!s.renames || typeof s.renames !== 'object') return false;
    if (!Object.values(s.renames as Record<string, unknown>).every((v) => typeof v === 'string')) {
      return false;
    }
  }
  if (s.history !== undefined && !isHistory(s.history)) return false;
  if (s.addedStates !== undefined && !isAddedStates(s.addedStates)) return false;
  if (s.addedTransitions !== undefined && !isAddedTransitions(s.addedTransitions)) return false;
  if (s.removed !== undefined && !isRemoved(s.removed)) return false;
  if (!s.positions || typeof s.positions !== 'object') return false;
  return Object.values(s.positions as Record<string, unknown>).every(isPoint);
}

function isAddedStates(value: unknown): value is ViewerAddedState[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const st = entry as Record<string, unknown>;
      return (
        typeof st.id === 'string' &&
        st.id.length > 0 &&
        typeof st.name === 'string' &&
        typeof st.xPos === 'number' &&
        Number.isFinite(st.xPos) &&
        typeof st.yPos === 'number' &&
        Number.isFinite(st.yPos)
      );
    })
  );
}

function isAddedTransitions(value: unknown): value is ViewerAddedTransition[] {
  const isLabel = (v: unknown) => v === undefined || typeof v === 'string';
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const t = entry as Record<string, unknown>;
      return (
        typeof t.idx === 'number' &&
        Number.isFinite(t.idx) &&
        typeof t.from === 'string' &&
        t.from.length > 0 &&
        typeof t.to === 'string' &&
        t.to.length > 0 &&
        isLabel(t.read) &&
        isLabel(t.write) &&
        isLabel(t.move) &&
        isLabel(t.pop) &&
        isLabel(t.push)
      );
    })
  );
}

function isRemoved(value: unknown): value is ViewerRemoved {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    Array.isArray(r.states) &&
    r.states.every((id) => typeof id === 'string') &&
    Array.isArray(r.transitions) &&
    r.transitions.every((index) => typeof index === 'number' && Number.isFinite(index))
  );
}

function isHistoryStep(value: unknown): value is ViewerHistoryStep {
  if (!value || typeof value !== 'object') return false;
  const step = value as Record<string, unknown>;
  if (typeof step.honorPositions !== 'boolean') return false;
  if (!step.positions || typeof step.positions !== 'object') return false;
  if (!Object.values(step.positions as Record<string, unknown>).every(isPoint)) return false;
  if (
    step.initialState !== undefined &&
    step.initialState !== null &&
    typeof step.initialState !== 'string'
  ) {
    return false;
  }
  // The three maps are checked only for shape. Their contents are the same values the fields
  // above carry and are validated there; a step that named a state this machine does not have
  // is caught by `viewStateFits` on the positions, which every step also has.
  const isStringMap = (v: unknown) =>
    v === undefined ||
    (!!v &&
      typeof v === 'object' &&
      Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string'));
  const isBoolMap = (v: unknown) =>
    v === undefined ||
    (!!v &&
      typeof v === 'object' &&
      Object.values(v as Record<string, unknown>).every((x) => typeof x === 'boolean'));
  if (!isStringMap(step.renames)) return false;
  if (!isBoolMap(step.finals)) return false;
  if (step.transitions !== undefined && (!step.transitions || typeof step.transitions !== 'object'))
    return false;
  if (step.addedStates !== undefined && !isAddedStates(step.addedStates)) return false;
  if (step.addedTransitions !== undefined && !isAddedTransitions(step.addedTransitions)) {
    return false;
  }
  if (step.removed !== undefined && !isRemoved(step.removed)) return false;
  return true;
}

function isHistory(value: unknown): value is ViewerHistory {
  if (!value || typeof value !== 'object') return false;
  const h = value as Record<string, unknown>;
  return (
    Array.isArray(h.undo) &&
    Array.isArray(h.redo) &&
    h.undo.every(isHistoryStep) &&
    h.redo.every(isHistoryStep)
  );
}

export function readViewState(key: string | null | undefined): ViewerViewState | null {
  if (!key || typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isViewState(parsed) ? parsed : null;
  } catch {
    // Blocked storage, or a truncated entry. Opening at the fit is a fine answer.
    return null;
  }
}

export function writeViewState(key: string | null | undefined, state: ViewerViewState): void {
  if (!key || typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(PREFIX + key, JSON.stringify(state));
  } catch {
    // Full or blocked. Losing the view is not worth interrupting anybody over.
  }
}

export function clearViewState(key: string | null | undefined): void {
  if (!key || typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(PREFIX + key);
  } catch {
    /* nothing to clear */
  }
}

/**
 * Whether a remembered arrangement belongs to the machine now on screen.
 *
 * Positions are keyed by state id, so putting one machine's arrangement onto another would
 * scatter states that happened to share a name and silently leave the rest where they were.
 * A saved entry is used only when every state it names is present.
 */
export function viewStateFits(state: ViewerViewState, nodeIds: readonly string[]): boolean {
  const ids = new Set(nodeIds);
  return Object.keys(state.positions).every((id) => ids.has(id));
}

/**
 * Whether a remembered history belongs to the machine now on screen.
 *
 * The same question `viewStateFits` asks, of every step: a step names positions by state id,
 * and stepping back to one belonging to a different machine would scatter it. Answered
 * separately because the two can disagree. The view is written on every pan, and the history
 * only when it changes, so an entry can carry a history older than the arrangement beside it.
 */
export function historyFits(history: ViewerHistory, nodeIds: readonly string[]): boolean {
  const stepFits = (step: ViewerHistoryStep) => {
    // A step's positions cover the graph as it stood, which includes any states the reader had
    // drawn by then. Those are not on the machine now if the step that made them has been
    // undone, so the step carries them and they count as known.
    const ids = new Set([...nodeIds, ...(step.addedStates ?? []).map((st) => st.id)]);
    return Object.keys(step.positions).every((id) => ids.has(id));
  };
  return history.undo.every(stepFits) && history.redo.every(stepFits);
}
