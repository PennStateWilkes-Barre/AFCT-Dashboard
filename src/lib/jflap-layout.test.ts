import { describe, it, expect } from 'vitest';
import {
  EDGE_LABEL_GAP,
  FINAL_STATE_BORDER_WIDTH,
  LABEL_LINE_HEIGHT,
  LABEL_LOOP_GAP,
  LOOP_REACH,
  NODE_DIAMETER,
  NOTE_MAX_WIDTH,
  NOTE_PADDING,
  START_MARKER_SIZE,
  STATE_BORDER_WIDTH,
  STATE_FONT_MIN_SIZE,
  STATE_FONT_SIZE,
  bestLoopDirection,
  bestStartMarkerDirection,
  edgeLabelGapForLines,
  edgeLabelGapForText,
  edgeLabelOffset,
  loopLabelOffset,
  noteBox,
  noteCentre,
  startMarkerPolygon,
  startMarkerPosition,
  stateFontSize,
} from './jflap-layout';

describe('the initial-state marker', () => {
  const state = { x: 100, y: 40 };
  const WEST = Math.PI;

  it('sits due west of the state by default, as JFLAP draws it', () => {
    const pos = startMarkerPosition(state);
    expect(pos.x).toBeLessThan(state.x);
    expect(pos.y).toBeCloseTo(state.y);
  });

  // The point is half a box out from the box centre, facing back at the state.
  const triangleTip = (pos: { x: number; y: number }, angle: number) => ({
    x: pos.x - (Math.cos(angle) * START_MARKER_SIZE) / 2,
    y: pos.y - (Math.sin(angle) * START_MARKER_SIZE) / 2,
  });
  const tipDistance = (angle: number, borderWidth?: number) => {
    const pos = startMarkerPosition(state, angle, NODE_DIAMETER, borderWidth);
    const tip = triangleTip(pos, angle);
    return Math.hypot(tip.x - state.x, tip.y - state.y);
  };

  it('puts the triangle point on the state rim, with no gap and no overlap', () => {
    for (const angle of [WEST, 0, Math.PI / 2, -Math.PI / 4]) {
      // Cytoscape centres a border on the node boundary, so the outside of the rim is half
      // a border beyond the nominal radius.
      expect(tipDistance(angle)).toBeCloseTo(NODE_DIAMETER / 2 + STATE_BORDER_WIDTH / 2);
    }
  });

  /**
   * A final state is two concentric circles, drawn as a 6px double border centred on the
   * boundary: the outer circle lands near 32 and the inner near 26, with the gap straddling
   * the nominal radius of 29. Reaching only to 29 left the arrow's point in that gap, so it
   * read as having pierced the outer circle. An arrow stops at the outermost edge.
   */
  it('clears the outer circle of a final state', () => {
    for (const angle of [WEST, 0, Math.PI / 2, -Math.PI / 4]) {
      const tip = tipDistance(angle, FINAL_STATE_BORDER_WIDTH);

      expect(tip).toBeCloseTo(NODE_DIAMETER / 2 + FINAL_STATE_BORDER_WIDTH / 2);
      // Specifically outside the gap, which is what the old placement landed in.
      expect(tip).toBeGreaterThan(NODE_DIAMETER / 2);
    }
  });

  it('pushes the marker further out for a final state than a plain one', () => {
    const plain = startMarkerPosition(state, WEST);
    const final = startMarkerPosition(state, WEST, NODE_DIAMETER, FINAL_STATE_BORDER_WIDTH);

    expect(Math.hypot(final.x - state.x, final.y - state.y)).toBeGreaterThan(
      Math.hypot(plain.x - state.x, plain.y - state.y),
    );
  });

  it('respects a custom node diameter', () => {
    const pos = startMarkerPosition({ x: 0, y: 0 }, WEST, 100);

    // Half the state, half its border, half the marker box, which is a fixed size.
    expect(pos.x).toBeCloseTo(-(50 + STATE_BORDER_WIDTH / 2 + START_MARKER_SIZE / 2));
  });

  it('stays on the left when nothing is in the way', () => {
    expect(bestStartMarkerDirection(state, [], [])).toBeCloseTo(WEST);
  });

  it('moves off the left when a transition runs out that side', () => {
    // This is the automatic layout's problem: nothing there keeps the initial state's
    // left clear, and the marker was drawn across the transitions leaving it.
    const angle = bestStartMarkerDirection(state, [], [WEST]);
    expect(angle).not.toBeCloseTo(WEST);
  });

  it('moves off the left when another state is sitting there', () => {
    const blocked = { x: state.x - NODE_DIAMETER, y: state.y };
    expect(bestStartMarkerDirection(state, [blocked], [])).not.toBeCloseTo(WEST);
  });

  it('points the triangle east when it sits on the left of the state', () => {
    // Three corners in cytoscape's -1..1 box: top left, the point, bottom left.
    expect(startMarkerPolygon(WEST)).toBe('0 -1, 1 0, 0 1');
  });

  it('turns the triangle to keep pointing back at the state', () => {
    // Sitting due east, the point must face west instead.
    const points = startMarkerPolygon(0)
      .split(', ')
      .map((p) => p.split(' ').map(Number) as [number, number]);
    const point = points.find(([x, y]) => Math.abs(y) < 0.001 && Math.abs(x) > 0.5);
    expect(point?.[0]).toBeCloseTo(-1);
  });

  it('keeps the triangle the same shape whichever way it faces', () => {
    // The box is square, so a turned triangle must not stretch: every corner stays the
    // same distance from the centre.
    for (const angle of [WEST, 0, Math.PI / 2, -Math.PI / 4, Math.PI / 4]) {
      const radii = startMarkerPolygon(angle)
        .split(', ')
        .map((p) => {
          const [x, y] = p.split(' ').map(Number) as [number, number];
          return Math.hypot(x, y);
        });
      for (const r of radii) expect(r).toBeCloseTo(1);
    }
  });
});

describe('edgeLabelOffset', () => {
  const left = { x: 0, y: 0 };
  const right = { x: 200, y: 0 };

  it('pushes the label perpendicular to a straight edge', () => {
    // Midpoint on the line itself: nothing bows, so fall back to the perpendicular.
    const off = edgeLabelOffset(left, right, { x: 100, y: 0 });
    expect(off).toEqual({ x: 0, y: EDGE_LABEL_GAP });
  });

  it('separates the labels of two states joined in both directions', () => {
    // Cytoscape bows the pair apart, one curve above the line and one below. Each label
    // has to move further out, not back towards the other.
    const there = edgeLabelOffset(left, right, { x: 100, y: -20 });
    const back = edgeLabelOffset(right, left, { x: 100, y: 20 });

    expect(there.y).toBe(-EDGE_LABEL_GAP);
    expect(back.y).toBe(EDGE_LABEL_GAP);
    // Anchored on its own curve, each label ends up a clear span from the other; the old
    // perpendicular-to-direction rule put them 16px apart, overlapping at a 16px font.
    const gapBetweenLabels = 20 + back.y - (-20 + there.y);
    expect(gapBetweenLabels).toBe(64);
  });

  it('lines up the two labels of a bidirectional pair', () => {
    // The midpoints here are what cytoscape actually reports for two level states 200
    // apart: each is ~0.9px towards its own source, because the drawn curve is shortened
    // at the target end for the arrowhead. Pointing opposite ways, the pair drifted 1.7px
    // apart and visibly failed to line up.
    const q0 = { x: 100, y: 150 };
    const q1 = { x: 300, y: 150 };
    const there = edgeLabelOffset(q0, q1, { x: 199.14, y: 136.89 });
    const back = edgeLabelOffset(q1, q0, { x: 200.86, y: 163.11 });

    expect(199.14 + there.x).toBeCloseTo(200.86 + back.x, 0);
    // Still one above the pair and one below, each on its own arc.
    expect(136.89 + there.y).toBeLessThan(150);
    expect(163.11 + back.y).toBeGreaterThan(150);
  });

  it('stands off perpendicular to a diagonal edge, on the side it bows towards', () => {
    const off = edgeLabelOffset({ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 30, y: 70 });
    expect(off.x).toBe(Math.round(-EDGE_LABEL_GAP * Math.SQRT1_2));
    expect(off.y).toBe(Math.round(EDGE_LABEL_GAP * Math.SQRT1_2));
  });

  it('keeps a straight edge label off the line when the midpoint is a pixel or two out', () => {
    // Cytoscape reports the midpoint of this straight edge as (96,159) where the true one
    // is (98,160). Reading a direction out of that 2px difference pushed the label along
    // the edge instead of away from it, and it came out drawn across its own line.
    const source = { x: 50, y: 110 };
    const target = { x: 145, y: 210 };
    const off = edgeLabelOffset(source, target, { x: 96, y: 159 });

    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const length = Math.hypot(dx, dy);
    // Distance from the offset label to the line it belongs to: the whole gap, not a
    // fraction of it.
    const fromLine = Math.abs(off.x * -dy + off.y * dx) / length;
    expect(fromLine).toBeCloseTo(EDGE_LABEL_GAP, 0);
  });

  it('takes a custom gap', () => {
    expect(edgeLabelOffset(left, right, { x: 100, y: -20 }, 30)).toEqual({ x: 0, y: -30 });
  });

  it('handles a midpoint that coincides with the endpoints', () => {
    const off = edgeLabelOffset(left, left, { x: 0, y: 0 });
    expect(Number.isFinite(off.x)).toBe(true);
    expect(Number.isFinite(off.y)).toBe(true);
    expect(off).toEqual({ x: 0, y: EDGE_LABEL_GAP });
  });
});

describe('bestLoopDirection', () => {
  const node = { x: 0, y: 0 };
  // Canvas y grows downwards, so straight above the state is negative y, and this is
  // where the loop's label lands when the loop points up.
  const aboveTheState = { x: 0, y: -(LOOP_REACH + 19) };

  it('points the loop up, where JFLAP draws it, when there is room', () => {
    expect(bestLoopDirection(node, [], [])).toBe(0);
  });

  it('stays up when the neighbours are on that side but not in the way', () => {
    // Two states up and to either side, as in the reported DFA. They are nowhere near
    // where the loop label goes, so the picture keeps matching JFLAP. A rule that merely
    // preferred open space would have swung the loop downwards here.
    expect(
      bestLoopDirection(
        node,
        [
          { x: -95, y: -100 },
          { x: 95, y: -100 },
        ],
        [Math.atan2(-100, -95), Math.atan2(-100, 95)],
      ),
    ).toBe(0);
  });

  it('turns aside when something already occupies where the label would go', () => {
    const deg = bestLoopDirection(node, [aboveTheState], []);
    expect(deg).not.toBe(0);
  });

  it('turns aside for a transition label, not just for a state', () => {
    // On a tight machine it is another edge's label the loop collides with, which is why
    // the caller passes label anchors in alongside the states.
    expect(bestLoopDirection(node, [{ x: 4, y: -74 }], [])).not.toBe(0);
  });

  it('picks a direction that is actually clear of the obstacle', () => {
    const deg = bestLoopDirection(node, [aboveTheState], []);
    const angle = ((deg - 90) * Math.PI) / 180;
    const label = {
      x: Math.cos(angle) * (LOOP_REACH + 19),
      y: Math.sin(angle) * (LOOP_REACH + 19),
    };
    expect(Math.hypot(label.x - aboveTheState.x, label.y - aboveTheState.y)).toBeGreaterThan(
      NODE_DIAMETER / 2,
    );
  });

  it('returns one of the eight compass points, in degrees clockwise from up', () => {
    const deg = bestLoopDirection(node, [aboveTheState], []);
    expect(deg % 45).toBe(0);
    expect(deg).toBeGreaterThanOrEqual(-180);
    expect(deg).toBeLessThanOrEqual(180);
  });
});

describe('loopLabelOffset', () => {
  const oneLine = LABEL_LINE_HEIGHT / 2 + LABEL_LOOP_GAP;

  it('lifts the label straight up above an upward loop', () => {
    expect(loopLabelOffset(0, 1)).toEqual({ x: 0, y: Math.round(-oneLine) });
  });

  it('drops the label below a downward loop', () => {
    expect(loopLabelOffset(180, 1)).toEqual({ x: 0, y: Math.round(oneLine) });
  });

  it('pushes the label out to the right of a rightward loop', () => {
    expect(loopLabelOffset(90, 1)).toEqual({ x: Math.round(oneLine), y: 0 });
  });

  it('clears a bundled label by its own height, not the loop as well', () => {
    // Four transitions on one loop: the label is four lines, and only has to clear half
    // of itself, because the far side of the loop is already where it is anchored.
    const off = loopLabelOffset(0, 4);
    expect(off.y).toBe(-Math.round((4 * LABEL_LINE_HEIGHT) / 2 + LABEL_LOOP_GAP));
  });

  it('treats a label with no lines as one line', () => {
    expect(loopLabelOffset(0, 0)).toEqual(loopLabelOffset(0, 1));
  });
});

describe('note geometry', () => {
  it('sizes a short note to its text plus padding', () => {
    const box = noteBox('hi');
    expect(box.width).toBe(Math.round(2 * 7.5) + NOTE_PADDING * 2);
    // One line.
    expect(box.height).toBe(18 + NOTE_PADDING * 2);
  });

  it('counts each hard line, including a blank one between paragraphs', () => {
    const box = noteBox('a\n\nb');
    expect(box.height).toBe(18 * 3 + NOTE_PADDING * 2);
  });

  /**
   * A note is free text a student typed, so it has no natural bound. Without a cap, one long
   * paragraph stretches the canvas until `fit` shrinks the machine itself to a speck.
   */
  it('wraps rather than growing wider than the cap', () => {
    const box = noteBox('x'.repeat(500));
    expect(box.width).toBeLessThanOrEqual(NOTE_MAX_WIDTH + NOTE_PADDING * 2);
    // 500 characters have to go somewhere, so it grows downwards instead.
    expect(box.height).toBeGreaterThan(18 * 4);
  });

  /**
   * JFLAP saves a note's top-left, because `automata/Note` is a Swing component placed with
   * `setLocation`. Cytoscape positions every node by its centre.
   */
  it('converts a saved top-left corner into a centre', () => {
    expect(noteCentre({ x: 100, y: 200 }, { width: 40, height: 20 })).toEqual({
      x: 120,
      y: 210,
    });
  });
});

describe('stateFontSize', () => {
  it('leaves an ordinary name at the size JFLAP draws it', () => {
    // The common case by far, and the one that must not change: two or three characters.
    expect(stateFontSize('q0')).toBe(STATE_FONT_SIZE);
    expect(stateFontSize('q12')).toBe(STATE_FONT_SIZE);
  });

  it('shrinks a name that would run out over the circle', () => {
    // What renaming from the properties panel makes ordinary: a word rather than a label.
    const small = stateFontSize('accepting');
    expect(small).toBeLessThan(STATE_FONT_SIZE);
    expect(small).toBeGreaterThanOrEqual(STATE_FONT_MIN_SIZE);
  });

  it('shrinks further the longer the name gets, until the floor', () => {
    expect(stateFontSize('abcdefgh')).toBeLessThan(stateFontSize('abcdef'));
    // Past readable, so it stops rather than trading one unreadable label for another.
    expect(stateFontSize('a'.repeat(40))).toBe(STATE_FONT_MIN_SIZE);
  });

  it('measures the longest line of a name that has more than one', () => {
    expect(stateFontSize('accepting\nq0')).toBe(stateFontSize('accepting'));
  });

  it('leaves an empty name alone rather than dividing by nothing', () => {
    expect(stateFontSize('')).toBe(STATE_FONT_SIZE);
  });
});

/**
 * How far a bundled transition label stands off its edge.
 *
 * Cytoscape centres a label on its anchor, so a block of several lines grows both ways and half
 * of it comes back over the edge. Where two states have a transition each way, the two blocks
 * grew into each other and the reader saw one column of alternating symbols. The gap is
 * measured to the nearest line instead, so the stack grows outward.
 */
describe('the gap between an edge and its label', () => {
  it('leaves a single line exactly where it has always been', () => {
    expect(edgeLabelGapForLines(1)).toBe(EDGE_LABEL_GAP);
    expect(edgeLabelGapForText('a')).toBe(EDGE_LABEL_GAP);
  });

  it('grows by half a line for each line after the first', () => {
    // Half, not a whole one: the block is centred on the anchor, so pushing it out by half its
    // extra height is what puts its nearest line back at the plain gap.
    expect(edgeLabelGapForLines(2)).toBe(EDGE_LABEL_GAP + LABEL_LINE_HEIGHT / 2);
    expect(edgeLabelGapForLines(3)).toBe(EDGE_LABEL_GAP + LABEL_LINE_HEIGHT);
    expect(edgeLabelGapForLines(5)).toBe(EDGE_LABEL_GAP + 2 * LABEL_LINE_HEIGHT);
  });

  it('keeps growing, one step at a time, however many there are', () => {
    const gaps = [1, 2, 3, 5, 8].map((n) => edgeLabelGapForLines(n));
    for (let i = 1; i < gaps.length; i += 1) expect(gaps[i]!).toBeGreaterThan(gaps[i - 1]!);
    expect(edgeLabelGapForLines(8)).toBe(EDGE_LABEL_GAP + 3.5 * LABEL_LINE_HEIGHT);
  });

  it('counts the lines the label actually has, after any wrapping', () => {
    expect(edgeLabelGapForText('a\nb\nc')).toBe(edgeLabelGapForLines(3));
    // A single transition whose symbols wrapped is still three lines to look at.
    expect(edgeLabelGapForText('a, b,\nc, d,\ne')).toBe(edgeLabelGapForLines(3));
  });

  it('treats an empty label as one line rather than none', () => {
    expect(edgeLabelGapForText('')).toBe(EDGE_LABEL_GAP);
    expect(edgeLabelGapForLines(0)).toBe(EDGE_LABEL_GAP);
  });

  /** The side is chosen by the curve's bow; this only says how far. */
  it('pushes further out without changing which side', () => {
    const source = { x: 0, y: 0 };
    const target = { x: 200, y: 0 };
    const mid = { x: 100, y: 0 };
    const one = edgeLabelOffset(source, target, mid, edgeLabelGapForLines(1));
    const three = edgeLabelOffset(source, target, mid, edgeLabelGapForLines(3));

    expect(Math.sign(three.y)).toBe(Math.sign(one.y));
    expect(Math.abs(three.y)).toBeGreaterThan(Math.abs(one.y));
  });

  it('keeps the two directions on opposite sides, however tall they get', () => {
    // Two states joined both ways: cytoscape bows the curves apart, and the labels follow the
    // bow. Both blocks growing outward keeps them apart rather than into each other.
    const a = { x: 0, y: 0 };
    const b = { x: 200, y: 0 };
    const gap = edgeLabelGapForLines(3);
    const forward = edgeLabelOffset(a, b, { x: 100, y: 20 }, gap);
    const back = edgeLabelOffset(b, a, { x: 100, y: -20 }, gap);

    expect(Math.sign(forward.y)).not.toBe(Math.sign(back.y));
  });

  it.each([
    ['horizontal', { x: 0, y: 0 }, { x: 200, y: 0 }],
    ['vertical', { x: 0, y: 0 }, { x: 0, y: 200 }],
    ['diagonal', { x: 0, y: 0 }, { x: 140, y: 140 }],
  ])('stands off a %s edge by the whole gap', (_name, source, target) => {
    const mid = { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
    const gap = edgeLabelGapForLines(3);
    const off = edgeLabelOffset(source, target, mid, gap);

    // Straight out from the edge, so the whole of the gap is spent crossing it.
    expect(Math.hypot(off.x, off.y)).toBeCloseTo(gap, 0);
  });
});
