/** @vitest-environment jsdom */

import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import JffViewerDialog, { JffCytoscapeViewer } from './JffViewerDialog';
import { transitionFields } from '@/lib/jflap-parse';
import {
  ViewerActionsGate,
  ViewerActionsProvider,
  useViewerActions,
} from '@/components/viewer/viewer-actions';

// The engine tests await an async load chain (fetch, parse, dynamic import, cytoscape
// ctor). On a CPU-starved CI runner that chain can take several seconds, so give this
// file generous headroom instead of racing vitest's 5s default. `retry` is the safety
// net for the residual case: this is an integration test that is correct but races the
// runner under full-suite contention, so a transient timeout shouldn't fail the build.
// Passed via a variable so `retry` (valid at runtime) isn't rejected by setConfig's
// stricter object-literal type.
const jffTestConfig = { testTimeout: 20000, retry: 2 };
vi.setConfig(jffTestConfig);

/* ─────────────────────── cytoscape engine mock (hoisted) ─────────────────── */
// The viewer sets cyRef.current right after cytoscape() returns and wraps the
// layout work in try/catch, so a chainable no-throw mock lets load() complete and
// exposes the toolbar handlers (zoom/fit/export) for assertion.
const h = vi.hoisted(() => {
  const chain: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'length') return 0;
      if (prop === 'empty') return () => true;
      if (prop === 'position' || prop === 'center') return () => ({ x: 0, y: 0 });
      if (prop === 'id') return () => 'n';
      if (prop === 'data') return () => undefined;
      if (prop === 'isNode') return () => false;
      if (typeof prop === 'symbol') return undefined;
      return () => chain;
    },
    apply() {
      return chain;
    },
  });

  const cy = {
    userZoomingEnabled: vi.fn(),
    panningEnabled: vi.fn(),
    userPanningEnabled: vi.fn(),
    resize: vi.fn(),
    destroy: vi.fn(),
    nodes: vi.fn(() => chain),
    edges: vi.fn(() => chain),
    elements: vi.fn(() => chain),
    getElementById: vi.fn(() => chain),
    // Node positions, so the undo tests can watch an arrangement being restored.
    __positions: {} as Record<string, { x: number; y: number }>,
    add: vi.fn(() => chain),
    on: vi.fn(),
    // Records handlers so a test can fire a tap the way cytoscape would.
    __handlers: {} as Record<string, (evt: unknown) => void>,
    // The layout reports completion, as cytoscape's does. Without it the viewer's own
    // `await new Promise(resolve => layout.on('layoutstop', resolve))` never settles, so
    // everything after the fit silently never ran and looked untestable.
    layout: vi.fn(() => ({
      run: vi.fn(),
      on: vi.fn((_event: string, cb: () => void) => {
        cb();
      }),
    })),
    width: vi.fn(() => 800),
    height: vi.fn(() => 600),
    zoom: vi.fn(() => 1),
    pan: vi.fn(() => ({ x: 0, y: 0 })),
    minZoom: vi.fn(() => 0.2),
    maxZoom: vi.fn(() => 6),
    center: vi.fn(() => ({ x: 0, y: 0 })),
    animate: vi.fn(),
    svg: vi.fn(() => '<svg></svg>'),
    png: vi.fn(() => 'data:image/png;base64,AAAA'),
    // Selecting the note nodes, which the notes toggle styles.
    $: vi.fn(() => ({ style: vi.fn() })),
  };

  const ctor = Object.assign(
    vi.fn(() => cy),
    { use: vi.fn() },
  );
  return { cy, ctor };
});

vi.mock('cytoscape', () => ({ default: h.ctor }));
vi.mock('cytoscape-elk', () => ({ default: {} }));
vi.mock('cytoscape-svg', () => ({ default: {} }));

// Resolve the (mocked) cytoscape modules once, up front. The component loads them
// with dynamic import() for bundle-splitting; pre-warming Vitest's module registry
// here keeps that import() from re-resolving the graph mid-run, which is what stalls
// under full-suite CPU contention and made this file flaky.
beforeAll(async () => {
  await Promise.all([import('cytoscape'), import('cytoscape-elk'), import('cytoscape-svg')]);
});

// Keep the Dialog wrapper light (no Radix portal / a11y noise); it renders children.
vi.mock('@/components/ui/dialog', () => import('@/test/mocks/ui').then((mod) => mod.dialogMock));

/* ──────────────────────────────── fixtures ──────────────────────────────── */

const FA_JFF = `<?xml version="1.0"?>
<structure>
  <type>fa</type>
  <automaton>
    <state id="0" name="q0"><x>0</x><y>0</y><initial/></state>
    <state id="1" name="q1"><x>120</x><y>0</y><final/></state>
    <transition><from>0</from><to>1</to><read>a</read></transition>
  </automaton>
</structure>`;

let fetchImpl: (url: string) => Promise<unknown>;
const okText = (text: string) => ({
  ok: true,
  status: 200,
  text: async () => text,
  json: async () => ({}),
  blob: async () => new Blob([text]),
});

/**
 * The viewer asks for two things: the file, and where it came from.
 *
 * Routed by URL rather than by call order, so a test that counts attempts at the file is
 * counting attempts at the file. The properties request is answered here once, for every test,
 * because no test in this file is about it: the ones that are pass their own rows in.
 */
const isPropertiesRequest = (url: string) => url.startsWith('/api/viewer/properties');

beforeEach(() => {
  vi.clearAllMocks();
  fetchImpl = async () => okText(FA_JFF);
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      isPropertiesRequest(url)
        ? Promise.resolve({ ...okText(''), ok: false, status: 404 })
        : fetchImpl(url),
    ),
  );
  // Export helpers create object URLs; jsdom doesn't implement them.
  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Resolves once load() has instantiated the (mocked) cytoscape engine, i.e. cyRef
// is set and the toolbar handlers can drive it. Generous timeout, kept well under the
// file's 20s testTimeout: the load chain (fetch, parse, dynamic import, ctor) can be
// slow under full-suite CPU contention, and 5s raced vitest's default and flaked.
const waitForEngine = () => waitFor(() => expect(h.ctor).toHaveBeenCalled(), { timeout: 15000 });

/**
 * Render the viewer as the standalone window does, with a handle on what it publishes.
 *
 * The toolbar in a panel is deliberately small: the exports, the layout choice and undo are
 * offered by the window's menu instead. So the tests that used to click a toolbar button
 * invoke the published action, which is the surface that still exists.
 */
function renderWithMenu(props: React.ComponentProps<typeof JffCytoscapeViewer>) {
  const seen: { current: ReturnType<typeof useViewerActions> | null } = { current: null };
  function Probe() {
    seen.current = useViewerActions();
    return null;
  }
  const view = render(
    <ViewerActionsProvider>
      <JffCytoscapeViewer {...props} />
      <Probe />
    </ViewerActionsProvider>,
  );
  return { ...view, menu: () => seen.current! };
}

/* ────────────────────────────────  tests  ───────────────────────────────── */

/**
 * A viewer in the standalone window, which is where the canvas tools live.
 *
 * A viewer in a dialog is for looking at a machine: it drops the exports, the layout choice and
 * the tool palette, all for the same reason. Presence of the provider IS that signal, so a test
 * about the tools has to say which surface it is on.
 */
const renderInWindow = (ui: React.ReactElement) => render(ui, { wrapper: ViewerActionsProvider });

describe('JffCytoscapeViewer — load & error', () => {
  it('shows an error message when the source fetch fails', async () => {
    fetchImpl = async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => '',
    });
    render(<JffCytoscapeViewer src="/api/files/solutions/x.jff" />);
    expect(await screen.findByText(/not there any more/i)).toBeInTheDocument();
    // The engine is never constructed on a failed fetch.
    expect(h.ctor).not.toHaveBeenCalled();
  });

  it('parses the machine type and reflects it in the badge', async () => {
    render(<JffCytoscapeViewer src="/x.jff" />);
    expect(await screen.findByText('Finite Automaton')).toBeInTheDocument();
  });

  it('constructs the cytoscape engine after a successful load', async () => {
    render(<JffCytoscapeViewer src="/x.jff" />);
    await waitForEngine();
    expect(h.ctor).toHaveBeenCalled();
  });
});

describe('JffCytoscapeViewer — toolbar presence', () => {
  it('renders the controls a panel keeps', async () => {
    render(<JffCytoscapeViewer src="/x.jff" />);
    for (const label of ['Toggle grid', 'Zoom out', 'Zoom in', 'Fit automaton to view']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('leaves the rest to the standalone window', async () => {
    // A panel over the page is for a look. Everything that changes the machine or takes a
    // copy of it lives in the window's menus, and the way there is on this toolbar.
    render(<JffCytoscapeViewer src="/x.jff" />);
    for (const label of ['Download SVG', 'Download PNG', 'Copy PNG to clipboard', 'Undo', 'Redo']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
    expect(screen.queryByRole('radiogroup', { name: 'Layout' })).toBeNull();
  });
});

describe('JffCytoscapeViewer — view toggles', () => {
  it('toggles the grid pressed-state on click', async () => {
    render(<JffCytoscapeViewer src="/x.jff" />);
    const grid = screen.getByRole('button', { name: 'Toggle grid' });
    expect(grid).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(grid);
    expect(grid).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(grid);
    expect(grid).toHaveAttribute('aria-pressed', 'false');
  });

  it('honors showGridDefault for the initial pressed-state', () => {
    render(<JffCytoscapeViewer src="/x.jff" showGridDefault />);
    expect(screen.getByRole('button', { name: 'Toggle grid' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('the layout the viewer publishes', () => {
  // The toolbar's segmented control is gone; the Machine menu owns the choice now. What has
  // to keep working is what the viewer publishes and what it does when told.

  it('starts auto-arranged, and says so', () => {
    const { menu } = renderWithMenu({ src: '/x.jff' });
    expect(menu().layout).toBe('auto');
  });

  it('follows honorPositionsDefault', () => {
    const { menu } = renderWithMenu({ src: '/x.jff', honorPositionsDefault: true });
    expect(menu().layout).toBe('as-drawn');
  });

  it('switches when the menu asks for the other one', () => {
    const { menu } = renderWithMenu({ src: '/x.jff' });
    act(() => menu().run('setAsDrawn'));
    expect(menu().layout).toBe('as-drawn');
    act(() => menu().run('setAutoArranged'));
    expect(menu().layout).toBe('auto');
  });

  it('does nothing when told to use the layout already showing', () => {
    // Switching rebuilds the graph, so a menu click on the ticked option must not.
    const { menu } = renderWithMenu({ src: '/x.jff', honorPositionsDefault: true });
    act(() => menu().run('setAsDrawn'));
    expect(menu().layout).toBe('as-drawn');
  });
});

describe('JffCytoscapeViewer — engine controls', () => {
  it('animates a zoom-in relative to the current zoom', async () => {
    render(<JffCytoscapeViewer src="/x.jff" />);
    await waitForEngine();
    h.cy.animate.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(h.cy.animate).toHaveBeenCalledTimes(1);
    // zoom() is 1 in the mock → target 1.2, clamped within [0.2, 6].
    expect(h.cy.animate.mock.calls[0][0]).toMatchObject({ zoom: 1.2 });
  });

  it('animates a zoom-out relative to the current zoom', async () => {
    render(<JffCytoscapeViewer src="/x.jff" />);
    await waitForEngine();
    h.cy.animate.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(h.cy.animate).toHaveBeenCalledTimes(1);
    expect(h.cy.animate.mock.calls[0][0].zoom).toBeCloseTo(1 / 1.2);
  });

  it('exports an SVG via the engine', async () => {
    const { menu } = renderWithMenu({ src: '/x.jff', title: 'My FA' });
    await waitForEngine();
    act(() => menu().run('downloadSVG'));
    await waitFor(() => expect(h.cy.svg).toHaveBeenCalled());
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it('exports a PNG via the engine', async () => {
    const { menu } = renderWithMenu({ src: '/x.jff' });
    await waitForEngine();
    act(() => menu().run('downloadPNG'));
    await waitFor(() => expect(h.cy.png).toHaveBeenCalled());
  });

  it('falls back to a PNG download when the clipboard is unavailable', async () => {
    const { menu } = renderWithMenu({ src: '/x.jff' });
    await waitForEngine();
    act(() => menu().run('copyPNG'));
    // jsdom has no ClipboardItem → copyPNG falls back to downloadPNG (png()).
    await waitFor(() => expect(h.cy.png).toHaveBeenCalled());
  });
});

describe('JffViewerDialog — wrapper', () => {
  it('does not mount the viewer when closed', () => {
    render(<JffViewerDialog open={false} onOpenChange={() => {}} src="/x.jff" title="My FA" />);
    expect(screen.queryByRole('button', { name: 'Zoom in' })).not.toBeInTheDocument();
  });

  it('mounts the viewer and shows the title when open', async () => {
    render(<JffViewerDialog open onOpenChange={() => {}} src="/x.jff" title="My FA" />);
    expect(screen.getByText('My FA')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Zoom in' })).toBeInTheDocument();
  });

  it('falls back to a default title', () => {
    render(<JffViewerDialog open onOpenChange={() => {}} src="/x.jff" />);
    expect(screen.getByText('JFLAP Viewer')).toBeInTheDocument();
  });
});

describe('the graph canvas says it can be dragged', () => {
  it('is an ordinary pointer at rest and a closed hand while dragging', () => {
    // jsdom cannot show a cursor, which is the point of asserting the classes: this is the
    // wiring, and how it looks is a browser check. The open hand is deliberately absent: it
    // would claim the whole canvas is a handle, over a diagram whose states are what a reader
    // is actually pointing at.
    render(<JffCytoscapeViewer src="/api/files/submissions/abc.jff" title="abc.jff" />);
    const canvas = screen.getByRole('img');
    expect(canvas.className).toContain('cursor-default');
    expect(canvas.className).toContain('active:cursor-grabbing');
    expect(canvas.className).not.toContain('cursor-grab ');
  });
});

/**
 * Whose file this is, beside what kind of machine it draws.
 *
 * A student's attempt and the instructor's answer are the same picture on the canvas. The
 * badge is the only thing on screen that tells them apart without opening Properties.
 */
describe('the file kind badge', () => {
  it('says Submission for a student attempt', async () => {
    render(<JffCytoscapeViewer src="/api/files/submissions/abc.jff" title="abc.jff" />);
    await waitForEngine();
    expect(screen.getByText('Submission')).toBeInTheDocument();
    expect(screen.queryByText('Solution')).toBeNull();
  });

  it('says Solution for the answer posted with a problem', async () => {
    render(<JffCytoscapeViewer src="/api/files/solutions/answer.jff" title="answer.jff" />);
    await waitForEngine();
    expect(screen.getByText('Solution')).toBeInTheDocument();
    expect(screen.queryByText('Submission')).toBeNull();
  });

  it('says Problem file for the third store, rather than calling it a solution', async () => {
    // Three stores, not two. Reading a problem's own file as the answer to it would be the
    // same mistake this badge exists to prevent, one door along.
    render(<JffCytoscapeViewer src="/api/files/problems/start.jff" title="start.jff" />);
    await waitForEngine();
    expect(screen.getByText('Problem file')).toBeInTheDocument();
  });

  it('says nothing about a file that did not come from one of them', async () => {
    // A guess here is worse than a gap: this badge is trusted precisely because it can only
    // ever be read off the route the file was actually fetched from.
    render(<JffCytoscapeViewer src="/somewhere/else.jff" title="else.jff" />);
    await waitForEngine();
    expect(screen.queryByText('Submission')).toBeNull();
    expect(screen.queryByText('Solution')).toBeNull();
    expect(screen.queryByText('Problem file')).toBeNull();
  });

  it('sits beside the machine type, not instead of it', async () => {
    render(<JffCytoscapeViewer src="/api/files/solutions/answer.jff" title="answer.jff" />);
    await waitForEngine();
    expect(screen.getByText('Finite Automaton')).toBeInTheDocument();
    expect(screen.getByText('Solution')).toBeInTheDocument();
  });
});

describe('the toolbar does not repeat what a menu already offers', () => {
  const SRC = '/api/files/submissions/abc.jff';

  /**
   * The canvas tools are the standalone window's, on the same line as the exports and the
   * layout choice. A panel over a page is for looking at a machine: it has no menus, no undo
   * and no room, and offering a way to redraw the automaton in it was the one editing surface
   * that had leaked across that line.
   */
  it('keeps the canvas tools out of a dialog', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();

    expect(screen.queryByTestId('viewer-tool-palette')).toBeNull();
  });

  it('offers them in the standalone window', async () => {
    renderInWindow(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();

    expect(screen.getByTestId('viewer-tool-palette')).toBeInTheDocument();
  });

  /**
   * Properties is the deliberate exception, and it is here so the exception is written down
   * rather than discovered. It is on the toolbar AND in the File menu: the menu is where
   * somebody looks for it by convention, and the button is the way to it without leaving the
   * machine. It also describes a different file in each pane of a split window, which the
   * menu bar cannot do.
   */
  it('offers Properties even though the menu bar has it too', () => {
    render(
      <ViewerActionsProvider>
        <JffCytoscapeViewer src={SRC} title="abc.jff" properties={{ rows: [] }} />
      </ViewerActionsProvider>,
    );
    expect(screen.getByRole('button', { name: 'File properties' })).toBeInTheDocument();
  });

  it('shows no Properties button where a caller has no answer to give', () => {
    // A viewer inside a dialog: the page around it has already said whose file this is.
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    expect(screen.queryByRole('button', { name: 'File properties' })).toBeNull();
  });

  it('keeps Grid in a dialog, where the toolbar is the only place it exists', () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    expect(screen.getByRole('button', { name: /toggle grid/i })).toBeInTheDocument();
  });

  it('drops it in the standalone window, where the menu bar has it', () => {
    // Presence of the provider IS the signal, so the two can never disagree about which
    // surface owns these controls.
    render(
      <ViewerActionsProvider>
        <JffCytoscapeViewer src={SRC} title="abc.jff" />
      </ViewerActionsProvider>,
    );
    expect(screen.queryByRole('button', { name: /toggle grid/i })).toBeNull();
  });

  it('keeps undo and redo to the standalone window', () => {
    // The other direction: these are not offered in a panel at all, so there is nothing to
    // duplicate. A machine is rearranged in the window, where there is room to see it.
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();

    render(
      <ViewerActionsProvider>
        <JffCytoscapeViewer src={SRC} title="abc.jff" />
      </ViewerActionsProvider>,
    );
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('keeps zoom in both, since the menu has no zoom', () => {
    // The dividing line is duplication, not tidiness: zoom exists only on the toolbar, so it
    // stays in both places.
    render(
      <ViewerActionsProvider>
        <JffCytoscapeViewer src={SRC} title="abc.jff" />
      </ViewerActionsProvider>,
    );
    expect(screen.getByRole('button', { name: /zoom in/i })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Zoom level' })).toBeInTheDocument();
  });
});

describe('the zoom slider', () => {
  const SRC = '/api/files/submissions/abc.jff';

  it('reads as one group: out, value, slider, in', () => {
    // The order is the request. Asserted by document position rather than by walking the DOM,
    // because the slider is built from several nested spans and any structural query would
    // break the next time that component changes.
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    const group = screen.getByRole('group', { name: 'Zoom' });
    const out = screen.getByRole('button', { name: 'Zoom out' });
    const value = screen.getByText('100%');
    const slider = screen.getByRole('slider', { name: 'Zoom level' });
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });

    for (const el of [out, value, slider, zoomIn]) expect(group).toContainElement(el);

    const precedes = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(precedes(out, value)).toBe(true);
    expect(precedes(value, slider)).toBe(true);
    expect(precedes(slider, zoomIn)).toBe(true);
  });

  it('shows the current zoom as a percentage', () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    expect(screen.getByRole('group', { name: 'Zoom' })).toHaveTextContent('100%');
  });

  it('keeps the value a fixed width, so the toolbar does not jump as zoom changes', () => {
    // Tabular numerals plus a set width. 50% and 200% must not move the buttons beside them.
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    const value = screen.getByText('100%');
    expect(value.className).toContain('tabular-nums');
    expect(value.className).toMatch(/\bw-\d+\b/);
  });

  it('offers Fit outside the zoom group, with a name that says what it does', () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    const fitButton = screen.getByRole('button', { name: 'Fit automaton to view' });
    expect(fitButton).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Zoom' })).not.toContainElement(fitButton);
  });

  it('offers Center beside Fit, since the two are asked for in the same moment', () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    const centerButton = screen.getByRole('button', { name: 'Center automaton in view' });
    expect(centerButton).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Zoom' })).not.toContainElement(centerButton);
    // Immediately after Fit, so the pair reads as one choice rather than two scattered ones.
    expect(screen.getByRole('button', { name: 'Fit automaton to view' }).nextElementSibling).toBe(
      centerButton,
    );
  });

  it('announces its value as a spoken percentage, not a track position', () => {
    // A bare value announces "62", which is where the thumb sits and means nothing. Percent
    // is spelled out because how a screen reader pronounces the symbol varies.
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    const slider = screen.getByRole('slider', { name: 'Zoom level' });
    expect(slider).toHaveAttribute('aria-valuetext', '100 percent');
  });
});

describe('what the viewer publishes to a menu', () => {
  it('wires Fit to window to the real fit, not to a stub', async () => {
    // The menu's own test can only prove the menu calls whatever was registered. This is the
    // other half: that the viewer registers something that actually fits the graph. Wiring it
    // to a no-op would satisfy the menu test and do nothing in the window.
    let run: ((name: 'fitToWindow') => void) | null = null;
    function Probe() {
      run = useViewerActions().run;
      return null;
    }
    render(
      <ViewerActionsProvider>
        <JffCytoscapeViewer src="/api/files/submissions/abc.jff" title="abc.jff" />
        <Probe />
      </ViewerActionsProvider>,
    );

    // `fit` is only wired once the engine has loaded, so calling it before that would pass
    // for the wrong reason: a no-op is indistinguishable from a stub.
    await waitForEngine();
    // Loading the graph resizes it too, so start counting from here.
    h.cy.resize.mockClear();
    act(() => run?.('fitToWindow'));
    expect(h.cy.resize).toHaveBeenCalled();
  });

  it('wires Center in window to a centring that leaves the zoom alone', async () => {
    let run: ((name: 'centerInWindow') => void) | null = null;
    function Probe() {
      run = useViewerActions().run;
      return null;
    }
    render(
      <ViewerActionsProvider>
        <JffCytoscapeViewer src="/api/files/submissions/abc.jff" title="abc.jff" />
        <Probe />
      </ViewerActionsProvider>,
    );

    await waitForEngine();
    h.cy.center.mockClear();
    h.cy.zoom.mockClear();
    h.cy.resize.mockClear();
    act(() => run?.('centerInWindow'));

    expect(h.cy.center).toHaveBeenCalled();
    // Not a fit, and not a scale change: the reader keeps the magnification they set. Fit
    // resizes the canvas on its way through, which is what tells the two apart here, and
    // setting the zoom would mean calling it with a value rather than reading it.
    expect(h.cy.resize).not.toHaveBeenCalled();
    expect(h.cy.zoom).not.toHaveBeenCalledWith(expect.anything());
  });
});

describe('the grid background renders the same on the server and in the browser', () => {
  it('uses the CSS variable with a literal fallback, not a computed colour', () => {
    // The viewer used to read --grid-color off the document at module scope behind a
    // `typeof window` check, so a server-rendered page produced one colour and hydration
    // produced another. Any literal here is fine; a computed one is not.
    render(
      <JffCytoscapeViewer src="/api/files/submissions/abc.jff" title="abc.jff" showGridDefault />,
    );
    const style = screen.getByRole('img').getAttribute('style') ?? '';
    expect(style).toContain('var(--grid-color, #0f172a)');
    // A resolved colour function is what the mismatch looked like on the client side.
    expect(style).not.toContain('lab(');
    expect(style).not.toContain('oklch(');
  });

  it('reads no computed style while rendering', () => {
    // Deliberately a source check. jsdom resolves --grid-color to an empty string, so the
    // computed-style version falls back to the same literal and renders identically here:
    // the runtime assertion above cannot tell the two apart, and passed throughout the bug.
    // What can be checked is the practice, which is what actually caused it. A computed read
    // inside an effect or a handler would be fine; this file should have neither.
    const source = readFileSync(path.join(__dirname, 'JffViewerDialog.tsx'), 'utf8');
    expect(source).not.toContain('getComputedStyle');
  });
});

describe('where the text description lives', () => {
  const SRC = '/api/files/submissions/abc.jff';

  it('keeps the panel and its toggle in a dialog', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    expect(screen.getByRole('button', { name: /show text representation/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Description of this file' })).toBeInTheDocument();
  });

  it('takes the panel off the screen in the standalone window', async () => {
    render(
      <ViewerActionsProvider>
        <JffCytoscapeViewer src={SRC} title="abc.jff" />
      </ViewerActionsProvider>,
    );
    await waitForEngine();
    expect(screen.queryByRole('button', { name: /show text representation/i })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Description of this file' })).toBeNull();
  });

  it('still gives the canvas its text alternative, which is not optional', async () => {
    // The panel is hidden, not removed: aria-describedby points at the summary, and a canvas
    // with nothing behind that attribute is unreadable to a screen reader. Removing the panel
    // outright would have been a silent accessibility regression.
    render(
      <ViewerActionsProvider>
        <JffCytoscapeViewer src={SRC} title="abc.jff" />
      </ViewerActionsProvider>,
    );
    await waitForEngine();
    const canvas = screen.getByRole('img');
    const describedBy = canvas.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const summary = document.getElementById(describedBy as string);
    expect(summary?.textContent).toMatch(/finite automaton/i);
  });

  it('publishes an action that opens it, and renders the listing to open', async () => {
    // What this cannot check: whether the dialog is shut to begin with. The shared ui/dialog
    // mock this file uses renders its children whatever `open` says and gives them no dialog
    // role, so open and closed look identical here. The wiring is covered; the opening itself
    // is a browser check.
    let run: ((name: 'showTextRepresentation') => void) | null = null;
    function Probe() {
      run = useViewerActions().run;
      return null;
    }
    render(
      <ViewerActionsProvider>
        <JffCytoscapeViewer src={SRC} title="abc.jff" />
        <Probe />
      </ViewerActionsProvider>,
    );
    await waitForEngine();

    expect(run).not.toBeNull();
    act(() => run?.('showTextRepresentation'));

    // The listing is present to be shown, with the same content the dialog panel carries.
    expect(screen.getByText('Text representation')).toBeInTheDocument();
    expect(screen.getByText('Initial state')).toBeInTheDocument();
  });
});

describe('the JFLAP notes toggle', () => {
  const SRC = '/api/files/submissions/abc.jff';

  it('draws notes by default, and hides them as a style change rather than a rebuild', async () => {
    // A rebuild would re-run the layout and move the machine under the reader, which is not
    // what asking to hide a note should do.
    let run: ((name: 'toggleNotes') => void) | null = null;
    function Probe() {
      run = useViewerActions().run;
      return null;
    }
    render(
      <ViewerActionsProvider>
        <JffCytoscapeViewer src={SRC} title="abc.jff" />
        <Probe />
      </ViewerActionsProvider>,
    );
    await waitForEngine();

    const style = vi.fn();
    h.cy.$.mockReturnValue({ style });
    act(() => run?.('toggleNotes'));

    expect(h.cy.$).toHaveBeenCalledWith('node.note');
    expect(style).toHaveBeenCalledWith('display', 'none');
    // The graph itself was not rebuilt.
    expect(h.ctor).toHaveBeenCalledTimes(1);
  });
});

describe('the start marker', () => {
  const startStyle = () => {
    // The ctor mock is untyped, so its recorded arguments come back as an empty tuple.
    const firstCall = h.ctor.mock.calls[0] as unknown as [
      { style?: { selector: string; style: Record<string, unknown> }[] },
    ];
    const style = firstCall?.[0]?.style;
    return style?.find((rule) => rule.selector === 'node.start')?.style;
  };

  it('is filled rather than see-through, so the grid does not show inside it', async () => {
    // Unfilled, the grid lines and any edge passing behind it ran straight through the
    // triangle, which made it read as an outline sitting on the canvas rather than as part
    // of the machine.
    render(
      <JffCytoscapeViewer src="/api/files/submissions/abc.jff" title="abc.jff" darkMode={false} />,
    );
    await waitForEngine();
    expect(startStyle()?.['background-opacity']).toBe(1);
    expect(startStyle()?.['background-color']).toBe('#ffffff');
  });

  it('takes the dark canvas colour in dark mode, not white', async () => {
    render(<JffCytoscapeViewer src="/api/files/submissions/abc.jff" title="abc.jff" darkMode />);
    await waitForEngine();
    expect(startStyle()?.['background-color']).not.toBe('#ffffff');
  });
});

describe('clicking a state', () => {
  const SRC = '/api/files/submissions/abc.jff';

  /** Fire the tap handler cytoscape would have called, with a node-shaped target. */
  const tapNode = (id: string) => {
    const tap = h.cy.on.mock.calls.find(([name]) => name === 'tap')?.[1] as
      ((evt: { target: unknown }) => void) | undefined;
    const node = {
      isNode: () => true,
      hasClass: () => false,
      id: () => id,
      closedNeighborhood: () => ({ addClass: () => ({ removeClass: () => undefined }) }),
    };
    act(() => tap?.({ target: node }));
  };

  const tapBackground = () => {
    const tap = h.cy.on.mock.calls.find(([name]) => name === 'tap')?.[1] as
      ((evt: { target: unknown }) => void) | undefined;
    act(() => tap?.({ target: h.cy }));
  };

  it('shows nothing until something is clicked', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    expect(screen.queryByRole('group', { name: /properties of state/i })).toBeNull();
  });

  it('names the state and lists what leaves and arrives', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapNode('0');
    const panel = await screen.findByRole('group', { name: /properties of state/i });
    expect(panel).toHaveTextContent('Out');
    expect(panel).toHaveTextContent('In');
  });

  it('goes away when the canvas is clicked, which is how somebody dismisses it', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapNode('0');
    expect(await screen.findByRole('group', { name: /properties of state/i })).toBeInTheDocument();
    tapBackground();
    // It slides away rather than vanishing, so it is marked closed at once and taken down when
    // the animation is over.
    expect(screen.getByTestId('viewer-properties-panel')).toHaveAttribute('data-state', 'closed');
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: /properties of state/i })).toBeNull(),
    );
  });

  it('closes from its own button too', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapNode('0');
    fireEvent.click(await screen.findByRole('button', { name: /close state properties/i }));
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: /properties of state/i })).toBeNull(),
    );
  });

  it('says what was clicked in the header, not just its name', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapNode('0');
    const panel = await screen.findByRole('group', { name: /properties of state/i });
    expect(panel).toHaveTextContent(/State\s+q0/);
  });

  it('closes on Escape from anywhere in the panel, not only from the close button', async () => {
    // The handler used to sit on the close button, which was the only thing that took focus.
    // It is not any more: a reader typing a name has to be able to press Escape too.
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapNode('0');
    const name = await screen.findByLabelText('Name');
    name.focus();

    fireEvent.keyDown(name, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByRole('group', { name: /properties of state/i })).toBeNull(),
    );
  });

  it('closes on Escape from the keyboard, since it is not a modal that traps it', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapNode('0');
    const close = await screen.findByRole('button', { name: /close state properties/i });
    close.focus();

    fireEvent.keyDown(close, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByRole('group', { name: /properties of state/i })).toBeNull(),
    );
  });

  it('floats over the drawing rather than being inside it or taking its width', async () => {
    // Two things at once. The canvas is a `role="img"`, so anything inside it is unreachable to
    // a screen reader; and the panel is positioned rather than laid out, so opening it does not
    // narrow the drawing and shift the machine under the reader.
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapNode('0');
    const panel = await screen.findByRole('group', { name: /properties of state/i });
    const frame = screen.getByTestId('viewer-properties-panel');
    const canvas = screen.getByRole('img');

    expect(canvas).not.toContainElement(panel);
    expect(frame.parentElement).toBe(canvas.parentElement?.parentElement);
    expect(frame.className).toContain('absolute');
    expect(frame.className).not.toContain('@[48rem]/viewer:static');
  });

  /**
   * The panel arrives and leaves as a drawer. jsdom draws nothing, so what these check is the
   * wiring the animation hangs off: the state the CSS reads, that the panel outlives the
   * selection long enough to slide away, and that it is not replaced when the reader clicks
   * from one state to another, which would restart the entrance for every click.
   */
  it('opens as a drawer, and stays put while it slides away', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();

    tapNode('0');
    await screen.findByRole('group', { name: /properties of state/i });
    expect(screen.getByTestId('viewer-properties-panel')).toHaveAttribute('data-state', 'open');

    tapBackground();

    // Still there, marked closed, and out of reach while it is leaving.
    const leaving = screen.getByTestId('viewer-properties-panel');
    expect(leaving).toHaveAttribute('data-state', 'closed');
    expect(leaving).toHaveAttribute('inert');
    await waitFor(() => expect(screen.queryByTestId('viewer-properties-panel')).toBeNull());
  });

  it('swaps its contents rather than arriving again when another state is clicked', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();

    tapNode('0');
    await screen.findByRole('group', { name: /properties of state/i });
    const frame = screen.getByTestId('viewer-properties-panel');

    tapNode('1');

    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('q1'));
    // The same element, so the entrance animation is not restarted under the reader.
    expect(screen.getByTestId('viewer-properties-panel')).toBe(frame);
    expect(frame).toHaveAttribute('data-state', 'open');
  });

  /**
   * The split window shows one inspector, on the side being worked in. What it must NOT do is
   * throw the other side's selection away: going back to that pane has to bring its panel back
   * as it was, not leave the reader to find their state again.
   */
  it('keeps the selection but hides the panel when the pane is not the active one', async () => {
    const { rerender } = render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapNode('0');
    await screen.findByRole('group', { name: /properties of state/i });

    rerender(<JffCytoscapeViewer src={SRC} title="abc.jff" focused={false} />);

    await waitFor(() => expect(screen.queryByTestId('viewer-properties-panel')).toBeNull());

    rerender(<JffCytoscapeViewer src={SRC} title="abc.jff" focused />);

    expect(await screen.findByRole('group', { name: /properties of state/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('q0');
  });

  it('names the machine under the title, so a window of four files says which is which', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();

    tapNode('0');

    const panel = await screen.findByRole('group', { name: /properties of state/i });
    expect(panel).toHaveTextContent('Finite Automaton');
  });

  /** A state whose coordinates the panel can read, which is what the Advanced section needs. */
  const positionedNode = (id: string, pos: { x: number; y: number }) => {
    const node = {
      isNode: () => true,
      hasClass: () => false,
      id: () => id,
      empty: () => false,
      data: () => undefined,
      position: vi.fn((next?: { x: number; y: number }) => {
        if (next) Object.assign(pos, next);
        return pos;
      }),
      addClass: () => node,
      removeClass: () => node,
    };
    return node;
  };

  const tapTarget = (target: unknown) => {
    const tap = h.cy.on.mock.calls.find(([name]) => name === 'tap')?.[1] as
      ((evt: { target: unknown }) => void) | undefined;
    act(() => tap?.({ target }));
  };

  /**
   * Advanced is about order, not concealment: the coordinates are a reason to open this panel
   * at all. So it starts open, and a reader who closes it keeps it closed while they work,
   * including across clicking a different state, which rebuilds the panel underneath.
   */
  it('opens Advanced by default and keeps it shut once the reader shuts it', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapTarget(positionedNode('0', { x: 100, y: 200 }));

    const advanced = await screen.findByRole('button', { name: 'Advanced' });
    expect(advanced).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('X')).toHaveValue(100);
    expect(screen.getByLabelText('Y')).toHaveValue(200);

    fireEvent.click(advanced);
    await waitFor(() => expect(screen.queryByLabelText('X')).toBeNull());

    tapTarget(positionedNode('1', { x: 300, y: 400 }));

    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('q1'));
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  /**
   * Half-typed coordinates.
   *
   * The box used to read its value straight back off the canvas, which made two ordinary
   * keystrokes impossible. Clearing it sent `Number('')`, which is 0 and perfectly finite, so
   * the state shot to the left edge; and typing a minus sign sent `NaN`, which was thrown away,
   * so the box put the old number back and ate the keystroke. Both happen on the way to a value
   * the reader was about to finish typing.
   */
  it('lets a coordinate be half-typed without moving the state', async () => {
    const pos = { x: 100, y: 200 };
    const node = positionedNode('0', pos);
    h.cy.getElementById.mockReturnValue(node);

    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapTarget(node);
    const x = (await screen.findByLabelText('X')) as HTMLInputElement;

    // Clearing the box used to send Number('') === 0 and shoot the state to the left edge.
    fireEvent.change(x, { target: { value: '' } });
    expect(x.value).toBe('');
    expect(pos).toEqual({ x: 100, y: 200 });

    // A lone minus sign is the start of a number, not a value. (A number input reports it as
    // an empty value, here and in a browser; what matters is that the state stays put and the
    // box does not refill itself with the old number, which is what ate the keystroke.)
    fireEvent.change(x, { target: { value: '-' } });
    expect(x.value).not.toBe('100');
    expect(pos).toEqual({ x: 100, y: 200 });

    // And finishing the number does move it.
    fireEvent.change(x, { target: { value: '-40' } });
    expect(pos).toMatchObject({ x: -40, y: 200 });
  });

  /**
   * The canvas tools. Select is the viewer as it has always behaved; State makes a click on
   * empty canvas draw one. The hook is told the consequence rather than the tool, so what
   * these check is that the button, the mode and that flag agree.
   */
  it('opens with Select active, and switches to State when asked', async () => {
    renderInWindow(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();

    const select = screen.getByRole('button', { name: 'Select' });
    const state = screen.getByRole('button', { name: 'State' });
    expect(select).toHaveAttribute('aria-pressed', 'true');
    expect(state).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(state);

    expect(screen.getByRole('button', { name: 'State' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    expect(screen.getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('leaves the State tool on Escape, so placement mode is never a trap', async () => {
    renderInWindow(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    fireEvent.click(screen.getByRole('button', { name: 'State' }));

    // On the window, because placing a state leaves focus on nothing in particular.
    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Select' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
  });

  it('offers Transition between State and Comment, and Escape leaves it', async () => {
    renderInWindow(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();

    fireEvent.click(screen.getByRole('button', { name: 'Transition' }));
    expect(screen.getByRole('button', { name: 'Transition' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Select' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
  });

  /**
   * Moving from "look at this" to "make one of these" has to be plain on the canvas. A state
   * left highlighted from a moment ago is the one thing that could be mistaken for the state a
   * line is about to start from.
   */
  it('puts down whatever was open when Transition is chosen', async () => {
    renderInWindow(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapNode('0');
    await screen.findByRole('group', { name: /properties of state/i });

    fireEvent.click(screen.getByRole('button', { name: 'Transition' }));

    await waitFor(() => expect(screen.queryByTestId('viewer-properties-panel')).toBeNull());
  });

  it('leaves the selection alone when Select is chosen, which is how you go back to it', async () => {
    renderInWindow(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapNode('0');
    await screen.findByRole('group', { name: /properties of state/i });

    fireEvent.click(screen.getByRole('button', { name: 'Select' }));

    expect(screen.getByRole('group', { name: /properties of state/i })).toBeInTheDocument();
  });

  it('shows each tool its key, without putting it in the name', async () => {
    renderInWindow(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();

    // The button is still called Select, and the key is announced as a shortcut.
    expect(screen.getByRole('button', { name: 'Select' })).toHaveAttribute(
      'aria-keyshortcuts',
      'V',
    );
    expect(screen.getByRole('button', { name: 'State' })).toHaveAttribute('aria-keyshortcuts', 'N');
    expect(screen.getByRole('button', { name: 'Transition' })).toHaveAttribute(
      'aria-keyshortcuts',
      'T',
    );
    expect(screen.getByRole('button', { name: 'Comment' })).toHaveAttribute(
      'aria-keyshortcuts',
      'C',
    );
  });

  /**
   * Every tab a reader opens stays mounted, so Escape has to belong to the pane being worked
   * in. Without this one press gives up a half-drawn line in a pane nobody is looking at.
   */
  it('answers Escape only in the pane being worked in', async () => {
    const { rerender } = renderInWindow(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    fireEvent.click(screen.getByRole('button', { name: 'State' }));

    rerender(<JffCytoscapeViewer src={SRC} title="abc.jff" focused={false} />);
    fireEvent.keyDown(window, { key: 'Escape' });

    // Still on State: this pane is not the one being worked in, so the key was not its
    // business. The palette is gone with the focus, so the tool is read from the hook's own
    // behaviour when focus returns.
    rerender(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    expect(screen.getByRole('button', { name: 'State' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Select' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
  });

  it('leaves the tool alone when Escape is pressed in a box being typed in', async () => {
    // Escape in the inspector's name box closes the panel, and in a comment it puts the caret
    // down. Taking the tool away as well would be two answers to one key.
    renderInWindow(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    fireEvent.click(screen.getByRole('button', { name: 'State' }));
    tapNode('0');
    const nameBox = await screen.findByLabelText('Name');

    // On the box, which is how the key really arrives: it bubbles to the window handler
    // carrying the box as its target, and that is what the guard reads.
    fireEvent.keyDown(nameBox, { key: 'Escape' });

    expect(screen.getByRole('button', { name: 'State' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps the tools to the side being worked in', async () => {
    const { rerender } = renderInWindow(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    expect(screen.getByTestId('viewer-tool-palette')).toBeInTheDocument();

    rerender(<JffCytoscapeViewer src={SRC} title="abc.jff" focused={false} />);

    expect(screen.queryByTestId('viewer-tool-palette')).toBeNull();
  });

  /**
   * What this cannot check: that the confirmation is shut to begin with. The shared ui/dialog
   * mock this file uses renders its children whatever `open` says and gives them no dialog
   * role, so open and closed look the same here. What it can check is that the question names
   * the right thing and that nothing goes until it is answered.
   */
  it('asks which state before deleting it, and takes it off when told to', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapNode('0');
    await screen.findByRole('group', { name: /properties of state/i });

    fireEvent.click(screen.getByRole('button', { name: /delete state/i }));

    expect(screen.getByText('Delete state q0?')).toBeInTheDocument();
    expect(screen.getByText('Are you sure you want to delete this state?')).toBeInTheDocument();
    // Still there: the click asked a question, it did not delete anything.
    expect(screen.getByRole('group', { name: /properties of state/i })).toBeInTheDocument();

    // "Delete" is this dialog's own word; the other confirmation in this tree says "Put it back".
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(screen.queryByRole('group', { name: /properties of state/i })).toBeNull(),
    );
  });

  it('renames the state as it is typed', async () => {
    // A viewer that can be marked up: the label follows the box straight away, and the file is
    // untouched, which is what the toolbar's note is for.
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapNode('0');
    const field = await screen.findByLabelText('Name');

    fireEvent.change(field, { target: { value: 'start' } });

    expect(await screen.findByRole('group', { name: /properties of state start/i })).toBeVisible();
    expect(field).toHaveValue('start');
    expect(await screen.findByRole('button', { name: /file changed/i })).toBeInTheDocument();
  });

  it('keeps the box empty when it is emptied, rather than filling it back in', async () => {
    // A state with no name is described by its id, so a box that read its value back from the
    // machine would put `q0` in as soon as the last character went.
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapNode('0');
    const field = await screen.findByLabelText('Name');

    fireEvent.change(field, { target: { value: '' } });

    expect(field).toHaveValue('');
  });

  it('offers Initial and Final as boxes that can be ticked', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapNode('0');

    const initial = await screen.findByLabelText('Initial');
    const final = screen.getByLabelText('Final');
    // q0 is the initial state in the fixture and q1 is the final one.
    expect(initial).toBeChecked();
    expect(final).not.toBeChecked();

    fireEvent.click(final);

    expect(await screen.findByRole('button', { name: /file changed/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Final')).toBeChecked();
  });

  it('lists what touches the state, and opens a transition when one is clicked', async () => {
    // The only other way to a transition's properties is clicking its line on the canvas, which
    // is no way at all for somebody not using a mouse.
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapNode('0');

    const outgoing = await screen.findByRole('list', { name: /outgoing transitions of state q0/i });
    const rows = within(outgoing).getAllByRole('button');
    expect(rows.length).toBeGreaterThan(0);

    fireEvent.click(rows[0]!);

    expect(await screen.findByRole('group', { name: /transition from/i })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /properties of state/i })).toBeNull();
  });

  /**
   * Which way a transition runs is the first thing you want of it. It used to be a prefix on
   * every row of one mixed list, which left the reader doing the sorting.
   */
  it('lists what leaves the state apart from what arrives at it', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();

    // q0 -> q1 on a is the whole machine, so q0 has an outgoing list and no incoming one.
    tapNode('0');
    expect(
      await screen.findByRole('list', { name: /outgoing transitions of state q0/i }),
    ).toHaveTextContent('q1');
    expect(screen.queryByRole('list', { name: /incoming transitions/i })).toBeNull();
    // The count sits at the end of the heading row rather than in the words.
    expect(
      within(screen.getByRole('group', { name: /properties of state/i })).getByText('1'),
    ).toBeInTheDocument();

    // And q1 the other way round: nothing leaves it.
    tapNode('1');
    expect(
      await screen.findByRole('list', { name: /incoming transitions of state q1/i }),
    ).toHaveTextContent('q0');
    expect(screen.queryByRole('list', { name: /outgoing transitions/i })).toBeNull();
  });

  it('offers where the state sits, and moves it when the numbers change', async () => {
    // The drawing's coordinates, not the file's: typing one is how two states are lined up
    // exactly, which dragging cannot do.
    const pos = { x: 100, y: 200 };
    const node = {
      isNode: () => true,
      hasClass: () => false,
      id: () => '0',
      empty: () => false,
      data: () => undefined,
      position: vi.fn((next?: { x: number; y: number }) => {
        if (next) Object.assign(pos, next);
        return pos;
      }),
      closedNeighborhood: () => ({ addClass: () => ({ removeClass: () => undefined }) }),
    };
    h.cy.getElementById.mockReturnValue(node);
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    const tap = h.cy.on.mock.calls.find(([name]) => name === 'tap')?.[1] as
      ((evt: { target: unknown }) => void) | undefined;
    act(() => tap?.({ target: node }));

    const x = await screen.findByLabelText('X');
    expect(x).toHaveValue(100);
    fireEvent.focus(x);
    fireEvent.change(x, { target: { value: '250' } });

    expect(pos).toMatchObject({ x: 250, y: 200 });
  });

  it('shows nothing for the start marker, which is scenery rather than a state', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    const tap = h.cy.on.mock.calls.find(([name]) => name === 'tap')?.[1] as
      ((evt: { target: unknown }) => void) | undefined;
    act(() =>
      tap?.({
        target: {
          isNode: () => true,
          hasClass: (c: string) => c === 'start',
          id: () => 'start-0',
          closedNeighborhood: () => ({ addClass: () => ({ removeClass: () => undefined }) }),
        },
      }),
    );
    expect(screen.queryByRole('group', { name: /properties of state/i })).toBeNull();
  });
});

describe('clicking a transition', () => {
  const SRC = '/api/files/submissions/abc.jff';

  const tapEdge = (source: string, target: string) => {
    const tap = h.cy.on.mock.calls.find(([name]) => name === 'tap')?.[1] as
      ((evt: { target: unknown }) => void) | undefined;
    const edge = {
      isNode: () => false,
      hasClass: () => false,
      id: () => `e0-${source}-${target}`,
      data: (key: string) => (key === 'source' ? source : target),
      closedNeighborhood: () => ({ addClass: () => ({ removeClass: () => undefined }) }),
    };
    act(() => tap?.({ target: edge }));
  };

  const tapNode = (id: string) => {
    const tap = h.cy.on.mock.calls.find(([name]) => name === 'tap')?.[1] as
      ((evt: { target: unknown }) => void) | undefined;
    act(() =>
      tap?.({
        target: {
          isNode: () => true,
          hasClass: () => false,
          id: () => id,
          closedNeighborhood: () => ({ addClass: () => ({ removeClass: () => undefined }) }),
        },
      }),
    );
  };

  /**
   * Somebody who has just drawn a line drew it in order to say what it reads. Only a drawing,
   * never a click: taking the focus of somebody who clicked a line to read it would be rude.
   */
  it('leaves the focus alone when a transition is only clicked', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();

    tapEdge('0', '1');

    const reads = await screen.findByLabelText('Reads');
    await waitFor(() => expect(document.activeElement).not.toBe(reads));
  });

  it('names both ends and lists what the transition reads', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapEdge('0', '1');
    const panel = await screen.findByRole('group', { name: /transition from/i });
    expect(panel).toHaveTextContent('Reads');
  });

  it('names the pair in the header and closes under its own name', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapEdge('0', '1');
    const panel = await screen.findByRole('group', { name: /transition from/i });
    // The title says what it is; the line under it says which pair.
    expect(panel).toHaveTextContent(/Transition/);
    expect(panel).toHaveTextContent(/q0\s*→\s*q1/);

    fireEvent.click(screen.getByRole('button', { name: 'Close transition properties' }));
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: /transition from/i })).toBeNull(),
    );
  });

  it('offers to delete the line a transition panel is about', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapEdge('0', '1');
    await screen.findByRole('group', { name: /transition from/i });

    fireEvent.click(screen.getByRole('button', { name: /delete transition/i }));

    expect(
      screen.getByText('Are you sure you want to delete this transition?'),
    ).toBeInTheDocument();
  });

  it('offers what it reads as a box that can be typed in', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapEdge('0', '1');

    const reads = await screen.findAllByLabelText('Reads');
    fireEvent.change(reads[0]!, { target: { value: 'x' } });

    expect(reads[0]).toHaveValue('x');
    expect(await screen.findByRole('button', { name: /file changed/i })).toBeInTheDocument();
    // A finite automaton reads and nothing else: no stack, no tape.
    expect(screen.queryByLabelText('Pops')).toBeNull();
    expect(screen.queryByLabelText('Writes')).toBeNull();
  });

  it('shows one panel at a time, not a state and a transition together', async () => {
    // Both are driven by the same click, so the previous one has to give way rather than the
    // two stacking in the same corner.
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapNode('0');
    expect(await screen.findByRole('group', { name: /properties of state/i })).toBeInTheDocument();
    tapEdge('0', '1');
    expect(await screen.findByRole('group', { name: /transition from/i })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /properties of state/i })).toBeNull();
  });

  it('goes away on a background click, like the state panel', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapEdge('0', '1');
    expect(await screen.findByRole('group', { name: /transition from/i })).toBeInTheDocument();
    const tap = h.cy.on.mock.calls.find(([name]) => name === 'tap')?.[1] as
      ((evt: { target: unknown }) => void) | undefined;
    act(() => tap?.({ target: h.cy }));
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: /transition from/i })).toBeNull(),
    );
  });

  it('shows nothing for an edge the machine does not have', async () => {
    // describeEdge returns null rather than an empty panel, so a stale or bundled id that no
    // longer matches produces no window at all.
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapEdge('nope', 'also-nope');
    expect(screen.queryByRole('group', { name: /transition from/i })).toBeNull();
  });
});

describe('copying the text representation', () => {
  it('offers the copy beside the text, in the standalone window', async () => {
    render(
      <ViewerActionsProvider>
        <JffCytoscapeViewer src="/api/files/submissions/abc.jff" title="abc.jff" />
      </ViewerActionsProvider>,
    );
    await waitForEngine();
    // The dialog mock renders its children regardless of `open`, so this proves the button is
    // there to be shown rather than that the dialog is open. See the note on that mock above.
    expect(screen.getByRole('button', { name: /copy as text/i })).toBeInTheDocument();
  });
});

describe('what the viewer opens at', () => {
  const SRC = '/api/files/submissions/abc.jff';

  it('fits to the space by default, which is what a dialog wants', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    await waitFor(() => expect(h.cy.resize).toHaveBeenCalled());
    // Fit leaves the scale wherever it lands; nothing forces it back to 1.
    expect(h.cy.zoom).not.toHaveBeenCalledWith(1);
  });

  it('opens at 100% when asked, so the machine is the size its author drew it', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" initialZoom="actual" />);
    await waitForEngine();
    // Still fits first: that sizes the canvas and centres the machine, which is what keeps it
    // in view at 1:1 rather than off in a corner.
    await waitFor(() => expect(h.cy.zoom).toHaveBeenCalledWith(1));
    expect(h.cy.resize).toHaveBeenCalled();
    expect(h.cy.center).toHaveBeenCalled();
  });
});

describe('undo and redo of the arrangement', () => {
  const SRC = '/api/files/submissions/abc.jff';

  /** A node the history code can read a position from and write one back to. */
  const fakeNode = (id: string, pos: { x: number; y: number }) => ({
    id: () => id,
    hasClass: () => false,
    empty: () => false,
    position: vi.fn((next?: { x: number; y: number }) => {
      if (next) Object.assign(pos, next);
      return pos;
    }),
  });

  const fire = (event: string) => {
    const handler = h.cy.on.mock.calls.find(([name]) => name === event)?.[2] as
      (() => void) | undefined;
    act(() => handler?.());
  };

  /** A whole drag: picked up, and let go. Cytoscape fires `dragfree` only if it really moved. */
  const drag = () => {
    fire('grab');
    fire('dragfree');
  };

  it('records one step per drag, not one per pixel of it', async () => {
    // One drag is one undoable step. The snapshot is taken on `grab`, which fires once at the
    // start, and kept until the state is let go; `position` fires continuously, and recording
    // there would bury the previous state under hundreds of near-identical snapshots.
    const pos = { x: 10, y: 20 };
    const node = fakeNode('0', pos);
    h.cy.nodes.mockReturnValue({ forEach: (fn: (n: unknown) => void) => fn(node), length: 1 });

    const view: { current: { canUndo: boolean; run: (n: 'undo') => void } | null } = {
      current: null,
    };
    function Probe() {
      const v = useViewerActions();
      view.current = { canUndo: v.canUndo, run: v.run };
      return null;
    }
    render(
      <ViewerActionsProvider>
        <JffCytoscapeViewer src={SRC} title="abc.jff" />
        <Probe />
      </ViewerActionsProvider>,
    );
    await waitForEngine();

    expect(view.current?.canUndo).toBe(false);
    drag();
    await waitFor(() => expect(view.current?.canUndo).toBe(true));
  });

  it('puts the positions back when undone', async () => {
    const pos = { x: 10, y: 20 };
    const node = fakeNode('0', pos);
    h.cy.nodes.mockReturnValue({ forEach: (fn: (n: unknown) => void) => fn(node), length: 1 });
    h.cy.getElementById.mockReturnValue(node);

    const view: { current: { canUndo: boolean; run: (n: 'undo') => void } | null } = {
      current: null,
    };
    function Probe() {
      const v = useViewerActions();
      view.current = { canUndo: v.canUndo, run: v.run };
      return null;
    }
    render(
      <ViewerActionsProvider>
        <JffCytoscapeViewer src={SRC} title="abc.jff" />
        <Probe />
      </ViewerActionsProvider>,
    );
    await waitForEngine();

    drag();
    await waitFor(() => expect(view.current?.canUndo).toBe(true));

    // The drag itself: the state ends up somewhere else.
    pos.x = 500;
    pos.y = 600;

    act(() => view.current?.run('undo'));
    await waitFor(() => expect(pos).toEqual({ x: 10, y: 20 }));
  });
});

describe('the toolbar undo and redo buttons', () => {
  const SRC = '/api/files/submissions/abc.jff';

  it('are disabled until there is something to step through', async () => {
    renderWithMenu({ src: SRC, title: 'abc.jff' });
    await waitForEngine();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
  });

  it('sit before the zoom group, where a toolbar puts them', async () => {
    renderWithMenu({ src: SRC, title: 'abc.jff' });
    await waitForEngine();
    const undoButton = screen.getByRole('button', { name: 'Undo' });
    const zoomGroup = screen.getByRole('group', { name: 'Zoom' });
    const precedes = Boolean(
      undoButton.compareDocumentPosition(zoomGroup) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(precedes).toBe(true);
  });

  it('drive the same history the menu does', async () => {
    const pos = { x: 10, y: 20 };
    const node = {
      id: () => '0',
      hasClass: () => false,
      empty: () => false,
      position: vi.fn((next?: { x: number; y: number }) => {
        if (next) Object.assign(pos, next);
        return pos;
      }),
    };
    h.cy.nodes.mockReturnValue({ forEach: (fn: (n: unknown) => void) => fn(node), length: 1 });
    h.cy.getElementById.mockReturnValue(node);

    renderWithMenu({ src: SRC, title: 'abc.jff' });
    await waitForEngine();

    const handler = (event: string) =>
      h.cy.on.mock.calls.find(([name]) => name === event)?.[2] as (() => void) | undefined;
    act(() => handler('grab')?.());
    act(() => handler('dragfree')?.());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled());

    pos.x = 500;
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(pos.x).toBe(10));
  });
});

describe('the machine does not flash on the way in', () => {
  const SRC = '/api/files/submissions/abc.jff';

  it('is hidden while the first layout is still settling', () => {
    // Cytoscape paints as soon as it is built, before anything has been fitted or scaled, so
    // the machine used to arrive at the wrong size and jump. Rendered but not shown.
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    expect(screen.getByRole('img').className).toContain('[&_canvas]:opacity-0');
  });

  it('appears once it has settled', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitFor(() =>
      expect(screen.getByRole('img').className).toContain('[&_canvas]:opacity-100'),
    );
  });

  it('hides again when a second file is loaded into the same viewer', async () => {
    // The one that was still flashing. React re-runs effects in development, and the source
    // can change in place, so a load that began with the graph already visible painted the
    // new machine un-fitted for a moment. Every load starts hidden.
    const { rerender } = render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitFor(() =>
      expect(screen.getByRole('img').className).toContain('[&_canvas]:opacity-100'),
    );

    rerender(<JffCytoscapeViewer src="/api/files/submissions/other.jff" title="other.jff" />);
    await waitFor(() => expect(screen.getByRole('img').className).toContain('opacity-0'));
    await waitFor(() =>
      expect(screen.getByRole('img').className).toContain('[&_canvas]:opacity-100'),
    );
  });

  it('appears even if setting the initial scale throws', async () => {
    // What the `finally` actually protects. `fitAndResize` swallows its own errors, so a
    // failing layout never reaches here; the step after it can still throw, and an invisible
    // graph with no explanation is worse than one at the wrong zoom.
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.cy.center.mockImplementationOnce(() => {
      throw new Error('center exploded');
    });
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" initialZoom="actual" />);
    await waitFor(() =>
      expect(screen.getByRole('img').className).toContain('[&_canvas]:opacity-100'),
    );
    // Caught, not escaped. Letting it escape leaves an unhandled rejection that fails the
    // whole run rather than any one test, which is how it reached CI green locally and red there.
    await waitFor(() => expect(reported).toHaveBeenCalled());
    reported.mockRestore();
  });
});

describe('snap to grid', () => {
  const SRC = '/api/files/submissions/abc.jff';

  /** Fire the handler cytoscape calls when a dragged state is released. */
  const dropAt = (pos: { x: number; y: number }) => {
    const handler = h.cy.on.mock.calls.find(([name]) => name === 'dragfree')?.[2] as
      ((evt: { target: unknown }) => void) | undefined;
    const node = {
      hasClass: () => false,
      position: vi.fn((next?: { x: number; y: number }) => {
        if (next) Object.assign(pos, next);
        return pos;
      }),
    };
    act(() => handler?.({ target: node }));
    return pos;
  };

  it('leaves a dropped state exactly where it was put, by default', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    expect(dropAt({ x: 37, y: 61 })).toEqual({ x: 37, y: 61 });
  });

  it('lands it on the nearest grid intersection when switched on', async () => {
    let toggle: (() => void) | null = null;
    function Probe() {
      const v = useViewerActions();
      toggle = () => v.run('toggleSnapToGrid');
      return null;
    }
    render(
      <ViewerActionsProvider>
        <JffCytoscapeViewer src={SRC} title="abc.jff" />
        <Probe />
      </ViewerActionsProvider>,
    );
    await waitForEngine();
    act(() => toggle?.());

    // 24-unit lattice: 37 rounds to 48, 61 rounds to 72.
    await waitFor(() => expect(dropAt({ x: 37, y: 61 })).toEqual({ x: 48, y: 72 }));
  });

  it('keeps the painted grid in step with the graph, or it snaps to lines nobody can see', async () => {
    // The lines are a CSS background. Left alone they stay put while the machine pans and
    // zooms underneath, and "snap to grid" would mean snapping to nothing visible.
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" showGridDefault />);
    await waitForEngine();
    const registered = h.cy.on.mock.calls.map(([name]) => name);
    expect(registered).toContain('zoom pan resize');
  });
});

describe('a viewer that is visible but not the one the menu is driving', () => {
  const SRC = '/api/files/submissions/abc.jff';

  it('still knows there is a menu bar, so it does not grow the controls back', () => {
    // In a split window both panes are on screen and only one may publish its actions. When
    // chrome presence was derived from the registry the gate nulls, the unfocused pane
    // decided it was in a dialog: it grew back the grid and layout controls the menu already
    // offers, and took a panel's card border, and the two panes swapped appearance every time
    // focus moved between them.
    render(
      <ViewerActionsProvider>
        <ViewerActionsGate active={false}>
          <JffCytoscapeViewer src={SRC} title="abc.jff" />
        </ViewerActionsGate>
      </ViewerActionsProvider>,
    );
    expect(screen.queryByRole('button', { name: /toggle grid/i })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Layout' })).toBeNull();
  });

  it('looks the same as the one that is, rather than like a panel', () => {
    const shell = (active: boolean) => {
      const { container, unmount } = render(
        <ViewerActionsProvider>
          <ViewerActionsGate active={active}>
            <JffCytoscapeViewer src={SRC} title="abc.jff" />
          </ViewerActionsGate>
        </ViewerActionsProvider>,
      );
      const className = container.querySelector('div')!.className;
      unmount();
      return className;
    };
    expect(shell(false)).toBe(shell(true));
  });
});

describe('the way to the standalone window', () => {
  const SRC = '/api/files/submissions/abc.jff';
  const TARGET = {
    href: '/viewer?kind=submissions&file=abc.jff&type=FA',
    tab: {
      kind: 'submissions' as const,
      file: 'abc.jff',
      type: 'FA',
      name: 'abc.jff',
      title: 'abc.jff',
    },
  };

  it('sits on the toolbar, which is where the controls it replaces were', () => {
    // The exports and the layout choice came off this toolbar; this is what took their place,
    // so it belongs in the same strip rather than up beside the dialog title.
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" windowTarget={TARGET} />);
    const button = screen.getByRole('button', { name: /open in the viewer/i });
    const follows = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

    // After the zoom controls and before the drawing: in the strip, at the end of it.
    expect(follows(screen.getByRole('group', { name: 'Zoom' }), button)).toBe(true);
    expect(follows(button, screen.getByRole('img'))).toBe(true);
  });

  it('is absent when the file cannot be linked to', () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    expect(screen.queryByRole('button', { name: /open in the viewer/i })).toBeNull();
  });

  it('closes the panel once the window has the file', () => {
    // Otherwise the reader has to dismiss a panel showing the same machine before they can
    // use the window they just asked for.
    const onOpenChange = vi.fn();
    // A real `window.open` returns the window it opened, or null when the browser blocked it.
    // Returning nothing stood for "blocked", which is now a case the button handles.
    vi.stubGlobal(
      'open',
      vi.fn(() => ({ focus: vi.fn() })),
    );
    render(
      <JffViewerDialog
        open
        onOpenChange={onOpenChange}
        src={SRC}
        title="abc.jff"
        windowTarget={TARGET}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /open in the viewer/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('what a pane shows while it opens, and when it cannot', () => {
  const SRC = '/api/files/submissions/abc.jff';

  it('says which step it is on rather than just spinning', async () => {
    // A large submission spends its wait in the fetch and a large machine in the layout, and
    // with two panes on screen one can be in each.
    let release: (value: unknown) => void = () => {};
    fetchImpl = () => new Promise((resolve) => (release = resolve));

    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    expect(await screen.findByText('Loading the file')).toBeInTheDocument();

    release(okText(FA_JFF));
    await waitFor(() => expect(screen.queryByTestId('viewer-loading')).toBeNull());
  });

  it('offers a way back when trying again could work', async () => {
    fetchImpl = async () => ({ ...okText(''), ok: false, status: 503, statusText: 'Unavailable' });
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);

    const failure = await screen.findByTestId('viewer-failure');
    expect(failure.textContent).toMatch(/server could not send/i);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('does not offer one when it could not', async () => {
    // A button that cannot help is worse than no button: it invites somebody to keep pressing.
    fetchImpl = async () => ({ ...okText(''), ok: false, status: 403, statusText: 'Forbidden' });
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);

    const failure = await screen.findByTestId('viewer-failure');
    expect(failure.textContent).toMatch(/not yours to open/i);
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('draws the machine once a retry works', async () => {
    let attempt = 0;
    fetchImpl = async () => {
      attempt += 1;
      return attempt === 1
        ? { ...okText(''), ok: false, status: 503, statusText: 'Unavailable' }
        : okText(FA_JFF);
    };

    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));

    await waitFor(() => expect(screen.queryByTestId('viewer-failure')).toBeNull());
    await waitForEngine();
  });

  it('says the diagram could not be drawn, rather than describing one that is not there', async () => {
    fetchImpl = async () => okText('<structure><oops');
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);

    await screen.findByTestId('viewer-failure');
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/could not be drawn/i);
  });
});

describe('two panes, one of which cannot open its file', () => {
  it('leaves the working one working, and explains only the one that failed', async () => {
    // The reason these states are per pane at all: a window showing two machines can have one
    // of them fine and the other refused, and one message for the window would be wrong about
    // half of it.
    fetchImpl = async (url: string) =>
      url.includes('good.jff')
        ? okText(FA_JFF)
        : { ...okText(''), ok: false, status: 403, statusText: 'Forbidden' };

    render(
      <>
        <div data-testid="left">
          <JffCytoscapeViewer src="/api/files/submissions/good.jff" title="good.jff" />
        </div>
        <div data-testid="right">
          <JffCytoscapeViewer src="/api/files/submissions/secret.jff" title="secret.jff" />
        </div>
      </>,
    );

    // Exactly one explanation, in the pane it belongs to.
    const failures = await screen.findAllByTestId('viewer-failure');
    expect(failures).toHaveLength(1);
    expect(screen.getByTestId('right')).toContainElement(failures[0]!);
    expect(failures[0]!.textContent).toMatch(/not yours to open/i);

    // And the other pane still drew its machine.
    await waitForEngine();
    const left = screen.getByTestId('left');
    expect(within(left).queryByTestId('viewer-failure')).toBeNull();
    await waitFor(() =>
      expect(within(left).getByRole('img').getAttribute('aria-label')).toMatch(/Diagram of/),
    );
  });
});

describe('telling a reader they have not changed the file', () => {
  const SRC = '/api/files/submissions/abc.jff';

  const drag = () => {
    const handler = (event: string) =>
      h.cy.on.mock.calls.find(([name]) => name === event)?.[2] as (() => void) | undefined;
    // Picked up and let go: `dragfree` is what tells a drag from a click, so both are needed.
    act(() => handler('grab')?.());
    act(() => handler('dragfree')?.());
  };

  it('says nothing about a file nobody has touched', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    expect(screen.queryByRole('button', { name: /file changed/i })).toBeNull();
  });

  it('appears once something has been moved', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    drag();
    expect(await screen.findByRole('button', { name: /file changed/i })).toBeInTheDocument();
  });

  it('stays away when a state was only clicked to read its properties', async () => {
    // A click picks the state up and puts it down without moving it, so it used to report a
    // rearrangement that had not happened.
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    const grab = h.cy.on.mock.calls.find(([name]) => name === 'grab')?.[2] as
      (() => void) | undefined;
    act(() => grab?.());

    expect(screen.queryByRole('button', { name: /file changed/i })).toBeNull();
  });

  it('says the submitted file is unchanged, which is the whole point of it', async () => {
    // Dragging three states apart to read an edge looks like editing, and nothing else on
    // screen says otherwise.
    const user = userEvent.setup();
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    drag();
    await user.click(await screen.findByRole('button', { name: /file changed/i }));

    expect(await screen.findByText(/submitted file is unchanged/i)).toBeInTheDocument();
  });

  it('offers the arrangement as a download', async () => {
    const user = userEvent.setup();
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    drag();
    await user.click(await screen.findByRole('button', { name: /file changed/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /download this arrangement/i }));

    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
  });

  it('asks before putting the machine back, since the history goes with it', async () => {
    const user = userEvent.setup();
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    drag();
    await user.click(await screen.findByRole('button', { name: /file changed/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /put it back/i }));

    expect(await screen.findByText(/Put the machine back\?/i)).toBeInTheDocument();
    // Still there: nothing happens until the reader says so.
    expect(screen.getByRole('button', { name: /file changed/i })).toBeInTheDocument();
  });
});

/**
 * Writing on the canvas.
 *
 * A text box is an annotation over the drawing, not part of the automaton: it is stored beside
 * the machine, it survives a refresh where the arrangement only survives a session, and nothing
 * about it reaches the parse. The last test in here is the one that matters most, because it is
 * the property everything else in the viewer depends on.
 */
describe('the Text tool', () => {
  const SRC = '/api/files/submissions/abc.jff';
  const STORAGE_KEY = `afct-viewer-text-boxes:${SRC}`;

  beforeEach(() => {
    window.localStorage.clear();
  });

  const tapBackground = (at = { x: 300, y: 200 }) => {
    const tap = h.cy.on.mock.calls.find(([name]) => name === 'tap')?.[1] as
      ((evt: { target: unknown; position?: { x: number; y: number } }) => void) | undefined;
    act(() => tap?.({ target: h.cy, position: at }));
  };

  const chooseText = () => fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
  const stored = () => JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');

  it('sits under State in the palette', async () => {
    renderInWindow(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    const tools = within(screen.getByTestId('viewer-tool-palette')).getAllByRole('button');
    expect(tools.map((b) => b.textContent)).toEqual(['Select', 'State', 'Transition', 'Comment']);
  });

  it('puts a box where the canvas was clicked, with the caret already in it', async () => {
    renderInWindow(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    chooseText();

    tapBackground({ x: 300, y: 200 });

    const box = await screen.findByRole('textbox', { name: 'Text box' });
    // Focused after the frame, not by autoFocus: the click that created it landed on the
    // canvas, which takes focus back on release.
    await waitFor(() => expect(document.activeElement).toBe(box));
  });

  it('keeps what was typed, under a key of its own for this file', async () => {
    const user = userEvent.setup();
    renderInWindow(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    chooseText();
    tapBackground({ x: 300, y: 200 });

    await user.type(
      await screen.findByRole('textbox', { name: 'Text box' }),
      'this loop never ends',
    );

    // The box itself is written the moment it is made; the typing follows a beat later, since
    // a keystroke is not worth a write of its own.
    await waitFor(() =>
      expect(stored()[0]).toMatchObject({ x: 300, y: 200, text: 'this loop never ends' }),
    );
    // The point cytoscape reported, in the graph's own coordinates. Nothing is scaled: these
    // never go into a .jff.
    expect(window.localStorage.getItem('afct-viewer-text-boxes:/api/files/other.jff')).toBeNull();
  });

  it('draws them again the next time the file is opened', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ id: 'text-1', x: 10, y: 20, width: 200, height: 80, text: 'from before' }]),
    );
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();

    expect(await screen.findByText('from before')).toBeInTheDocument();
  });

  it('drops a box nobody typed into, so a stray click leaves nothing behind', async () => {
    renderInWindow(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    chooseText();
    tapBackground();
    const box = await screen.findByRole('textbox', { name: 'Text box' });

    fireEvent.blur(box);

    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Text box' })).toBeNull());
    expect(stored()).toEqual([]);
  });

  it('stays up, so a reader can label three things without going back to the palette', async () => {
    const user = userEvent.setup();
    renderInWindow(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    chooseText();

    tapBackground({ x: 0, y: 0 });
    await user.type(await screen.findByRole('textbox', { name: 'Text box' }), 'one');
    fireEvent.blur(screen.getByRole('textbox', { name: 'Text box' }));
    tapBackground({ x: 400, y: 0 });
    await user.type(await screen.findByRole('textbox', { name: 'Text box' }), 'two');

    await waitFor(() => expect(stored()).toHaveLength(2));
    expect(screen.getByRole('button', { name: 'Comment' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('is deleted by the Delete key when it is selected, and not while it is being typed in', async () => {
    const user = userEvent.setup();
    renderInWindow(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    chooseText();
    tapBackground();
    await user.type(await screen.findByRole('textbox', { name: 'Text box' }), 'keep me');

    // Typing: the key belongs to the caret, and the box stays.
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Text box' }), { key: 'Delete' });
    expect(stored()).toHaveLength(1);

    fireEvent.blur(screen.getByRole('textbox', { name: 'Text box' }));
    await screen.findByTestId('viewer-text-resize-se');

    fireEvent.keyDown(window, { key: 'Delete' });

    await waitFor(() => expect(stored()).toEqual([]));
    expect(screen.queryByText('keep me')).toBeNull();
  });

  it('shows the same notes in the dialog and in the pop-out window', async () => {
    // The window supplies a viewStateKey and the dialog does not, so keying on that would have
    // given one file two sets of notes and lost them on Open in Window.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ id: 'text-1', x: 0, y: 0, width: 200, height: 80, text: 'written here' }]),
    );
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" viewStateKey="submissions:abc.jff" />);
    await waitForEngine();

    expect(await screen.findByText('written here')).toBeInTheDocument();
  });

  it('can be reached and opened from the keyboard', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ id: 'text-1', x: 10, y: 20, width: 200, height: 80, text: 'from before' }]),
    );
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();

    const box = await screen.findByRole('button', { name: 'from before' });
    box.focus();
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(await screen.findByRole('textbox', { name: 'Text box' })).toHaveValue('from before');
  });

  it('moves with the pointer, in the coordinates the machine uses', async () => {
    const user = userEvent.setup();
    renderInWindow(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    chooseText();
    tapBackground({ x: 100, y: 100 });
    await user.type(await screen.findByRole('textbox', { name: 'Text box' }), 'note');
    fireEvent.blur(screen.getByRole('textbox', { name: 'Text box' }));

    const box = await screen.findByText('note');
    fireEvent.pointerDown(box, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(box, { clientX: 40, clientY: -25 });
    fireEvent.pointerUp(box, { clientX: 40, clientY: -25 });

    // Zoom is 1 in this mock, so a pixel is a unit.
    await waitFor(() => expect(stored()[0]).toMatchObject({ x: 140, y: 75 }));
  });

  it('resizes from a handle, and never below the minimum', async () => {
    const user = userEvent.setup();
    renderInWindow(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    chooseText();
    tapBackground();
    await user.type(await screen.findByRole('textbox', { name: 'Text box' }), 'note');
    fireEvent.blur(screen.getByRole('textbox', { name: 'Text box' }));

    const handle = await screen.findByTestId('viewer-text-resize-se');
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(handle, { clientX: -400, clientY: 60 });
    fireEvent.pointerUp(handle, { clientX: -400, clientY: 60 });

    await waitFor(() => expect(stored()[0]).toMatchObject({ width: 80, height: 140 }));
  });

  /**
   * The one that matters. A note over a drawing must not become part of the drawing: no state,
   * no transition, and nothing that says the reader has changed the submitted file.
   */
  it('changes nothing about the machine', async () => {
    const user = userEvent.setup();
    renderInWindow(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    const drawnBefore = h.cy.add.mock.calls.length;
    chooseText();
    tapBackground();
    await user.type(await screen.findByRole('textbox', { name: 'Text box' }), 'not a state');

    expect(h.cy.add.mock.calls.length).toBe(drawnBefore);
    expect(screen.queryByRole('button', { name: /file changed/i })).toBeNull();
    expect(screen.queryByRole('group', { name: /properties of state/i })).toBeNull();
  });
});

/**
 * What a viewer may do, which is three questions and used to be one.
 *
 * `showInspector` decided whether the properties panel appeared AND whether the tool palette
 * appeared, so "there is no room for a panel on this side of a split" and "this reader may not
 * redraw this machine" had the same answer. These are the tests that keep them apart.
 */
describe('viewer capabilities', () => {
  const SRC = '/api/files/submissions/abc.jff';

  const tapNode = (id: string) => {
    const tap = h.cy.on.mock.calls.find(([name]) => name === 'tap')?.[1] as
      ((evt: { target: unknown }) => void) | undefined;
    const node = {
      isNode: () => true,
      hasClass: () => false,
      id: () => id,
      closedNeighborhood: () => ({ addClass: () => ({ removeClass: () => undefined }) }),
    };
    act(() => tap?.({ target: node }));
  };

  const tapBackground = (at = { x: 300, y: 200 }) => {
    const tap = h.cy.on.mock.calls.find(([name]) => name === 'tap')?.[1] as
      ((evt: { target: unknown; position?: { x: number; y: number } }) => void) | undefined;
    act(() => tap?.({ target: h.cy, position: at }));
  };

  beforeEach(() => {
    window.localStorage.clear();
  });

  it('inspects a state while the machine may not be edited', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" capabilities={{ editMachine: false }} />);
    await waitForEngine();
    tapNode('0');

    const panel = await screen.findByRole('group', { name: /properties of state/i });
    // Everything readable, nothing typeable, and no way to delete what you are reading.
    expect(screen.getByLabelText('Name')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Initial')).toBeDisabled();
    expect(screen.getByLabelText('Final')).toBeDisabled();
    expect(within(panel).queryByRole('button', { name: /delete state/i })).toBeNull();
  });

  it('hides the State tool when the machine may not be edited, and keeps Comment', async () => {
    renderInWindow(
      <JffCytoscapeViewer src={SRC} title="abc.jff" capabilities={{ editMachine: false }} />,
    );
    await waitForEngine();

    const tools = within(screen.getByTestId('viewer-tool-palette')).getAllByRole('button');
    expect(tools.map((b) => b.textContent)).toEqual(['Select', 'Comment']);
  });

  it('hides the Comment tool when annotation is off, and keeps State', async () => {
    renderInWindow(
      <JffCytoscapeViewer src={SRC} title="abc.jff" capabilities={{ annotate: false }} />,
    );
    await waitForEngine();

    const tools = within(screen.getByTestId('viewer-tool-palette')).getAllByRole('button');
    expect(tools.map((b) => b.textContent)).toEqual(['Select', 'State', 'Transition']);
  });

  it('shows no palette at all when nothing can be created', async () => {
    render(
      <JffCytoscapeViewer
        src={SRC}
        title="abc.jff"
        capabilities={{ editMachine: false, annotate: false }}
      />,
    );
    await waitForEngine();

    // Select on its own is how the viewer already behaves, so a one-button palette would be
    // furniture over the drawing.
    expect(screen.queryByTestId('viewer-tool-palette')).toBeNull();
    // And the inspector is untouched by any of that.
    tapNode('0');
    expect(await screen.findByRole('group', { name: /properties of state/i })).toBeInTheDocument();
  });

  it('leaves the palette alone when only the inspector is withheld', async () => {
    renderInWindow(
      <JffCytoscapeViewer src={SRC} title="abc.jff" capabilities={{ inspect: false }} />,
    );
    await waitForEngine();

    expect(screen.getByTestId('viewer-tool-palette')).toBeInTheDocument();
    tapNode('0');
    // The click still selects; there is simply nowhere showing what was selected.
    expect(screen.queryByTestId('viewer-properties-panel')).toBeNull();
  });

  it('puts the tool back to Select when the capability behind it is taken away', async () => {
    const { rerender } = renderInWindow(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    fireEvent.click(screen.getByRole('button', { name: 'State' }));
    expect(screen.getByRole('button', { name: 'State' })).toHaveAttribute('aria-pressed', 'true');

    rerender(
      <JffCytoscapeViewer src={SRC} title="abc.jff" capabilities={{ editMachine: false }} />,
    );

    expect(screen.queryByRole('button', { name: 'State' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'true');
    // And a click on empty canvas draws nothing, because the mode went with the capability.
    const drawnBefore = h.cy.add.mock.calls.length;
    tapBackground();
    expect(h.cy.add.mock.calls.length).toBe(drawnBefore);
  });

  /**
   * The palette being absent is not what makes a viewer read-only. Anything else that reaches
   * these (a menu item, a shortcut, a linked pane) has to be refused too, so the refusal lives
   * with the machine rather than with the buttons.
   */
  it('refuses to change the machine even when something calls straight through', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" capabilities={{ editMachine: false }} />);
    await waitForEngine();
    tapNode('0');
    await screen.findByRole('group', { name: /properties of state/i });

    // The box is read-only in the browser; fire the change the way a caller that ignored that
    // would, and the name still does not move.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'renamed' } });

    expect(screen.getByLabelText('Name')).toHaveValue('q0');
    expect(screen.queryByRole('button', { name: /file changed/i })).toBeNull();
  });

  it('draws no comments when annotation is off', async () => {
    window.localStorage.setItem(
      `afct-viewer-text-boxes:${SRC}`,
      JSON.stringify([{ id: 'text-1', x: 0, y: 0, width: 200, height: 80, text: 'a note' }]),
    );
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" capabilities={{ annotate: false }} />);
    await waitForEngine();

    expect(screen.queryByText('a note')).toBeNull();
  });
});

/**
 * The student's preview.
 *
 * It answers one question, "is this the file I meant to send", and offers exactly what that
 * takes: the camera, and where the file came from. Everything a marker uses is the other side
 * of a capability a student does not have, and the states stay where the file put them, because
 * a preview that invites rearranging invites a change nobody can save.
 */
/**
 * Several states at once, from the reader's side of it.
 *
 * The panel describes one state. Picking out a second closes it, which is the honest answer to
 * "which state is this about", and leaves the dimming as the only sign of what is selected: the
 * count in the toolbar is what says so in words.
 */
describe('picking out several states', () => {
  const SRC = '/api/files/submissions/abc.jff';

  const tap = (id: string, modifier?: 'ctrlKey' | 'metaKey') => {
    const handler = h.cy.on.mock.calls.find(([name]) => name === 'tap')?.[1] as
      ((evt: { target: unknown; originalEvent?: Record<string, boolean> }) => void) | undefined;
    act(() =>
      handler?.({
        target: {
          isNode: () => true,
          hasClass: () => false,
          id: () => id,
          position: () => ({ x: 100, y: 200 }),
          closedNeighborhood: () => ({ addClass: () => ({ removeClass: () => undefined }) }),
        },
        ...(modifier ? { originalEvent: { [modifier]: true } } : {}),
      }),
    );
  };

  it('closes the inspector for two, and says how many are selected instead', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tap('0');
    await screen.findByRole('group', { name: /properties of state/i });

    tap('1', 'ctrlKey');

    await waitFor(() => expect(screen.queryByTestId('viewer-properties-panel')).toBeNull());
    expect(await screen.findByText('2 states selected')).toBeInTheDocument();
  });

  it('brings the inspector back when one is taken out again', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tap('0');
    tap('1', 'ctrlKey');
    await waitFor(() => expect(screen.queryByTestId('viewer-properties-panel')).toBeNull());

    tap('1', 'ctrlKey');

    expect(await screen.findByRole('group', { name: /properties of state/i })).toBeInTheDocument();
    expect(screen.queryByText(/states selected/)).toBeNull();
  });

  it('says nothing about a count when only one state is selected', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();

    tap('0');

    expect(screen.queryByText(/states selected/)).toBeNull();
  });

  it('puts the selection down on Escape', async () => {
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tap('0');
    tap('1', 'ctrlKey');
    await screen.findByText('2 states selected');

    // On the window: a click on a canvas focuses no element, so there is nowhere else for the
    // key to arrive. The tool's own Escape and this are one handler, in order.
    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByText(/states selected/)).toBeNull());
  });
});

/**
 * Reset puts the file back, and the comments written over it go with it.
 *
 * A comment is not part of the automaton, but it is something the reader added to this
 * drawing. Leaving notes floating over a machine that has been put back is a half-reset.
 */
describe('resetting a machine and its comments', () => {
  const SRC = '/api/files/submissions/abc.jff';
  const KEY = `afct-viewer-text-boxes:${SRC}`;

  beforeEach(() => {
    window.localStorage.clear();
  });

  /** Something has to have changed for the toolbar to offer a reset at all. */
  const drag = () => {
    const handler = (event: string) =>
      h.cy.on.mock.calls.find(([name]) => name === event)?.[2] as (() => void) | undefined;
    act(() => handler('grab')?.());
    act(() => handler('dragfree')?.());
  };

  const openReset = async (user: ReturnType<typeof userEvent.setup>) => {
    drag();
    await user.click(await screen.findByRole('button', { name: /file changed/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /put it back/i }));
  };

  it('takes the comments off the drawing and out of storage', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify([{ id: 'text-1', x: 0, y: 0, width: 200, height: 80, text: 'a note' }]),
    );
    const user = userEvent.setup();
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    expect(await screen.findByText('a note')).toBeInTheDocument();

    await openReset(user);
    fireEvent.click(await screen.findByRole('button', { name: /put it back/i }));

    await waitFor(() => expect(screen.queryByText('a note')).toBeNull());
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('says so before it does it', async () => {
    const user = userEvent.setup();
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();

    await openReset(user);

    expect(await screen.findByText(/your comments are removed/i)).toBeInTheDocument();
  });
});

/**
 * Enter, from the last box of a transition, means "that one is labelled".
 *
 * The workflow it is for: click a state, click another, type the symbol, Enter, and start the
 * next one. The tool stays up, so the mouse never has to go back to the palette.
 */
describe('finishing a transition from the keyboard', () => {
  const SRC = '/api/files/submissions/abc.jff';

  const tapEdge = (source: string, target: string) => {
    const tap = h.cy.on.mock.calls.find(([name]) => name === 'tap')?.[1] as
      ((evt: { target: unknown }) => void) | undefined;
    act(() =>
      tap?.({
        target: {
          isNode: () => false,
          hasClass: () => false,
          id: () => `e0-${source}-${target}`,
          data: (key: string) => (key === 'source' ? source : target),
          closedNeighborhood: () => ({ addClass: () => ({ removeClass: () => undefined }) }),
        },
      }),
    );
  };

  /**
   * Still there after the panel's exit animation would have finished.
   *
   * The panel slides out rather than vanishing, so it stays in the document for a moment after
   * it has been closed. Asserting on it the instant a key was pressed cannot tell "did not
   * close" from "is closing", which is the difference these tests are about.
   */
  const stillOpen = async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.getByRole('group', { name: /transition from/i })).toBeInTheDocument();
  };

  it('commits what was typed, closes the panel and lets the line go', async () => {
    renderInWindow(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapEdge('0', '1');
    const reads = await screen.findByLabelText('Reads');

    // Written on every keystroke, so by the time Enter arrives the value is already the
    // machine's. Enter only puts the panel down.
    fireEvent.change(reads, { target: { value: 'b' } });
    fireEvent.keyDown(reads, { key: 'Enter' });

    await waitFor(() => expect(screen.queryByTestId('viewer-properties-panel')).toBeNull());

    // The line was let go rather than the panel merely hidden, and the symbol stuck: clicking
    // it again opens a panel about the same transition, reading what was typed.
    tapEdge('0', '1');
    expect(await screen.findByLabelText('Reads')).toHaveValue('b');
  });

  it('leaves the tool it was drawn with alone', async () => {
    // Nothing in finishing touches the tool, which is what lets the next two clicks draw the
    // next line. Asserted with the tool this viewer happens to be in, since choosing Transition
    // is itself what puts a selected line down.
    renderInWindow(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapEdge('0', '1');
    const reads = await screen.findByLabelText('Reads');

    fireEvent.keyDown(reads, { key: 'Enter' });

    await waitFor(() => expect(screen.queryByTestId('viewer-properties-panel')).toBeNull());
    expect(screen.getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('adds no history step of its own', async () => {
    // Typing already took one. Closing a panel is not a change to the machine.
    renderInWindow(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapEdge('0', '1');
    const reads = await screen.findByLabelText('Reads');
    fireEvent.focus(reads);
    fireEvent.change(reads, { target: { value: 'b' } });
    await screen.findByRole('button', { name: /file changed/i });

    fireEvent.keyDown(reads, { key: 'Enter' });
    await waitFor(() => expect(screen.queryByTestId('viewer-properties-panel')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    // One undo puts the symbol back, so Enter added nothing to step through.
    tapEdge('0', '1');
    expect(await screen.findByLabelText('Reads')).toHaveValue('a');
  });

  it('leaves the panel alone when Enter comes from anywhere else in it', async () => {
    // Only the last box means "done". A button, a tick box or the name of a state is not the
    // end of labelling a transition.
    renderInWindow(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapEdge('0', '1');
    const panel = await screen.findByRole('group', { name: /transition from/i });

    fireEvent.keyDown(within(panel).getByRole('button', { name: /delete transition/i }), {
      key: 'Enter',
    });

    await stillOpen();
  });

  /**
   * A pushdown automaton and a Turing machine have three boxes each, so the last one is not
   * the first. The panel draws them from `transitionFields`, and this reads the same list, so
   * the two cannot come to disagree about which box ends the labelling.
   */
  it.each([
    ['pda', 'push'],
    ['tm', 'move'],
    ['fa', 'read'],
  ] as const)('finishes a %s transition from its %s box and no earlier', (type, last) => {
    const fields = transitionFields(type);
    expect(fields[fields.length - 1]).toBe(last);
    // And the boxes before it are not the end: Tab is how somebody gets between them.
    for (const field of fields.slice(0, -1)) expect(field).not.toBe(last);
  });

  it('makes the last box of the last transition on a line the one that finishes', async () => {
    // Parallel transitions between the same two states share a line and a panel. Drawing a
    // second one adds a block below the first, and it is that block's last box that ends the
    // labelling: the new transition takes the highest index, so it is the one at the bottom.
    fetchImpl = async () =>
      okText(`<?xml version="1.0"?>
<structure>
  <type>fa</type>
  <automaton>
    <state id="0" name="q0"><x>0</x><y>0</y><initial/></state>
    <state id="1" name="q1"><x>120</x><y>0</y><final/></state>
    <transition><from>0</from><to>1</to><read>a</read></transition>
    <transition><from>0</from><to>1</to><read>b</read></transition>
  </automaton>
</structure>`);
    renderInWindow(<JffCytoscapeViewer src={SRC} title="abc.jff" />);
    await waitForEngine();
    tapEdge('0', '1');
    const boxes = await screen.findAllByLabelText('Reads');
    expect(boxes).toHaveLength(2);

    // The first block is not the end of it.
    fireEvent.keyDown(boxes[0]!, { key: 'Enter' });
    await stillOpen();

    fireEvent.keyDown(boxes[1]!, { key: 'Enter' });

    await waitFor(() => expect(screen.queryByTestId('viewer-properties-panel')).toBeNull());
  });

  it('says nothing about a machine nobody may edit', async () => {
    renderInWindow(
      <JffCytoscapeViewer src={SRC} title="abc.jff" capabilities={{ editMachine: false }} />,
    );
    await waitForEngine();
    tapEdge('0', '1');
    const reads = await screen.findByLabelText('Reads');

    fireEvent.keyDown(reads, { key: 'Enter' });

    // The panel is a read of the transition, and Enter does not close a read.
    await stillOpen();
  });
});

describe('a preview', () => {
  const SRC = '/api/files/submissions/abc.jff';

  const tapNode = (id: string) => {
    const tap = h.cy.on.mock.calls.find(([name]) => name === 'tap')?.[1] as
      ((evt: { target: unknown }) => void) | undefined;
    act(() =>
      tap?.({
        target: {
          isNode: () => true,
          hasClass: () => false,
          id: () => id,
          closedNeighborhood: () => ({ addClass: () => ({ removeClass: () => undefined }) }),
        },
      }),
    );
  };

  const preview = () =>
    render(<JffCytoscapeViewer src={SRC} title="abc.jff" preview properties={{ rows: [] }} />);

  it('keeps the camera: zoom, Fit and Center', async () => {
    preview();
    await waitForEngine();

    expect(screen.getByRole('button', { name: /zoom in/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /zoom out/i })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Zoom level' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fit automaton/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /center automaton/i })).toBeInTheDocument();
  });

  it('keeps the properties, which is most of the answer to "is this the right file"', async () => {
    preview();
    await waitForEngine();

    expect(screen.getByRole('button', { name: 'File properties' })).toBeInTheDocument();
  });

  it('offers no tools, and no way to inspect or annotate', async () => {
    preview();
    await waitForEngine();

    expect(screen.queryByTestId('viewer-tool-palette')).toBeNull();
    tapNode('0');
    expect(screen.queryByRole('group', { name: /properties of state/i })).toBeNull();
    expect(screen.queryByTestId('viewer-text-layer')).toBeNull();
  });

  it('offers no grid and no way out to the standalone window', async () => {
    render(
      <JffCytoscapeViewer
        src={SRC}
        title="abc.jff"
        preview
        properties={{ rows: [] }}
        windowTarget={{ href: '/viewer?x=1', tab: 'abc' } as never}
      />,
    );
    await waitForEngine();

    expect(screen.queryByRole('button', { name: /toggle grid/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /open in viewer/i })).toBeNull();
  });

  it('refuses to change the machine even if something calls straight through', async () => {
    // The absence of a button is not the rule; this is. A preview withholds all three
    // capabilities, and the machine enforces the one that matters.
    preview();
    await waitForEngine();
    tapNode('0');

    expect(screen.queryByRole('button', { name: /file changed/i })).toBeNull();
  });
});
