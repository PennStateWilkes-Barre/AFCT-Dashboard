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
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from '@/components/ui/menubar';
import { useViewerActions } from '@/components/viewer/viewer-actions';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog';
import { VIEWER_DOCS_URL } from '@/lib/viewer-link';
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
  const { ready, grid, notes, snapToGrid, layout, canUndo, canRedo, run } = useViewerActions();

  return (
    <Menubar className="bg-card h-auto rounded-none border-x-0 border-t-0 px-2 py-1 shadow-none">
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
              {/* The same machine with the layout on screen, which after auto-arranging is
                  usually far more readable than the one that was submitted. A new file: the
                  submitted one is never altered. */}
              <MenubarItem disabled={!ready} onSelect={() => run('downloadCurrent')}>
                <FileDown aria-hidden="true" />
                Current view
              </MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSeparator />
          {/* Where the file came from, rather than what is in it. Disabled rather than hidden
              when there is nothing to show, so the menu does not change shape between files. */}
          <MenubarItem disabled={!properties} onSelect={() => setPropertiesOpen(true)}>
            <Info aria-hidden="true" />
            Properties
          </MenubarItem>
          <MenubarSeparator />
          <MenubarSub>
            <MenubarSubTrigger>
              <Share aria-hidden="true" />
              Export
            </MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem disabled={!ready} onSelect={() => run('downloadSVG')}>
                <FileCode2 aria-hidden="true" />
                SVG
              </MenubarItem>
              <MenubarItem disabled={!ready} onSelect={() => run('downloadPNG')}>
                <FileImage aria-hidden="true" />
                PNG
              </MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Edit</MenubarTrigger>
        <MenubarContent>
          {/* At the top of Edit, where every application puts them. They step back through
              changes to the arrangement: a state dragged, or the layout switched. Not zoom or
              pan, which move the camera rather than the machine. */}
          <MenubarItem disabled={!canUndo} onSelect={() => run('undo')}>
            <Undo2 aria-hidden="true" />
            Undo
          </MenubarItem>
          <MenubarItem disabled={!canRedo} onSelect={() => run('redo')}>
            <Redo2 aria-hidden="true" />
            Redo
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>View</MenubarTrigger>
        <MenubarContent>
          {/* First because it is the one people reach for most: after zooming or panning
              about, this is how you get the whole machine back on screen. */}
          {/* The same icon the toolbar's Fit button uses. One action, one icon, wherever it
              is offered from. */}
          <MenubarItem disabled={!ready} onSelect={() => run('fitToWindow')}>
            <Scan aria-hidden="true" />
            Fit to window
          </MenubarItem>
          {/* Under Fit, for the reader who has zoomed in on a corner and lost the machine
              rather than wanting the whole of it back: this moves the camera and leaves the
              scale alone. */}
          <MenubarItem disabled={!ready} onSelect={() => run('centerInWindow')}>
            <Crosshair aria-hidden="true" />
            Center in window
          </MenubarItem>
          <MenubarSeparator />
          {/* A checkbox item rather than a plain one, so the menu says what the grid is
              doing now rather than only what selecting it would do. It drives the same state
              as the Grid button in the viewer's own toolbar, so the two never disagree. */}
          <MenubarCheckboxItem
            checked={grid}
            disabled={!ready}
            onCheckedChange={() => run('toggleGrid')}
          >
            Grid
          </MenubarCheckboxItem>
          {/* On by default: a note is the author's own words, part of the answer rather than
              decoration. Off is for a busy machine where they cover the states. They are only
              drawn in the "As drawn" layout, so this does nothing once auto-arranged. */}
          <MenubarCheckboxItem
            checked={notes}
            disabled={!ready}
            onCheckedChange={() => run('toggleNotes')}
          >
            JFLAP Notes
          </MenubarCheckboxItem>
          {/* Snap to grid is not here. It changes where the states go rather than what the
              reader can see, so it sits under Layout with the rest of the arrangement. The
              grid's visibility stays here, which is the other half of the same pair: one is
              about looking, one is about moving. */}
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
                Move to other side
              </MenubarItem>
            </>
          ) : null}
          {onToggleLinkViews ? (
            // Greyed rather than hidden while there is only one machine on screen: an item
            // that comes and goes reads as a bug, a greyed one reads as "not yet".
            <MenubarCheckboxItem
              checked={linkViews}
              disabled={!canLinkViews}
              onCheckedChange={onToggleLinkViews}
            >
              Link the two views
            </MenubarCheckboxItem>
          ) : null}
        </MenubarContent>
      </MenubarMenu>

      {/*
        Where the states go, as against how they are looked at.

        View answers "what can I see and from how far away"; this answers "where is everything".
        The two were one menu, and Snap to grid sitting under the grid's own visibility was the
        seam: they share a word and nothing else. This is also where aligning and distributing
        a selection will go, which is the reason to separate them now rather than when there are
        six more items to move.
      */}
      <MenubarMenu>
        <MenubarTrigger>Layout</MenubarTrigger>
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
          {/* Off by default: a machine arrives with the positions its author chose, and quietly
              moving every state the first time one is nudged would be a change nobody asked
              for. */}
          <MenubarCheckboxItem
            checked={snapToGrid}
            disabled={!ready}
            onCheckedChange={() => run('toggleSnapToGrid')}
          >
            Snap to grid
          </MenubarCheckboxItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Machine</MenubarTrigger>
        <MenubarContent>
          {/* What the machine is, and what leaves the viewer as a picture of it. Where its
              states sit is Layout's, above. "Machine" rather than "Automata" because the code
              and the text representation already call it that, and because it is one machine. */}
          {/* Format icons, matching File > Export, so the same format carries the same icon
              wherever it appears. Two identical Copy icons would say only "these are both
              copies", which the labels already say. */}
          <MenubarItem disabled={!ready} onSelect={() => run('copyPNG')}>
            <FileImage aria-hidden="true" />
            Copy as PNG
          </MenubarItem>
          {/* Pastes as vector art, so it stays sharp in a slide or a printed handout, where
              the PNG above does not. */}
          <MenubarItem disabled={!ready} onSelect={() => run('copySVG')}>
            <FileCode2 aria-hidden="true" />
            Copy as SVG
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem disabled={!ready} onSelect={() => setResetOpen(true)}>
            <RotateCcw aria-hidden="true" />
            Reset machine
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Help</MenubarTrigger>
        <MenubarContent>
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

      {properties ? (
        <Dialog open={propertiesOpen} onOpenChange={setPropertiesOpen}>
          <DialogContent className="max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Properties</DialogTitle>
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

      {/* Confirmed rather than immediate: a reader can spend a while pulling a crowded
          machine apart, and there is no undo once the history has gone with it. */}
      <ConfirmDialog
        open={resetOpen}
        title="Reset this machine?"
        description="The states go back where the file has them, and the layout, the zoom and the undo history for this machine are forgotten. The other open files are not affected, and the submitted file is not changed."
        confirmText="Reset machine"
        onConfirm={() => {
          run('resetMachine');
          setResetOpen(false);
        }}
        onCancel={() => setResetOpen(false)}
      />
    </Menubar>
  );
}
