import { describe, it, expect } from 'vitest';

import {
  alignPositions,
  distributePositions,
  ALIGN_MINIMUM,
  DISTRIBUTE_MINIMUM,
  type PlacedState,
} from './viewer-align';

const at = (id: string, x: number, y: number): PlacedState => ({ id, x, y });

/** Three states in a rough diagonal, which every command below has something to do with. */
const SCATTERED = [at('a', 10, 100), at('b', 50, 40), at('c', 90, 130)];

const xs = (states: PlacedState[]) => states.map((s) => s.x);
const ys = (states: PlacedState[]) => states.map((s) => s.y);

describe('lining states up', () => {
  it('brings them onto the leftmost, the rightmost, or the middle between', () => {
    expect(xs(alignPositions(SCATTERED, 'left'))).toEqual([10, 10, 10]);
    expect(xs(alignPositions(SCATTERED, 'right'))).toEqual([90, 90, 90]);
    expect(xs(alignPositions(SCATTERED, 'center'))).toEqual([50, 50, 50]);
  });

  it('does the same the other way up', () => {
    expect(ys(alignPositions(SCATTERED, 'top'))).toEqual([40, 40, 40]);
    expect(ys(alignPositions(SCATTERED, 'bottom'))).toEqual([130, 130, 130]);
    expect(ys(alignPositions(SCATTERED, 'middle'))).toEqual([85, 85, 85]);
  });

  it('leaves the other axis alone, so a row keeps its order and its spacing', () => {
    expect(ys(alignPositions(SCATTERED, 'left'))).toEqual([100, 40, 130]);
    expect(xs(alignPositions(SCATTERED, 'top'))).toEqual([10, 50, 90]);
  });

  /**
   * The middle of what is selected rather than an average of it. Two states together and one
   * far out on its own would otherwise pull the line towards the pair.
   */
  it('centres on the span, not on the crowd', () => {
    const lopsided = [at('a', 0, 0), at('b', 10, 0), at('c', 100, 0)];
    expect(xs(alignPositions(lopsided, 'center'))).toEqual([50, 50, 50]);
  });

  it('keeps every state it was given, by id', () => {
    expect(alignPositions(SCATTERED, 'left').map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('does nothing to fewer than two, which is not an alignment', () => {
    expect(alignPositions([at('a', 10, 10)], 'left')).toEqual([]);
    expect(alignPositions([], 'left')).toEqual([]);
    expect(ALIGN_MINIMUM).toBe(2);
  });
});

describe('spreading states out', () => {
  it('keeps the two on the ends and evens out what is between', () => {
    const spread = distributePositions(
      [at('a', 0, 0), at('b', 10, 0), at('c', 100, 0)],
      'horizontal',
    );
    expect(spread.map((s) => [s.id, s.x])).toEqual([
      ['a', 0],
      ['b', 50],
      ['c', 100],
    ]);
  });

  it('does the same the other way up, and leaves the other axis alone', () => {
    const spread = distributePositions(
      [at('a', 7, 0), at('b', 3, 10), at('c', 5, 100)],
      'vertical',
    );
    expect(spread.map((s) => [s.id, s.y])).toEqual([
      ['a', 0],
      ['b', 50],
      ['c', 100],
    ]);
    expect(xs(spread)).toEqual([7, 3, 5]);
  });

  /** By where they sit, not by when they were clicked: spreading must not reorder them. */
  it('works from the order they are in, whatever order it was handed', () => {
    const spread = distributePositions(
      [at('c', 100, 0), at('a', 0, 0), at('b', 10, 0)],
      'horizontal',
    );
    expect(spread.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(xs(spread)).toEqual([0, 50, 100]);
  });

  it('evens out four as readily as three', () => {
    const spread = distributePositions(
      [at('a', 0, 0), at('b', 1, 0), at('c', 2, 0), at('d', 90, 0)],
      'horizontal',
    );
    expect(xs(spread)).toEqual([0, 30, 60, 90]);
  });

  it('does nothing to fewer than three, which have no gap to even out', () => {
    expect(distributePositions([at('a', 0, 0), at('b', 90, 0)], 'horizontal')).toEqual([]);
    expect(DISTRIBUTE_MINIMUM).toBe(3);
  });

  it('leaves states that share a coordinate where they are', () => {
    // Nothing to spread along: the span is zero, so every step is zero.
    const spread = distributePositions([at('a', 5, 0), at('b', 5, 0), at('c', 5, 0)], 'horizontal');
    expect(xs(spread)).toEqual([5, 5, 5]);
  });
});
