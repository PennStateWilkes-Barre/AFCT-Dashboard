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
 * The text a reader has written over a machine.
 *
 * Held here rather than in `useJffCytoscape` on purpose. That hook is about the automaton: the
 * parse, the drawing, the overrides that make the panel's edits survive a rebuild, and the undo
 * history over them. A text box is none of those things. Keeping it out means it cannot change
 * a state count, a transition count, the "modified" indicator, an export or the description,
 * and nobody has to remember that it might.
 *
 * The other side of that decision: undo does not reach these. Deleting a box is its own
 * confirmed action, and the history belongs to the machine.
 */
export function useViewerTextBoxes(documentId: string | null | undefined) {
  const [boxes, setBoxes] = useState<ViewerTextBox[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  // What is on screen, for the callbacks below: they are handed to a layer that lives as long as
  // the viewer does, and reading state through a ref keeps every one of them stable.
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;

  // Read on the way in, and again if this pane is pointed at a different file. Storage is only
  // available in the browser, so this is an effect rather than an initial value: the server
  // renders no boxes and the first paint agrees with it.
  useEffect(() => {
    setBoxes(readTextBoxes(documentId));
    setSelectedId(null);
    setEditingId(null);
  }, [documentId]);

  /** Save on every change. Small, rare, and a lost write is a lost note. */
  const commit = useCallback(
    (next: ViewerTextBox[]) => {
      setBoxes(next);
      boxesRef.current = next;
      writeTextBoxes(documentId, next);
    },
    [documentId],
  );

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
    setEditingId((current) => {
      if (current === null) return null;
      const box = boxesRef.current.find((b) => b.id === current);
      if (box && box.text.trim() === '') {
        commit(boxesRef.current.filter((b) => b.id !== current));
        setSelectedId((s) => (s === current ? null : s));
      }
      return null;
    });
  }, [commit]);

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
