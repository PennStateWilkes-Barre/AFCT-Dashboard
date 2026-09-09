'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  readTextBoxes,
  writeTextBoxes,
  freeTextBoxId,
  TEXT_BOX_DEFAULT_SIZE,
  TEXT_BOX_MIN_SIZE,
  TEXT_BOX_MAX_LENGTH,
  type ViewerTextBox,
} from '@/lib/viewer-text-boxes';

/**
 * How long a keystroke may wait before it is written down.
 *
 * Long enough that typing a sentence is one write rather than forty, short enough that nobody
 * gets to close the tab in the gap. Every other change is written at once.
 */
const TEXT_WRITE_DELAY_MS = 250;

/**
 * What the undo history needs from the hook that owns it.
 *
 * The comments are held here and the history is held in `useJffCytoscape`, so the two have to
 * be introduced. Three calls, matching how the machine already records its own changes:
 *
 * - `record` is for a change that is over as soon as it happens: a box created, moved, resized
 *   or deleted. It writes a step for how things stand right now, before the change lands.
 * - `hold` and `commitHeld` are for typing. The snapshot is taken when a box is opened and only
 *   becomes a step at the first keystroke, so a sentence is one undo rather than forty and
 *   opening a box and leaving it alone is none.
 * - `discardHeld` throws a held snapshot away, for the edit that left nothing behind.
 *
 * There is one held snapshot for the whole viewer, and picking up a state takes it too, so
 * `hold` hands back something naming the snapshot it took and `discardHeld` wants it back. It
 * then throws away only that one: without the check, abandoning an empty comment and then
 * dragging a state would discard the snapshot the drag had just taken and lose its undo step.
 *
 * Optional throughout: a viewer wired without a history still writes comments, they are simply
 * not undoable.
 */
export type ViewerTextBoxHistory = {
  record: () => void;
  /** Take a snapshot, and say which one, for `discardHeld`. Null when there was none to take. */
  hold: () => object | null;
  commitHeld: () => void;
  discardHeld: (held: object | null) => void;
};

/**
 * The text a reader has written over a machine.
 *
 * Held here rather than in `useJffCytoscape` on purpose. That hook is about the automaton: the
 * parse, the drawing, and the overrides that make the panel's edits survive a rebuild. A text
 * box is none of those things. Keeping it out means it cannot change a state count, a
 * transition count, an export or the description, and nobody has to remember that it might.
 *
 * Undo is the one thing the two do share. A reader who writes a note and presses Ctrl+Z means
 * that note, and a command that puts back a rename but shrugs at a comment is the kind of
 * inconsistency nobody reads the manual to discover. So every change here records a step on
 * the machine's history, through the calls above, and an undo hands the boxes back through
 * `restore`. One history, in the order things actually happened.
 *
 * The two stores still keep their own lifetimes, and that is fine rather than a compromise.
 * The history lives in `sessionStorage` and goes when the window does; the comments live in
 * `localStorage` because a note is meant to still be there tomorrow. Come back the next day
 * and the notes are on the machine with nothing to undo, which is what a machine with no
 * history says too.
 *
 * Note that a comment now counts towards "File changed", since that indicator is partly the
 * depth of the undo history. That is the honest answer: Reset already takes the comments off.
 */
export function useViewerTextBoxes(
  documentId: string | null | undefined,
  history?: ViewerTextBoxHistory,
) {
  const [boxes, setBoxes] = useState<ViewerTextBox[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  // What is on screen, for the callbacks below: they are handed to a layer that lives as long as
  // the viewer does, and reading state through a ref keeps every one of them stable.
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;
  const editingIdRef = useRef(editingId);
  editingIdRef.current = editingId;
  // Read at the moment of a change rather than closed over, so the callbacks below stay stable
  // even though the viewer hands this in during render (see JffViewerDialog: the history hook
  // runs after this one, so what arrives here is a stable shim over a ref).
  const historyRef = useRef(history);
  historyRef.current = history;
  /** Which snapshot was taken as a box was opened, so only that one is ever thrown away. */
  const heldStep = useRef<object | null>(null);

  // Read on the way in, and again if this pane is pointed at a different file. Storage is only
  // available in the browser, so this is an effect rather than an initial value: the server
  // renders no boxes and the first paint agrees with it.
  useEffect(() => {
    setBoxes(readTextBoxes(documentId));
    setSelectedId(null);
    setEditingId(null);
  }, [documentId]);

  /**
   * A write that has been put off, and the timer that will make it.
   *
   * Typing is the one change that arrives dozens at a time. Every other one (create, move,
   * resize, delete) is a single act and is written immediately, because a lost write there is a
   * lost note; a keystroke can wait a moment, and anything discrete that follows it flushes it
   * first, so storage is never behind by more than the pause in somebody's typing.
   */
  const pendingWrite = useRef<ViewerTextBox[] | null>(null);
  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (writeTimer.current !== null) {
      clearTimeout(writeTimer.current);
      writeTimer.current = null;
    }
    const pending = pendingWrite.current;
    pendingWrite.current = null;
    if (pending) writeTextBoxes(documentId, pending);
  }, [documentId]);

  /** Save on every change. `defer` is for a keystroke, and nothing else. */
  const commit = useCallback(
    (next: ViewerTextBox[], defer = false) => {
      setBoxes(next);
      boxesRef.current = next;
      if (!defer) {
        flush();
        writeTextBoxes(documentId, next);
        return;
      }
      pendingWrite.current = next;
      if (writeTimer.current !== null) clearTimeout(writeTimer.current);
      writeTimer.current = setTimeout(() => {
        writeTimer.current = null;
        const pending = pendingWrite.current;
        pendingWrite.current = null;
        if (pending) writeTextBoxes(documentId, pending);
      }, TEXT_WRITE_DELAY_MS);
    },
    [documentId, flush],
  );

  // Leaving the viewer must not lose the last few characters. Also on the way to another file,
  // since `documentId` is in `flush`: the write has to land under the key it was typed for.
  useEffect(() => flush, [flush]);

  /**
   * Put a new box where the reader clicked, and let them type in it straight away.
   *
   * `at` is in the graph's own coordinates and becomes the box's top-left corner, so the box
   * starts where the pointer was rather than around it: a box that appears centred on the click
   * covers the thing that was just clicked next to.
   */
  const addAt = useCallback(
    (at: { x: number; y: number }) => {
      const box: ViewerTextBox = {
        id: freeTextBoxId(boxesRef.current),
        x: at.x,
        y: at.y,
        ...TEXT_BOX_DEFAULT_SIZE,
        text: '',
      };
      // Held rather than recorded, and held before the box exists. A box nobody types into is
      // taken away again by `endEdit`, so it should leave no step at all; one that is typed into
      // commits this at the first keystroke, and a single undo takes back the box and its words
      // together, which is what making a comment felt like.
      heldStep.current = historyRef.current?.hold() ?? null;
      commit([...boxesRef.current, box]);
      setSelectedId(box.id);
      setEditingId(box.id);
    },
    [commit],
  );

  const setText = useCallback(
    (id: string, text: string) => {
      // The first keystroke of an edit turns the held snapshot into a step; every one after it
      // finds nothing held. So a sentence is one undo, and the caret moving through the box
      // without changing anything is none.
      historyRef.current?.commitHeld();
      heldStep.current = null;
      commit(
        boxesRef.current.map((b) =>
          b.id === id ? { ...b, text: text.slice(0, TEXT_BOX_MAX_LENGTH) } : b,
        ),
        true,
      );
    },
    [commit],
  );

  /** Move one, in graph coordinates. Called once, on release, not on every frame of the drag. */
  const moveTo = useCallback(
    (id: string, x: number, y: number) => {
      historyRef.current?.record();
      commit(boxesRef.current.map((b) => (b.id === id ? { ...b, x, y } : b)));
    },
    [commit],
  );

  /** Resize one. Never below the minimum, whatever the pointer says. */
  const resizeTo = useCallback(
    (id: string, width: number, height: number) => {
      historyRef.current?.record();
      commit(
        boxesRef.current.map((b) =>
          b.id === id
            ? {
                ...b,
                width: Math.max(TEXT_BOX_MIN_SIZE.width, width),
                height: Math.max(TEXT_BOX_MIN_SIZE.height, height),
              }
            : b,
        ),
      );
    },
    [commit],
  );

  const remove = useCallback(
    (id: string) => {
      // Nothing to take away, so nothing to record: a Delete against a selection left over from
      // an undo would otherwise push a step that changed nothing.
      if (!boxesRef.current.some((b) => b.id === id)) return;
      historyRef.current?.record();
      commit(boxesRef.current.filter((b) => b.id !== id));
      setSelectedId((current) => (current === id ? null : current));
      setEditingId((current) => (current === id ? null : current));
    },
    [commit],
  );

  /**
   * Stop editing.
   *
   * A box nobody typed anything into goes rather than sitting on the drawing as an empty
   * rectangle: the only way to get one is to click the canvas with the Text tool up, which is
   * also how somebody clicks by accident.
   */
  // Narrowed and stable: nothing outside wants the updater form, and callers put these in
  // effect dependency lists.
  const select = useCallback((id: string | null) => setSelectedId(id), []);
  const beginEdit = useCallback((id: string) => {
    // How things stand before a word of this edit is typed. Only on the way in: opening a box
    // that is already open would take a second snapshot and split one edit into two steps.
    if (editingIdRef.current !== id) heldStep.current = historyRef.current?.hold() ?? null;
    setEditingId(id);
  }, []);

  const endEdit = useCallback(() => {
    const current = editingIdRef.current;
    if (current === null) return;
    const box = boxesRef.current.find((b) => b.id === current);
    // Whatever this edit held, it is over. Nothing was typed if the snapshot is still held, and
    // leaving it held would let the next thing that commits one (aligning states, say) turn it
    // into a step that changes nothing. Naming the snapshot is what makes this safe: a state
    // picked up since takes the same slot, and its snapshot is left alone.
    historyRef.current?.discardHeld(heldStep.current);
    heldStep.current = null;
    if (box && box.text.trim() === '') {
      // No step for the removal either. A box that was just made and never typed into is back
      // to where the discarded snapshot was taken. A box that HAD words and was emptied already
      // recorded a step at its first keystroke, and that step holds the words, so one undo puts
      // the whole box back: what somebody who cleared it by accident wants.
      commit(boxesRef.current.filter((b) => b.id !== current));
      setSelectedId((s) => (s === current ? null : s));
    } else {
      // Done typing, so nothing is outstanding any more.
      flush();
    }
    setEditingId(null);
  }, [commit, flush]);

  /**
   * Take every comment off this file.
   *
   * For Reset, which puts the automaton back the way it opened. A comment is the reader's own
   * writing rather than part of the machine, but it is still something they added to this
   * drawing, and leaving notes floating over a machine that has been put back would be a
   * half-reset nobody asked for. Storage goes with them, so a refresh does not bring them back.
   *
   * No step, deliberately, and this is the one change here that records none. Reset throws the
   * whole history away as part of what it means, so a step recorded here would either be wiped
   * a moment later or, depending on which of the two ran first, survive as the only thing left
   * to undo after a Reset that was supposed to leave nothing.
   */
  const clearAll = useCallback(() => {
    commit([]);
    setSelectedId(null);
    setEditingId(null);
  }, [commit]);

  /**
   * Put the comments back to what an undo step saw.
   *
   * The one way in that records nothing, because it IS the history acting. Through `commit`
   * like everything else, so a keystroke's deferred write is flushed first: without that, the
   * timer set just before an undo fires just after it and leaves storage holding text that is
   * no longer on the screen.
   */
  const restore = useCallback(
    (next: readonly ViewerTextBox[]) => {
      const restored = [...next];
      commit(restored);
      // A box the step does not have cannot go on being the selected or the edited one.
      const present = new Set(restored.map((b) => b.id));
      setSelectedId((s) => (s && present.has(s) ? s : null));
      setEditingId((e) => (e && present.has(e) ? e : null));
    },
    [commit],
  );

  /** The boxes as they stand right now, for a snapshot taken from outside a render. */
  const readBoxes = useCallback((): readonly ViewerTextBox[] => boxesRef.current, []);

  return {
    boxes,
    readBoxes,
    restore,
    clearAll,
    selectedId,
    editingId,
    select,
    beginEdit,
    endEdit,
    addAt,
    setText,
    moveTo,
    resizeTo,
    remove,
  };
}

export type ViewerTextBoxesApi = ReturnType<typeof useViewerTextBoxes>;
