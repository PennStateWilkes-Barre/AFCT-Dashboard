// src/lib/jflap-layout.ts
//
// Pure geometry for the JFLAP viewer: placing a finite-automaton "start" stub next to its
// initial state, aiming a self-loop into free space, and offsetting a transition label
// clear of whatever it belongs to. Extracted from JffViewerDialog, where the
// clutter-scoring loop was duplicated (initial layout + drag reposition), so it can live
// and be tested on its own.
//
// Angles in this file are screen angles in radians unless a name says otherwise: measured
// from due east, and turning clockwise, because canvas y grows downwards.

export type Point = { x: number; y: number };

/** Diameter of a state node in the JFLAP viewer; sets the overlap threshold. */
export const NODE_DIAMETER = 58;

/**
 * Border widths the viewer draws states with. Exported rather than left as literals in the
 * stylesheet because the initial-state marker has to be placed against the OUTER edge of
 * whichever border a state has, and cytoscape centres a border on the node boundary
 * (`border-position` defaults to `center`), so half of it lies outside the nominal radius.
 *
 * A final state is drawn as a double border, which is JFLAP's two concentric circles. At 6px
 * centred on a 29px radius, the outer circle sits at ~32 and the inner at ~26, with the gap
 * between them straddling 29. That is why these two numbers have to reach the geometry: a
 * marker placed against the nominal radius stops in the gap, so the arrow appears to pierce
 * the outer circle and stop inside the ring.
 */
export const STATE_BORDER_WIDTH = 2;
export const FINAL_STATE_BORDER_WIDTH = 6;

/** The size a state's name is drawn at when it fits, which is nearly always. */
export const STATE_FONT_SIZE = 16;

/**
 * The smallest a state's name is allowed to shrink to.
 *
 * Past this the name stops being readable and shrinking it further only trades one unreadable
 * label for another, so a very long name is allowed to overflow the circle instead. The
 * properties panel is where a name that long is meant to be read.
 */
export const STATE_FONT_MIN_SIZE = 9;

/**
 * The size to draw a state's name at so it stays inside the circle.
 *
 * States are a fixed 58px across, the way JFLAP draws them, so a name longer than about five
 * characters ran out over the edge and into the machine around it. Renaming a state from the
 * properties panel made that ordinary rather than rare: "start" fits, "accepting" does not.
 *
 * The width of a string is estimated rather than measured. Measuring means a canvas context and
 * a font that has finished loading, and this is called for every state on every restyle, while
 * being wrong by a few percent costs nothing here: the answer is a font size for a label that
 * has a couple of pixels of slack either side. `WIDTH_PER_EM` is the average advance of a
 * digit-and-letter mix in the UI sans face, which is what state names are.
 */
export function stateFontSize(label: string, diameter: number = NODE_DIAMETER): number {
  const text = String(label ?? '');
  if (text.length === 0) return STATE_FONT_SIZE;
  const WIDTH_PER_EM = 0.6;
  // The chord across the middle of the circle, less the border it would sit on and a little
  // air either side. Not the full diameter: a label that touches the circle reads as a mistake.
  const usable = diameter - 2 * STATE_BORDER_WIDTH - 8;
  const longestLine = Math.max(...text.split('\n').map((line) => line.length));
  const fits = usable / (longestLine * WIDTH_PER_EM);
  if (fits >= STATE_FONT_SIZE) return STATE_FONT_SIZE;
  return Math.max(STATE_FONT_MIN_SIZE, Math.floor(fits));
}

/** How far a transition label sits off its edge, in pixels. */
export const EDGE_LABEL_GAP = 12;

/**
 * Smallest curve bow that counts as one rather than as rounding. Cytoscape reports the
 * midpoint of a straight edge up to about two pixels off the true midpoint; the bow it
 * puts on a pair of opposed edges is an order of magnitude larger.
 */
const MIN_BOW = 4;

/** Line box of a transition label at the 16px edge font, and its clearance from a loop. */
export const LABEL_LINE_HEIGHT = 19;
export const LABEL_LOOP_GAP = 10;

/**
 * How far a self-loop's far side sits from the centre of its state. Measured off the
 * rendered graph at the loop styling the viewer uses (a 58px state, a 48px control-point
 * step); cytoscape works it out from several style properties at once, so there is no
 * single one to read it from.
 */
export const LOOP_REACH = 61;

/**
 * How much room a self-loop's label needs around it before its direction counts as taken.
 * Roughly a state's radius plus a label's own half-height, so a loop is turned aside by
 * something genuinely in its way and not by a neighbour merely being on that side.
 */
const LOOP_LABEL_CLEARANCE = NODE_DIAMETER / 2 + LABEL_LINE_HEIGHT / 2;

/** The 8 compass directions, starting straight up and turning clockwise. */
const COMPASS_FROM_NORTH = Array.from({ length: 8 }, (_, i) => -Math.PI / 2 + i * (Math.PI / 4));

/** The same 8, starting due west, for things that belong on the left if they can be. */
const COMPASS_FROM_WEST = Array.from({ length: 8 }, (_, i) => {
  const angle = Math.PI + i * (Math.PI / 4);
  return angle > Math.PI ? angle - 2 * Math.PI : angle;
});

/**
 * Box the initial-state marker is drawn in. Square, which is what lets the triangle be
 * turned to any angle without the shape distorting: cytoscape stretches
 * `shape-polygon-points` over the node's width and height, so an oblong box would squash
 * the triangle differently at every angle.
 */
export const START_MARKER_SIZE = NODE_DIAMETER;

/**
 * How wide a note is allowed to get before its text wraps, in viewer pixels.
 *
 * A note is free text a student typed, so it has no natural bound: one long paragraph would
 * otherwise stretch the canvas until the machine itself was a speck after `fit`. Roughly four
 * states wide, which is enough for a sentence without dominating a diagram.
 */
export const NOTE_MAX_WIDTH = NODE_DIAMETER * 4;

/** Font size a note is drawn at, a little under the 16px used for edge labels. */
export const NOTE_FONT_SIZE = 14;

/** Line box for wrapped note text at {@link NOTE_FONT_SIZE}. */
export const NOTE_LINE_HEIGHT = 18;

/** Padding inside a note's box, so its text does not touch the border. */
export const NOTE_PADDING = 6;

/**
 * Average character width at {@link NOTE_FONT_SIZE}, for estimating how text wraps.
 *
 * An estimate on purpose. The viewer already sizes ELK's spacing from a per-character figure
 * (`useJffCytoscape`, ~8px at the 16px edge font) rather than measuring, because the geometry
 * has to be computable without a canvas: `toElements` is pure and is unit tested in jsdom,
 * where real text metrics do not exist. Being a few pixels out moves a note slightly; being
 * unable to place it at all would be worse.
 */
const NOTE_CHAR_WIDTH = 7.5;

/**
 * The box a note's text needs once wrapped at {@link NOTE_MAX_WIDTH}.
 *
 * Explicit line breaks are honoured, because JFLAP notes are multi-line text areas, and each
 * of those lines then wraps on its own.
 */
export function noteBox(text: string): { width: number; height: number } {
  const charsPerLine = Math.max(1, Math.floor(NOTE_MAX_WIDTH / NOTE_CHAR_WIDTH));
  const hardLines = text.split('\n');

  let widestChars = 0;
  let lineCount = 0;
  for (const line of hardLines) {
    // An empty line is still a line: a blank line between paragraphs takes vertical space.
    const wrapped = Math.max(1, Math.ceil(line.length / charsPerLine));
    lineCount += wrapped;
    widestChars = Math.max(widestChars, Math.min(line.length, charsPerLine));
  }

  return {
    width: Math.round(widestChars * NOTE_CHAR_WIDTH) + NOTE_PADDING * 2,
    height: Math.round(lineCount * NOTE_LINE_HEIGHT) + NOTE_PADDING * 2,
  };
}

/**
 * Where to put a note's centre, given the top-left corner JFLAP saved and the box its text
 * turned out to need.
 *
 * JFLAP's note is a Swing `JTextArea` positioned with `setLocation`, which places a component by
 * its **top-left**. A state is a circle drawn centred on its point. Cytoscape positions every
 * node by its centre, so a note passed straight through lands half its own width and height
 * down and to the right of where the student put it, which is most of a state's width out.
 *
 * Sizes are measured from the text rather than read from the file, because JFLAP does not
 * persist them: `automata/Note` writes only the text and the point.
 */
export function noteCentre(topLeft: Point, size: { width: number; height: number }): Point {
  return {
    x: topLeft.x + size.width / 2,
    y: topLeft.y + size.height / 2,
  };
}

/**
 * The marker itself, as JFLAP draws it: an unfilled triangle lying on its side with its
 * point against the state, as wide as the state's radius and as tall as its diameter.
 * Given in the -1..1 box `shape-polygon-points` uses, pointing due east, which is the
 * shape wanted when the marker sits on the state's left.
 */
const START_MARKER_POINTS: Point[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
];

/**
 * Which way out of the state the initial-state marker should sit.
 *
 * Due west whenever it can be, because that is where JFLAP puts it and this viewer is
 * read alongside JFLAP. It moves only when west is genuinely taken, which on an
 * automatic layout it often is: nothing there arranges the states so as to leave the
 * initial one's left side free, and the marker was landing across the transitions
 * running out of it. On a machine drawn by hand it stays on the left essentially always,
 * because whoever drew it left that space.
 *
 * `incidentAngles` matters more here than the obstacle list, since what the marker
 * usually has to avoid is a line rather than another state.
 */
export function bestStartMarkerDirection(
  nodePos: Point,
  obstacles: Point[],
  incidentAngles: number[],
  nodeDiameter: number = NODE_DIAMETER,
): number {
  return leastClutteredAngle(
    COMPASS_FROM_WEST,
    nodePos,
    obstacles,
    incidentAngles,
    nodeDiameter,
    nodeDiameter * 0.9,
  );
}

/**
 * Where the marker's box goes for a given direction: far enough out that the triangle's
 * point lands against the outside of the state's rim. The point sits half a box from the
 * box's centre, so the distance is the state's radius, plus the half of its border that is
 * drawn outside the boundary, plus that half box.
 *
 * `borderWidth` is what makes a final state work. Its double border is wider, and reaching
 * only to the nominal radius left the point in the gap between the two circles, so the
 * arrow looked like it had pierced the outer one. An arrow stops at a state's outermost
 * edge, whether the state is accepting or not.
 */
export function startMarkerPosition(
  statePos: Point,
  angle: number = Math.PI,
  nodeDiameter: number = NODE_DIAMETER,
  borderWidth: number = STATE_BORDER_WIDTH,
): Point {
  const distance = nodeDiameter / 2 + borderWidth / 2 + START_MARKER_SIZE / 2;
  return {
    x: statePos.x + Math.cos(angle) * distance,
    y: statePos.y + Math.sin(angle) * distance,
  };
}

/**
 * The marker's outline for a given direction, as cytoscape's `shape-polygon-points`
 * string. The triangle is turned to point back at the state it belongs to.
 */
export function startMarkerPolygon(angle: number = Math.PI): string {
  // The marker sits at `angle` from the state, so its point faces the opposite way.
  const facing = angle + Math.PI;
  const cos = Math.cos(facing);
  const sin = Math.sin(facing);
  return START_MARKER_POINTS.map((p) => {
    const x = p.x * cos - p.y * sin;
    const y = p.x * sin + p.y * cos;
    return `${round3(x)} ${round3(y)}`;
  }).join(', ');
}

/** Trims floating-point dust out of the polygon string; cytoscape parses it as text. */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Of the given candidate directions, the one with the least around it. Lining up with an
 * edge already leaving the state is penalized too, since whatever is placed there would
 * sit along that edge. Ties go to the earliest candidate, so each caller passes its
 * directions in order of preference and gets that one whenever it is clear.
 *
 * `radius` is how far out the thing being placed will sit, `obstacles` are the points it
 * has to stay clear of, and `incidentAngles` are the screen angles of the edges already
 * at this state.
 */
function leastClutteredAngle(
  candidates: number[],
  nodePos: Point,
  obstacles: Point[],
  incidentAngles: number[],
  radius: number,
  clearance: number,
): number {
  const scores = candidates.map((angle) => {
    const testX = nodePos.x + Math.cos(angle) * radius;
    const testY = nodePos.y + Math.sin(angle) * radius;

    let score = 0;
    for (const pos of obstacles) {
      const dx = testX - pos.x;
      const dy = testY - pos.y;
      if (Math.sqrt(dx * dx + dy * dy) < clearance) score += 1000;
    }

    for (const edgeAngle of incidentAngles) {
      let diff = Math.abs(angle - edgeAngle);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (diff < Math.PI / 6) score += 10; // within 30° of an edge already there
    }
    return score;
  });

  let bestIdx = 0;
  let bestScore = scores[0] ?? Infinity;
  for (let i = 1; i < scores.length; ++i) {
    const s = scores[i];
    if (s !== undefined && s < bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  }
  return candidates[bestIdx] ?? 0;
}

/**
 * Which way a state's self-loop should arc, in the degrees cytoscape's `loop-direction`
 * wants: zero is straight up and the angle turns clockwise.
 *
 * Straight up is where JFLAP puts every loop, and where this returns whenever there is
 * room, because matching the desktop tool is worth more than a tidier picture. But JFLAP
 * draws a far smaller loop. At the size this viewer draws them, a loop and its label
 * reach a good way past the state, so on a crowded state the label landed on top of the
 * transitions above it. Hence: up unless up is taken, and only then the next way round.
 *
 * That is why this scores obstacles by a flat threshold and not by distance. Anything
 * that merely prefers open space walks loops away from `up` on machines that read fine
 * with them there, and the picture stops looking like the one the student drew.
 *
 * `obstacles` should be the other states plus the anchor of every transition label
 * already placed, because on a tight machine it is a label, not a state, that the loop
 * collides with.
 */
export function bestLoopDirection(
  nodePos: Point,
  obstacles: Point[],
  incidentAngles: number[],
  reach: number = LOOP_REACH,
): number {
  const angle = leastClutteredAngle(
    COMPASS_FROM_NORTH,
    nodePos,
    obstacles,
    incidentAngles,
    // Test where the loop's LABEL will sit, not the loop: that is the part that reaches
    // furthest and the part that has to stay readable.
    reach + LABEL_LINE_HEIGHT,
    LOOP_LABEL_CLEARANCE,
  );
  // Screen angle (east, clockwise) back to cytoscape's loop angle (north, clockwise).
  const degrees = Math.round((Math.atan2(Math.cos(angle), -Math.sin(angle)) * 180) / Math.PI);
  return degrees;
}

/**
 * How far to shift a self-loop's label off the point cytoscape anchors it to, which is
 * the far side of the loop. Pushes it further out along the loop's own direction, by
 * enough to clear its own height: every transition between the same pair of states is
 * bundled into one edge whose label is those transitions on separate lines, so a busy
 * state's loop can carry a dozen.
 *
 * `loopDirectionDegrees` is what `bestLoopDirection` returned. The loop's far side is
 * already the anchor, so this must not also count the loop's own reach: doing that parked
 * a one-line label a long way off in space.
 */
export function loopLabelOffset(
  loopDirectionDegrees: number,
  lineCount: number,
  lineHeight: number = LABEL_LINE_HEIGHT,
  gap: number = LABEL_LOOP_GAP,
): Point {
  const angle = ((loopDirectionDegrees - 90) * Math.PI) / 180; // back to a screen angle
  const push = (Math.max(1, lineCount) * lineHeight) / 2 + gap;
  return {
    x: Math.round(Math.cos(angle) * push),
    y: Math.round(Math.sin(angle) * push),
  };
}

/**
 * How far a bundled transition label has to stand off its edge, given how tall it is.
 *
 * Cytoscape centres a label on the point it is anchored to, so a block of several lines grows
 * in both directions: half of it comes back over the edge it belongs to, and where there is a
 * transition each way between two states, the two blocks grow into each other and interleave.
 * What somebody reads then is one column of alternating symbols with no way to tell which
 * belongs to which direction.
 *
 * So the gap is measured to the NEAREST line rather than to the middle of the block: the line
 * closest to the edge keeps the same clearance a single label has always had, and the rest of
 * the stack grows outward. A one-line label comes out at exactly the old gap, which is what
 * leaves every ordinary edge where it was.
 *
 * Pure, and separate from which side the label goes on: this only says how far.
 */
export function edgeLabelGapForLines(
  lineCount: number,
  lineHeight: number = LABEL_LINE_HEIGHT,
  gap: number = EDGE_LABEL_GAP,
): number {
  return gap + (Math.max(1, lineCount) - 1) * (lineHeight / 2);
}

/**
 * The same, from the label cytoscape is actually drawing.
 *
 * The lines are counted off the final string, after `bundleEdges` has wrapped anything too
 * long, so a single transition whose symbols wrap onto three lines is three lines here too.
 * An empty label counts as one and gets the plain gap.
 */
export function edgeLabelGapForText(
  label: string,
  lineHeight: number = LABEL_LINE_HEIGHT,
  gap: number = EDGE_LABEL_GAP,
): number {
  return edgeLabelGapForLines(label.split('\n').length, lineHeight, gap);
}

/**
 * How far to shift a transition label off the point cytoscape anchors it to, which is the
 * midpoint of the drawn curve.
 *
 * The label always moves straight out from the edge, which is the direction that clears
 * the line for the least distance travelled. Only the SIDE comes from the curve: it goes
 * to whichever side that curve already bows towards.
 *
 * The side is the part that matters, because of two states with a transition each way.
 * Cytoscape bows those two curves apart, and the rule this replaced turned 90° from each
 * edge's own source→target direction, which sent both labels into the gap between the
 * curves, one on top of the other. Picking the side by the bow separates them, the way
 * JFLAP puts one label above the pair and one below.
 */
export function edgeLabelOffset(
  source: Point,
  target: Point,
  midpoint: Point,
  gap: number = EDGE_LABEL_GAP,
): Point {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy);
  // A self-loop or a zero-length edge has no direction to stand off from.
  if (!length || !Number.isFinite(length)) return { x: 0, y: gap };

  const alongX = dx / length;
  const alongY = dy / length;
  const perpX = -dy / length;
  const perpY = dx / length;

  const centreX = (source.x + target.x) / 2 - midpoint.x;
  const centreY = (source.y + target.y) / 2 - midpoint.y;

  // How far the curve bows, and to which side. Cytoscape's midpoint for a straight edge
  // lands a pixel or two off the true midpoint, and reading a direction out of that
  // rounding noise is what used to leave a label sitting across its own edge, so only a
  // bow clearly bigger than the noise gets a vote. Below it, either side is as good, and
  // keeping the sign positive leaves a lone edge's label where it has always been.
  const bow = centreX * -perpX + centreY * -perpY;
  const side = bow < -MIN_BOW ? -1 : 1;

  // Slide the label back to the halfway point along the edge. Cytoscape anchors it to the
  // middle of the DRAWN curve, which runs rim to rim and is shortened at the target end to
  // leave room for the arrowhead, so the anchor sits slightly towards the source. Two
  // states joined in both directions point opposite ways, so their labels drifted apart
  // by twice that and stopped lining up. Only the drift ALONG the edge is corrected; the
  // part across it is the bow, which the label should keep following.
  const drift = centreX * alongX + centreY * alongY;

  // `|| 0` keeps a zero component as plain 0 rather than JavaScript's -0.
  return {
    x: Math.round(alongX * drift + perpX * side * gap) || 0,
    y: Math.round(alongY * drift + perpY * side * gap) || 0,
  };
}
