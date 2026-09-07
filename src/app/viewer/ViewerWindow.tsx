'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ViewerActionsGate, ViewerActionsProvider } from '@/components/viewer/viewer-actions';
import { ViewerMenubar } from '@/components/viewer/ViewerMenubar';
import { viewerFileSrc } from '@/lib/viewer-link';
import type { ViewerProperties } from '@/lib/viewer-properties';
import { clearViewState, type ViewerViewport } from '@/lib/viewer-view-state';
import { showToast } from '@/lib/toast';
import {
  MAX_VIEWER_TABS,
  tabKey,
  VIEWER_ALIVE_KEY,
  VIEWER_CHANNEL,
  type ViewerTab,
} from '@/lib/viewer-tabs';
import {
  activeTab,
  applyDrop,
  closeTab,
  focusedTab,
  insertionIndexAt,
  isShowing,
  moveTabBefore,
  moveTabToPane,
  layoutToSearch,
  dropZone,
  focusPane,
  openTab,
  paneAtPoint,
  paneCount,
  paneOf,
  selectTab,
  splitTabToSide,
  tabToFocusAfterClosing,
  tabsInPane,
  type DropTarget,
  type PaneIndex,
  type ViewerLayout,
} from '@/lib/viewer-panes';
import { ViewerClient } from './ViewerClient';

/** How often the window says it is alive, so an opener can find it without a handle. */
const HEARTBEAT_MS = 2000;

/** What each pane is called, for the tab strips and anything that names a side. */
const PANE_NAMES = ['Left pane', 'Right pane'] as const;

/**
 * The drag's own media type.
 *
 * Checked in `dragover` so that dragging a file in from the desktop, or a selection out of the
 * page, does not paint a drop outline over a machine and promise something that will not
 * happen. The payload itself does not travel in the drag: browsers protect drag data until the
 * drop, so `dragover` can read the type list and nothing else, and what is being dragged has
 * to be remembered here instead.
 */
const TAB_DRAG_TYPE = 'application/x-afct-viewer-tab';

/**
 * Where the outline sits while a drop would land there.
 *
 * The same rectangle either way: a split shows the half the dragged machine would take, and a
 * move shows the pane it would land in, which is that same half.
 */
function outlineRectClass(target: DropTarget): string {
  const right = target.kind === 'split' ? target.side === 'right' : target.pane === 1;
  return right ? 'inset-y-0 left-1/2 w-1/2' : 'inset-y-0 left-0 w-1/2';
}

/**
 * Where a pane sits in the shared body.
 *
 * Absolute rather than a flex row because every viewer in the window is a sibling in one
 * container: see the body below for why that matters. A pane is a rectangle, not a box with
 * its own children.
 */
function paneRectClass(pane: PaneIndex, panes: 1 | 2): string {
  if (panes === 1) return 'inset-0';
  return pane === 0 ? 'inset-y-0 left-0 w-1/2' : 'inset-y-0 left-1/2 w-1/2';
}

/**
 * The standalone viewer window: strips of open files, one file showing per pane.
 *
 * The layout is state here and mirrored into the URL with `history.replaceState`, never a
 * router navigation. This route is a server component, so navigating would re-run its queries
 * on every tab click for data already in hand. The same reason `useReviewSelection` does it.
 *
 * Only a tab that has been looked at renders a viewer. That is what keeps the audit trail
 * honest: the bytes of a student's file are fetched when somebody looks at it, so ten open
 * tabs and a refresh do not write eleven disclosure records for work nobody read.
 */
export function ViewerWindow({
  initialLayout,
  initialProperties,
}: {
  initialLayout: ViewerLayout;
  /** Properties for the tabs the window opened with, loaded on the server. */
  initialProperties: Record<string, ViewerProperties | null>;
}) {
  // Unique per window, so the tab and panel ids below cannot collide with anything else on
  // the page and are stable across renders.
  const ids = useId();
  const tabId = (key: string) => `${ids}tab-${key}`;
  const panelId = (key: string) => `${ids}panel-${key}`;

  const [layout, setLayout] = useState(initialLayout);
  const [properties, setProperties] =
    useState<Record<string, ViewerProperties | null>>(initialProperties);
  /**
   * Which tabs have been looked at, and so are kept mounted.
   *
   * A tab that has been on screen stays in the tree, hidden, because unmounting it would take
   * its zoom, its arrangement and its undo history with it: switching away and back would
   * silently undo the reader's work on that machine. One that has never been opened is not
   * mounted at all, which is what keeps a window full of tabs from fetching a dozen students'
   * files, and the audit trail from recording a dozen views nobody made.
   */
  const [opened, setOpened] = useState<string[]>([]);
  /**
   * Whether the two halves share one camera.
   *
   * Off unless asked for: two machines that are not versions of each other rarely sit in the
   * same place, so moving one would drag the other somewhere useless. Comparing two attempts
   * at the same problem is the case it is for.
   */
  const [linkViews, setLinkViews] = useState(false);
  /** Where the pane that is driving is looking, for the other one to follow. */
  const [sharedViewport, setSharedViewport] = useState<ViewerViewport | null>(null);

  /**
   * The layout as it is right now, for a handler that must read it and act on what it finds.
   *
   * A `setLayout` updater cannot: it has to stay pure, and opening a tab that pushes the
   * window over its limit needs to raise a toast about what it closed.
   */
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  /** Put the keyboard on a tab button, wherever in the strips it now is. */
  const focusTab = (key: string) => {
    document.querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(key)}"]`)?.focus();
  };

  const panes = paneCount(layout);
  const focused = focusedTab(layout);
  // Both panes' tabs are on screen at once when the window is split, so both count as looked
  // at and both need their properties, not just whichever pane the menu bar is driving.
  const showing = useMemo(
    () => [activeTab(layout, 0), activeTab(layout, 1)].filter((tab) => tab !== null),
    [layout],
  );
  const showingKeys = showing.map(tabKey).join('|');

  /**
   * The order the machines are rendered in, which is not the order of the tabs.
   *
   * `opened` is append-only: a key joins it the first time its tab is looked at and never
   * moves. Rendering the body in that order means neither dragging a tab to the other side nor
   * dragging it along its own strip moves a single node in the DOM, so nothing is unmounted
   * and nothing inside a machine loses keyboard focus. The strips show the tab order; the body
   * shows whatever was mounted first, which nobody can see anyway.
   */
  const mountOrder = useMemo(() => {
    const keys = [...opened];
    for (const tab of showing) if (!keys.includes(tabKey(tab))) keys.push(tabKey(tab));
    return keys;
  }, [opened, showing]);

  useEffect(() => {
    if (!showingKeys) return;
    const keys = showingKeys.split('|');
    setOpened((current) => {
      const missing = keys.filter((key) => !current.includes(key));
      return missing.length ? [...current, ...missing] : current;
    });
  }, [showingKeys]);

  // The URL follows the layout, so a refresh restores this set and the link can be handed on.
  useEffect(() => {
    // Closing the last tab clears it rather than leaving it alone. The link still named the
    // file that was just closed, so a refresh reopened it, which also fetched a student's
    // work and recorded a view of it that nobody asked for.
    const search = layout.tabs.length === 0 ? '' : `?${layoutToSearch(layout)}`;
    window.history.replaceState(null, '', `${window.location.pathname}${search}`);
  }, [layout]);

  /**
   * Say the window is here.
   *
   * `localStorage` rather than the channel, for the reason `SessionWatcher` gives: an opener
   * has to answer "is a viewer already open" synchronously inside the click, before the
   * browser withdraws the gesture that lets it open a window at all. A message cannot be
   * waited for in that window of time; a stored timestamp can be read.
   */
  useEffect(() => {
    const beat = () => {
      try {
        window.localStorage.setItem(VIEWER_ALIVE_KEY, String(Date.now()));
      } catch {
        // Private browsing or blocked storage. The opener then just replaces this window,
        // which is the behaviour from before tabs existed.
      }
    };
    beat();
    const timer = window.setInterval(beat, HEARTBEAT_MS);
    const clear = () => {
      try {
        window.localStorage.removeItem(VIEWER_ALIVE_KEY);
      } catch {
        /* nothing to clear */
      }
    };
    window.addEventListener('pagehide', clear);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pagehide', clear);
      clear();
    };
  }, []);

  // A file sent from another window lands in the pane the menu bar is on, which is the one
  // the reader was last working in.
  const receiveTab = useCallback((next: ViewerTab) => {
    const before = layoutRef.current;
    const { layout: after, evicted } = openTab(before, next);
    setLayout(after);
    if (!evicted) return;

    // The window holds a fixed number of files, so opening one when it is full closes another.
    // That used to happen in silence: somebody came back to a strip with a file missing from
    // it and nothing to say where it had gone.
    //
    // The remembered view of the closed file is deliberately left in place, unlike closing a
    // tab by hand. Nobody asked for this one to go, so undoing brings it back as it was rather
    // than as a fresh copy of the file.
    showToast.warning(`Closed ${evicted.name} to make room`, {
      description: `The viewer holds ${MAX_VIEWER_TABS} files at once, and ${next.name} needed a place.`,
      action: {
        label: 'Undo',
        onClick: () => setLayout(before),
      },
    });
  }, []);

  useEffect(() => {
    if (typeof BroadcastChannel !== 'function') return;
    const channel = new BroadcastChannel(VIEWER_CHANNEL);
    channel.onmessage = (event: MessageEvent) => {
      const message = event.data as { type?: string; tab?: ViewerTab } | null;
      if (message?.type !== 'open-tab' || !message.tab) return;
      receiveTab(message.tab);
      // Bring the window forward, since the click that asked for this happened elsewhere.
      window.focus();
    };
    return () => channel.close();
  }, [receiveTab]);

  // Properties for a tab that arrived after the page was rendered, which the server never saw.
  useEffect(() => {
    const wanted = showing.filter((tab) => !(tabKey(tab) in properties));
    if (wanted.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const tab of wanted) {
        try {
          const res = await fetch(
            `/api/viewer/properties?kind=${encodeURIComponent(tab.kind)}&file=${encodeURIComponent(tab.file)}`,
          );
          const value = res.ok ? ((await res.json()) as ViewerProperties) : null;
          if (!cancelled) setProperties((p) => ({ ...p, [tabKey(tab)]: value }));
        } catch {
          if (!cancelled) setProperties((p) => ({ ...p, [tabKey(tab)]: null }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showing, properties]);

  /**
   * Focus the pane a click landed in.
   *
   * On the shared body rather than on a pane element, because there is no pane element: the
   * panes are rectangles over one container, so which one was clicked is arithmetic. Capture
   * phase, so a click that also does something inside the graph still moves focus first.
   */
  const bodyRef = useRef<HTMLDivElement | null>(null);
  /** The tab being dragged, since the drag itself will not carry it. */
  const draggingKey = useRef<string | null>(null);
  /** Where a drop would land right now, which is what the outline draws. */
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  /** Where a drop into a strip would put the tab, which is what the caret draws. */
  const [insertion, setInsertion] = useState<{ pane: PaneIndex; index: number; x: number } | null>(
    null,
  );
  const focusFromPoint = (clientX: number) => {
    const rect = bodyRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pane = paneAtPoint(clientX, rect, panes);
    if (pane !== null && pane !== layout.focused) setLayout((c) => focusPane(c, pane));
  };

  const dragProps = (tab: ViewerTab) => ({
    draggable: true,
    onDragStart: (event: React.DragEvent) => {
      draggingKey.current = tabKey(tab);
      // Firefox refuses to start a drag at all without this, and the type is what tells a
      // dragover that the thing overhead is one of ours. The value is never read.
      event.dataTransfer.setData(TAB_DRAG_TYPE, tabKey(tab));
      event.dataTransfer.effectAllowed = 'move';
    },
    // Fires for a drop outside the window and for Escape, neither of which fires `drop`. The
    // outline would otherwise stay painted over the machine.
    onDragEnd: () => {
      draggingKey.current = null;
      setDropTarget(null);
      setInsertion(null);
    },
  });

  /**
   * Dropping a tab into a strip, which both reorders it and decides which side it is on.
   *
   * The gap is worked out from where the tabs actually are, so it follows whatever the strip
   * has done with them: they truncate, and the strip scrolls when there are many.
   */
  const stripDragProps = (pane: PaneIndex) => ({
    onDragOver: (event: React.DragEvent<HTMLDivElement>) => {
      if (!draggingKey.current || !event.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
      // Without this the browser refuses the drop and `onDrop` never fires at all.
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const strip = event.currentTarget;
      const tabs = [...strip.querySelectorAll('[data-tab-key]')];
      const rects = tabs.map((tab) => tab.getBoundingClientRect());
      const index = insertionIndexAt(event.clientX, rects);
      if (index === null) {
        setInsertion(null);
        return;
      }
      // Against the leading edge of the tab it would sit in front of, or the trailing edge of
      // the last one. Relative to the strip's content, so it stays put when the strip scrolls.
      const stripRect = strip.getBoundingClientRect();
      const edge = rects[index]?.left ?? rects[rects.length - 1]?.right ?? stripRect.left;
      setInsertion({ pane, index, x: edge - stripRect.left + strip.scrollLeft });
      // A tab dropped into a strip lands in a strip, never as a split.
      setDropTarget(null);
    },
    onDragLeave: (event: React.DragEvent<HTMLDivElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setInsertion(null);
    },
    onDrop: (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const key = draggingKey.current;
      const at = insertion;
      draggingKey.current = null;
      setInsertion(null);
      setDropTarget(null);
      if (!key || !at) return;
      setLayout((current) => {
        const inPane = tabsInPane(current, at.pane).filter((tab) => tabKey(tab) !== key);
        const before = inPane[at.index] ?? null;
        return moveTabBefore(current, key, before ? tabKey(before) : null, at.pane);
      });
    },
  });

  const bodyDragProps = {
    onDragOver: (event: React.DragEvent) => {
      if (!draggingKey.current || !event.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
      // Without this the browser refuses the drop and `onDrop` never fires at all.
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const rect = bodyRef.current?.getBoundingClientRect();
      setDropTarget(rect ? dropZone(event.clientX, rect, panes) : null);
    },
    onDragLeave: (event: React.DragEvent) => {
      // Only when the pointer has left the body itself, not on the way between the elements
      // inside it, each of which fires this as it goes.
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setDropTarget(null);
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      const key = draggingKey.current;
      const target = dropTarget;
      draggingKey.current = null;
      setDropTarget(null);
      if (key && target) setLayout((current) => applyDrop(current, key, target));
    },
  };

  /**
   * The keyboard route to a split, and to moving a machine between the halves.
   *
   * Dragging a tab does the same thing. A feature reachable only by dragging is one a reader
   * using a keyboard, a screen reader or a touch screen cannot use at all, and this is
   * university software with two accessibility audits behind it.
   */
  const canMoveToOtherSide = Boolean(focused) && layout.tabs.length > 1;
  const moveToOtherSide = () => {
    if (!focused) return;
    const key = tabKey(focused);
    setLayout((current) =>
      paneCount(current) === 2
        ? moveTabToPane(current, key, current.focused === 0 ? 1 : 0)
        : splitTabToSide(current, key, 'right'),
    );
    // The tab is unmounted from one strip and mounted in the other, so without this the
    // keyboard lands back on the document and the reader has to find their place again.
    setFocusAfterMove(key);
  };

  /**
   * A tab to put keyboard focus on once the strips have been re-rendered.
   *
   * Used after a move, where the button is unmounted from one strip and mounted in the other,
   * and after a close, where it is removed outright. Either way focus would otherwise fall
   * back to the document and leave somebody navigating by keyboard at the top of the page.
   */
  const [focusAfterMove, setFocusAfterMove] = useState<string | null>(null);
  useEffect(() => {
    if (!focusAfterMove) return;
    focusTab(focusAfterMove);
    setFocusAfterMove(null);
  }, [focusAfterMove, layout]);

  /**
   * Arrow, Home and End move within one strip, as the tabs pattern expects.
   *
   * Focus only, not selection: each tab holds a whole machine, and stepping across four of
   * them to reach the fifth would build and throw away three graphs on the way. Enter or Space
   * on the button selects, which is what it already did.
   */
  const onTabKeyDown = (event: React.KeyboardEvent, pane: PaneIndex, key: string) => {
    const inPane = tabsInPane(layout, pane);
    const at = inPane.findIndex((tab) => tabKey(tab) === key);
    if (at < 0 || inPane.length === 0) return;
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = (at + 1) % inPane.length;
        break;
      case 'ArrowLeft':
        next = (at - 1 + inPane.length) % inPane.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = inPane.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = inPane[next];
    if (target) focusTab(tabKey(target));
  };

  // Linking is only meaningful with something to link to, and only the pane the reader is
  // working in drives: one direction at a time, so the two cannot chase each other.
  const canLinkViews = panes === 2;
  const linked = linkViews && canLinkViews;

  const close = (tab: ViewerTab) => {
    const key = tabKey(tab);
    // Worked out before the tab goes, since afterwards there is no place in the strip to
    // count from.
    const neighbour = tabToFocusAfterClosing(layout, key);
    setLayout((current) => closeTab(current, key));
    if (neighbour) setFocusAfterMove(neighbour);
    // Closing already unmounts it, since it leaves the tab list. This just keeps the list
    // from accumulating files nobody has open any more.
    setOpened((current) => current.filter((k) => k !== key));
    // Closing is how a reader discards an arrangement, so the remembered view goes with it
    // rather than reappearing if they open the file again.
    clearViewState(key);
  };

  if (!focused) {
    return (
      <main className="flex h-screen min-w-0 flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">
          No file is open. Choose one from a course and select Open in the viewer.
        </p>
      </main>
    );
  }

  return (
    <ViewerActionsProvider>
      <main className="flex h-screen min-w-0 flex-1 flex-col overflow-hidden">
        <ViewerMenubar
          downloadHref={`${viewerFileSrc(focused.kind, focused.file)}?download=1`}
          // Also on each pane's own toolbar, beside the file it describes. Both on purpose:
          // the menu is where somebody looks for it by convention, and the toolbar button is
          // the one-click way to it while reading a machine.
          properties={properties[tabKey(focused)] ?? null}
          onMoveToOtherSide={moveToOtherSide}
          canMoveToOtherSide={canMoveToOtherSide}
          linkViews={linkViews}
          canLinkViews={canLinkViews}
          onToggleLinkViews={() => setLinkViews((on) => !on)}
        />

        {/* Which half the menu bar acts on, for a reader who cannot see the marked strip.
            Only while the window is split, since with one pane there is nothing to say. */}
        <p role="status" className="sr-only">
          {panes === 2
            ? `The menu applies to the ${PANE_NAMES[layout.focused].toLowerCase()}.`
            : ''}
        </p>

        {/* One strip per pane, side by side. Tabs carry the white of the menu bar above and
            the grey of the toolbar below, so the selected one reads as the label of what is
            on screen, and the strip behind them is quieter than either. */}
        <div className="bg-card flex shrink-0">
          {(panes === 1 ? ([0] as const) : ([0, 1] as const)).map((pane) => (
            <div
              key={pane}
              className={cn(
                'relative flex min-w-0 items-end gap-1 overflow-x-auto px-3 pt-2',
                panes === 1 ? 'flex-1' : 'w-1/2',
                // The divider between the two halves, carried by the left strip so it lines
                // up with the one down the body below it.
                panes === 2 && pane === 0 && 'border-border border-r',
                // The same fill under every strip, split or not. It used to mark the half the
                // menus were not acting on, which made a strip's colour mean one thing in a
                // split window and nothing at all in a single one. The bar over the file the
                // menus act on says that instead, and says it the same way in both.
                'bg-muted/60',
              )}
              role="tablist"
              aria-label={panes === 1 ? 'Open files' : PANE_NAMES[pane]}
              {...stripDragProps(pane)}
            >
              {/* Where the tab would go. Drawn in the strip rather than between the tabs so
                  nothing moves under the pointer while the reader is aiming at a gap. */}
              {insertion?.pane === pane ? (
                <div
                  className="bg-primary pointer-events-none absolute bottom-0 z-10 w-0.5"
                  style={{ left: insertion.x, top: '0.5rem' }}
                  aria-hidden="true"
                  data-testid="viewer-tab-insertion"
                />
              ) : null}
              {tabsInPane(layout, pane).map((tab) => {
                const selected = isShowing(layout, tab);
                return (
                  <div
                    key={tabKey(tab)}
                    className={cn(
                      'relative flex max-w-56 shrink-0 items-center gap-1 rounded-t-md border pr-1',
                      selected
                        ? 'bg-background border-b-0'
                        : 'bg-card text-muted-foreground hover:bg-muted border-transparent',
                      // The file the menus are acting on. A bar along the top of it, the way an
                      // editor marks its active group. With two machines on screen it answers
                      // "which one does Reset mean", which is otherwise a guess; with one it is
                      // the same mark on the same thing rather than a decoration that appears
                      // out of nowhere when the window is split. Drawn rather than bordered so
                      // nothing shifts by a pixel when focus moves.
                      selected &&
                        pane === layout.focused &&
                        "after:bg-primary after:absolute after:inset-x-0 after:top-0 after:h-[3px] after:rounded-t-md after:content-['']",
                    )}
                  >
                    <button
                      type="button"
                      role="tab"
                      id={tabId(tabKey(tab))}
                      aria-selected={selected}
                      aria-controls={panelId(tabKey(tab))}
                      // Roving: one stop per strip in the Tab sequence, and the arrows move
                      // between them. Tabbing through a dozen open files to reach the toolbar
                      // is not navigation.
                      tabIndex={selected ? 0 : -1}
                      data-tab-key={tabKey(tab)}
                      {...dragProps(tab)}
                      onKeyDown={(event) => onTabKeyDown(event, pane, tabKey(tab))}
                      onClick={() => setLayout((current) => selectTab(current, tabKey(tab)))}
                      className="min-w-0 truncate px-3 py-1.5 text-sm font-semibold"
                      title={tab.title}
                    >
                      {tab.name}
                    </button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-5 w-5 shrink-0 p-0"
                      // In the Tab sequence only for the tab on screen, so tabbing out of a
                      // strip does not walk through a close button for every open file. The
                      // arrows reach the others, and their close buttons with them.
                      tabIndex={selected ? 0 : -1}
                      onClick={() => close(tab)}
                      aria-label={`Close ${tab.name}`}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/*
          One body holding every opened tab, not one body per pane.

          Two rules keep a machine's zoom, arrangement and undo history alive when it is moved
          from one side to the other. Every viewer is a direct sibling of every other, so no
          per-pane wrapper: a component that crosses parents is unmounted and rebuilt. And they
          are rendered in the window's own tab order, never grouped by pane, so a move changes
          nothing but a class and does not reorder the DOM, which would drop focus out of the
          graph a reader was using.

          Hidden with `visibility` rather than `display`, because a hidden box keeps its size:
          cytoscape reads the container to work out its viewport, and a collapsed one would
          come back at the wrong scale, which is the very thing this is preserving.
        */}
        <div
          className="relative min-h-0 flex-1"
          ref={bodyRef}
          onPointerDownCapture={(event) => focusFromPoint(event.clientX)}
          data-testid="viewer-body"
          {...bodyDragProps}
        >
          {mountOrder
            .map((key) => layout.tabs.find((tab) => tabKey(tab) === key))
            .filter((tab) => tab !== undefined)
            .map((tab) => {
              const pane = paneOf(layout, tabKey(tab));
              const visible = isShowing(layout, tab);
              return (
                <div
                  key={tabKey(tab)}
                  role="tabpanel"
                  id={panelId(tabKey(tab))}
                  aria-labelledby={tabId(tabKey(tab))}
                  className={cn('absolute', paneRectClass(pane, panes), !visible && 'invisible')}
                  // Out of the accessibility tree and out of the tab order while hidden, so a
                  // reader is not walked through a dozen machines they cannot see.
                  inert={!visible}
                >
                  {/* Only the pane the menu bar is on may publish its actions to it. */}
                  <ViewerActionsGate active={visible && pane === layout.focused}>
                    <ViewerClient
                      src={viewerFileSrc(tab.kind, tab.file)}
                      problemType={tab.type}
                      title={tab.title}
                      epsSymbol={tab.eps}
                      viewStateKey={tabKey(tab)}
                      // Each pane's own file, not the focused one's: in a split window the two
                      // panes are two different submissions, and one Properties button showing
                      // the other side's course is the worst kind of wrong.
                      properties={properties[tabKey(tab)] ?? null}
                      // One inspector and one tool palette, on the side being worked in. Two
                      // inspectors took a third of a split window between them for a panel the
                      // reader had finished with on one of the sides, and two palettes would be
                      // two answers to which machine a click draws on. The other pane keeps its
                      // selection: clicking back into it makes it the focused one, and its panel
                      // comes back as it was. Room, not permission: every pane here may edit,
                      // which is `capabilities` and is left at its default.
                      focused={visible && pane === layout.focused}
                      // Exactly one of these two, and only on a machine that is on screen: the
                      // pane being worked in reports where it is looking, and the other one
                      // follows. A hidden tab does neither, or it would come back showing a
                      // view of a machine nobody chose for it.
                      onViewportChange={
                        linked && visible && pane === layout.focused ? setSharedViewport : null
                      }
                      linkedViewport={
                        linked && visible && pane !== layout.focused ? sharedViewport : null
                      }
                    />
                  </ViewerActionsGate>
                </div>
              );
            })}

          {/* Two machines on two grids run into each other without something between them.
              A line down the middle rather than a gap, so neither pane loses any width, and
              over the canvases rather than beside them, since the panes are rectangles in one
              container and have no edges of their own to carry a border. */}
          {panes === 2 ? (
            <div
              className="bg-border pointer-events-none absolute inset-y-0 left-1/2 z-10 w-px -translate-x-1/2"
              aria-hidden="true"
            />
          ) : null}

          {/* Where the machine would land. `pointer-events: none` because it sits over the
              body it is reacting to, and would otherwise swallow the very dragover events
              that keep it in the right place. */}
          {dropTarget ? (
            <div
              className={cn(
                'border-primary bg-primary/10 pointer-events-none absolute z-20 rounded-md border-2 border-dashed',
                outlineRectClass(dropTarget),
              )}
              aria-hidden="true"
              data-testid="viewer-drop-outline"
            />
          ) : null}
        </div>
      </main>
    </ViewerActionsProvider>
  );
}
