/** @vitest-environment jsdom */
import { describe, it, expect } from 'vitest';

import {
  matchViewerShortcut,
  isEditableShortcutTarget,
  shortcutKeys,
  viewerShortcut,
  VIEWER_SHORTCUTS,
  type ShortcutEvent,
} from './viewer-shortcuts';

const press = (key: string, mods: Partial<ShortcutEvent> = {}): ShortcutEvent => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('which shortcut a key press is', () => {
  it.each([
    ['v', {}, 'selectTool'],
    ['V', {}, 'selectTool'],
    ['n', {}, 'stateTool'],
    ['t', {}, 'transitionTool'],
    ['c', {}, 'commentTool'],
    ['f', {}, 'fit'],
    ['F', { shiftKey: true }, 'center'],
    ['g', {}, 'grid'],
    ['G', { shiftKey: true }, 'snapToGrid'],
    ['?', { shiftKey: true }, 'help'],
    ['z', { ctrlKey: true }, 'undo'],
    ['z', { metaKey: true }, 'undo'],
    ['z', { ctrlKey: true, shiftKey: true }, 'redo'],
    ['z', { metaKey: true, shiftKey: true }, 'redo'],
    ['y', { ctrlKey: true }, 'redo'],
  ])('reads %s with %j as %s', (key, mods, id) => {
    expect(matchViewerShortcut(press(key, mods))).toBe(id);
  });

  /**
   * A letter with a command key held belongs to the browser or the system, and a viewer that
   * answered Ctrl+N would take a new window away from somebody who asked for one.
   */
  it.each([
    ['n', { ctrlKey: true }],
    ['n', { metaKey: true }],
    ['c', { metaKey: true }],
    ['c', { ctrlKey: true }],
    ['t', { ctrlKey: true }],
    ['f', { altKey: true }],
    ['g', { ctrlKey: true }],
    ['s', { ctrlKey: true }],
    ['s', { metaKey: true }],
    ['n', { shiftKey: true }],
    ['v', { shiftKey: true }],
    ['z', { ctrlKey: true, altKey: true }],
    ['y', { ctrlKey: true, shiftKey: true }],
    ['x', {}],
  ])('leaves %s with %j alone', (key, mods) => {
    expect(matchViewerShortcut(press(key, mods))).toBeNull();
  });

  it('tells the shifted letters from the plain ones', () => {
    expect(matchViewerShortcut(press('f'))).toBe('fit');
    expect(matchViewerShortcut(press('f', { shiftKey: true }))).toBe('center');
    expect(matchViewerShortcut(press('g'))).toBe('grid');
    expect(matchViewerShortcut(press('g', { shiftKey: true }))).toBe('snapToGrid');
  });
});

describe('how the keys are written', () => {
  it('spells the command key for the platform, and leaves plain letters alone', () => {
    expect(shortcutKeys('undo')).toBe('Ctrl+Z');
    expect(shortcutKeys('undo', true)).toBe('⌘Z');
    expect(shortcutKeys('fit')).toBe('F');
    expect(shortcutKeys('fit', true)).toBe('F');
  });

  it('gives every shortcut a label, keys and an aria value', () => {
    // The Help dialog, the menu hints and `aria-keyshortcuts` all read these, so a shortcut
    // added without one of them would show a blank.
    for (const shortcut of VIEWER_SHORTCUTS) {
      expect(shortcut.label.length).toBeGreaterThan(0);
      expect(shortcut.keys.length).toBeGreaterThan(0);
      expect(shortcut.aria.length).toBeGreaterThan(0);
    }
    expect(viewerShortcut('grid').label).toBe('Toggle grid');
  });
});

describe('what counts as typing rather than a shortcut', () => {
  const inside = (html: string) => {
    document.body.innerHTML = html;
    return document.querySelector('[data-target]');
  };

  it.each([
    ['an input', '<input data-target />'],
    ['a textarea', '<textarea data-target></textarea>'],
    ['a select', '<select data-target></select>'],
    ['a contenteditable', '<div contenteditable="true" data-target></div>'],
    ['a textbox role', '<div role="textbox" data-target></div>'],
    ['a combobox role', '<div role="combobox" data-target></div>'],
    ['a listbox role', '<div role="listbox" data-target></div>'],
    ['inside a dialog', '<div role="dialog"><button data-target></button></div>'],
    ['inside a menu', '<div role="menu"><div data-target></div></div>'],
    ['inside a menubar', '<div role="menubar"><div data-target></div></div>'],
  ])('keeps out of %s', (_label, html) => {
    expect(isEditableShortcutTarget(inside(html))).toBe(true);
  });

  it('acts on the canvas and on the page itself', () => {
    expect(isEditableShortcutTarget(inside('<div data-target></div>'))).toBe(false);
    expect(isEditableShortcutTarget(null)).toBe(false);
  });
});
