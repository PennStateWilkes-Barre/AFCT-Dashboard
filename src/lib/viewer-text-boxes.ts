/**
 * Text a reader has written on top of a machine, and where it is kept.
 *
 * Somebody reading a submission wants to write "this loop is the bug" beside the loop. That is
 * not part of the automaton and never becomes part of it: these boxes are annotations drawn over
 * the canvas, they are not states, they are not JFLAP notes (which come out of the file and are
 * the student's own words), and nothing here reaches the parse, the evaluator, or the counts in
 * the toolbar.
 *
 * `localStorage`, not the `sessionStorage` the rest of the view uses. The camera and the
 * arrangement are how one sitting looked at a file; a written note is meant to still be there
 * tomorrow, which is the whole reason it is typed rather than said out loud. Nothing here is
 * authoritative: the submitted file is unchanged, and losing a box costs the reader the typing.
 */

/**
 * One box.
 *
 * `x`/`y` are the top-left corner and `width`/`height` the size, all in the graph's own
 * coordinates: the same numbers a state position has on the canvas, NOT the units the `.jff`
 * file stores (those are scaled on the way in, see POSITION_SCALE). Boxes never go into a
 * `.jff`, so there is nothing to scale them to, and keeping them in canvas units is what lets
 * the overlay ride the graph's own pan and zoom with one transform.
 */
export type ViewerTextBox = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
};

/** How big a new box is, and how small a reader is allowed to drag one. */
export const TEXT_BOX_DEFAULT_SIZE = { width: 200, height: 80 };
export const TEXT_BOX_MIN_SIZE = { width: 80, height: 30 };

/**
 * A cap, so a wedged loop or a paste of a novel cannot fill the origin's storage quota and take
 * the remembered view down with it. Well past anything a reader would write by hand.
 */
export const TEXT_BOX_MAX_LENGTH = 2000;
const MAX_BOXES = 200;

const PREFIX = 'afct-viewer-text-boxes:';

/** The storage key for one document. Exported so a caller can clear or inspect one. */
export function textBoxStorageKey(documentId: string): string {
  return PREFIX + documentId;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isTextBox(value: unknown): value is ViewerTextBox {
  if (!value || typeof value !== 'object') return false;
  const b = value as Record<string, unknown>;
  return (
    typeof b.id === 'string' &&
    b.id.length > 0 &&
    typeof b.text === 'string' &&
    isFiniteNumber(b.x) &&
    isFiniteNumber(b.y) &&
    isFiniteNumber(b.width) &&
    isFiniteNumber(b.height) &&
    b.width >= TEXT_BOX_MIN_SIZE.width &&
    b.height >= TEXT_BOX_MIN_SIZE.height
  );
}

/**
 * Read one document's boxes back.
 *
 * Anything that is not a list of well formed boxes reads as none: hand-edited storage, an entry
 * from a future shape, a truncated write. A reader who has lost their annotations is worse off
 * than one who never had them, but a viewer that will not open is worse than both.
 */
export function readTextBoxes(documentId: string | null | undefined): ViewerTextBox[] {
  if (!documentId || typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(textBoxStorageKey(documentId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTextBox).slice(0, MAX_BOXES);
  } catch {
    // Blocked storage, or a half-written entry. No annotations is a working viewer.
    return [];
  }
}

/** Write them back, or remove the entry when the last one goes. */
export function writeTextBoxes(
  documentId: string | null | undefined,
  boxes: readonly ViewerTextBox[],
): void {
  if (!documentId || typeof window === 'undefined') return;
  try {
    const key = textBoxStorageKey(documentId);
    if (boxes.length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(
      key,
      JSON.stringify(
        boxes
          .slice(0, MAX_BOXES)
          .map((b) => ({ ...b, text: b.text.slice(0, TEXT_BOX_MAX_LENGTH) })),
      ),
    );
  } catch {
    // Full, or blocked. Losing the persistence is not worth interrupting a reader over; the
    // boxes stay on screen for as long as the page is open.
  }
}

/** An id nobody else in this document is using. */
export function freeTextBoxId(boxes: readonly ViewerTextBox[]): string {
  const taken = new Set(boxes.map((b) => b.id));
  for (let n = 1; ; n += 1) {
    const id = `text-${n}`;
    if (!taken.has(id)) return id;
  }
}
