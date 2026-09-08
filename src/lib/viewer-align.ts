/**
 * Where a set of states should end up when they are lined up or spread out.
 *
 * Arithmetic only: it is handed the states it is to arrange, with the coordinates they have
 * now, and answers with the coordinates they should have. It knows nothing about the graph, the
 * selection or the history, which is what lets the rules be read and tested as rules.
 *
 * Coordinates are the centres of the states, which is what the graph reports and what a
 * transition is drawn between. Every state in this viewer is a circle of the same size, so
 * lining up their left edges and lining up their centres move them to the same places; the two
 * commands differ only in which column they all end up in.
 */

/** One state, where it is now or where it should be. */
export type PlacedState = { id: string; x: number; y: number };

/** Which edge or middle the states are brought onto. */
export type AlignMode = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';

/** Which way the gaps are made even. */
export type DistributeAxis = 'horizontal' | 'vertical';

/** How many states each command needs before it means anything. */
export const ALIGN_MINIMUM = 2;
export const DISTRIBUTE_MINIMUM = 3;

const axisOf = (mode: AlignMode): 'x' | 'y' =>
  mode === 'left' || mode === 'center' || mode === 'right' ? 'x' : 'y';

/**
 * Bring every state onto one line.
 *
 * The line is taken from the states themselves: their leftmost, their rightmost, or the middle
 * between the two. Nothing moves along the other axis, so a row keeps its order and its
 * spacing and only stops wandering up and down.
 *
 * Fewer than two states is not an alignment, and nothing moves.
 */
export function alignPositions(states: readonly PlacedState[], mode: AlignMode): PlacedState[] {
  if (states.length < ALIGN_MINIMUM) return [];
  const axis = axisOf(mode);
  const values = states.map((state) => state[axis]);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const target =
    mode === 'left' || mode === 'top'
      ? low
      : mode === 'right' || mode === 'bottom'
        ? high
        : // The middle of what is selected rather than an average of it, so one state far out
          // on its own does not drag the line towards the crowd.
          (low + high) / 2;

  return states.map((state) => ({ ...state, [axis]: target }));
}

/**
 * Make the gaps between the states even.
 *
 * The two on the ends stay where they are, since they are what defines the span, and the ones
 * between them are spread evenly along it. Evenly by centre, which for equal circles is evenly
 * by the gap between their edges as well.
 *
 * Fewer than three states has no gap to even out: two are already evenly spaced, whatever they
 * are, and nothing moves.
 */
export function distributePositions(
  states: readonly PlacedState[],
  axis: DistributeAxis,
): PlacedState[] {
  if (states.length < DISTRIBUTE_MINIMUM) return [];
  const key = axis === 'horizontal' ? 'x' : 'y';
  // In the order they sit, not the order they were clicked: spreading them out must not
  // reorder them.
  const ordered = [...states].sort((a, b) => a[key] - b[key]);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (!first || !last) return [];

  const step = (last[key] - first[key]) / (ordered.length - 1);
  return ordered.map((state, index) => ({ ...state, [key]: first[key] + step * index }));
}
