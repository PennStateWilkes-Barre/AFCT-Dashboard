/**
 * The keys the standalone viewer answers to, in one place.
 *
 * One definition per shortcut, read by everything that has an opinion about it: the handler
 * that matches a key press, the menu that shows a hint beside an item, the tool palette's
 * tooltips, and the Help dialog that lists the lot. Four copies of "Ctrl+Z" is four chances for
 * one of them to be wrong, and the wrong one is always the one somebody reads.
 *
 * Pure and DOM-free apart from the shape of a keyboard event, so the matching rules can be
 * tested as rules rather than through a rendered viewer.
 */

/** Every shortcut the viewer implements. The id is what a handler switches on. */
export type ViewerShortcutId =
  | 'selectTool'
  | 'stateTool'
  | 'transitionTool'
  | 'commentTool'
  | 'undo'
  | 'redo'
  | 'deleteSelection'
  | 'fit'
  | 'center'
  | 'grid'
  | 'snapToGrid'
  | 'help';

/** The headings the Help dialog groups by, in the order it shows them. */
export const VIEWER_SHORTCUT_GROUPS = ['Tools', 'Editing', 'View', 'Arrange', 'Help'] as const;
export type ViewerShortcutGroup = (typeof VIEWER_SHORTCUT_GROUPS)[number];

/** The parts of a keyboard event the rules read. Anything with these fields will do. */
export type ShortcutEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

export type ViewerShortcut = {
  id: ViewerShortcutId;
  group: ViewerShortcutGroup;
  /** What the shortcut does, as the Help dialog lists it. */
  label: string;
  /** How the keys are written. `mac` only where the platform spells it differently. */
  keys: string;
  macKeys?: string;
  /**
   * The value for `aria-keyshortcuts` on a control that has this shortcut, in the syntax that
   * attribute takes: space-separated alternatives, `+` between simultaneous keys.
   */
  aria: string;
  matches: (event: ShortcutEvent) => boolean;
};

/** Alt is never part of a viewer shortcut, and a held Alt means the press was meant elsewhere. */
const noCommandKeys = (e: ShortcutEvent) => !e.ctrlKey && !e.metaKey && !e.altKey;

/** A plain letter: no command key, and Shift only where the shortcut asks for it. */
const letter =
  (key: string, shift = false) =>
  (e: ShortcutEvent) =>
    noCommandKeys(e) && e.shiftKey === shift && e.key.toLowerCase() === key;

/** Ctrl on Windows and Linux, Cmd on a Mac. Both are accepted everywhere: neither is ambiguous. */
const command = (e: ShortcutEvent) => (e.ctrlKey || e.metaKey) && !e.altKey;

export const VIEWER_SHORTCUTS: readonly ViewerShortcut[] = [
  {
    id: 'selectTool',
    group: 'Tools',
    label: 'Select tool',
    keys: 'V',
    aria: 'V',
    matches: letter('v'),
  },
  {
    // N rather than S, which leaves the letter people associate with saving alone.
    id: 'stateTool',
    group: 'Tools',
    label: 'State tool',
    keys: 'N',
    aria: 'N',
    matches: letter('n'),
  },
  {
    id: 'transitionTool',
    group: 'Tools',
    label: 'Transition tool',
    keys: 'T',
    aria: 'T',
    matches: letter('t'),
  },
  {
    id: 'commentTool',
    group: 'Tools',
    label: 'Comment tool',
    keys: 'C',
    aria: 'C',
    matches: letter('c'),
  },
  {
    id: 'undo',
    group: 'Editing',
    label: 'Undo',
    keys: 'Ctrl+Z',
    macKeys: '⌘Z',
    aria: 'Control+Z Meta+Z',
    matches: (e) => command(e) && !e.shiftKey && e.key.toLowerCase() === 'z',
  },
  {
    // Two spellings, because both are in people's fingers: the shifted undo everywhere, and
    // Ctrl+Y on Windows.
    id: 'redo',
    group: 'Editing',
    label: 'Redo',
    keys: 'Ctrl+Shift+Z',
    macKeys: '⇧⌘Z',
    aria: 'Control+Shift+Z Meta+Shift+Z Control+Y',
    matches: (e) =>
      command(e) &&
      ((e.shiftKey && e.key.toLowerCase() === 'z') || (!e.shiftKey && e.key.toLowerCase() === 'y')),
  },
  {
    /**
     * Listed here, answered elsewhere.
     *
     * Deleting needs to know what is selected, and that lives in the viewer rather than in the
     * window's chrome: a state goes through the same confirmation the properties panel asks
     * (JffViewerDialog), and a comment through the layer that owns it (CanvasTextLayer). Both
     * bind the key themselves. This entry exists so the Help dialog can say the key does
     * something, which is the whole reason that dialog is there. `useViewerShortcuts` matches
     * it and finds no command, which is a no-op: it does not swallow the press.
     */
    id: 'deleteSelection',
    group: 'Editing',
    label: 'Delete the selected state or comment',
    keys: 'Delete',
    aria: 'Delete Backspace',
    matches: (e) =>
      noCommandKeys(e) && !e.shiftKey && (e.key === 'Delete' || e.key === 'Backspace'),
  },
  {
    id: 'fit',
    group: 'View',
    label: 'Fit to window',
    keys: 'F',
    aria: 'F',
    matches: letter('f'),
  },
  {
    id: 'center',
    group: 'View',
    label: 'Center in window',
    keys: 'Shift+F',
    aria: 'Shift+F',
    matches: letter('f', true),
  },
  {
    id: 'grid',
    group: 'View',
    label: 'Toggle grid',
    keys: 'G',
    aria: 'G',
    matches: letter('g'),
  },
  {
    id: 'snapToGrid',
    group: 'Arrange',
    label: 'Toggle snap to grid',
    keys: 'Shift+G',
    aria: 'Shift+G',
    matches: letter('g', true),
  },
  {
    // Matched on the character rather than on Shift and the slash key, because where `?` lives
    // on a keyboard is a question about the layout somebody is typing on.
    id: 'help',
    group: 'Help',
    label: 'Keyboard shortcuts',
    keys: '?',
    aria: 'Shift+?',
    matches: (e) => noCommandKeys(e) && e.key === '?',
  },
];

const BY_ID = new Map(VIEWER_SHORTCUTS.map((shortcut) => [shortcut.id, shortcut]));

/** One shortcut by id, for the places that want a particular one's hint. */
export function viewerShortcut(id: ViewerShortcutId): ViewerShortcut {
  const found = BY_ID.get(id);
  // Every id in the union is in the list above, so this cannot happen; the union is the guard.
  if (!found) throw new Error(`Unknown viewer shortcut: ${id}`);
  return found;
}

/** How to write a shortcut's keys on this platform. */
export function shortcutKeys(id: ViewerShortcutId, mac = false): string {
  const shortcut = viewerShortcut(id);
  return mac ? (shortcut.macKeys ?? shortcut.keys) : shortcut.keys;
}

/**
 * Which shortcut a key press is, if it is one.
 *
 * The list is walked in order and the first match wins. Nothing in it overlaps: the plain
 * letters refuse a command key, the command ones require it, and the two shifted letters are
 * told from their unshifted neighbours by Shift itself.
 */
export function matchViewerShortcut(event: ShortcutEvent): ViewerShortcutId | null {
  for (const shortcut of VIEWER_SHORTCUTS) {
    if (shortcut.matches(event)) return shortcut.id;
  }
  return null;
}

/**
 * Whether a key press belongs to whatever the reader is typing in, rather than to the viewer.
 *
 * A state's name, a transition's symbol and a comment are all text somebody types into while
 * the viewer is on screen, and every letter shortcut above is a letter they might type. The
 * same goes for a control that answers keys itself: a menu, a dialog and a select all use
 * letters and Escape for their own navigation.
 *
 * Written as a list of what to keep out of rather than a list of what to act on, because the
 * failure is silent and one-sided: a shortcut that does not fire is noticed, and a shortcut
 * that fires while somebody is naming a state renames nothing and switches their tool.
 */
export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"], [role="dialog"], [role="menu"], [role="menubar"], [role="listbox"]',
    ),
  );
}
