/** @vitest-environment jsdom */

import React from 'react';
import { render, screen, fireEvent, act, within, createEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { tabKey, VIEWER_ALIVE_KEY, VIEWER_CHANNEL, type ViewerTab } from '@/lib/viewer-tabs';

/** How many times a viewer for each file has been built, so a remount is visible. */
const mounts = new Map<string, number>();

// The viewer itself is exercised by its own tests; here it only has to say which file it was
// given, so switching tabs can be seen to switch machines, and count its own mounts, which is
// how "the zoom survived" is checked without a layout engine to zoom.
vi.mock('./ViewerClient', () => ({
  ViewerClient: ({
    src,
    properties,
    focused,
    onViewportChange,
    linkedViewport,
  }: {
    src: string;
    properties?: { rows: { label: string; value: string }[] } | null;
    focused?: boolean;
    onViewportChange?: ((v: { zoom: number; pan: { x: number; y: number } }) => void) | null;
    linkedViewport?: { zoom: number; pan: { x: number; y: number } } | null;
  }) => {
    React.useEffect(() => {
      mounts.set(src, (mounts.get(src) ?? 0) + 1);
    }, [src]);
    return (
      <div
        data-testid="viewer"
        data-src={src}
        // What its own toolbar's Properties button would show, which is this pane's file.
        data-properties={properties?.rows[0]?.value ?? ''}
        // Which end of a link this machine is on, and what it has been told to follow.
        data-role={onViewportChange ? 'driving' : linkedViewport ? 'following' : 'alone'}
        // Whether this is the pane being worked in, which is what decides whether its
        // properties panel and its tool palette have room.
        data-inspector={focused ? 'shown' : 'hidden'}
        data-following={linkedViewport ? JSON.stringify(linkedViewport) : ''}
      >
        <button
          type="button"
          onClick={() => onViewportChange?.({ zoom: 2.5, pan: { x: -30, y: 12 } })}
        >
          {`report ${src}`}
        </button>
      </div>
    );
  },
}));
vi.mock('@/lib/toast', () => ({
  showToast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock('@/components/viewer/ViewerMenubar', () => ({
  ViewerMenubar: ({
    downloadHref,
    properties,
    onMoveToOtherSide,
    canMoveToOtherSide,
    linkViews,
    onToggleLinkViews,
    canLinkViews,
  }: {
    downloadHref: string;
    properties?: { rows: { label: string; value: string }[] } | null;
    onMoveToOtherSide?: () => void;
    canMoveToOtherSide?: boolean;
    linkViews?: boolean;
    onToggleLinkViews?: () => void;
    canLinkViews?: boolean;
  }) => (
    <div
      data-testid="menubar"
      data-download={downloadHref}
      data-properties={properties?.rows[0]?.value ?? ''}
    >
      <button type="button" disabled={!canMoveToOtherSide} onClick={onMoveToOtherSide}>
        Move to other side
      </button>
      <button
        type="button"
        disabled={!canLinkViews}
        aria-pressed={linkViews}
        onClick={onToggleLinkViews}
      >
        Link the two views
      </button>
    </div>
  ),
}));

import { MAX_VIEWER_TABS } from '@/lib/viewer-tabs';
import { showToast } from '@/lib/toast';
import type { ViewerLayout } from '@/lib/viewer-panes';
import { ViewerWindow } from './ViewerWindow';

/**
 * jsdom does not implement BroadcastChannel, so the handshake is unreachable without one.
 * A stub that delivers to the other open channels of the same name is enough: what is being
 * tested is that the window listens and appends, not the browser's delivery.
 */
class TestChannel {
  static open: TestChannel[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(public name: string) {
    TestChannel.open.push(this);
  }
  postMessage(data: unknown) {
    for (const other of TestChannel.open) {
      if (other !== this && other.name === this.name) {
        other.onmessage?.({ data } as MessageEvent);
      }
    }
  }
  close() {
    TestChannel.open = TestChannel.open.filter((c) => c !== this);
  }
}

const tab = (file: string, name = file): ViewerTab => ({
  kind: 'submissions',
  file,
  type: 'FA',
  name,
  title: `${name} heading`,
});

/** The file the reader is actually looking at: the one viewer that is not hidden. */
const showing = () => {
  const visible = screen
    .getAllByTestId('viewer')
    .filter((v) => !v.closest('[inert]'))
    .map((v) => v.getAttribute('data-src'));
  expect(visible).toHaveLength(1);
  return visible[0];
};

/** A window opened on these files, all in one pane, showing the one at `active`. */
const renderWindow = (
  tabs: ViewerTab[],
  active = 0,
  properties: Record<string, { rows: { label: string; value: string }[] } | null> = {},
) => {
  const layout: ViewerLayout = {
    tabs,
    panes: {},
    active: [tabs[active] ? tabKey(tabs[active]!) : null, null],
    focused: 0,
  };
  return render(<ViewerWindow initialLayout={layout} initialProperties={properties} />);
};

beforeEach(() => {
  // Shared across the file, so a test asserting something was NOT raised needs a clean count.
  vi.mocked(showToast.warning).mockClear();
  mounts.clear();
  TestChannel.open = [];
  vi.stubGlobal('BroadcastChannel', TestChannel);
  // The properties fetch for a tab the server never saw. Not what these tests are about.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the tab strip', () => {
  it('shows one tab per open file, with the active one selected', () => {
    renderWindow([tab('a.jff'), tab('b.jff')], 1);
    const strip = screen.getAllByRole('tab');
    expect(strip.map((t) => t.textContent)).toEqual(['a.jff', 'b.jff']);
    expect(strip[1].getAttribute('aria-selected')).toBe('true');
    expect(showing()).toContain('b.jff');
  });

  it('switches the machine on screen when another tab is chosen', () => {
    renderWindow([tab('a.jff'), tab('b.jff')]);
    expect(showing()).toContain('a.jff');
    fireEvent.click(screen.getAllByRole('tab')[1]);
    expect(showing()).toContain('b.jff');
  });

  it('closes a tab and keeps a neighbour showing', () => {
    renderWindow([tab('a.jff'), tab('b.jff')], 1);
    fireEvent.click(screen.getByLabelText('Close b.jff'));
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['a.jff']);
    expect(showing()).toContain('a.jff');
  });

  it('clears the link when the last tab is closed', () => {
    // It still named the file that was just closed, so a refresh reopened it: a student's
    // work fetched, and a view of it recorded, that nobody asked for.
    renderWindow([tab('a.jff')]);
    expect(window.location.search).toContain('a.jff');

    fireEvent.click(screen.getByLabelText('Close a.jff'));
    expect(window.location.search).toBe('');
  });

  it('says so plainly when the last tab is closed', () => {
    renderWindow([tab('a.jff')]);
    fireEvent.click(screen.getByLabelText('Close a.jff'));
    expect(screen.queryByTestId('viewer')).toBeNull();
    expect(screen.getByText(/No file is open/i)).toBeTruthy();
  });

  it('keeps the URL in step, so a refresh restores the same set', () => {
    renderWindow([tab('a.jff'), tab('b.jff')]);
    fireEvent.click(screen.getAllByRole('tab')[1]);
    const search = new URLSearchParams(window.location.search);
    // One active tab per pane, so the second half is the empty right pane.
    expect(search.get('active')).toBe('1,-1');
    expect(search.get('tabs')).toContain('b.jff');
  });
});

describe('a file sent from another window', () => {
  const send = (t: ViewerTab) => {
    const opener = new TestChannel(VIEWER_CHANNEL);
    act(() => {
      opener.postMessage({ type: 'open-tab', tab: t });
    });
    opener.close();
  };

  it('opens as a new tab and comes to the front', () => {
    renderWindow([tab('a.jff')]);
    send(tab('b.jff'));
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['a.jff', 'b.jff']);
    expect(showing()).toContain('b.jff');
  });

  it('selects the tab it already has rather than opening a second one', () => {
    renderWindow([tab('a.jff'), tab('b.jff')], 1);
    send(tab('a.jff'));
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(showing()).toContain('a.jff');
  });

  it('ignores a message that is not asking for a tab', () => {
    renderWindow([tab('a.jff')]);
    const opener = new TestChannel(VIEWER_CHANNEL);
    act(() => {
      opener.postMessage({ type: 'something-else', tab: tab('b.jff') });
      opener.postMessage({ type: 'open-tab' });
    });
    opener.close();
    expect(screen.getAllByRole('tab')).toHaveLength(1);
  });
});

describe('what a tab keeps while another one is on screen', () => {
  it('does not rebuild a machine that is switched away from and back to', () => {
    // The bug this fixes: the viewer was keyed on the active file, so every tab click threw
    // the graph away and built a new one. Zoom, the arrangement and the undo history went
    // with it, which looked like the zoom resetting itself.
    renderWindow([tab('a.jff'), tab('b.jff')]);
    const first = screen.getByTestId('viewer').getAttribute('data-src');

    fireEvent.click(screen.getAllByRole('tab')[1]);
    fireEvent.click(screen.getAllByRole('tab')[0]);

    expect(mounts.get(first!)).toBe(1);
  });

  it('holds the tab it left behind in the page, hidden rather than removed', () => {
    renderWindow([tab('a.jff'), tab('b.jff')]);
    fireEvent.click(screen.getAllByRole('tab')[1]);

    const viewers = screen.getAllByTestId('viewer');
    expect(viewers).toHaveLength(2);
    // Hidden ones are out of the accessibility tree and the tab order, so a reader is not
    // walked through machines nobody can see.
    expect(viewers.filter((v) => v.closest('[inert]'))).toHaveLength(1);
  });

  it('does not build a tab nobody has opened yet', () => {
    // What keeps a window of tabs from fetching a dozen students' files, and the audit trail
    // from recording a dozen views nobody made.
    renderWindow([tab('a.jff'), tab('b.jff'), tab('c.jff')]);
    expect(screen.getAllByTestId('viewer')).toHaveLength(1);
    expect(mounts.has('/api/files/submissions/c.jff')).toBe(false);
  });

  it('throws away the remembered view when a tab is closed', () => {
    // Closing is how a reader discards an arrangement. Leaving it in storage would bring it
    // back the next time the same file was opened, which nobody asked for.
    window.sessionStorage.setItem('afct.viewer.view.submissions:b.jff', '{"v":1}');
    renderWindow([tab('a.jff'), tab('b.jff')]);
    fireEvent.click(screen.getByLabelText('Close b.jff'));
    expect(window.sessionStorage.getItem('afct.viewer.view.submissions:b.jff')).toBeNull();
  });

  it('starts clean when a closed file is opened again', () => {
    // Closing a tab is the way to discard an arrangement, so re-opening the same file must
    // build a new graph rather than appear to remember one that has gone.
    renderWindow([tab('a.jff'), tab('b.jff')]);
    fireEvent.click(screen.getAllByRole('tab')[1]);
    expect(mounts.get('/api/files/submissions/b.jff')).toBe(1);

    fireEvent.click(screen.getByLabelText('Close b.jff'));
    const opener = new TestChannel(VIEWER_CHANNEL);
    act(() => opener.postMessage({ type: 'open-tab', tab: tab('b.jff') }));
    opener.close();

    expect(mounts.get('/api/files/submissions/b.jff')).toBe(2);
  });
});

describe('the menu bar belongs to the tab on screen', () => {
  // Two of the menu's entries do not go through the viewer at all: the Download link and the
  // Properties dialog are handed down from here. They have to follow the selected tab like
  // everything else, or a reader downloads one student's file while looking at another's.

  it('offers the showing tab as the download, marked as a download', () => {
    renderWindow([tab('a.jff'), tab('b.jff')]);
    expect(screen.getByTestId('menubar').getAttribute('data-download')).toBe(
      '/api/files/submissions/a.jff?download=1',
    );

    fireEvent.click(screen.getAllByRole('tab')[1]);
    expect(screen.getByTestId('menubar').getAttribute('data-download')).toBe(
      '/api/files/submissions/b.jff?download=1',
    );
  });

  it("hands the menu bar the showing tab's properties", () => {
    renderWindow([tab('a.jff'), tab('b.jff')], 0, {
      'submissions:a.jff': { rows: [{ label: 'Student', value: 'Ada' }] },
      'submissions:b.jff': { rows: [{ label: 'Student', value: 'Grace' }] },
    });
    expect(screen.getByTestId('menubar').getAttribute('data-properties')).toBe('Ada');

    fireEvent.click(screen.getAllByRole('tab')[1]);
    expect(screen.getByTestId('menubar').getAttribute('data-properties')).toBe('Grace');
  });

  /**
   * The pane's own toolbar button asks the same question of a different file. The menu bar
   * follows whichever tab is on screen; a pane describes the file in it, and in a split window
   * those are two different submissions at once.
   */
  it("gives each pane its own file's properties", () => {
    renderWindow([tab('a.jff'), tab('b.jff')], 0, {
      'submissions:a.jff': { rows: [{ label: 'Student', value: 'Ada' }] },
      'submissions:b.jff': { rows: [{ label: 'Student', value: 'Grace' }] },
    });
    // By file, not by which is on screen: a tab that has been opened stays mounted, so there
    // can be two viewers here and each has to be describing its own.
    const propertiesOf = (file: string) =>
      screen
        .getAllByTestId('viewer')
        .find((el) => el.getAttribute('data-src')?.endsWith(file))
        ?.getAttribute('data-properties');

    expect(propertiesOf('a.jff')).toBe('Ada');

    fireEvent.click(screen.getAllByRole('tab')[1]);
    expect(propertiesOf('b.jff')).toBe('Grace');
    expect(propertiesOf('a.jff')).toBe('Ada');
  });
});

describe('dragging a tab to one side', () => {
  const TYPE = 'application/x-afct-viewer-tab';

  /** A drag payload the browser would build. `types` is all a dragover may read. */
  const transfer = (types: string[] = [TYPE]) => ({
    types,
    setData: vi.fn(),
    dropEffect: '',
    effectAllowed: '',
  });

  /** jsdom measures everything as zero, and where a drop lands is arithmetic over a rect. */
  const withRect = () =>
    vi
      .spyOn(HTMLDivElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ left: 0, width: 800, top: 0, height: 600 } as DOMRect);

  const body = () => screen.getByTestId('viewer-body');
  const outline = () => screen.queryByTestId('viewer-drop-outline');

  /**
   * Fire a dragover at a place.
   *
   * `fireEvent.dragOver(el, { clientX })` does not work: `clientX` is a read-only getter
   * inherited from MouseEvent, so the assignment is silently dropped and the handler sees
   * `undefined`. It has to be defined onto the event.
   */
  const dragOverAt = (x: number, types: string[] = [TYPE]) => {
    const event = createEvent.dragOver(body(), { dataTransfer: transfer(types) });
    Object.defineProperty(event, 'clientX', { value: x });
    fireEvent(body(), event);
    return event;
  };

  /** Leave the body towards something, or towards nothing when the pointer leaves the page. */
  const dragLeaveTo = (target: Element | null) => {
    // `relatedTarget` is a read-only getter, like `clientX` above: assigning it through
    // fireEvent's init is silently dropped and the handler sees null, which is the one value
    // that means something different.
    const event = createEvent.dragLeave(body(), { dataTransfer: transfer() });
    Object.defineProperty(event, 'relatedTarget', { value: target });
    fireEvent(body(), event);
  };

  const dragTab = (name: string) =>
    fireEvent.dragStart(screen.getByRole('tab', { name }), { dataTransfer: transfer() });

  it('paints an outline over the half the machine would take', () => {
    const rect = withRect();
    renderWindow([tab('a.jff'), tab('b.jff')]);
    dragTab('b.jff');

    dragOverAt(780);
    expect(outline()?.className).toContain('left-1/2');

    dragOverAt(20);
    expect(outline()?.className).toContain('left-0');
    rect.mockRestore();
  });

  it('paints nothing across the middle, where a drop would do nothing', () => {
    const rect = withRect();
    renderWindow([tab('a.jff'), tab('b.jff')]);
    dragTab('b.jff');
    dragOverAt(400);
    expect(outline()).toBeNull();
    rect.mockRestore();
  });

  it('ignores something dragged in from outside the page', () => {
    // A file from the desktop, or a selection from another window. Promising a split and then
    // not doing one is worse than doing nothing.
    const rect = withRect();
    renderWindow([tab('a.jff'), tab('b.jff')]);
    dragTab('b.jff');
    dragOverAt(780, ['Files']);
    expect(outline()).toBeNull();
    rect.mockRestore();
  });

  it('accepts the drag, without which the browser would never deliver the drop', () => {
    // The trap: a dragover that does not call preventDefault means the drop is refused and
    // `onDrop` is never called at all. jsdom delivers the drop regardless, so nothing else
    // here would notice; this asserts on the event itself.
    const rect = withRect();
    renderWindow([tab('a.jff'), tab('b.jff')]);
    dragTab('b.jff');

    expect(dragOverAt(780).defaultPrevented).toBe(true);
    // And does not claim a drag that is not ours, which would stop the page doing whatever it
    // would otherwise do with it.
    expect(dragOverAt(780, ['Files']).defaultPrevented).toBe(false);
    rect.mockRestore();
  });

  it('splits the window when the tab is let go', () => {
    const rect = withRect();
    renderWindow([tab('a.jff'), tab('b.jff')]);
    dragTab('b.jff');
    dragOverAt(780);
    fireEvent.drop(body(), { dataTransfer: transfer() });

    const strips = screen.getAllByRole('tablist');
    expect(strips.map((s) => s.getAttribute('aria-label'))).toEqual(['Left pane', 'Right pane']);
    expect(
      within(strips[1]!)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['b.jff']);
    expect(outline()).toBeNull();
    // And the menu bar follows the machine that was dropped. Somebody dragged this one
    // somewhere on purpose, so it is what Reset and Download have to mean.
    expect(screen.getByTestId('menubar').getAttribute('data-download')).toContain('b.jff');
    rect.mockRestore();
  });

  it('clears the outline when the pointer leaves the window', () => {
    const rect = withRect();
    renderWindow([tab('a.jff'), tab('b.jff')]);
    dragTab('b.jff');
    dragOverAt(780);

    dragLeaveTo(null);
    expect(outline()).toBeNull();
    rect.mockRestore();
  });

  it('keeps the outline while the pointer crosses things inside the window', () => {
    // dragleave fires on the way into every child, so an unconditional clear would make the
    // outline flicker off and on as the pointer passed over each machine.
    const rect = withRect();
    renderWindow([tab('a.jff'), tab('b.jff')]);
    dragTab('b.jff');
    dragOverAt(780);

    dragLeaveTo(screen.getAllByTestId('viewer')[0]!);
    expect(outline()).not.toBeNull();
    rect.mockRestore();
  });

  it('clears the outline when the drag ends without a drop', () => {
    // Escape, or letting go outside the window. Neither fires a drop, and the outline would
    // otherwise stay painted over the machine.
    const rect = withRect();
    renderWindow([tab('a.jff'), tab('b.jff')]);
    dragTab('b.jff');
    dragOverAt(780);
    expect(outline()).not.toBeNull();

    fireEvent.dragEnd(screen.getByRole('tab', { name: 'b.jff' }));
    expect(outline()).toBeNull();
    rect.mockRestore();
  });

  it('tells the browser what is being dragged, or Firefox will not start one', () => {
    renderWindow([tab('a.jff'), tab('b.jff')]);
    const dataTransfer = transfer();
    fireEvent.dragStart(screen.getByRole('tab', { name: 'b.jff' }), { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith(TYPE, 'submissions:b.jff');
  });

  it('refuses to split the only open file', () => {
    const rect = withRect();
    renderWindow([tab('a.jff')]);
    dragTab('a.jff');
    dragOverAt(780);
    fireEvent.drop(body(), { dataTransfer: transfer() });
    expect(screen.getAllByRole('tablist')).toHaveLength(1);
    rect.mockRestore();
  });
});

describe('reordering the tabs by dragging them along a strip', () => {
  const TYPE = 'application/x-afct-viewer-tab';
  const transfer = (types: string[] = [TYPE]) => ({
    types,
    setData: vi.fn(),
    dropEffect: '',
    effectAllowed: '',
  });

  /**
   * Lay the tabs out, since jsdom does not.
   *
   * Each tab button 100 wide from x=0, and the strip starting at x=0. Without this every
   * element measures zero and the gap the pointer is over is arithmetic over nothing.
   */
  const layOutTabs = () =>
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const key = this.getAttribute('data-tab-key');
      if (key) {
        const index = [...document.querySelectorAll('[data-tab-key]')].indexOf(this);
        return {
          left: index * 100,
          width: 100,
          right: index * 100 + 100,
          top: 0,
          height: 30,
        } as DOMRect;
      }
      return { left: 0, width: 800, right: 800, top: 0, height: 600 } as DOMRect;
    });

  const strip = () => screen.getAllByRole('tablist')[0]!;
  const order = () => screen.getAllByRole('tab').map((t) => t.textContent);

  const dragOverStripAt = (x: number) => {
    const event = createEvent.dragOver(strip(), { dataTransfer: transfer() });
    Object.defineProperty(event, 'clientX', { value: x });
    fireEvent(strip(), event);
  };

  it('moves a tab to where it was dropped', () => {
    const rects = layOutTabs();
    renderWindow([tab('a.jff'), tab('b.jff'), tab('c.jff')]);
    expect(order()).toEqual(['a.jff', 'b.jff', 'c.jff']);

    fireEvent.dragStart(screen.getByRole('tab', { name: 'c.jff' }), { dataTransfer: transfer() });
    // Left of a.jff's middle, so in front of it.
    dragOverStripAt(20);
    fireEvent.drop(strip(), { dataTransfer: transfer() });

    expect(order()).toEqual(['c.jff', 'a.jff', 'b.jff']);
    rects.mockRestore();
  });

  it('moves one to the end', () => {
    const rects = layOutTabs();
    renderWindow([tab('a.jff'), tab('b.jff'), tab('c.jff')]);

    fireEvent.dragStart(screen.getByRole('tab', { name: 'a.jff' }), { dataTransfer: transfer() });
    dragOverStripAt(290);
    fireEvent.drop(strip(), { dataTransfer: transfer() });

    expect(order()).toEqual(['b.jff', 'c.jff', 'a.jff']);
    rects.mockRestore();
  });

  it('shows where the tab would go', () => {
    const rects = layOutTabs();
    renderWindow([tab('a.jff'), tab('b.jff')]);
    fireEvent.dragStart(screen.getByRole('tab', { name: 'b.jff' }), { dataTransfer: transfer() });

    expect(screen.queryByTestId('viewer-tab-insertion')).toBeNull();
    dragOverStripAt(20);
    expect(screen.getByTestId('viewer-tab-insertion')).toBeTruthy();
    rects.mockRestore();
  });

  it('does not move the machines in the page when the tabs are reordered', () => {
    // React keeps the same component when a keyed child is reordered, so nothing is rebuilt
    // either way and a mount count would say nothing here. What reordering does move is the
    // node: a canvas moved in the DOM drops whatever had keyboard focus inside it and repaints.
    // So the body renders in the order the machines were first opened, never in tab order.
    const rects = layOutTabs();
    renderWindow([tab('a.jff'), tab('b.jff')]);
    // Both on screen at some point, so both are mounted and the order is worth comparing.
    fireEvent.click(screen.getByRole('tab', { name: 'b.jff' }));
    fireEvent.click(screen.getByRole('tab', { name: 'a.jff' }));
    const before = screen.getAllByTestId('viewer').map((v) => v.getAttribute('data-src'));
    expect(before).toHaveLength(2);

    fireEvent.dragStart(screen.getByRole('tab', { name: 'b.jff' }), { dataTransfer: transfer() });
    dragOverStripAt(20);
    fireEvent.drop(strip(), { dataTransfer: transfer() });

    expect(order()).toEqual(['b.jff', 'a.jff']);
    expect(screen.getAllByTestId('viewer').map((v) => v.getAttribute('data-src'))).toEqual(before);
    rects.mockRestore();
  });

  it('leaves a drag from somewhere else alone', () => {
    const rects = layOutTabs();
    renderWindow([tab('a.jff'), tab('b.jff')]);
    fireEvent.dragStart(screen.getByRole('tab', { name: 'b.jff' }), { dataTransfer: transfer() });

    const event = createEvent.dragOver(strip(), { dataTransfer: transfer(['Files']) });
    Object.defineProperty(event, 'clientX', { value: 20 });
    fireEvent(strip(), event);

    expect(screen.queryByTestId('viewer-tab-insertion')).toBeNull();
    expect(event.defaultPrevented).toBe(false);
    rects.mockRestore();
  });
});

describe('a window split into two panes', () => {
  // Nothing on screen can make a split yet: the drag lands in a later step. What is being
  // checked here is the rendering the split will drive, and the one property everything else
  // rests on, which is that moving a machine between the panes does not rebuild it.
  const splitLayout = (): ViewerLayout => ({
    tabs: [tab('a.jff'), tab('b.jff'), tab('c.jff')],
    panes: { 'submissions:c.jff': 1 },
    active: ['submissions:a.jff', 'submissions:c.jff'],
    focused: 1,
  });

  const renderLayout = (layout: ViewerLayout) =>
    render(<ViewerWindow initialLayout={layout} initialProperties={{}} />);

  it('gives each side its own strip, named so they can be told apart', () => {
    renderLayout(splitLayout());
    const strips = screen.getAllByRole('tablist');
    expect(strips.map((s) => s.getAttribute('aria-label'))).toEqual(['Left pane', 'Right pane']);
    expect(
      within(strips[0]!)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['a.jff', 'b.jff']);
    expect(
      within(strips[1]!)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['c.jff']);
  });

  it('shows one machine per pane, and hides the rest', () => {
    renderLayout(splitLayout());
    const visible = screen
      .getAllByTestId('viewer')
      .filter((v) => !v.closest('[inert]'))
      .map((v) => v.getAttribute('data-src'));
    expect(visible).toHaveLength(2);
    expect(visible.join(' ')).toContain('a.jff');
    expect(visible.join(' ')).toContain('c.jff');
  });

  it('puts each pane in its own half', () => {
    renderLayout(splitLayout());
    const paneOf = (file: string) =>
      screen
        .getAllByTestId('viewer')
        .find((v) => v.getAttribute('data-src')?.includes(file))!
        .closest('div[class*="absolute"]')!.className;
    expect(paneOf('a.jff')).toContain('left-0');
    expect(paneOf('c.jff')).toContain('left-1/2');
  });

  it('follows a click into the other pane, so the menu acts on what was clicked', () => {
    // jsdom measures everything as zero, and which pane a point is in is arithmetic over a
    // rectangle. Without a real one the test would be exercising degenerate input rather than
    // the behaviour.
    const rect = vi
      .spyOn(HTMLDivElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ left: 0, width: 800, top: 0, height: 600 } as DOMRect);

    renderLayout(splitLayout());
    // Opened focused on the right pane, so the menu bar starts on c.jff.
    expect(screen.getByTestId('menubar').getAttribute('data-download')).toContain('c.jff');

    fireEvent.pointerDown(screen.getAllByTestId('viewer')[0]!, { clientX: 100 });
    expect(screen.getByTestId('menubar').getAttribute('data-download')).toContain('a.jff');

    rect.mockRestore();
  });

  /**
   * One inspector in a split window, on the side being worked in. Two of them took a third of
   * the window between them, and one of the two was always about a machine the reader had
   * finished with.
   */
  it('offers the properties panel to the focused pane alone', () => {
    const rect = vi
      .spyOn(HTMLDivElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ left: 0, width: 800, top: 0, height: 600 } as DOMRect);

    renderLayout(splitLayout());
    const inspectors = () =>
      screen.getAllByTestId('viewer').map((v) => v.getAttribute('data-inspector'));

    // Opened focused on the right pane.
    expect(inspectors()).toEqual(['hidden', 'shown']);

    // A click into the left half is what makes it the active side, canvas included.
    fireEvent.pointerDown(screen.getAllByTestId('viewer')[0]!, { clientX: 100 });

    expect(inspectors()).toEqual(['shown', 'hidden']);

    rect.mockRestore();
  });

  it('marks the half the menu bar is acting on', () => {
    // Two machines on screen, one menu bar. Without this nobody can tell which one Reset or
    // Download will mean, which is the question somebody asks before clicking either. The bar
    // over the file says it; the strips themselves are the same colour on both sides, so a
    // strip's fill never has to be read as meaning something.
    renderLayout(splitLayout());
    const strips = screen.getAllByRole('tablist');
    expect(strips[0]!.className).toContain('bg-muted/60');
    expect(strips[1]!.className).toContain('bg-muted/60');

    const marked = () =>
      screen
        .getAllByRole('tab')
        .filter((t) => t.parentElement?.className.includes('after:bg-primary'))
        .map((t) => t.textContent);
    expect(marked()).toEqual(['c.jff']);

    fireEvent.click(screen.getByRole('tab', { name: 'b.jff' }));
    expect(marked()).toEqual(['b.jff']);
  });

  it('marks the file on screen with one pane as well as two', () => {
    // The same mark on the same thing whether or not the window is split: a bar that appeared
    // only once a second machine was opened reads as being about the split rather than about
    // which file the menus mean.
    // One pane: every tab in it, and the focus on it by definition. The strip carries the same
    // fill it has when the window is split, so nothing about it changes on the way in and out.
    renderLayout({
      tabs: [tab('a.jff'), tab('b.jff')],
      panes: {},
      active: ['submissions:a.jff', null],
      focused: 0,
    });

    const marked = screen
      .getAllByRole('tab')
      .filter((t) => t.parentElement?.className.includes('after:bg-primary'))
      .map((t) => t.textContent);
    expect(marked).toEqual([screen.getByRole('tab', { selected: true }).textContent]);
    expect(screen.getByRole('tablist').className).toContain('bg-muted/60');
  });

  it('draws a line between the two halves', () => {
    // Two grids running into each other read as one crowded picture.
    const { container } = renderLayout(splitLayout());
    expect(container.querySelector('.bg-border.absolute')).not.toBeNull();
  });

  it('does not rebuild the machines when a pane collapses', () => {
    // Closing the last tab on one side takes the window back to one pane, which changes every
    // surviving machine's half-width rectangle to the full one. It must be only that: a
    // rebuild would take the zoom, the arrangement and the undo history with it.
    //
    // This is the reason every viewer in the window is a sibling in one container, rendered
    // in the window's own tab order rather than grouped by pane. Grouped, a collapse would
    // move them to a different parent and React would unmount them.
    renderLayout(splitLayout());
    expect(mounts.get('/api/files/submissions/c.jff')).toBe(1);

    // Emptying the LEFT pane, so the survivor on the right has to become the left pane. That
    // is the case where a grouped layout would move it to a different parent; closing the
    // right-hand tab instead would leave everything where it was and prove nothing.
    fireEvent.click(screen.getByLabelText('Close a.jff'));
    fireEvent.click(screen.getByLabelText('Close b.jff'));

    expect(screen.getAllByRole('tablist')).toHaveLength(1);
    expect(mounts.get('/api/files/submissions/c.jff')).toBe(1);
  });
});

describe('the heartbeat that lets an opener find this window', () => {
  it('is written while the window is open and cleared when it goes', () => {
    const view = renderWindow([tab('a.jff')]);
    const beat = Number(window.localStorage.getItem(VIEWER_ALIVE_KEY));
    expect(Date.now() - beat).toBeLessThan(1000);
    view.unmount();
    expect(window.localStorage.getItem(VIEWER_ALIVE_KEY)).toBeNull();
  });
});

describe('splitting without a mouse', () => {
  // Dragging a tab is not a gesture everybody can make. The same operation is on the View
  // menu, which is the keyboard, screen-reader and touch route to it.
  const move = () => fireEvent.click(screen.getByRole('button', { name: 'Move to other side' }));

  it('splits the window from the menu', () => {
    renderWindow([tab('a.jff'), tab('b.jff')], 1);
    move();
    const strips = screen.getAllByRole('tablist');
    expect(strips.map((s) => s.getAttribute('aria-label'))).toEqual(['Left pane', 'Right pane']);
    expect(
      within(strips[1]!)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['b.jff']);
  });

  it('moves the file back when it is used again', () => {
    renderWindow([tab('a.jff'), tab('b.jff')], 1);
    move();
    move();
    expect(screen.getAllByRole('tablist')).toHaveLength(1);
  });

  it('leaves the keyboard on the tab that moved', () => {
    // It is unmounted from one strip and mounted in the other, so without putting focus back
    // the reader is returned to the top of the document with no idea where they were.
    renderWindow([tab('a.jff'), tab('b.jff')], 1);
    move();
    expect(document.activeElement?.textContent).toBe('b.jff');
  });

  it('is offered only when there is a second file to split away from', () => {
    renderWindow([tab('a.jff')]);
    expect(screen.getByRole('button', { name: 'Move to other side' })).toBeDisabled();
  });

  it('says which half the menu is acting on, for somebody who cannot see the strip', () => {
    renderWindow([tab('a.jff'), tab('b.jff')], 1);
    expect(screen.getByRole('status').textContent).toBe('');

    move();
    expect(screen.getByRole('status').textContent).toBe('The menu applies to the right pane.');

    fireEvent.click(screen.getByRole('tab', { name: 'a.jff' }));
    expect(screen.getByRole('status').textContent).toBe('The menu applies to the left pane.');
  });
});

describe('the tab strip as a tabs widget', () => {
  const tabs = () => screen.getAllByRole('tab');
  const byName = (name: string) => screen.getByRole('tab', { name });

  it('puts one stop per strip in the Tab sequence', () => {
    // Tabbing through a dozen open files to reach the toolbar is not navigation. The arrows
    // reach the rest.
    renderWindow([tab('a.jff'), tab('b.jff'), tab('c.jff')], 1);
    expect(tabs().map((t) => t.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
  });

  it('moves along the strip with the arrows, and wraps', () => {
    renderWindow([tab('a.jff'), tab('b.jff'), tab('c.jff')]);
    byName('a.jff').focus();

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement?.textContent).toBe('b.jff');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(document.activeElement?.textContent).toBe('a.jff');
    // Wrapping in both directions, as the pattern expects.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(document.activeElement?.textContent).toBe('c.jff');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement?.textContent).toBe('a.jff');
  });

  it('jumps to the ends with Home and End', () => {
    renderWindow([tab('a.jff'), tab('b.jff'), tab('c.jff')], 1);
    byName('b.jff').focus();

    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement?.textContent).toBe('c.jff');
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement?.textContent).toBe('a.jff');
  });

  it('moves focus without switching machines, since each tab is a whole graph', () => {
    // Automatic activation would build and discard a graph for every tab crossed on the way
    // to the one somebody wanted.
    renderWindow([tab('a.jff'), tab('b.jff')]);
    byName('a.jff').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });

    expect(byName('a.jff').getAttribute('aria-selected')).toBe('true');
    expect(showing()).toContain('a.jff');
  });

  it('says which machine each tab controls, and which tab names each machine', () => {
    renderWindow([tab('a.jff'), tab('b.jff')]);
    const panel = screen.getAllByRole('tabpanel')[0]!;
    const controls = byName('a.jff').getAttribute('aria-controls');
    expect(controls).toBe(panel.getAttribute('id'));
    expect(panel.getAttribute('aria-labelledby')).toBe(byName('a.jff').getAttribute('id'));
  });

  it('keeps the keyboard in the strip when a tab is closed', () => {
    // The button goes with the tab, so without this focus falls back to the document and
    // somebody navigating by keyboard is returned to the top of the page.
    renderWindow([tab('a.jff'), tab('b.jff'), tab('c.jff')], 1);
    fireEvent.click(screen.getByLabelText('Close b.jff'));
    expect(document.activeElement?.textContent).toBe('c.jff');
  });

  it('falls back to the tab before it when the last one is closed', () => {
    renderWindow([tab('a.jff'), tab('b.jff')], 1);
    fireEvent.click(screen.getByLabelText('Close b.jff'));
    expect(document.activeElement?.textContent).toBe('a.jff');
  });

  it('keeps the arrows inside one strip when the window is split', () => {
    render(
      <ViewerWindow
        initialLayout={{
          tabs: [tab('a.jff'), tab('b.jff'), tab('c.jff')],
          panes: { 'submissions:c.jff': 1 },
          active: ['submissions:a.jff', 'submissions:c.jff'],
          focused: 0,
        }}
        initialProperties={{}}
      />,
    );
    byName('a.jff').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    // c.jff is in the other strip, which is its own tablist.
    expect(document.activeElement?.textContent).toBe('b.jff');
  });

  it('keeps the close button out of the way of tabs it does not belong to', () => {
    renderWindow([tab('a.jff'), tab('b.jff')], 0);
    const closers = screen.getAllByRole('button', { name: /^Close / });
    expect(closers.map((c) => c.getAttribute('tabindex'))).toEqual(['0', '-1']);
  });
});

describe('linking the two views', () => {
  const splitLayout = (): ViewerLayout => ({
    tabs: [tab('a.jff'), tab('b.jff')],
    panes: { 'submissions:b.jff': 1 },
    active: ['submissions:a.jff', 'submissions:b.jff'],
    focused: 0,
  });

  const renderSplit = () =>
    render(<ViewerWindow initialLayout={splitLayout()} initialProperties={{}} />);

  const link = () => fireEvent.click(screen.getByRole('button', { name: 'Link the two views' }));
  /** The driving pane saying where it is looking, which the real viewer does on its own. */
  const reportFrom = (file: string) =>
    fireEvent.click(screen.getByRole('button', { name: `report /api/files/submissions/${file}` }));
  const roleOf = (file: string) =>
    screen
      .getAllByTestId('viewer')
      .find((v) => v.getAttribute('data-src')?.includes(file))!
      .getAttribute('data-role');

  it('is off until it is asked for', () => {
    // Two machines that are not versions of each other rarely sit in the same place, so
    // moving one would drag the other somewhere useless.
    renderSplit();
    expect(roleOf('a.jff')).toBe('alone');
    expect(roleOf('b.jff')).toBe('alone');
  });

  it('is not offered while there is only one machine on screen', () => {
    renderWindow([tab('a.jff'), tab('b.jff')]);
    expect(screen.getByRole('button', { name: 'Link the two views' })).toBeDisabled();
  });

  it('makes the pane being worked in drive, and the other follow', () => {
    // One direction at a time, so the two cannot chase each other.
    renderSplit();
    link();
    reportFrom('a.jff');
    expect(roleOf('a.jff')).toBe('driving');
    expect(roleOf('b.jff')).toBe('following');
  });

  it('hands the follower the camera the driver reports', () => {
    renderSplit();
    link();
    fireEvent.click(screen.getByRole('button', { name: 'report /api/files/submissions/a.jff' }));

    const following = screen
      .getAllByTestId('viewer')
      .find((v) => v.getAttribute('data-src')?.includes('b.jff'))!
      .getAttribute('data-following');
    expect(JSON.parse(following!)).toEqual({ zoom: 2.5, pan: { x: -30, y: 12 } });
  });

  it('swaps which one drives when the reader moves to the other pane', () => {
    renderSplit();
    link();
    reportFrom('a.jff');

    fireEvent.click(screen.getByRole('tab', { name: 'b.jff' }));
    expect(roleOf('b.jff')).toBe('driving');
    expect(roleOf('a.jff')).toBe('following');
  });

  it('lets go when it is switched off again', () => {
    renderSplit();
    link();
    reportFrom('a.jff');
    link();
    expect(roleOf('a.jff')).toBe('alone');
    expect(roleOf('b.jff')).toBe('alone');
  });

  it('leaves a tab that is not on screen out of it', () => {
    // A hidden tab given somebody else's camera would come back showing a view of a machine
    // nobody chose for it, and would write that view down as its own.
    render(
      <ViewerWindow
        initialLayout={{
          tabs: [tab('a.jff'), tab('b.jff'), tab('c.jff')],
          panes: { 'submissions:b.jff': 1, 'submissions:c.jff': 1 },
          active: ['submissions:a.jff', 'submissions:b.jff'],
          focused: 0,
        }}
        initialProperties={{}}
      />,
    );
    // b.jff has been on screen, so it stays mounted; c.jff takes its place in that pane.
    fireEvent.click(screen.getByRole('tab', { name: 'c.jff' }));
    fireEvent.click(screen.getByRole('tab', { name: 'a.jff' }));
    link();
    reportFrom('a.jff');

    expect(roleOf('c.jff')).toBe('following');
    expect(roleOf('b.jff')).toBe('alone');
  });

  it('links nothing once the window is back to one pane', () => {
    renderSplit();
    link();
    reportFrom('a.jff');
    fireEvent.click(screen.getByLabelText('Close b.jff'));
    expect(roleOf('a.jff')).toBe('alone');
  });
});

describe('when a file arrives and the window is already full', () => {
  const full = () => Array.from({ length: MAX_VIEWER_TABS }, (_, i) => tab(`f${i}.jff`));

  const send = (t: ViewerTab) => {
    const opener = new TestChannel(VIEWER_CHANNEL);
    act(() => {
      opener.postMessage({ type: 'open-tab', tab: t });
    });
    opener.close();
  };

  const names = () => screen.getAllByRole('tab').map((t) => t.textContent);

  it('says which file it closed, and why', () => {
    // It used to go in silence, so somebody came back to a strip with a file missing from it
    // and nothing to say where it had gone.
    renderWindow(full());
    send(tab('new.jff'));

    expect(showToast.warning).toHaveBeenCalledWith(
      'Closed f0.jff to make room',
      expect.objectContaining({ description: expect.stringContaining('new.jff') }),
    );
  });

  it('offers to put it back', () => {
    renderWindow(full());
    send(tab('new.jff'));
    expect(names()).not.toContain('f0.jff');

    const options = vi.mocked(showToast.warning).mock.calls[0]![1] as {
      action: { label: string; onClick: () => void };
    };
    expect(options.action.label).toBe('Undo');
    act(() => options.action.onClick());

    // Back exactly as it was: the closed file returns and the one that displaced it goes.
    expect(names()).toContain('f0.jff');
    expect(names()).not.toContain('new.jff');
  });

  it("keeps the closed file's remembered view, so undoing brings it back as it was", () => {
    // Unlike closing a tab by hand, which is somebody deciding to discard an arrangement.
    // Nobody asked for this one to go.
    window.sessionStorage.setItem('afct.viewer.view.submissions:f0.jff', '{"v":1}');
    renderWindow(full());
    send(tab('new.jff'));

    expect(window.sessionStorage.getItem('afct.viewer.view.submissions:f0.jff')).not.toBeNull();
  });

  it('says nothing when there was room', () => {
    renderWindow([tab('a.jff')]);
    send(tab('b.jff'));
    expect(showToast.warning).not.toHaveBeenCalled();
  });

  it('says nothing when the file was already open', () => {
    renderWindow(full());
    send(tab('f3.jff'));
    expect(showToast.warning).not.toHaveBeenCalled();
    expect(names()).toHaveLength(MAX_VIEWER_TABS);
  });
});
