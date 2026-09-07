'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { availableCanvasTools, DEFAULT_CANVAS_TOOL, type CanvasTool } from './CanvasToolPalette';
import type { ViewerCapabilities } from './viewer-capabilities';

/**
 * Which tool the canvas is in, and everything that can take it away.
 *
 * One value, never a flag per tool. `isAddingState` beside `isAddingComment` is two states that
 * can both be true and a bug the first time they are, and the number of ways to get it wrong
 * grows with every tool. Here there is one answer and it is always exactly one.
 *
 * The extension point for a tool that takes more than one click: keep `activeTool` at that tool
 * for the whole gesture and hold the half-finished work beside this hook. Transition, when it
 * arrives, will want something like `{ sourceId } | null` living in the viewer: chosen on the
 * first click, spent on the second, dropped by Escape. It does not belong in the union and it
 * does not belong in useJffCytoscape, which knows only that a graph coordinate was clicked.
 */
export function useCanvasTools(capabilities: ViewerCapabilities) {
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
  useEffect(() => {
    if (activeTool === DEFAULT_CANVAS_TOOL) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input, textarea, select')) return;
      resetTool();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeTool, resetTool]);

  return { activeTool, tools, selectTool: setRequested, resetTool };
}
