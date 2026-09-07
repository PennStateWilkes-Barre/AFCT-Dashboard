'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { availableCanvasTools, DEFAULT_CANVAS_TOOL, type CanvasTool } from './CanvasToolPalette';
import type { ViewerCapabilities } from './viewer-capabilities';

/**
 * Which tool the canvas is in, and everything that can take it away.
 *
 * One value, never a flag per tool. `isAddingState` beside `isAddingComment` is two states that
 * can both be true and a bug the first time they are, and the number of ways to get it wrong
 * grows with every tool. Here there is one answer and it is always exactly one.
 *
 * How a tool that takes more than one click works, which Transition already does: `activeTool`
 * stays at that tool for the whole gesture and the half-finished work is held beside this hook.
 * Transition's is the state a line is being drawn from, chosen on the first click, spent on the
 * second, dropped by Escape; it lives in the layer that owns the graph, because that is where
 * the clicks are worked out. It is not in the union, and there is no value for "halfway
 * through": stages are not tools.
 */
export function useCanvasTools(
  capabilities: ViewerCapabilities,
  /**
   * What Escape means here, in order, before it means nothing.
   *
   * One handler for the key rather than one per feature, because Escape is a single word for
   * "never mind" and what it should give up is whatever is most recent: a half-drawn line
   * first, then the tool that was drawing it, then whatever is selected. Two listeners would
   * each answer at once and the reader would lose two things to one press.
   *
   * `cancelGesture` returns whether there was anything to cancel.
   */
  escape: { cancelGesture?: () => boolean; clearSelection?: () => void } = {},
) {
  const [requested, setRequested] = useState<CanvasTool>(DEFAULT_CANVAS_TOOL);

  const tools = useMemo(() => availableCanvasTools(capabilities), [capabilities]);

  /**
   * The tool in force, which is not always the one last asked for.
   *
   * A capability can be withdrawn while a tool is up: a pane turned read-only with State
   * selected would otherwise go on drawing states that the viewer no longer allows. Corrected
   * here rather than in an effect so there is never a render, however brief, in which the
   * canvas is in a mode nobody may use.
   */
  const activeTool = tools.includes(requested) ? requested : DEFAULT_CANVAS_TOOL;

  // Keep what is remembered in step with what is in force, or a tool that came back later would
  // reappear on its own long after the reader stopped asking for it.
  useEffect(() => {
    if (!tools.includes(requested)) setRequested(DEFAULT_CANVAS_TOOL);
  }, [tools, requested]);

  const resetTool = useCallback(() => setRequested(DEFAULT_CANVAS_TOOL), []);

  /**
   * Escape leaves a creation tool.
   *
   * On the window rather than on the viewer, because placing something leaves focus nowhere in
   * particular: a click on a canvas focuses no element, so a handler on the container would
   * never hear the key that is meant to get the reader out of placement mode. Bound only while
   * a tool other than Select is up, so an ordinary viewer listens for nothing.
   *
   * Not while they are typing. The inspector's boxes and a comment being written are inside
   * this viewer, and Escape in either of those means "put this down"; taking the tool away as
   * well would be two answers to one key. A comment editor stops the event before it reaches
   * here, and this checks the target as well for everything that does not.
   */
  const escapeRef = useRef(escape);
  escapeRef.current = escape;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        // Not while typing, and not inside anything that closes on this key itself. A dialog,
        // a menu and a confirmation all answer Escape on their own, and taking the reader's
        // selection away as they dismiss one would be a second answer they did not ask for.
        target.closest('input, textarea, select, [role="dialog"], [role="menu"], [role="menubar"]')
      ) {
        return;
      }
      // Half-finished work first, the tool second, the selection last. Somebody who drew a line
      // to the wrong state wants that line gone, not the tool they are still using, and
      // somebody with no line half-drawn and no tool up means the states they picked out.
      if (escapeRef.current.cancelGesture?.()) return;
      if (activeTool !== DEFAULT_CANVAS_TOOL) {
        resetTool();
        return;
      }
      escapeRef.current.clearSelection?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeTool, resetTool]);

  return { activeTool, tools, selectTool: setRequested, resetTool };
}
