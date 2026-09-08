/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import {
  readViewState,
  writeViewState,
  clearViewState,
  viewStateFits,
  type ViewerViewState,
} from './viewer-view-state';

const STATE: ViewerViewState = {
  v: 1,
  zoom: 1.75,
  pan: { x: -40, y: 12 },
  positions: { q0: { x: 0, y: 0 }, q1: { x: 100, y: 24 } },
  honorPositions: true,
};

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('remembering how a machine was being looked at', () => {
  it('comes back exactly as it went in', () => {
    writeViewState('submissions:a.jff', STATE);
    expect(readViewState('submissions:a.jff')).toEqual(STATE);
  });

  it('keeps one file apart from another', () => {
    writeViewState('submissions:a.jff', STATE);
    expect(readViewState('submissions:b.jff')).toBeNull();
  });

  it('forgets on request, which is what closing a tab does', () => {
    writeViewState('submissions:a.jff', STATE);
    clearViewState('submissions:a.jff');
    expect(readViewState('submissions:a.jff')).toBeNull();
  });

  it('reads nothing without a key, which is every viewer in a dialog', () => {
    writeViewState(null, STATE);
    expect(window.sessionStorage.length).toBe(0);
    expect(readViewState(null)).toBeNull();
  });
});

describe('an entry from before a field existed', () => {
  it('still opens, because the view is worth more than the flag', () => {
    // The version exists so a shape can grow without throwing away what a reader had on
    // screen. An entry with no `modified` is one of those.
    writeViewState('submissions:a.jff', STATE);
    expect(readViewState('submissions:a.jff')?.modified).toBeUndefined();
    expect(readViewState('submissions:a.jff')?.zoom).toBe(STATE.zoom);
  });

  it('keeps the flag when it is there', () => {
    writeViewState('submissions:a.jff', { ...STATE, modified: true });
    expect(readViewState('submissions:a.jff')?.modified).toBe(true);
  });

  /**
   * The same promise, for the field drawn transitions added. An entry written before this
   * existed is one with no drawn transitions in it, and it has to open rather than being
   * thrown away: what a reader had on screen is worth more than the field they never used.
   */
  it('opens an entry, history and all, that predates drawn transitions', () => {
    window.sessionStorage.setItem(
      'afct.viewer.view.submissions:a.jff',
      JSON.stringify({
        ...STATE,
        history: {
          undo: [{ positions: { q0: { x: 0, y: 0 } }, honorPositions: true }],
          redo: [],
        },
      }),
    );
    const back = readViewState('submissions:a.jff');
    expect(back?.addedTransitions).toBeUndefined();
    expect(back?.history?.undo).toHaveLength(1);
    expect(back?.history?.undo[0].addedTransitions).toBeUndefined();
  });

  /**
   * And the same again for the comments a step now carries. An entry written before undo
   * reached them is a step with no comments in it, not a broken one.
   */
  it('opens a step that predates comments, and keeps them when they are there', () => {
    window.sessionStorage.setItem(
      'afct.viewer.view.submissions:a.jff',
      JSON.stringify({
        ...STATE,
        history: {
          undo: [{ positions: { q0: { x: 0, y: 0 } }, honorPositions: true }],
          redo: [],
        },
      }),
    );
    expect(readViewState('submissions:a.jff')?.history?.undo[0].textBoxes).toBeUndefined();

    const boxes = [{ id: 'text-1', x: 10, y: 20, width: 200, height: 80, text: 'the bug' }];
    writeViewState('submissions:a.jff', {
      ...STATE,
      history: {
        undo: [{ positions: { q0: { x: 0, y: 0 } }, honorPositions: true, textBoxes: boxes }],
        redo: [],
      },
    });
    expect(readViewState('submissions:a.jff')?.history?.undo[0].textBoxes).toEqual(boxes);
  });

  it('refuses a step whose comments are the wrong shape', () => {
    window.sessionStorage.setItem(
      'afct.viewer.view.submissions:a.jff',
      JSON.stringify({
        ...STATE,
        history: {
          undo: [
            {
              positions: { q0: { x: 0, y: 0 } },
              honorPositions: true,
              // No width, which `isTextBox` refuses. A half-shaped record should not reach
              // the canvas through the history any more than it should through storage.
              textBoxes: [{ id: 'text-1', x: 10, y: 20, height: 80, text: 'the bug' }],
            },
          ],
          redo: [],
        },
      }),
    );
    expect(readViewState('submissions:a.jff')).toBeNull();
  });

  it('keeps drawn transitions when they are there, and refuses a mangled one', () => {
    const drawn = [{ idx: 7, from: '0', to: '1', read: 'a' }];
    writeViewState('submissions:a.jff', { ...STATE, addedTransitions: drawn });
    expect(readViewState('submissions:a.jff')?.addedTransitions).toEqual(drawn);

    window.sessionStorage.setItem(
      'afct.viewer.view.submissions:a.jff',
      JSON.stringify({ ...STATE, addedTransitions: [{ idx: 'seven', from: '0', to: '1' }] }),
    );
    expect(readViewState('submissions:a.jff')).toBeNull();
  });
});

describe('refusing an entry that is not ours', () => {
  const bad: [string, unknown][] = [
    ['not JSON at all', undefined],
    ['an older shape', { ...STATE, v: 0 }],
    ['a zoom of zero, which would blank the canvas', { ...STATE, zoom: 0 }],
    ['a zoom that is not a number', { ...STATE, zoom: 'big' }],
    ['a missing pan', { ...STATE, pan: null }],
    ['a pan carrying NaN', { ...STATE, pan: { x: Number.NaN, y: 0 } }],
    ['a position that is not a point', { ...STATE, positions: { q0: 'over there' } }],
    ['a layout flag that is not a flag', { ...STATE, honorPositions: 'yes' }],
    ['a modified flag that is not a flag', { ...STATE, modified: 'a bit' }],
  ];

  it.each(bad)('ignores %s', (_label, value) => {
    // The key is in the reader's own storage and editable, and an entry written by an older
    // version outlives the code that wrote it. Either way the answer is to open at the fit.
    window.sessionStorage.setItem(
      'afct.viewer.view.submissions:a.jff',
      value === undefined ? '{oops' : JSON.stringify(value),
    );
    expect(readViewState('submissions:a.jff')).toBeNull();
  });
});

describe('when storage itself refuses', () => {
  it('says nothing was remembered rather than throwing', () => {
    // Private browsing, or a browser set to block site data. The viewer still has to open.
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    // Prove the stub is in force first, or every assertion below would hold anyway.
    expect(() => window.sessionStorage.getItem('anything')).toThrow();

    expect(() => writeViewState('k', STATE)).not.toThrow();
    expect(readViewState('k')).toBeNull();
    expect(() => clearViewState('k')).not.toThrow();
  });
});

describe('matching an arrangement to the machine on screen', () => {
  it('accepts one whose states are all present', () => {
    expect(viewStateFits(STATE, ['q0', 'q1', 'q2'])).toBe(true);
  });

  it('refuses one naming a state this machine does not have', () => {
    // The guard against putting one machine's arrangement onto another: the states that
    // happened to share a name would move and the rest would not, which is worse than a fit.
    expect(viewStateFits(STATE, ['q0'])).toBe(false);
  });
});
