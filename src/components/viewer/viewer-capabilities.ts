/**
 * What a viewer is allowed to do with what it is showing.
 *
 * Three separate questions that used to be one. `showInspector` decided whether the properties
 * panel appeared AND whether the tool palette appeared, which quietly made "you may look at
 * this" and "you may change this" the same answer. They are not: a submission being marked is
 * something to read and annotate but not to redraw, and a split window hides one pane's
 * inspector for room while both panes remain equally editable.
 *
 * Kept to three flags rather than a permission system. The viewer has three kinds of action and
 * a fourth is not in sight; a generic capability bag would be more to learn and no more capable.
 */
export type ViewerCapabilities = {
  /** Open the properties of a state or a transition. Reading, not changing. */
  inspect: boolean;
  /**
   * Change the machine: draw a state, rename one, re-mark initial and final, re-word a
   * transition, delete either. None of this touches the submitted file, which is why the viewer
   * can offer it at all, but it does change what the reader is looking at.
   */
  editMachine: boolean;
  /** Write comments over the drawing. Never part of the machine. See useViewerTextBoxes. */
  annotate: boolean;
};

/** What a viewer can do unless a caller says otherwise, which is everything. */
export const DEFAULT_VIEWER_CAPABILITIES: ViewerCapabilities = {
  inspect: true,
  editMachine: true,
  annotate: true,
};

/**
 * Look and comment, but leave the machine alone.
 *
 * Here for the contexts that will want it (a comparison pane, a viewer beside a rubric) and for
 * the tests that prove read-only is enforced rather than merely unoffered.
 */
export const READ_ONLY_VIEWER_CAPABILITIES: ViewerCapabilities = {
  inspect: true,
  editMachine: false,
  annotate: true,
};

/** Fill in whatever a caller did not say. */
export function resolveViewerCapabilities(
  partial?: Partial<ViewerCapabilities> | null,
): ViewerCapabilities {
  return { ...DEFAULT_VIEWER_CAPABILITIES, ...(partial ?? {}) };
}
