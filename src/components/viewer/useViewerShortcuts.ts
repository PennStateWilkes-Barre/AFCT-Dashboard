'use client';

import { useEffect, useRef } from 'react';

import {
  isEditableShortcutTarget,
  matchViewerShortcut,
  type ViewerShortcutId,
} from '@/lib/viewer-shortcuts';
import type { ViewerActions } from './viewer-actions';
import type { CanvasTool } from './CanvasToolPalette';

/** Which registered command each shortcut runs, for the ones that are simply a command. */
const COMMANDS: Partial<Record<ViewerShortcutId, keyof ViewerActions>> = {
  selectTool: 'selectSelectTool',
  stateTool: 'selectStateTool',
  transitionTool: 'selectTransitionTool',
  commentTool: 'selectCommentTool',
  undo: 'undo',
  redo: 'redo',
  fit: 'fitToWindow',
  center: 'centerInWindow',
  grid: 'toggleGrid',
  snapToGrid: 'toggleSnapToGrid',
};

/** Which tool each tool shortcut asks for, so availability can be checked before running. */
const TOOLS: Partial<Record<ViewerShortcutId, CanvasTool>> = {
  selectTool: 'select',
  stateTool: 'state',
  transitionTool: 'transition',
  commentTool: 'text',
};

/**
 * The standalone window's keyboard shortcuts, in one listener.
 *
 * One listener, at the window, owned by the chrome. Every tab a reader has opened stays
 * mounted so its arrangement and history survive, so a listener inside the viewer would be one
 * listener per open file: pressing F would fit four machines, three of them off screen. This
 * runs where the menu bar runs, and reaches the machine the same way the menu does, through the
 * actions registry, which only the focused pane is allowed to write to. So a shortcut goes
 * exactly where a menu item would.
 *
 * Escape is not here. It belongs to `useCanvasTools`, which has to answer it in an order this
 * hook cannot see: give up a half-drawn line, then leave the tool, then clear the selection.
 * Two listeners for one key would each answer at once.
 */
export function useViewerShortcuts({
  run,
  tools,
  canUndo,
  canRedo,
  onHelp,
}: {
  run: (name: keyof ViewerActions) => void;
  /** What the focused viewer can offer, so an unavailable tool is left to the browser. */
  tools: readonly CanvasTool[];
  canUndo: boolean;
  canRedo: boolean;
  onHelp: () => void;
}): void {
  // Read at the moment of the key press rather than closed over, so the listener is bound once
  // and still sees the focused pane as it now stands.
  const state = useRef({ run, tools, canUndo, canRedo, onHelp });
  state.current = { run, tools, canUndo, canRedo, onHelp };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A held key is one press. Nothing here is a thing to do repeatedly.
      if (event.repeat) return;
      if (isEditableShortcutTarget(event.target)) return;

      const id = matchViewerShortcut(event);
      if (!id) return;
      const { run, tools, canUndo, canRedo, onHelp } = state.current;

      if (id === 'help') {
        event.preventDefault();
        onHelp();
        return;
      }
      // Nothing to step back to, or a tool this viewer does not offer: the press was not ours,
      // so it is left alone rather than swallowed.
      if (id === 'undo' && !canUndo) return;
      if (id === 'redo' && !canRedo) return;
      const tool = TOOLS[id];
      if (tool && !tools.includes(tool)) return;

      const command = COMMANDS[id];
      if (!command) return;
      event.preventDefault();
      run(command);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
