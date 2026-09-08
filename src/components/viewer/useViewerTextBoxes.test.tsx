/** @vitest-environment jsdom */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { readTextBoxes } from '@/lib/viewer-text-boxes';
import { useViewerTextBoxes, type ViewerTextBoxHistory } from './useViewerTextBoxes';

/**
 * A stand-in for the machine's undo history, built to behave like the real one.
 *
 * Not bare spies. `commitHeld` is called on every keystroke and does nothing on all but the
 * first, exactly as `commitPendingMove` does in useJffCytoscape, so counting the calls would
 * say a sentence was forty steps when it is one. What is counted here is what would end up on
 * the undo stack, which is the thing the reader feels.
 *
 * `hold` hands back an object the way the real one hands back the snapshot it took, so the
 * token `discardHeld` is given can be checked rather than assumed.
 */
function spyHistory() {
  const steps: string[] = [];
  const held: object[] = [];
  let pending: object | null = null;
  const history: ViewerTextBoxHistory = {
    record: () => steps.push('record'),
    hold: () => {
      const token = { step: held.length };
      held.push(token);
      pending = token;
      return token;
    },
    commitHeld: () => {
      if (!pending) return;
      pending = null;
      steps.push('held');
    },
    discardHeld: (token) => {
      discarded.push(token);
      if (token && pending === token) pending = null;
    },
  };
  const discarded: (object | null)[] = [];
  return { history, held, steps, discarded };
}

const DOC = 'submissions/1/a.jff';

function setup() {
  const spy = spyHistory();
  const view = renderHook(() => useViewerTextBoxes(DOC, spy.history));
  return { ...spy, ...view };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
});

describe('comments on the machine s undo history', () => {
  it('holds a step as a box is made, and turns it into one at the first keystroke', () => {
    const { steps, held, result } = setup();

    act(() => result.current.addAt({ x: 10, y: 20 }));
    expect(held).toHaveLength(1);
    // Nothing typed yet, so nothing is a step: a box that is abandoned should leave none.
    expect(steps).toEqual([]);

    const id = result.current.boxes[0].id;
    act(() => result.current.setText(id, 'th'));
    act(() => result.current.setText(id, 'this loop'));
    // One step for the sentence, not one per letter.
    expect(steps).toEqual(['held']);
  });

  it('records a step for a move, a resize and a delete', () => {
    const { steps, result } = setup();
    act(() => result.current.addAt({ x: 0, y: 0 }));
    const id = result.current.boxes[0].id;
    act(() => result.current.setText(id, 'note'));

    act(() => result.current.moveTo(id, 40, 60));
    act(() => result.current.resizeTo(id, 300, 120));
    act(() => result.current.remove(id));
    expect(steps).toEqual(['held', 'record', 'record', 'record']);
  });

  it('records nothing for a delete of a box that is not there', () => {
    const { steps, result } = setup();
    act(() => result.current.remove('text-9'));
    expect(steps).toEqual([]);
  });

  it('throws the held step away when a new box is left empty, and names which one', () => {
    const { steps, held, discarded, result } = setup();

    act(() => result.current.addAt({ x: 10, y: 20 }));
    act(() => result.current.endEdit());

    expect(result.current.boxes).toHaveLength(0);
    expect(steps).toEqual([]);
    // The token from this edit's own hold, so a snapshot somebody else has taken since is safe.
    expect(discarded).toEqual([held[0]]);
  });

  it('keeps the step that has the words when a box is emptied and left', () => {
    const { steps, discarded, result } = setup();
    act(() => result.current.addAt({ x: 10, y: 20 }));
    const id = result.current.boxes[0].id;
    act(() => result.current.setText(id, 'the bug'));

    // Cleared and left: the box goes, but the step recorded at the first keystroke still holds
    // the words, so one undo brings the whole comment back.
    act(() => result.current.setText(id, ''));
    act(() => result.current.endEdit());
    expect(result.current.boxes).toHaveLength(0);
    expect(steps).toEqual(['held']);
    // Nothing was still held by the time it was left, so nothing was thrown away.
    expect(discarded).toEqual([null]);
  });

  it('holds once per visit to a box, not once per way in', () => {
    const { held, result } = setup();
    act(() => result.current.addAt({ x: 0, y: 0 }));
    const id = result.current.boxes[0].id;
    act(() => result.current.setText(id, 'a'));
    act(() => result.current.endEdit());

    act(() => result.current.beginEdit(id));
    act(() => result.current.beginEdit(id));
    expect(held).toHaveLength(2);
  });

  it('puts a step s comments back without recording one, and writes them down', () => {
    const { steps, held, result } = setup();
    const boxes = [{ id: 'text-1', x: 5, y: 5, width: 200, height: 80, text: 'was here' }];

    act(() => result.current.restore(boxes));
    expect(result.current.boxes).toEqual(boxes);
    expect(readTextBoxes(DOC)).toEqual(boxes);
    expect(steps).toEqual([]);
    expect(held).toEqual([]);
  });

  it('drops a selection the step being restored does not have', () => {
    const { result } = setup();
    act(() => result.current.addAt({ x: 0, y: 0 }));
    const id = result.current.boxes[0].id;
    act(() => result.current.setText(id, 'gone in a moment'));
    expect(result.current.selectedId).toBe(id);

    act(() => result.current.restore([]));
    expect(result.current.selectedId).toBeNull();
    expect(result.current.editingId).toBeNull();
  });

  /**
   * The one that only fails on a real timer. A keystroke's write is deferred, so an undo that
   * did not flush first would be overtaken by the timer and storage would keep the text the
   * screen no longer shows.
   */
  it('does not let a keystroke s deferred write land after an undo', async () => {
    vi.useFakeTimers();
    const { result } = setup();
    act(() => result.current.addAt({ x: 0, y: 0 }));
    const id = result.current.boxes[0].id;
    act(() => result.current.setText(id, 'typed but not saved yet'));

    act(() => result.current.restore([]));
    act(() => vi.advanceTimersByTime(1000));

    expect(readTextBoxes(DOC)).toEqual([]);
    vi.useRealTimers();
  });

  it('takes every comment off without a step, since Reset throws the history away', () => {
    const { steps, result } = setup();
    act(() => result.current.addAt({ x: 0, y: 0 }));
    const id = result.current.boxes[0].id;
    act(() => result.current.setText(id, 'note'));

    act(() => result.current.clearAll());
    expect(result.current.boxes).toHaveLength(0);
    expect(steps).toEqual(['held']);
  });

  it('writes comments even with no history to record on', () => {
    const view = renderHook(() => useViewerTextBoxes(DOC));
    act(() => view.result.current.addAt({ x: 1, y: 2 }));
    const id = view.result.current.boxes[0].id;
    act(() => view.result.current.setText(id, 'no history here'));
    act(() => view.result.current.endEdit());
    expect(readTextBoxes(DOC)[0].text).toBe('no history here');
  });
});
