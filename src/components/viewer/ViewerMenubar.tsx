'use client';

import { Fragment, useState } from 'react';

import {
  Download,
  FileDown,
  FileImage,
  FileCode2,
  Crosshair,
  Scan,
  ListTree,
  BookOpen,
  Info,
  Keyboard,
  Share,
  Undo2,
  Redo2,
  RotateCcw,
  Columns2,
} from 'lucide-react';
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from '@/components/ui/menubar';
import { useViewerActions } from '@/components/viewer/viewer-actions';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog';
import { VIEWER_DOCS_URL } from '@/lib/viewer-link';
import { viewerShortcut, shortcutKeys, type ViewerShortcutId } from '@/lib/viewer-shortcuts';
import { useViewerShortcuts } from './useViewerShortcuts';
import { ViewerShortcutsDialog, useMacKeys } from './ViewerShortcutsDialog';
import type { ViewerProperties } from '@/lib/viewer-properties';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * The standalone window's menu bar.
 *
 * `bg-card` rather than the component's default `bg-background`: this app's light background
 * token is a light blue-grey (#E7EBF0), which reads as a disabled strip across the top of a
 * window. A menu bar is expected to be the same colour as the thing it belongs to, so it takes
 * the white card surface and separates itself with the border underneath instead.
 *
 * A menu rather than a row of buttons because this window will accumulate commands that are
 * used rarely and need to be found by reading rather than recognised by icon. One menu today;
 * the shape is what makes adding the next one uneventful.
 */
export function ViewerMenubar({
  downloadHref,
  properties,
  onMoveToOtherSide,
  canMoveToOtherSide = false,
  linkViews = false,
  onToggleLinkViews,
  canLinkViews = false,
}: {
  downloadHref: string;
  /** Null when the file is unknown or not this reader's to see. */
  properties?: ViewerProperties | null;
  /**
   * Put the file on screen on the other side of the window, splitting it if it is not split.
   *
   * A window concern rather than a viewer one, so it arrives as a prop rather than through the
   * actions registry: the machine knows nothing about how many panes there are.
   *
   * This is also the keyboard route to a split. Dragging a tab does the same thing, and a
   * feature reachable only by dragging is not one everybody can use.
   */
  onMoveToOtherSide?: () => void;
  canMoveToOtherSide?: boolean;
  /**
   * Whether the two halves share one camera, and how to change that.
   *
   * A window concern like the move above, so it arrives as a prop: a machine knows nothing
   * about the other one. Off unless asked for, because two unrelated machines rarely sit in
   * the same place, and moving one would drag the other somewhere useless.
   */
  linkViews?: boolean;
  onToggleLinkViews?: () => void;
  canLinkViews?: boolean;
}) {
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  // False for a grammar or a regular expression, which have nothing to export: those viewers
  // register no actions, so the items disable themselves rather than being hidden. A missing
  // menu item reads as a bug; a greyed one reads as "not for this kind of file".
  const { ready, grid, notes, snapToGrid, layout, canUndo, canRedo, tools, run } =
    useViewerActions();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /**
   * The window's one keyboard listener, here because this is the chrome: rendered once, and
   * already reaching the focused pane through the same registry the menu items use.
   */
  useViewerShortcuts({ run, tools, canUndo, canRedo, onHelp: () => setShortcutsOpen(true) });
  const mac = useMacKeys();
  /**
   * The hint beside a menu item, from the same definition the handler matches against.
   *
   * Hidden from the accessibility tree: a screen reader reading "Grid G" is worse than one
   * reading "Grid", and `aria-keyshortcuts` on the item says the key properly.
   */
  const hint = (id: ViewerShortcutId) => (
    <MenubarShortcut aria-hidden="true">{shortcutKeys(id, mac)}</MenubarShortcut>
  );

  return (
    <Menubar className="bg-card h-auto rounded-none border-x-0 border-t-0 px-2 py-1 shadow-none">
      {/* The nouns here say "automaton", because that is what this window is nearly always
          showing. A grammar and a regular expression open in it too, and their graph actions
          disable themselves rather than being relabelled; making the words follow the content
          type is worth doing when those can be edited, and not before. */}
      <MenubarMenu>
        <MenubarTrigger>File</MenubarTrigger>
        <MenubarContent>
          <MenubarSub>
            <MenubarSubTrigger>
              <Download aria-hidden="true" />
              Download
            </MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem asChild>
                {/* The file exactly as it was submitted, from the same route the viewer
                    reads, which records it as a download rather than a view. */}
                <a href={downloadHref} download>
                  <Download aria-hidden="true" />
                  Original file
                </a>
              </MenubarItem>
              {/* The automaton with the arrangement on screen, written to a new file: the
                  submitted one is never altered. Named for what it writes out, since the two
                  image exports below are the ones that save a picture. */}
              <MenubarItem disabled={!ready} onSelect={() => run('downloadCurrent')}>
                <FileDown aria-hidden="true" />
                Current automaton
              </MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          {/* Under Download: the two are the same question with different answers, the file or
              a picture of it. */}
          <MenubarSub>
            <MenubarSubTrigger>
              <Share aria-hidden="true" />
              Export image
            </MenubarSubTrigger>
            <MenubarSubContent>
              {/* The common raster format first. */}
              <MenubarItem disabled={!ready} onSelect={() => run('downloadPNG')}>
                <FileImage aria-hidden="true" />
                PNG
              </MenubarItem>
              <MenubarItem disabled={!ready} onSelect={() => run('downloadSVG')}>
                <FileCode2 aria-hidden="true" />
                SVG
              </MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSeparator />
          {/* Where the file came from, rather than what is in it. Named "File properties"
              because this viewer also has properties panels for a state and for a transition.
              Disabled rather than hidden when there is nothing to show, so the menu does not
              change shape between files. */}
          <MenubarItem disabled={!properties} onSelect={() => setPropertiesOpen(true)}>
            <Info aria-hidden="true" />
            File properties
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Edit</MenubarTrigger>
        <MenubarContent>
          {/* At the top of Edit, where every application puts them. They step back through
              changes to the arrangement: a state dragged, or the layout switched. Not zoom or
              pan, which move the camera rather than the machine. */}
          <MenubarItem
            disabled={!canUndo}
            onSelect={() => run('undo')}
            aria-keyshortcuts={viewerShortcut('undo').aria}
          >
            <Undo2 aria-hidden="true" />
            Undo
            {hint('undo')}
          </MenubarItem>
          <MenubarItem
            disabled={!canRedo}
            onSelect={() => run('redo')}
            aria-keyshortcuts={viewerShortcut('redo').aria}
          >
            <Redo2 aria-hidden="true" />
            Redo
            {hint('redo')}
          </MenubarItem>
          <MenubarSeparator />
          {/* Under Edit with the clipboard. What these copy is a picture of the automaton
              rather than a selection, which is what the labels say. Format icons, matching
              File's Export image, so a format carries the same icon wherever it appears. */}
          <MenubarItem disabled={!ready} onSelect={() => run('copyPNG')}>
            <FileImage aria-hidden="true" />
            Copy as PNG
          </MenubarItem>
          {/* Vector art, which stays sharp at any size where the PNG above does not. */}
          <MenubarItem disabled={!ready} onSelect={() => run('copySVG')}>
            <FileCode2 aria-hidden="true" />
            Copy as SVG
          </MenubarItem>
          <MenubarSeparator />
          {/* The far end of Undo: it takes back everything the reader has done at once. The
              ellipsis says a question comes first. */}
          <MenubarItem disabled={!ready} onSelect={() => setResetOpen(true)}>
            <RotateCcw aria-hidden="true" />
            Reset automaton...
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>View</MenubarTrigger>
        <MenubarContent>
          {/* How to get the whole automaton back on screen after zooming or panning about.
              The same icon the toolbar's Fit button uses: one action, one icon, wherever it is
              offered from. */}
          <MenubarItem
            disabled={!ready}
            onSelect={() => run('fitToWindow')}
            aria-keyshortcuts={viewerShortcut('fit').aria}
          >
            <Scan aria-hidden="true" />
            Fit to window
            {hint('fit')}
          </MenubarItem>
          {/* Under Fit, and different from it: this moves the camera and leaves the scale
              alone. */}
          <MenubarItem
            disabled={!ready}
            onSelect={() => run('centerInWindow')}
            aria-keyshortcuts={viewerShortcut('center').aria}
          >
            <Crosshair aria-hidden="true" />
            Center in window
            {hint('center')}
          </MenubarItem>
          <MenubarSeparator />
          {/* A checkbox item rather than a plain one, so the menu says what the grid is
              doing now rather than only what selecting it would do. It drives the same state
              as the Grid button in the viewer's own toolbar, so the two never disagree. */}
          <MenubarCheckboxItem
            checked={grid}
            disabled={!ready}
            onCheckedChange={() => run('toggleGrid')}
            aria-keyshortcuts={viewerShortcut('grid').aria}
          >
            Grid
            {hint('grid')}
          </MenubarCheckboxItem>
          {/* On by default: a note is the author's own words, part of the answer rather than
              decoration. Only drawn in the "As drawn" arrangement, so this does nothing once
              auto-arranged. */}
          <MenubarCheckboxItem
            checked={notes}
            disabled={!ready}
            onCheckedChange={() => run('toggleNotes')}
          >
            JFLAP notes
          </MenubarCheckboxItem>
          {/* Snap to grid is not here: it changes where the states go rather than what can be
              seen, so it sits under Arrange. The grid's visibility stays here, which is the
              other half of the same pair. */}
          <MenubarSeparator />
          {/* The same content the dialog viewers show in a panel under the graph. Here it
              opens in a window, so the graph keeps the full height of the screen. */}
          <MenubarItem disabled={!ready} onSelect={() => run('showTextRepresentation')}>
            <ListTree aria-hidden="true" />
            Text representation
          </MenubarItem>
          {onMoveToOtherSide ? (
            <>
              <MenubarSeparator />
              <MenubarItem disabled={!canMoveToOtherSide} onSelect={onMoveToOtherSide}>
                <Columns2 aria-hidden="true" />
                Move to other pane
              </MenubarItem>
            </>
          ) : null}
          {onToggleLinkViews ? (
            // Greyed rather than hidden while there is only one automaton on screen: an item
            // that comes and goes reads as a bug, a greyed one reads as "not yet".
            <MenubarCheckboxItem
              checked={linkViews}
              disabled={!canLinkViews}
              onCheckedChange={onToggleLinkViews}
            >
              Link views
            </MenubarCheckboxItem>
          ) : null}
        </MenubarContent>
      </MenubarMenu>

      {/*
        Where the states go, as against how they are looked at.

        View answers "what can I see and from how far away"; this answers "where is everything".
        The two were one menu, and Snap to grid sitting under the grid's own visibility was the
        seam: they share a word and nothing else. "Arrange" rather than "Layout" because a
        layout is the thing you end up with and arranging is what these do, and because it is
        the word an aligning and distributing pair will want above them.
      */}
      <MenubarMenu>
        <MenubarTrigger>Arrange</MenubarTrigger>
        <MenubarContent>
          {/* The arrangement itself: the author's own positions, or the engine's. Flattened
              rather than kept behind a submenu, since it is the first thing this menu is
              about. */}
          <MenubarRadioGroup
            value={layout}
            onValueChange={(next) => run(next === 'as-drawn' ? 'setAsDrawn' : 'setAutoArranged')}
          >
            <MenubarRadioItem value="as-drawn" disabled={!ready}>
              As drawn
            </MenubarRadioItem>
            <MenubarRadioItem value="auto" disabled={!ready}>
              Auto-arranged
            </MenubarRadioItem>
          </MenubarRadioGroup>
          <MenubarSeparator />
          {/* Off by default: an automaton arrives with the positions its author chose, and
              quietly moving every state the first time one is nudged would be a change nobody
              asked for. */}
          <MenubarCheckboxItem
            checked={snapToGrid}
            disabled={!ready}
            onCheckedChange={() => run('toggleSnapToGrid')}
            aria-keyshortcuts={viewerShortcut('snapToGrid').aria}
          >
            Snap to grid
            {hint('snapToGrid')}
          </MenubarCheckboxItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Help</MenubarTrigger>
        <MenubarContent>
          {/* The same dialog `?` opens: one piece of state, two ways to it. */}
          <MenubarItem
            onSelect={() => setShortcutsOpen(true)}
            aria-keyshortcuts={viewerShortcut('help').aria}
          >
            <Keyboard aria-hidden="true" />
            Keyboard shortcuts
            {hint('help')}
          </MenubarItem>
          <MenubarSeparator />
          {/* A plain link, so it behaves like one: middle-click, copy the address, open in a
              background tab. `noopener` because it leaves the application. */}
          <MenubarItem asChild>
            <a href={VIEWER_DOCS_URL} target="_blank" rel="noopener noreferrer">
              <BookOpen aria-hidden="true" />
              Documentation
            </a>
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <ViewerShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />

      {properties ? (
        <Dialog open={propertiesOpen} onOpenChange={setPropertiesOpen}>
          <DialogContent className="max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>File properties</DialogTitle>
              <DialogDescription>Where this file came from.</DialogDescription>
            </DialogHeader>
            <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
              {properties.rows.map((row) => (
                <Fragment key={row.label}>
                  <dt className="text-muted-foreground">{row.label}</dt>
                  <dd className="break-words">{row.value}</dd>
                </Fragment>
              ))}
            </dl>
          </DialogContent>
        </Dialog>
      ) : null}

      {/* Confirmed rather than immediate, and the description is a list rather than a phrase:
          this now throws away drawn states and transitions as well as an arrangement, and the
          undo history goes with them, so there is nothing to step back to afterwards.

          Checked against `resetMachine`, which clears the renames, the initial and final marks,
          the transition edits, the drawn states and transitions, the deletions, the arrangement
          choice, the remembered view and the history, and then re-reads the file. It does NOT
          touch Snap to grid or what the grid and the notes are showing, so this does not say
          it does. */}
      <ConfirmDialog
        open={resetOpen}
        title="Reset this automaton?"
        description="This discards every change you have made here: states and transitions you added, renamed, re-marked, re-worded or deleted, and where everything sits. The arrangement choice, the zoom and the undo history go with them. The submitted file is not changed, and the other open files are not affected."
        confirmText="Reset automaton"
        onConfirm={() => {
          // The action keeps its own name. What it does has not changed; what it is called on
          // screen has.
          run('resetMachine');
          setResetOpen(false);
        }}
        onCancel={() => setResetOpen(false)}
      />
    </Menubar>
  );
}
