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
 * The text a reader has written over a machine.
 *
 * Held here rather than in `useJffCytoscape` on purpose. That hook is about the automaton: the
 * parse, the drawing, the overrides that make the panel's edits survive a rebuild, and the undo
 * history over them. A text box is none of those things. Keeping it out means it cannot change
 * a state count, a transition count, the "modified" indicator, an export or the description,
 * and nobody has to remember that it might.
 *
 * The other side of that decision: undo does not reach these. The toolbar's Undo puts back a
 * rename or a deleted state, and does nothing about a comment, which is an inconsistency worth
 * naming rather than discovering. It was left that way deliberately, twice over:
 *
 * The two have different lifetimes. The machine's history and its overrides live in
 * `sessionStorage` and go when the window does; comments live in `localStorage` because a note
 * is meant to still be there tomorrow. Merging them means one history that half survives a
 * refresh, and an undo after a reload that would restore a comment from a record that had
 * already been thrown away.
 *
 * And they have different shapes. A machine step is a whole snapshot of six override maps,
 * cheap because they are small; a comment step wants the box that changed, since snapshotting
 * every note on every keystroke is not.
 *
 * If it is unified later, this is the seam: every change here goes through `commit` below, so
 * that one function is where a step would be recorded, and the machine's history would need a
 * step kind that carries text boxes and a rule for what an undo across a refresh means.
 */
export function useViewerTextBoxes(documentId: string | null | undefined) {
  const [boxes, setBoxes] = useState<ViewerTextBox[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  // What is on screen, for the callbacks below: they are handed to a layer that lives as long as
  // the viewer does, and reading state through a ref keeps every one of them stable.
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;
  const editingIdRef = useRef(editingId);
  editingIdRef.current = editingId;

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
      commit([...boxesRef.current, box]);
      setSelectedId(box.id);
      setEditingId(box.id);
    },
    [commit],
  );

  const setText = useCallback(
    (id: string, text: string) => {
      commit(
        boxesRef.current.map((b) =>
          b.id === id ? { ...b, text: text.slice(0, TEXT_BOX_MAX_LENGTH) } : b,
        ),
        true,
      );
    },
    [commit],
  );

  /** Move one, in graph coordinates. */
  const moveTo = useCallback(
    (id: string, x: number, y: number) => {
      commit(boxesRef.current.map((b) => (b.id === id ? { ...b, x, y } : b)));
    },
    [commit],
  );

  /** Resize one. Never below the minimum, whatever the pointer says. */
  const resizeTo = useCallback(
    (id: string, width: number, height: number) => {
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
  const beginEdit = useCallback((id: string) => setEditingId(id), []);

  const endEdit = useCallback(() => {
    const current = editingIdRef.current;
    if (current === null) return;
    const box = boxesRef.current.find((b) => b.id === current);
    if (box && box.text.trim() === '') {
      commit(boxesRef.current.filter((b) => b.id !== current));
      setSelectedId((s) => (s === current ? null : s));
    } else {
      // Done typing, so nothing is outstanding any more.
      flush();
    }
    setEditingId(null);
  }, [commit, flush]);

  return {
    boxes,
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
