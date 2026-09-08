/** @vitest-environment jsdom */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The JFLAP viewer's cytoscape engine.
 *
 * The geometry this hook decides with lives in `lib/jflap-layout` and is already covered
 * there; the parsing lives in `lib/jflap-parse` and likewise. What was untested is the part
 * in between: taking a parsed machine, driving cytoscape with it, and placing the things
 * JFLAP draws that cytoscape has no concept of - the initial-state marker, the self-loop
 * arcs, and the standoff that keeps a transition label off its own line.
 *
 * Cytoscape is replaced with a fake rather than run for real. That is not a shortcut here:
 * a real engine would need a canvas and a layout pass, and its node positions would then be
 * whatever the layout chose, so the geometry assertions below could not say anything exact.
 * Driving it with fixed positions is what makes "the marker went to the far side" checkable.
 * What the fake cannot tell you is whether the picture looks right, which is a browser job.
 */

/* ────────────────────────── a minimal fake cytoscape ────────────────────────── */

type Pos = { x: number; y: number };

class FakeEl {
  data_: Record<string, unknown>;
  pos: Pos;
  classes: Set<string>;
  style_: Record<string, unknown> = {};
  cy!: FakeCy;

  constructor(data: Record<string, unknown>, pos: Pos, classes = '') {
    this.data_ = { ...data };
    this.pos = { ...pos };
    this.classes = new Set(classes.split(' ').filter(Boolean));
  }

  id() {
    return String(this.data_.id);
  }
  data(key?: string, value?: unknown) {
    if (key === undefined) return this.data_;
    if (value !== undefined) {
      this.data_[key] = value;
      return this;
    }
    return this.data_[key];
  }
  position(): Pos;
  position(next: Pos): this;
  position(next?: Pos): Pos | this {
    if (next) {
      this.pos = { ...next };
      return this;
    }
    return this.pos;
  }
  style(obj?: Record<string, unknown>) {
    if (obj) Object.assign(this.style_, obj);
    return this.style_;
  }
  hasClass(c: string) {
    return this.classes.has(c);
  }
  addClass(c: string) {
    c.split(' ').forEach((x) => this.classes.add(x));
    return this;
  }
  removeClass(c: string) {
    c.split(' ').forEach((x) => this.classes.delete(x));
    return this;
  }
  isNode() {
    return this.data_.source === undefined;
  }
  empty() {
    return false;
  }
  /**
   * Take this element off the graph.
   *
   * Modelled because the code removes the initial-state marker this way when the reader takes
   * the marker off every state, and without it that removal silently did nothing here: the
   * marker stayed on the fake graph and any test of it would have passed for the wrong reason.
   */
  remove() {
    const list = this.isNode() ? this.cy.nodeList : this.cy.edgeList;
    const at = list.indexOf(this as FakeEl);
    if (at >= 0) list.splice(at, 1);
    return this;
  }
  source() {
    return this.cy.byId(String(this.data_.source)) as FakeEl;
  }
  target() {
    return this.cy.byId(String(this.data_.target)) as FakeEl;
  }
  /** Cytoscape's real midpoint; enough for the label-offset maths under test. */
  midpoint() {
    const a = this.source().position();
    const b = this.target().position();
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  connectedEdges() {
    return this.cy.edgeList.filter(
      (e) => e.data_.source === this.id() || e.data_.target === this.id(),
    );
  }
}

type Collection = FakeEl[] & {
  addClass: (c: string) => Collection;
  removeClass: (c: string) => Collection;
};

/** Cytoscape collections carry class methods; plain arrays do not. */
function collection(els: FakeEl[]): Collection {
  const arr = [...els] as Collection;
  arr.addClass = (c) => {
    els.forEach((e) => e.addClass(c));
    return arr;
  };
  arr.removeClass = (c) => {
    els.forEach((e) => e.removeClass(c));
    return arr;
  };
  return arr;
}

/** An absent element: cytoscape answers with an empty collection, not null. */
const MISSING = { empty: () => true, position: () => ({ x: 0, y: 0 }), style: () => ({}) };

/**
 * The size a graph is built at.
 *
 * Mutable so a test can build one in a container that has no box yet, which is the case the
 * pan that keeps the reader's spot has to refuse to act on.
 */
const builtAt = { width: 800, height: 600 };

class FakeCy {
  nodeList: FakeEl[] = [];
  edgeList: FakeEl[] = [];
  destroyed = false;
  fitCalls = 0;
  layoutNames: string[] = [];
  handlers: Record<string, (evt: unknown) => void> = {};
  /**
   * The element definitions exactly as they were handed to cytoscape.
   *
   * `nodeList` below keeps only what a fake element models. Some things are properties of the
   * definition rather than of the element, `selectable` and `grabbable` among them, and those
   * are the ones that say a note is not part of the machine.
   */
  rawElements: Array<Record<string, unknown>> = [];
  /** The stylesheet as handed to cytoscape, so a rule can be asserted by its selector. */
  styleSheet: Array<{ selector: string; style: Record<string, unknown> }> = [];

  constructor(config: {
    elements?: Array<Record<string, unknown>>;
    style?: Array<{ selector: string; style: Record<string, unknown> }>;
  }) {
    this.rawElements = config.elements ?? [];
    this.styleSheet = config.style ?? [];
    for (const el of config.elements ?? []) {
      const data = el.data as Record<string, unknown>;
      const made = new FakeEl(
        data,
        (el.position as Pos) ?? { x: 0, y: 0 },
        (el.classes as string) ?? '',
      );
      made.cy = this;
      if (data.source !== undefined) this.edgeList.push(made);
      else this.nodeList.push(made);
    }
  }

  /** The style block for one selector, exactly as the viewer declared it. */
  styleFor(selector: string) {
    return this.styleSheet.find((rule) => rule.selector === selector)?.style;
  }

  byId(id: string) {
    return [...this.nodeList, ...this.edgeList].find((e) => e.id() === id);
  }

  nodes() {
    return this.nodeList;
  }
  /** Only the one selector the hook uses. */
  edges(selector?: string) {
    if (selector === '[isLoop = 1]') return this.edgeList.filter((e) => e.data_.isLoop === 1);
    return this.edgeList;
  }
  elements() {
    return collection([...this.nodeList, ...this.edgeList]);
  }
  getElementById(id: string) {
    return this.byId(id) ?? MISSING;
  }
  add(spec: { data: Record<string, unknown>; position?: Pos; classes?: string }) {
    const made = new FakeEl(spec.data, spec.position ?? { x: 0, y: 0 }, spec.classes ?? '');
    made.cy = this;
    // Sorted the way the constructor sorts the elements a load hands over, and for the same
    // reason. It used to put everything in `nodeList`, which was fine while the only thing
    // added after a load was the initial-state marker; a line added back by undo went into the
    // node list, and every test of one passed for the wrong reason.
    if (spec.data.source !== undefined) this.edgeList.push(made);
    else this.nodeList.push(made);
    return made;
  }
  layout(opts: { name: string }) {
    this.layoutNames.push(opts.name);
    return {
      run: () => {},
      on: (_evt: string, cb: () => void) => cb(),
    };
  }
  /**
   * Cytoscape takes either `(event, handler)` or `(event, selector, handler)`, and the viewer
   * uses both. Storing the second argument regardless left the selector string under the
   * event name, so a test that fired `grab` was calling a string.
   */
  on(evt: string, a: unknown, b?: (e: unknown) => void) {
    this.handlers[evt] = (typeof a === 'function' ? a : b) as (e: unknown) => void;
  }
  fit() {
    this.fitCalls += 1;
  }
  destroy() {
    this.destroyed = true;
  }
  resize() {
    this.viewWidth = this.containerWidth;
    this.viewHeight = this.containerHeight;
  }
  centerCalls = 0;
  center() {
    this.centerCalls += 1;
  }
  animations: Array<{ zoom: number }> = [];
  animate(opts: { zoom: number }) {
    this.animations.push(opts);
  }
  /**
   * The size cytoscape thinks it has, and the size its container actually is.
   *
   * Two of them because that is how the real thing behaves: `width()` answers from a cached
   * measurement and only `resize()` goes back to the DOM. Cytoscape watches the container
   * itself, though, so in a browser something else has usually called `resize()` before the
   * viewer's own handler runs: see the resize helper below, which is what makes that true here.
   */
  containerWidth = builtAt.width;
  containerHeight = builtAt.height;
  viewWidth = builtAt.width;
  viewHeight = builtAt.height;
  width() {
    return this.viewWidth;
  }
  height() {
    return this.viewHeight;
  }
  /**
   * Call every handler registered for an event.
   *
   * Cytoscape reports a viewport change whether a person or the code caused it, and the
   * handlers are registered under names like `'viewport position'`, so a token match is what
   * matches them. Without this the fake stayed silent when the code moved the camera, and the
   * guard against a linked pane reporting back the camera it was just handed was unreachable.
   */
  emit(name: string) {
    for (const [key, handler] of Object.entries(this.handlers)) {
      if (key.split(' ').includes(name)) handler({ target: this });
    }
  }

  zoomLevel = 1;
  /** A getter and a setter on one name, as cytoscape's is. */
  zoom(next?: number) {
    if (typeof next === 'number' && next !== this.zoomLevel) {
      this.zoomLevel = next;
      this.emit('zoom');
      this.emit('viewport');
    }
    return this.zoomLevel;
  }
  minZoom() {
    return 0.2;
  }
  maxZoom() {
    return 6;
  }
  // Read by the grid sync, which keeps the painted lines in step with the graph. Without it
  // that sync threw on every load, and only its own try/catch kept the viewer working: the
  // feature was silently absent here rather than tested.
  panPosition: Pos = { x: 0, y: 0 };
  pan(next?: Pos) {
    if (next && (next.x !== this.panPosition.x || next.y !== this.panPosition.y)) {
      this.panPosition = { ...next };
      this.emit('pan');
      this.emit('viewport');
    }
    return this.panPosition;
  }
  panningEnabled() {}
  /**
   * Whether a person may drag the canvas, and whether they may drag a state.
   *
   * Modelled rather than ignored because they are the whole of how a drag means one thing or
   * the other: with the Transition tool up the states are held still and the canvas does not
   * slide away under the gesture. A fake that swallowed both calls would let a test of "the
   * state did not move" pass because this fake never moves states anyway.
   */
  panningByUser = true;
  userPanningEnabled(next?: boolean) {
    if (typeof next === 'boolean') this.panningByUser = next;
    return this.panningByUser;
  }
  ungrabbed = false;
  autoungrabify(next?: boolean) {
    if (typeof next === 'boolean') this.ungrabbed = next;
    return this.ungrabbed;
  }
  userZoomingEnabled() {}
  svg() {
    return '<svg/>';
  }
  png() {
    return 'data:image/png;base64,AAA';
  }
}

const instances: FakeCy[] = [];
const cytoscapeMock = vi.hoisted(() => {
  // The module default is callable *and* carries `use`, which the hook calls once to
  // register the elk and svg extensions.
  const fn = vi.fn() as ReturnType<typeof vi.fn> & { use: ReturnType<typeof vi.fn> };
  fn.use = vi.fn();
  return { fn };
});

vi.mock('cytoscape', () => ({ default: cytoscapeMock.fn }));
vi.mock('cytoscape-elk', () => ({ default: () => {} }));
vi.mock('cytoscape-svg', () => ({ default: () => {} }));

import { useJffCytoscape, DEFAULT_EPS } from './useJffCytoscape';
import { describeState, parseJflap } from '@/lib/jflap-parse';
import { toJflapXml } from '@/lib/jflap-write';
import { STATE_FONT_SIZE } from '@/lib/jflap-layout';
import type { ViewerViewState } from '@/lib/viewer-view-state';

/* ─────────────────────────────── the fixture ─────────────────────────────── */

// q0 is initial, q1 is final and carries a self-loop. Two transitions run q0 -> q1, so
// there is a real edge to lay a label along and a loop to steer around.
const faXml = `
<structure>
  <type>fa</type>
  <automaton>
    <state id="0" name="q0"><x>10</x><y>20</y><initial/></state>
    <state id="1" name="q1"><x>100</x><y>20</y><final/></state>
    <transition><from>0</from><to>1</to><read>a</read></transition>
    <transition><from>1</from><to>1</to><read></read></transition>
  </automaton>
</structure>`;

function Harness(props: Parameters<typeof useJffCytoscape>[0] & { onApi?: (a: unknown) => void }) {
  const api = useJffCytoscape(props);
  props.onApi?.(api);
  return <div ref={api.containerRef} data-testid="canvas" />;
}

const renderViewer = (props: Partial<Parameters<typeof useJffCytoscape>[0]> = {}) => {
  let latest: ReturnType<typeof useJffCytoscape>;
  const onApi = (a: unknown) => {
    latest = a as ReturnType<typeof useJffCytoscape>;
  };
  const view = render(<Harness src="/api/files/machine.jff" {...props} onApi={onApi} />);
  return {
    ...view,
    api: () => latest,
    /** Re-render with different options, as the window does when the link is switched on. */
    rerender: (next: Partial<Parameters<typeof useJffCytoscape>[0]> = {}) =>
      view.rerender(<Harness src="/api/files/machine.jff" {...props} {...next} onApi={onApi} />),
  };
};

const lastCy = () => instances[instances.length - 1];

/**
 * A state picked up, moved, and put down.
 *
 * Cytoscape fires `grab` on the way down and `dragfree` on release, but `dragfree` only when
 * something really moved, which is how a drag is told from a click. Tests that mean "a state
 * was moved" have to fire both: firing `grab` alone is a click, and now records nothing.
 */
const dragState = (id = '0', to?: { x: number; y: number }) => {
  const cy = lastCy();
  act(() => cy.handlers['grab']?.({ target: cy.byId(id) }));
  if (to) cy.byId(id)?.position(to);
  act(() => cy.handlers['dragfree']?.({ target: cy.byId(id) }));
};
const fetchOk = (body: string) =>
  vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK', text: async () => body });

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  instances.length = 0;
  builtAt.width = 800;
  builtAt.height = 600;
  cytoscapeMock.fn.mockImplementation((config: { elements?: Array<Record<string, unknown>> }) => {
    const cy = new FakeCy(config);
    instances.push(cy);
    return cy;
  });
  global.fetch = fetchOk(faXml) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

/* ──────────────────────────────── the tests ──────────────────────────────── */

describe('loading the machine', () => {
  it('reports the parsed machine type', async () => {
    const { api } = renderViewer();

    await waitFor(() => expect(api().type).toBe('fa'));
    expect(api().failure).toBeNull();
    expect(api().parsed?.states).toHaveLength(2);
  });

  it('keeps the parsed machine, which is the only screen-reader-usable form of it', async () => {
    // The canvas says nothing to assistive tech, so the viewer renders a text description
    // from this. Losing it would make the dialog unreadable without sight.
    const { api } = renderViewer();

    await waitFor(() => expect(api().parsed).not.toBeNull());
    expect(api().parsed?.transitions).toHaveLength(2);
  });

  it('surfaces a failed fetch with its status, and builds no graph', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    }) as unknown as typeof fetch;

    const { api } = renderViewer();

    // No status code in it: the reader cannot act on a number, and one in a message reads as
    // a fault they caused.
    await waitFor(() => expect(api().failure?.title).toMatch(/not there any more/i));
    expect(api().failure?.retryable).toBe(false);
    expect(cytoscapeMock.fn).not.toHaveBeenCalled();
  });

  it('surfaces an unparseable file rather than rendering an empty canvas', async () => {
    global.fetch = fetchOk('<structure><oops') as unknown as typeof fetch;

    const { api } = renderViewer();

    await waitFor(() => expect(api().failure?.title).toMatch(/not a machine/i));
    // The same bytes will not parse the second time.
    expect(api().failure?.retryable).toBe(false);
    expect(cytoscapeMock.fn).not.toHaveBeenCalled();
  });

  it('uses the caller’s epsilon symbol on an empty transition', async () => {
    renderViewer({ epsSymbol: '@' });

    await waitFor(() => expect(lastCy()).toBeDefined());
    const loop = lastCy().edges('[isLoop = 1]')[0];
    expect(loop.data('label')).toBe('@');
  });

  it('defaults that symbol to ε', async () => {
    renderViewer();

    await waitFor(() => expect(lastCy()).toBeDefined());
    expect(lastCy().edges('[isLoop = 1]')[0].data('label')).toBe(DEFAULT_EPS);
  });
});

describe('the initial-state marker', () => {
  it('is added beside the initial state, and only for that state', async () => {
    renderViewer();

    await waitFor(() => expect(lastCy().getElementById('__start0').empty?.()).not.toBe(true));
    const marker = lastCy().byId('__start0') as FakeEl;
    const q0 = lastCy().byId('0') as FakeEl;

    expect(marker.hasClass('start')).toBe(true);
    // Beside it, not on top of it.
    expect(marker.position()).not.toEqual(q0.position());
    expect(lastCy().byId('__start1')).toBeUndefined();
  });

  it('carries an explicit empty label, which stops cytoscape warning about the mapping', async () => {
    renderViewer();

    await waitFor(() => expect(lastCy().byId('__start0')).toBeDefined());
    expect((lastCy().byId('__start0') as FakeEl).data('label')).toBe('');
  });

  it('is turned to point back at its state', async () => {
    renderViewer();

    await waitFor(() => expect(lastCy().byId('__start0')).toBeDefined());
    const marker = lastCy().byId('__start0') as FakeEl;

    expect(marker.style()['shape-polygon-points']).toEqual(expect.any(String));
  });

  it('is repositioned rather than duplicated when the layout is redone', async () => {
    // Toggling honorPositions re-runs placement against the same graph. A marker added
    // again each time would stack invisible triangles on the canvas.
    const { api } = renderViewer();
    await waitFor(() => expect(lastCy().byId('__start0')).toBeDefined());

    api().toggleHonorPositions();

    // Retry the count itself: the rebuilt graph places its marker asynchronously, and
    // asserting on a snapshot taken too early sees zero rather than a duplicate.
    await waitFor(() => {
      const markers = lastCy()
        .nodes()
        .filter((n) => n.id().startsWith('__start'));
      expect(markers).toHaveLength(1);
    });
  });
});

describe('self-loops', () => {
  it('records the direction it chose, so the marker can be steered clear of it', async () => {
    renderViewer();

    await waitFor(() => expect(lastCy()).toBeDefined());
    const loop = lastCy().edges('[isLoop = 1]')[0];

    await waitFor(() => expect(typeof loop.data('loopDirection')).toBe('number'));
  });

  it('is drawn as an arc, since cytoscape has no loop curve-style', async () => {
    renderViewer();

    await waitFor(() => expect(lastCy()).toBeDefined());
    const loop = lastCy().edges('[isLoop = 1]')[0];

    await waitFor(() => expect(loop.style()['curve-style']).toBe('bezier'));
    expect(loop.style()['loop-direction']).toMatch(/deg$/);
    // JFLAP points the arrowhead back into the state it left.
    expect(loop.style()['source-arrow-shape']).toBe('triangle');
    expect(loop.style()['target-arrow-shape']).toBe('none');
  });
});

describe('transition labels', () => {
  it('are lifted clear of their own line', async () => {
    // Without the standoff the text sits on the edge and neither is readable.
    renderViewer();

    await waitFor(() => expect(lastCy()).toBeDefined());
    const straight = lastCy()
      .edges()
      .find((e) => e.data('isLoop') !== 1) as FakeEl;

    await waitFor(() => expect(straight.style()['text-margin-x']).toEqual(expect.any(Number)));
    expect(straight.style()['text-margin-y']).toEqual(expect.any(Number));
  });

  it('leaves self-loop labels horizontal, as JFLAP draws them', async () => {
    // A straight edge rotates its label to follow the line. A loop has no direction to
    // follow, so it opts out and takes its offset from the loop geometry instead.
    renderViewer();

    await waitFor(() => expect(lastCy()).toBeDefined());
    const loop = lastCy().edges('[isLoop = 1]')[0];

    await waitFor(() => expect(loop.style()['curve-style']).toBe('bezier'));
    expect(loop.style()['text-rotation']).toBe('none');
    expect(loop.style()['text-margin-y']).toEqual(expect.any(Number));
  });
});

describe('rebuilding the graph', () => {
  it('destroys the previous engine rather than leaking it', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));
    const first = instances[0];

    api().toggleHonorPositions();

    await waitFor(() => expect(instances.length).toBeGreaterThan(1));
    expect(first.destroyed).toBe(true);
  });

  it('honours the file’s own coordinates with a preset layout when asked', async () => {
    renderViewer({ honorPositionsDefault: true });

    await waitFor(() => expect(lastCy().layoutNames).toContain('preset'));
  });

  it('lays the machine out itself when not asked', async () => {
    renderViewer({ honorPositionsDefault: false });

    await waitFor(() => expect(lastCy().layoutNames.length).toBeGreaterThan(0));
    expect(lastCy().layoutNames).not.toContain('preset');
  });

  /**
   * Notes only make sense where the saved coordinates are used. Auto-arranged, every state has
   * moved, so a note left where the student put it annotates whatever it lands on.
   */
  describe('notes written on the drawing', () => {
    const noteXml = `
<structure>
  <type>fa</type>
  <automaton>
    <state id="0" name="q0"><x>10</x><y>20</y><initial/></state>
    <note><text>check this loop</text><x>60</x><y>80</y></note>
  </automaton>
</structure>`;

    const noteElements = () =>
      lastCy().rawElements.filter((e) => e.classes === 'note') as Array<{
        data: { label: string };
        selectable?: boolean;
        grabbable?: boolean;
      }>;

    it('draws a note when the saved positions are used', async () => {
      global.fetch = fetchOk(noteXml) as unknown as typeof fetch;
      renderViewer({ honorPositionsDefault: true });

      await waitFor(() => expect(noteElements()).toHaveLength(1));
      expect(noteElements()[0].data.label).toBe('check this loop');
    });

    it('leaves it out when the machine is auto-arranged', async () => {
      global.fetch = fetchOk(noteXml) as unknown as typeof fetch;
      renderViewer({ honorPositionsDefault: false });

      await waitFor(() => expect(lastCy().rawElements.length).toBeGreaterThan(0));
      expect(noteElements()).toHaveLength(0);
    });

    /**
     * A note sits where the student dropped it and nothing moves aside for it, so it can land
     * on a state. When it does the machine has to stay readable, which means the note goes
     * behind it rather than over it.
     */
    it('is drawn behind the machine, so it cannot hide a state', async () => {
      global.fetch = fetchOk(noteXml) as unknown as typeof fetch;
      renderViewer({ honorPositionsDefault: true });

      await waitFor(() => expect(noteElements()).toHaveLength(1));
      const style = lastCy().styleFor('node.note');
      const stateStyle = lastCy().styleFor('node');
      expect(Number(style?.['z-index'])).toBeLessThan(Number(stateStyle?.['z-index']));
    });

    it('is not something the reader can select or drag', async () => {
      global.fetch = fetchOk(noteXml) as unknown as typeof fetch;
      renderViewer({ honorPositionsDefault: true });

      await waitFor(() => expect(noteElements()).toHaveLength(1));
      expect(noteElements()[0].selectable).toBe(false);
      expect(noteElements()[0].grabbable).toBe(false);
    });
  });

  it('fits the whole graph, labels included', async () => {
    renderViewer();

    await waitFor(() => expect(lastCy().fitCalls).toBeGreaterThan(0));
  });
});

describe('the export actions', () => {
  it('produce an SVG from the live graph', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(lastCy()).toBeDefined());

    const createUrl = vi.fn().mockReturnValue('blob:x');
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await api().downloadSVG();

    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });
});

describe('interacting with the graph', () => {
  it('dims everything except the one thing that was tapped', async () => {
    renderViewer();
    await waitFor(() => expect(lastCy().handlers.tap).toBeDefined());
    const cy = lastCy();
    const q0 = cy.byId('0') as FakeEl;

    cy.handlers.tap({ target: q0 });

    expect(q0.hasClass('highlighted')).toBe(true);
    expect(q0.hasClass('faded')).toBe(false);
    // Everything else stays dimmed, including the transitions running out of the state that
    // was clicked. They used to come up with it, which lit four things for one click.
    expect((cy.byId('1') as FakeEl).hasClass('faded')).toBe(true);
    const outgoing = cy.edgeList.filter((e) => e.data('source') === '0');
    expect(outgoing.length).toBeGreaterThan(0);
    expect(outgoing.every((e) => e.hasClass('faded'))).toBe(true);
  });

  it('lights the transition alone when a line is tapped', async () => {
    renderViewer();
    await waitFor(() => expect(lastCy().handlers.tap).toBeDefined());
    const cy = lastCy();
    const edge = cy.edgeList.find((e) => e.data('source') === '0' && e.data('target') === '1')!;

    cy.handlers.tap({ target: edge });

    expect(edge.hasClass('highlighted')).toBe(true);
    // Not the states at either end of it.
    expect((cy.byId('0') as FakeEl).hasClass('faded')).toBe(true);
    expect((cy.byId('1') as FakeEl).hasClass('faded')).toBe(true);
  });

  it('clears the dimming when the background is tapped', async () => {
    renderViewer();
    await waitFor(() => expect(lastCy().handlers.tap).toBeDefined());
    const cy = lastCy();
    cy.handlers.tap({ target: cy.byId('0') });

    cy.handlers.tap({ target: cy });

    expect(cy.elements().some((e) => e.hasClass('faded') || e.hasClass('highlighted'))).toBe(false);
  });

  it('re-runs the geometry when a state is dragged', async () => {
    renderViewer();
    await waitFor(() => expect(lastCy().handlers.position).toBeDefined());
    const cy = lastCy();
    const marker = cy.byId('__start0') as FakeEl;
    const before = { ...marker.position() };
    (cy.byId('0') as FakeEl).position({ x: 400, y: 400 });

    await cy.handlers.position({ target: cy.byId('0') });

    await waitFor(() => expect(marker.position()).not.toEqual(before));
  });

  it('ignores a move of the marker itself, which would otherwise recurse', async () => {
    // repositionStartNodes moves the marker, which fires `position` again. Without the
    // guard that is an endless loop.
    renderViewer();
    await waitFor(() => expect(lastCy().handlers.position).toBeDefined());
    const cy = lastCy();
    const marker = cy.byId('__start0') as FakeEl;
    marker.position({ x: 999, y: 999 });

    await cy.handlers.position({ target: marker });

    expect(marker.position()).toEqual({ x: 999, y: 999 });
  });
});

describe('zooming', () => {
  it('zooms in and out around the graph', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(lastCy()).toBeDefined());

    api().zoomIn();
    expect(lastCy().animations.at(-1)?.zoom).toBeCloseTo(1.2);

    api().zoomOut();
    expect(lastCy().animations.at(-1)?.zoom).toBeCloseTo(1 / 1.2);
  });

  it('will not zoom past the engine’s own limits', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(lastCy()).toBeDefined());
    lastCy().zoomLevel = 100;

    api().zoomIn();

    expect(lastCy().animations.at(-1)?.zoom).toBe(6);
  });
});

describe('remembering the view across a refresh', () => {
  const KEY = 'submissions:machine.jff';
  const STORAGE_KEY = `afct.viewer.view.${KEY}`;

  beforeEach(() => {
    window.sessionStorage.clear();
  });

  const saved = () => {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ViewerViewState) : null;
  };

  it('writes the view down once the machine has settled', async () => {
    renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(saved()).not.toBeNull());
    // Both states, since the viewer opens on the drawn layout here.
    expect(Object.keys(saved()!.positions).sort()).toEqual(['0', '1']);
  });

  it('follows the reader as they zoom and pan', async () => {
    renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(saved()).not.toBeNull());

    const cy = lastCy();
    cy.zoom(2.5);
    cy.pan({ x: -30, y: 12 });
    // Cytoscape fires this for the wheel, the slider, Fit and a drag of the background alike.
    cy.handlers['viewport position']?.({});

    await waitFor(() => expect(saved()?.zoom).toBe(2.5));
    expect(saved()?.pan).toEqual({ x: -30, y: 12 });
  });

  it('saves the last movement before the page goes', async () => {
    // The writer is debounced, so without a flush on the way out a wheel or a drag in the
    // last fraction of a second before a refresh would be lost. Asserted synchronously on
    // purpose: the pending timer cannot have fired yet, so only the flush can have written.
    renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(saved()).not.toBeNull());

    lastCy().zoom(2.5);
    lastCy().handlers['viewport position']?.({});
    window.dispatchEvent(new Event('pagehide'));

    expect(saved()?.zoom).toBe(2.5);
  });

  it('opens the next time where the reader left it', async () => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 1,
        zoom: 3,
        pan: { x: 42, y: -7 },
        // Keyed by the ids in the file, which is what the graph's nodes carry.
        positions: { '0': { x: 500, y: 500 }, '1': { x: 640, y: 500 } },
        honorPositions: true,
      }),
    );

    renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(lastCy().zoomLevel).toBe(3));
    expect(lastCy().panPosition).toEqual({ x: 42, y: -7 });
    expect(lastCy().byId('0')?.position()).toEqual({ x: 500, y: 500 });
  });

  it('puts the view back when the graph is rebuilt, not only on the first load', async () => {
    // The graph is rebuilt for more than a refresh: the theme changes, and React replays
    // effects on mount in development, which loads the machine twice. Restoring on the first
    // load and never again left the rebuild at the plain fit, and the write that follows a
    // load then put that over the entry, so a refresh came back to nothing remembered.
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 1,
        zoom: 3,
        pan: { x: 42, y: -7 },
        positions: { '0': { x: 500, y: 500 }, '1': { x: 640, y: 500 } },
        honorPositions: true,
      }),
    );

    const { rerender } = renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(lastCy().zoomLevel).toBe(3));

    rerender({ darkMode: true });

    await waitFor(() => expect(instances.length).toBeGreaterThan(1));
    await waitFor(() => expect(lastCy().zoomLevel).toBe(3));
    expect(lastCy().panPosition).toEqual({ x: 42, y: -7 });
    expect(lastCy().byId('0')?.position()).toEqual({ x: 500, y: 500 });
    // And the entry still says where the reader was, rather than where the rebuild fitted.
    expect(saved()?.zoom).toBe(3);
  });

  it('writes down which properties panel is open, and that one was closed', async () => {
    const { api } = renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(saved()).not.toBeNull());

    act(() => lastCy().handlers.tap({ target: lastCy().byId('0') }));
    await waitFor(() => expect(saved()?.selection).toEqual({ kind: 'state', id: '0' }));

    act(() => api().clearSelectedState());
    await waitFor(() => expect(saved()?.selection).toBeNull());
  });

  it('opens the panel again on the state it was open on', async () => {
    // A refresh is not a click, so without this a reader came back to the machine they left and
    // no panel: the one thing on screen saying which state they were reading about.
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 1,
        zoom: 1,
        pan: { x: 0, y: 0 },
        positions: { '0': { x: 500, y: 500 }, '1': { x: 640, y: 500 } },
        honorPositions: true,
        selection: { kind: 'state', id: '0' },
      }),
    );

    const { api } = renderViewer({ viewStateKey: KEY });

    await waitFor(() => expect(api().selectedState?.name).toBe('q0'));
    // And the drawing agrees: an open panel with nothing marked on the canvas is worse than no
    // panel at all.
    expect(lastCy().byId('0')?.hasClass('highlighted')).toBe(true);
    expect(lastCy().byId('1')?.hasClass('faded')).toBe(true);
  });

  it('opens the panel again on the transition it was open on', async () => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 1,
        zoom: 1,
        pan: { x: 0, y: 0 },
        positions: { '0': { x: 500, y: 500 }, '1': { x: 640, y: 500 } },
        honorPositions: true,
        selection: { kind: 'transition', from: '0', to: '1' },
      }),
    );

    const { api } = renderViewer({ viewStateKey: KEY });

    await waitFor(() => expect(api().selectedTransition?.from).toBe('q0'));
    expect(api().selectedTransition?.to).toBe('q1');
  });

  it('ignores a selection the machine no longer has', async () => {
    // The same file name can hold a different machine, and a panel about a state that is not
    // there would describe nothing.
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 1,
        zoom: 1,
        pan: { x: 0, y: 0 },
        positions: { '0': { x: 500, y: 500 }, '1': { x: 640, y: 500 } },
        honorPositions: true,
        selection: { kind: 'state', id: 'q7' },
      }),
    );

    const { api } = renderViewer({ viewStateKey: KEY });

    await waitFor(() => expect(api().phase).toBe('ready'));
    expect(api().selectedState).toBeNull();
  });

  it('lets the newest load have the last word on the view', async () => {
    // Two loads in flight: a rebuild starts while the one before it is still in its final
    // frame. The older one used to finish by writing down the view of the graph it no longer
    // owned, which was the fit the new one had just opened at, and the restore that followed
    // read that back, losing the reader's zoom and positions.
    //
    // The exact interleaving that does the damage cannot be forced from here, so this is the
    // scenario rather than a proof of the guard: it failed about one full-suite run in ten
    // before each load was told which graph is its own.
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 1,
        zoom: 3,
        pan: { x: 42, y: -7 },
        positions: { '0': { x: 500, y: 500 }, '1': { x: 640, y: 500 } },
        honorPositions: true,
      }),
    );

    const { rerender } = renderViewer({ viewStateKey: KEY });
    // As soon as the first graph exists, before its load has finished: that is the window.
    await waitFor(() => expect(instances).toHaveLength(1));
    rerender({ darkMode: true });

    await waitFor(() => expect(instances.length).toBeGreaterThan(1));
    await waitFor(() => expect(lastCy().zoomLevel).toBe(3));
    expect(saved()?.zoom).toBe(3);
  });

  it('comes back to the same place when the canvas is a different width', async () => {
    // The properties panel docks beside the drawing and takes 20rem of it, and on the way back
    // in it opens a moment after the view is restored. Restoring the pan, which is in rendered
    // pixels, therefore moved the machine left by half a panel on every refresh, and it piled
    // up: Jeff saw it walk further left each time.
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 1,
        zoom: 1,
        // Written down at 480 wide, where this pan put the model point (100, 100) in the middle.
        pan: { x: 140, y: 200 },
        centre: { x: 100, y: 100 },
        positions: { '0': { x: 500, y: 500 }, '1': { x: 640, y: 500 } },
        honorPositions: true,
      }),
    );

    renderViewer({ viewStateKey: KEY });

    // The fake canvas is 800 x 600, so the same point in the middle means a different pan.
    await waitFor(() => expect(lastCy().panPosition).toEqual({ x: 300, y: 200 }));
  });

  it('does not put the old positions back when the layout is switched', async () => {
    // The regression this guards: the restore ran at the end of every load, and switching to
    // Auto-arranged is a load, so the layout engine placed the states and the remembered
    // positions were immediately dropped back on top. Auto-arranged looked broken.
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 1,
        zoom: 1,
        pan: { x: 0, y: 0 },
        positions: { '0': { x: 500, y: 500 }, '1': { x: 640, y: 500 } },
        honorPositions: true,
      }),
    );

    const { api } = renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(lastCy().byId('0')?.position()).toEqual({ x: 500, y: 500 }));

    act(() => api().toggleHonorPositions());
    await waitFor(() => expect(lastCy().layoutNames).toContain('elk'));
    expect(lastCy().byId('0')?.position()).not.toEqual({ x: 500, y: 500 });
  });

  it('ignores an arrangement belonging to a different machine', async () => {
    // Positions are keyed by state name, so another machine's would move whichever states
    // happened to share a name and leave the rest, which is worse than opening at the fit.
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 1,
        zoom: 3,
        pan: { x: 42, y: -7 },
        positions: { '0': { x: 500, y: 500 }, '7': { x: 900, y: 500 } },
        honorPositions: true,
      }),
    );

    const { api } = renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(api().type).toBe('fa'));
    await waitFor(() => expect(lastCy().fitCalls).toBeGreaterThan(0));
    expect(lastCy().zoomLevel).not.toBe(3);
    expect(lastCy().byId('0')?.position()).not.toEqual({ x: 500, y: 500 });
  });

  it('remembers nothing without a key, which is every viewer in a dialog', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(api().type).toBe('fa'));
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe('the size a state name is drawn at', () => {
  const nodeFontSize = (label: string) => {
    const rule = lastCy().styleSheet.find((r) => r.selector === 'node');
    const size = rule?.style['font-size'] as ((node: unknown) => number) | undefined;
    return size?.({ data: () => label });
  };

  it('asks per state rather than fixing one size for all of them', async () => {
    // Cytoscape re-runs a function mapper when the element's data changes, which is what makes
    // a state renamed in the properties panel come back at a size that fits.
    renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));

    expect(nodeFontSize('q0')).toBe(STATE_FONT_SIZE);
    expect(nodeFontSize('accepting')).toBeLessThan(STATE_FONT_SIZE);
  });
});

describe('moving a state by typing its coordinates', () => {
  it('says where the selected state is, and follows it when it is dragged', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));
    const cy = lastCy();

    act(() => cy.handlers.tap({ target: cy.byId('0') }));
    await waitFor(() => expect(api().selectedStatePosition).toEqual(cy.byId('0')?.position()));

    cy.byId('0')?.position({ x: 700, y: 400 });
    await act(async () => {
      await cy.handlers.position({ target: cy.byId('0') });
    });

    expect(api().selectedStatePosition).toEqual({ x: 700, y: 400 });
  });

  it('moves the state, and is one undoable step like a drag', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));
    const cy = lastCy();
    const before = { ...cy.byId('0')!.position() };
    act(() => cy.handlers.tap({ target: cy.byId('0') }));

    // Focus first, which is where the snapshot is taken, exactly as picking a state up is.
    act(() => api().beginEdit());
    act(() => api().moveState('0', { x: 250, y: 250 }));

    expect(cy.byId('0')?.position()).toEqual({ x: 250, y: 250 });
    await waitFor(() => expect(api().canUndo).toBe(true));

    act(() => api().undo());
    expect(cy.byId('0')?.position()).toEqual(before);
  });

  it('records nothing when the boxes are only tabbed through', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));

    act(() => api().beginEdit());

    expect(api().canUndo).toBe(false);
  });
});

describe('renaming a state', () => {
  const KEY = 'submissions:machine.jff';

  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('changes the label on the drawing and everything that describes it', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));
    act(() => lastCy().handlers.tap({ target: lastCy().byId('0') }));

    act(() => api().renameState('0', 'start'));

    await waitFor(() => expect(api().selectedState?.name).toBe('start'));
    expect(lastCy().byId('0')?.data('label')).toBe('start');
    // And every other panel that names it, which all come from the same parsed machine.
    expect(api().parsed?.states.find((st) => st.id === '0')?.name).toBe('start');
    expect(describeState(api().parsed!, '1', DEFAULT_EPS)?.incoming.join(' ')).toContain('start');
  });

  it('says the drawing has been changed, since it no longer matches the file', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));
    expect(api().viewModified).toBe(false);

    act(() => api().renameState('0', 'start'));

    await waitFor(() => expect(api().viewModified).toBe(true));
  });

  it('survives a rebuild, which re-reads the file and would put the old name back', async () => {
    const { api, rerender } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));
    act(() => api().renameState('0', 'start'));
    await waitFor(() => expect(lastCy().byId('0')?.data('label')).toBe('start'));

    // A theme change is a rebuild, and so is switching the layout.
    rerender({ darkMode: true });

    await waitFor(() => expect(instances.length).toBeGreaterThan(1));
    await waitFor(() => expect(lastCy().byId('0')?.data('label')).toBe('start'));
  });

  it('comes back after a refresh, with the note that says the file is not the file', async () => {
    // Without this the names reverted while the toolbar still said the drawing had been
    // changed, which was a claim about nothing.
    window.sessionStorage.setItem(
      `afct.viewer.view.${KEY}`,
      JSON.stringify({
        v: 1,
        zoom: 1,
        pan: { x: 0, y: 0 },
        positions: { '0': { x: 500, y: 500 }, '1': { x: 640, y: 500 } },
        honorPositions: true,
        modified: true,
        renames: { '0': 'start' },
      }),
    );

    const { api } = renderViewer({ viewStateKey: KEY });

    await waitFor(() => expect(lastCy().byId('0')?.data('label')).toBe('start'));
    expect(api().viewModified).toBe(true);
  });

  it('writes the names down, so the next visit has them', async () => {
    const { api } = renderViewer({ viewStateKey: KEY });
    // After the load has finished, so the write that carries the name has to be this change's
    // own rather than the one the load ends with.
    await waitFor(() => expect(api().phase).toBe('ready'));

    act(() => api().renameState('0', 'start'));

    await waitFor(() =>
      expect(JSON.parse(window.sessionStorage.getItem(`afct.viewer.view.${KEY}`)!).renames).toEqual(
        { '0': 'start' },
      ),
    );
  });

  it('is given up when the machine is put back the way it opened', async () => {
    const { api } = renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(instances).toHaveLength(1));
    act(() => api().renameState('0', 'start'));
    await waitFor(() => expect(api().viewModified).toBe(true));

    act(() => api().resetMachine());

    await waitFor(() => expect(instances.length).toBeGreaterThan(1));
    await waitFor(() => expect(lastCy().byId('0')?.data('label')).toBe('q0'));
    expect(api().viewModified).toBe(false);
  });
});

describe('choosing which state is initial', () => {
  const KEY = 'submissions:machine.jff';

  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('moves the marker rather than giving the machine two initial states', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));
    expect(
      api()
        .parsed?.states.filter((st) => st.initial)
        .map((st) => st.id),
    ).toEqual(['0']);

    act(() => api().setInitialState('1'));

    await waitFor(() =>
      expect(
        api()
          .parsed?.states.filter((st) => st.initial)
          .map((st) => st.id),
      ).toEqual(['1']),
    );
    expect(lastCy().byId('1')?.data('initial')).toBe(1);
    expect(lastCy().byId('0')?.data('initial')).toBe(0);
  });

  it('leaves the machine without one when the box is unticked', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));

    act(() => api().setInitialState(null));

    await waitFor(() => expect(api().parsed?.states.some((st) => st.initial)).toBe(false));
    expect(api().viewModified).toBe(true);
  });

  it('survives a rebuild and a refresh, like the names do', async () => {
    const { api, rerender } = renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(api().phase).toBe('ready'));
    act(() => api().setInitialState('1'));
    await waitFor(() =>
      expect(
        JSON.parse(window.sessionStorage.getItem(`afct.viewer.view.${KEY}`)!).initialState,
      ).toBe('1'),
    );

    rerender({ darkMode: true });

    await waitFor(() => expect(instances.length).toBeGreaterThan(1));
    await waitFor(() => expect(lastCy().byId('1')?.data('initial')).toBe(1));
    expect(lastCy().byId('0')?.data('initial')).toBe(0);
  });

  it('is given up when the machine is put back the way it opened', async () => {
    const { api } = renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(instances).toHaveLength(1));
    act(() => api().setInitialState('1'));
    await waitFor(() => expect(api().viewModified).toBe(true));

    act(() => api().resetMachine());

    await waitFor(() => expect(instances.length).toBeGreaterThan(1));
    await waitFor(() => expect(lastCy().byId('0')?.data('initial')).toBe(1));
    expect(api().viewModified).toBe(false);
  });
});

describe('choosing which states are final', () => {
  const KEY = 'submissions:machine.jff';

  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('marks one without saying anything about the others', async () => {
    // Unlike the initial state: a machine can have any number of final states, or none.
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));

    act(() => api().setFinalState('0', true));

    await waitFor(() =>
      expect(
        api()
          .parsed?.states.filter((st) => st.final)
          .map((st) => st.id),
      ).toEqual(['0', '1']),
    );
    expect(lastCy().byId('0')?.hasClass('final')).toBe(true);
    expect(api().viewModified).toBe(true);
  });

  it('takes the double circle away again', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));

    act(() => api().setFinalState('1', false));

    await waitFor(() => expect(lastCy().byId('1')?.hasClass('final')).toBe(false));
    expect(api().parsed?.states.some((st) => st.final)).toBe(false);
  });

  it('survives a rebuild and is written down for the next visit', async () => {
    const { api, rerender } = renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(api().phase).toBe('ready'));
    act(() => api().setFinalState('0', true));
    await waitFor(() =>
      expect(JSON.parse(window.sessionStorage.getItem(`afct.viewer.view.${KEY}`)!).finals).toEqual({
        '0': true,
      }),
    );

    rerender({ darkMode: true });

    await waitFor(() => expect(instances.length).toBeGreaterThan(1));
    await waitFor(() => expect(lastCy().byId('0')?.hasClass('final')).toBe(true));
  });
});

describe('changing what a transition reads', () => {
  const KEY = 'submissions:machine.jff';

  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('redraws the line from the transitions behind it', async () => {
    const { api } = renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(instances).toHaveLength(1));
    const edge = lastCy().edgeList.find(
      (e) => e.data('source') === '0' && e.data('target') === '1',
    );
    const before = edge?.data('label');

    act(() => api().setTransitionField(0, 'read', 'x'));

    await waitFor(() => expect(edge?.data('label')).not.toBe(before));
    expect(String(edge?.data('label'))).toContain('x');
    expect(api().viewModified).toBe(true);
  });

  it('leaves the other transitions on the same line alone', async () => {
    // Two transitions between the same pair are drawn as one line carrying both labels, so the
    // label is worked out again from all of them rather than replaced by the one that changed.
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));

    act(() => api().setTransitionField(0, 'read', 'x'));

    await waitFor(() => expect(api().parsed?.transitions[0]?.read).toBe('x'));
    expect(api().parsed?.transitions[1]?.read).not.toBe('x');
  });

  it('survives a rebuild and is written down for the next visit', async () => {
    const { api, rerender } = renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(api().phase).toBe('ready'));
    act(() => api().setTransitionField(0, 'read', 'x'));
    await waitFor(() =>
      expect(
        JSON.parse(window.sessionStorage.getItem(`afct.viewer.view.${KEY}`)!).transitions,
      ).toEqual({ '0': { read: 'x' } }),
    );

    rerender({ darkMode: true });

    await waitFor(() => expect(instances.length).toBeGreaterThan(1));
    await waitFor(() => expect(api().parsed?.transitions[0]?.read).toBe('x'));
  });
});

describe('putting a machine back the way it opened', () => {
  const KEY = 'submissions:machine.jff';
  const STORAGE_KEY = `afct.viewer.view.${KEY}`;

  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('builds the machine again from the file', async () => {
    // With something remembered, because that is what reset has to overrule: without it the
    // rebuild would restore the arrangement the reader just asked to be rid of.
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 1,
        zoom: 2,
        pan: { x: 0, y: 0 },
        positions: { '0': { x: 700, y: 700 }, '1': { x: 800, y: 700 } },
        honorPositions: true,
      }),
    );
    const { api } = renderViewer({ viewStateKey: KEY, honorPositionsDefault: true });
    await waitFor(() => expect(instances).toHaveLength(1));
    await waitFor(() => expect(lastCy().byId('0')?.position()).toEqual({ x: 700, y: 700 }));

    act(() => api().resetMachine());

    await waitFor(() => expect(instances.length).toBeGreaterThan(1));
    // Where the file itself puts q0, taken from what was handed to the new engine rather
    // than from a number written here, which would only be the scale factor restated.
    const fromFile = lastCy().rawElements.find((el) => (el.data as { id?: string }).id === '0')
      ?.position as { x: number; y: number };
    expect(fromFile).not.toEqual({ x: 700, y: 700 });
    expect(lastCy().byId('0')?.position()).toEqual(fromFile);
  });

  it('goes back to the layout the viewer opens on', async () => {
    const { api } = renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(api().honorPositions).toBe(false));
    act(() => api().toggleHonorPositions());
    await waitFor(() => expect(api().honorPositions).toBe(true));

    act(() => api().resetMachine());
    await waitFor(() => expect(api().honorPositions).toBe(false));
  });

  it('forgets the remembered view, so a refresh does not bring it back', async () => {
    const { api } = renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(window.sessionStorage.getItem(STORAGE_KEY)).not.toBeNull());

    act(() => api().resetMachine());

    // Immediately, before the rebuild writes an entry of its own. Waiting would find that
    // one and pass whether or not the old one was ever thrown away. The rebuild does write
    // one, and should: a refresh after a reset comes back to the reset machine.
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('leaves nothing to undo, since there is nothing to go back to', async () => {
    const { api } = renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(instances).toHaveLength(1));
    dragState();
    await waitFor(() => expect(api().canUndo).toBe(true));

    act(() => api().resetMachine());
    await waitFor(() => expect(api().canUndo).toBe(false));
  });
});

describe('keeping the canvas in step with its container', () => {
  /**
   * The global polyfill in `src/test/setup.ts` is inert, so a viewer under it never hears
   * about a resize at all and any assertion here would pass whatever the code did. This one
   * records its callback so the test can be the browser.
   */
  const observers: Array<() => void> = [];
  const observed: Element[] = [];
  class RecordingResizeObserver {
    constructor(private cb: () => void) {
      observers.push(() => this.cb());
    }
    observe(target: Element) {
      observed.push(target);
    }
    unobserve() {}
    disconnect() {}
  }

  beforeEach(() => {
    observers.length = 0;
    observed.length = 0;
    vi.stubGlobal('ResizeObserver', RecordingResizeObserver);
  });

  const resize = async () => {
    // Cytoscape watches the container itself and calls its own `resize` on a shorter debounce
    // than the viewer's, so by the time the viewer's handler runs the graph already knows its
    // new size. Without this the test asked the viewer to compare two readings it would never
    // get in a browser, and passed while a split pane left its machine half off the side.
    lastCy()?.resize();
    for (const fire of observers) fire();
    // The handler is debounced, so nothing has happened yet.
    await new Promise((resolve) => setTimeout(resolve, 250));
  };

  it('watches the container, not the window', async () => {
    // A pane in the standalone viewer is half the width of one that has the window to itself,
    // and it can change without the window changing at all. Asserted on what was observed
    // rather than on an observer existing: building one and never pointing it at anything
    // would satisfy that and hear nothing.
    const { container } = renderViewer();
    await waitFor(() => expect(observed.length).toBeGreaterThan(0));
    expect(observed).toContain(container.querySelector('[data-testid="canvas"]'));
  });

  it('keeps the zoom the reader set', async () => {
    // It used to refit here, so zooming in on one corner of a large machine and then dragging
    // the window wider put the whole machine back on screen at its own scale.
    renderViewer();
    await waitFor(() => expect(observers.length).toBeGreaterThan(0));
    lastCy().zoom(2.5);
    const fitsBefore = lastCy().fitCalls;

    await resize();

    expect(lastCy().zoomLevel).toBe(2.5);
    expect(lastCy().fitCalls).toBe(fitsBefore);
  });

  it('keeps what the reader was looking at in the middle', async () => {
    // Halving a pane must not move them: somebody examining one corner of a large automaton
    // splits the window and should still be looking at that corner, not back at the middle of
    // a machine they had deliberately scrolled away from.
    renderViewer();
    await waitFor(() => expect(observers.length).toBeGreaterThan(0));
    const cy = lastCy();
    cy.zoom(2);
    // Panned well away from the middle, as a reader examining a corner would be.
    cy.pan({ x: -1000, y: -400 });
    // The model point under the centre of the viewport right now.
    const centre = {
      x: (cy.viewWidth / 2 - cy.panPosition.x) / cy.zoomLevel,
      y: (cy.viewHeight / 2 - cy.panPosition.y) / cy.zoomLevel,
    };

    cy.containerWidth = 400; // the pane halved
    await resize();

    const after = {
      x: (cy.viewWidth / 2 - cy.panPosition.x) / cy.zoomLevel,
      y: (cy.viewHeight / 2 - cy.panPosition.y) / cy.zoomLevel,
    };
    expect(after.x).toBeCloseTo(centre.x, 6);
    expect(after.y).toBeCloseTo(centre.y, 6);
    expect(cy.zoomLevel).toBe(2);
  });

  it('does not move the view when the canvas had no size to compare against', async () => {
    // A container measured before it had a box would otherwise read as a change the width of a
    // whole pane, and throw the machine sideways the first time it was looked at.
    builtAt.width = 0;
    builtAt.height = 0;
    renderViewer();
    await waitFor(() => expect(observers.length).toBeGreaterThan(0));
    const cy = lastCy();
    cy.containerWidth = 800;
    cy.containerHeight = 600;
    const pan = { ...cy.panPosition };

    await resize();

    expect(cy.panPosition).toEqual(pan);
  });

  it('writes down the same centre after a resize, so refreshing does not walk the machine', async () => {
    // The drift Jeff saw: open the properties panel, refresh, and the machine sits further left
    // every time. The panel narrows the canvas after the view has been restored, so what is
    // written down has to be the point in the middle rather than the pan that put it there.
    const KEY = 'submissions:machine.jff';
    window.sessionStorage.clear();
    renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(observers.length).toBeGreaterThan(0));
    const cy = lastCy();
    cy.zoom(2);
    cy.pan({ x: -200, y: -80 });
    act(() => cy.handlers['viewport position']?.({}));
    await waitFor(() =>
      expect(
        JSON.parse(window.sessionStorage.getItem(`afct.viewer.view.${KEY}`)!).centre,
      ).toBeDefined(),
    );
    const before = JSON.parse(window.sessionStorage.getItem(`afct.viewer.view.${KEY}`)!).centre;

    // The panel opening: 20rem off the width of the canvas.
    cy.containerWidth = 480;
    await resize();
    act(() => cy.handlers['viewport position']?.({}));

    await waitFor(() => {
      const after = JSON.parse(window.sessionStorage.getItem(`afct.viewer.view.${KEY}`)!);
      expect(after.centre.x).toBeCloseTo(before.x, 6);
      expect(after.centre.y).toBeCloseTo(before.y, 6);
      // The pan did move, which is the point: the same place, seen through a narrower window.
      expect(after.pan.x).not.toBe(-200);
    });
  });

  it('leaves Fit to window fitting and centring, which is what it is for', async () => {
    // Resizing keeps the reader where they are; Fit deliberately does not. The two must stay
    // different, or the only way back to the whole machine is gone.
    const { api } = renderViewer();
    await waitFor(() => expect(observers.length).toBeGreaterThan(0));
    const fitsBefore = lastCy().fitCalls;
    lastCy().pan({ x: -1000, y: -400 });

    act(() => api().fit());

    await waitFor(() => expect(lastCy().fitCalls).toBeGreaterThan(fitsBefore));
  });

  it('centres the machine on request without touching the scale', async () => {
    // The other half of Fit: a reader who zoomed in on a corner and panned off the machine
    // wants it back in front of them at the scale they chose, not the whole thing at once.
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));
    const cy = lastCy();
    cy.zoom(2.5);
    cy.centerCalls = 0;
    const fitsBefore = cy.fitCalls;

    act(() => api().center());

    expect(cy.centerCalls).toBe(1);
    expect(cy.fitCalls).toBe(fitsBefore);
    expect(cy.zoomLevel).toBe(2.5);
  });

  it('does not recentre the whole machine, which would be a different place', async () => {
    renderViewer();
    await waitFor(() => expect(observers.length).toBeGreaterThan(0));
    lastCy().centerCalls = 0;
    lastCy().pan({ x: -1000, y: -400 });

    await resize();

    expect(lastCy().centerCalls).toBe(0);
  });
});

describe('undoing a layout switch', () => {
  /**
   * The sequence a reader actually performs: drag a state on the drawn layout, switch to
   * auto-arranged, then change their mind. Both the layout and the states they had moved have
   * to come back.
   *
   * Switching the layout rebuilds the graph, because `honorPositions` is an input to the load.
   * The step used to put the positions onto the graph it was about to throw away, so the
   * layout returned and every manual position was silently lost.
   */
  it('brings back the positions the reader had arranged, not just the layout', async () => {
    const { api } = renderViewer({ honorPositionsDefault: true });
    await waitFor(() => expect(instances).toHaveLength(1));

    // A state picked up and put down somewhere else, which is one undoable step.
    dragState('0', { x: 640, y: 480 });
    await waitFor(() => expect(api().canUndo).toBe(true));

    act(() => api().toggleHonorPositions());
    await waitFor(() => expect(api().honorPositions).toBe(false));
    await waitFor(() => expect(instances.length).toBeGreaterThan(1));

    act(() => api().undo());

    await waitFor(() => expect(api().honorPositions).toBe(true));
    await waitFor(() => expect(lastCy().byId('0')?.position()).toEqual({ x: 640, y: 480 }));
  });

  it('leaves the view where it was, since an undo moves the machine and not the camera', async () => {
    const { api } = renderViewer({ honorPositionsDefault: true });
    await waitFor(() => expect(instances).toHaveLength(1));
    dragState('0', { x: 640, y: 480 });
    await waitFor(() => expect(api().canUndo).toBe(true));

    act(() => api().toggleHonorPositions());
    await waitFor(() => expect(instances.length).toBeGreaterThan(1));
    // Where the reader is looking when they decide to undo. The rebuild the undo causes would
    // otherwise refit and move them somewhere else.
    lastCy().zoom(2.5);
    lastCy().pan({ x: -60, y: 24 });

    const built = instances.length;
    act(() => api().undo());

    // The undo rebuilds again, so wait for that graph before reading anything off it: the
    // one before it already has these values and would answer yes to both.
    await waitFor(() => expect(instances.length).toBeGreaterThan(built));
    await waitFor(() => expect(lastCy().zoomLevel).toBe(2.5));
    expect(lastCy().panPosition).toEqual({ x: -60, y: 24 });
  });

  it('still restores within one layout, where no rebuild happens', async () => {
    const { api } = renderViewer({ honorPositionsDefault: true });
    await waitFor(() => expect(instances).toHaveLength(1));
    const before = { ...lastCy().byId('0')!.position() };

    dragState('0', { x: 900, y: 900 });
    await waitFor(() => expect(api().canUndo).toBe(true));

    act(() => api().undo());
    expect(lastCy().byId('0')?.position()).toEqual(before);
    expect(instances).toHaveLength(1);
  });
});

describe("linking one pane's camera to the other", () => {
  it('reports where it is being looked at as soon as it starts driving', async () => {
    // Otherwise turning the link on does nothing until the reader happens to scroll, and it
    // reads as a control that did not work.
    const onViewportChange = vi.fn();
    renderViewer({ onViewportChange });
    await waitFor(() => expect(instances).toHaveLength(1));
    await waitFor(() => expect(onViewportChange).toHaveBeenCalled());
  });

  it('reports again when the reader moves', async () => {
    const onViewportChange = vi.fn();
    renderViewer({ onViewportChange });
    await waitFor(() => expect(instances).toHaveLength(1));
    onViewportChange.mockClear();

    lastCy().zoom(2.5);
    lastCy().pan({ x: -30, y: 12 });
    act(() => lastCy().handlers['viewport']?.({}));

    expect(onViewportChange).toHaveBeenCalledWith({ zoom: 2.5, pan: { x: -30, y: 12 } });
  });

  it("takes the other pane's camera when it is the one following", async () => {
    const { rerender } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));

    rerender({ linkedViewport: { zoom: 3, pan: { x: 40, y: -8 } } });

    await waitFor(() => expect(lastCy().zoomLevel).toBe(3));
    expect(lastCy().panPosition).toEqual({ x: 40, y: -8 });
  });

  it('does not report the camera it was just given', async () => {
    // Cytoscape reports a move whether a person or this code caused it. Reporting one back
    // would have the two panes talking past each other.
    const onViewportChange = vi.fn();
    const { rerender, api } = renderViewer({ onViewportChange });
    // Wait for the load to finish, not just for the graph to exist: it reports the opening
    // view when it ends, and clearing before that left the report racing the rerender below.
    await waitFor(() => expect(api().phase).toBe('ready'));
    onViewportChange.mockClear();

    // Both props at once, which the window never does: it gives a pane one or the other. This
    // is the guard's whole subject, so the test has to set up the case it guards against.
    rerender({ onViewportChange, linkedViewport: { zoom: 3, pan: { x: 40, y: -8 } } });
    await waitFor(() => expect(lastCy().zoomLevel).toBe(3));

    expect(onViewportChange).not.toHaveBeenCalled();
  });

  it('starts reporting when the link is switched on, not on the next scroll', async () => {
    // The graph is built after the first render, so an effect that reported on mount found
    // nothing there. This is the case it exists for: the link turned on later.
    const onViewportChange = vi.fn();
    const { rerender, api } = renderViewer();
    // Settled, not merely constructed: the load reports once at the end of its own run, and
    // rerendering before that finished would be answered by the load rather than by the
    // effect this is about.
    await waitFor(() => expect(api().settled).toBe(true));

    rerender({ onViewportChange });

    await waitFor(() => expect(onViewportChange).toHaveBeenCalled());
  });

  it('says nothing at all when nobody is listening', async () => {
    // Every viewer in a dialog, and every pane while the two are not linked.
    renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));
    lastCy().zoom(2);
    // No handler to call and nothing to report to; this must simply not throw.
    expect(() => act(() => lastCy().handlers['viewport']?.({}))).not.toThrow();
  });
});

describe('what a pane says while it is opening a machine, and when it cannot', () => {
  it('starts by saying it is fetching, and ends by saying it is done', async () => {
    const { api } = renderViewer();
    expect(api().phase).toBe('fetching');
    await waitFor(() => expect(api().phase).toBe('ready'));
    expect(api().failure).toBeNull();
  });

  it('tells a refusal apart from a request that never got an answer', async () => {
    // One is worth trying again and the other is not, and the reader can only tell if the
    // viewer does.
    global.fetch = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    const { api } = renderViewer();
    await waitFor(() => expect(api().failure).not.toBeNull());
    expect(api().failure?.retryable).toBe(true);
    expect(api().failure?.title).toMatch(/could not be reached/i);
  });

  it('does not offer to try again when the answer will be the same', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    }) as unknown as typeof fetch;
    const { api } = renderViewer();
    await waitFor(() => expect(api().failure).not.toBeNull());
    expect(api().failure?.retryable).toBe(false);
    expect(api().failure?.title).toMatch(/not yours to open/i);
  });

  it('builds no graph out of a file it could not fetch', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, statusText: 'Boom' }) as unknown as typeof fetch;
    renderViewer();
    await waitFor(() => expect(instances).toHaveLength(0));
    expect(cytoscapeMock.fn).not.toHaveBeenCalled();
  });

  it('opens the machine when a retry succeeds', async () => {
    // The case the retry exists for: the server was briefly unhappy, not the file.
    let attempt = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.resolve({ ok: false, status: 503, statusText: 'Unavailable' })
        : Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: async () => faXml });
    }) as unknown as typeof fetch;

    const { api } = renderViewer();
    await waitFor(() => expect(api().failure?.retryable).toBe(true));

    act(() => api().retry());

    await waitFor(() => expect(api().failure).toBeNull());
    await waitFor(() => expect(api().type).toBe('fa'));
  });
});

describe('saying that the drawing has been rearranged', () => {
  const KEY = 'submissions:machine.jff';
  const STORAGE_KEY = `afct.viewer.view.${KEY}`;

  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('says nothing about a file nobody has touched', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(api().phase).toBe('ready'));
    expect(api().viewModified).toBe(false);
  });

  it('speaks up once a state has been moved', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));
    dragState();
    await waitFor(() => expect(api().viewModified).toBe(true));
  });

  it('says nothing when a state is only clicked to read its properties', async () => {
    // A click starts by picking the state up, so recording the arrangement there made every
    // click report a rearrangement that had not happened.
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));
    const cy = lastCy();

    act(() => cy.handlers['grab']?.({ target: cy.byId('0') }));
    act(() => cy.handlers.tap({ target: cy.byId('0') }));

    await waitFor(() => expect(api().selectedState?.id).toBe('0'));
    expect(api().viewModified).toBe(false);
    expect(api().canUndo).toBe(false);
  });

  it('speaks up when the layout is switched, which moves every state', async () => {
    const { api } = renderViewer({ honorPositionsDefault: true });
    await waitFor(() => expect(instances).toHaveLength(1));
    act(() => api().toggleHonorPositions());
    await waitFor(() => expect(api().viewModified).toBe(true));
  });

  it('goes quiet again once the reader has undone what they did', async () => {
    const { api } = renderViewer({ honorPositionsDefault: true });
    await waitFor(() => expect(instances).toHaveLength(1));
    dragState();
    await waitFor(() => expect(api().viewModified).toBe(true));

    act(() => api().undo());
    await waitFor(() => expect(api().viewModified).toBe(false));
  });

  it('remembers across a refresh that something was moved', async () => {
    // The rearranging survives a reload, so the note that explains it has to as well.
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 1,
        zoom: 1,
        pan: { x: 0, y: 0 },
        positions: { '0': { x: 500, y: 500 }, '1': { x: 640, y: 500 } },
        honorPositions: true,
        modified: true,
      }),
    );
    const { api } = renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(api().viewModified).toBe(true));
  });

  it('writes down whether anything was moved, so the next visit knows', async () => {
    const { api } = renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(api().phase).toBe('ready'));
    expect(JSON.parse(window.sessionStorage.getItem(STORAGE_KEY)!).modified).toBe(false);

    // The drag alone, with no scroll after it: releasing the state is the last thing that
    // happens, so it is what has to write the flag down.
    dragState();
    await waitFor(() =>
      expect(JSON.parse(window.sessionStorage.getItem(STORAGE_KEY)!).modified).toBe(true),
    );
  });

  it('goes quiet when a rearrangement carried over from a refresh is put back', async () => {
    // The other direction: here the flag came from storage rather than from this session's
    // undo history, so clearing the history is not enough to answer it.
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 1,
        zoom: 1,
        pan: { x: 0, y: 0 },
        positions: { '0': { x: 500, y: 500 }, '1': { x: 640, y: 500 } },
        honorPositions: true,
        modified: true,
      }),
    );
    const { api } = renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(api().viewModified).toBe(true));

    act(() => api().resetMachine());
    await waitFor(() => expect(api().viewModified).toBe(false));
  });

  it('goes quiet when the machine is put back', async () => {
    const { api } = renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(instances).toHaveLength(1));
    dragState();
    await waitFor(() => expect(api().viewModified).toBe(true));

    act(() => api().resetMachine());
    await waitFor(() => expect(api().viewModified).toBe(false));
  });
});

/**
 * Undo and redo across the machine itself, not just where the states sit.
 *
 * The history used to be the arrangement's alone, so a reader who renamed a state or ticked
 * the wrong box had no way back short of Reset, which throws away everything else with it.
 * These check the harder half of that: putting a name back means writing the FILE's name, and
 * by then the drawing no longer remembers it.
 */
describe('undoing a change to the machine', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('puts back the name the file gave a state, not just the reader’s last one', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));

    act(() => api().beginEdit());
    act(() => api().renameState('0', 'start'));
    await waitFor(() => expect(lastCy().byId('0')?.data('label')).toBe('start'));
    expect(api().canUndo).toBe(true);

    act(() => api().undo());

    expect(lastCy().byId('0')?.data('label')).toBe('q0');
    expect(api().parsed?.states.find((st) => st.id === '0')?.name).toBe('q0');
    expect(api().canRedo).toBe(true);

    act(() => api().redo());
    expect(lastCy().byId('0')?.data('label')).toBe('start');
  });

  it('is one step for a whole name, not one per keystroke', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));

    // What typing "start" into the box actually sends.
    act(() => api().beginEdit());
    for (const value of ['s', 'st', 'sta', 'star', 'start']) {
      act(() => api().renameState('0', value));
    }

    act(() => api().undo());

    expect(lastCy().byId('0')?.data('label')).toBe('q0');
    expect(api().canUndo).toBe(false);
  });

  it('takes back making a state final, and the double circle with it', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));

    act(() => api().setFinalState('0', true));
    await waitFor(() => expect(lastCy().byId('0')?.hasClass('final')).toBe(true));

    act(() => api().undo());

    expect(lastCy().byId('0')?.hasClass('final')).toBe(false);
    expect(api().parsed?.states.find((st) => st.id === '0')?.final).toBe(false);
  });

  it('takes back moving the initial marker', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));

    act(() => api().setInitialState('1'));
    await waitFor(() => expect(lastCy().byId('1')?.data('initial')).toBe(1));

    act(() => api().undo());

    expect(lastCy().byId('0')?.data('initial')).toBe(1);
    expect(lastCy().byId('1')?.data('initial')).toBe(0);
  });

  /**
   * The marker is one node per initial state, so taking it away removes it entirely. Undoing
   * back has to make a new one rather than move one that is no longer there.
   */
  it('brings the initial marker back after it was taken away', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));
    const markers = () => lastCy().nodeList.filter((n) => n.hasClass('start'));
    expect(markers()).toHaveLength(1);

    act(() => api().setInitialState(null));
    await waitFor(() => expect(markers()).toHaveLength(0));

    act(() => api().undo());

    expect(markers()).toHaveLength(1);
    expect(lastCy().byId('0')?.data('initial')).toBe(1);
  });

  it('takes back what a transition reads, and redraws the line', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));
    const edge = () =>
      lastCy().edgeList.find((e) => e.data('source') === '0' && e.data('target') === '1');
    const before = edge()?.data('label');

    act(() => api().beginEdit());
    act(() => api().setTransitionField(0, 'read', 'x'));
    await waitFor(() => expect(edge()?.data('label')).not.toBe(before));

    act(() => api().undo());

    expect(edge()?.data('label')).toBe(before);
    expect(api().parsed?.transitions[0]?.read).not.toBe('x');
  });

  it('unwinds a drag and a rename in the order they were made', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));
    const cy = lastCy();
    const home = { ...cy.byId('0')!.position() };

    act(() => api().beginEdit());
    act(() => api().renameState('0', 'start'));
    act(() => api().beginEdit());
    act(() => api().moveState('0', { x: 250, y: 250 }));
    await waitFor(() => expect(cy.byId('0')?.position()).toEqual({ x: 250, y: 250 }));

    // The move first, because it was last.
    act(() => api().undo());
    expect(cy.byId('0')?.position()).toEqual(home);
    expect(cy.byId('0')?.data('label')).toBe('start');

    act(() => api().undo());
    expect(cy.byId('0')?.data('label')).toBe('q0');
  });

  it('makes the redo branch unreachable once something else is changed', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));

    act(() => api().setFinalState('0', true));
    act(() => api().undo());
    expect(api().canRedo).toBe(true);

    act(() => api().setInitialState('1'));

    expect(api().canRedo).toBe(false);
  });

  /**
   * The remembered view is what a refresh reads back, so an undo that did not reach it would
   * be given back the moment the reader reloaded the page.
   */
  it('is written down, so a refresh does not hand the change back', async () => {
    const KEY = 'submissions:machine.jff';
    const stored = () =>
      JSON.parse(window.sessionStorage.getItem(`afct.viewer.view.${KEY}`) ?? '{}');
    const { api } = renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(api().phase).toBe('ready'));

    act(() => api().beginEdit());
    act(() => api().renameState('0', 'start'));
    await waitFor(() => expect(stored().renames).toEqual({ '0': 'start' }));

    act(() => api().undo());

    await waitFor(() => expect(stored().renames).toEqual({}));
  });

  it('says the drawing matches the file again once the change is undone', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));
    expect(api().viewModified).toBe(false);

    act(() => api().setFinalState('0', true));
    await waitFor(() => expect(api().viewModified).toBe(true));

    act(() => api().undo());

    await waitFor(() => expect(api().viewModified).toBe(false));
  });
});

/**
 * Undo and redo across a refresh.
 *
 * The remembered view already brought a machine back exactly as the reader had left it, and
 * then refused to undo any of it: Undo was greyed out over work that was plainly still there.
 * The history travels with the rest of the view now.
 */
describe('carrying the undo history through a refresh', () => {
  const KEY = 'submissions:machine.jff';

  const stored = () => JSON.parse(window.sessionStorage.getItem(`afct.viewer.view.${KEY}`) ?? '{}');

  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('writes the steps down beside the arrangement', async () => {
    const { api } = renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(api().phase).toBe('ready'));

    act(() => api().setFinalState('0', true));

    await waitFor(() => expect(stored().history?.undo).toHaveLength(1));
    expect(stored().history.redo).toEqual([]);
    // The step is the drawing as it stood BEFORE the change, which is what undo returns to.
    expect(stored().history.undo[0].finals ?? {}).toEqual({});
    expect(stored().history.undo[0].positions).toHaveProperty('0');
  });

  it('brings Undo back enabled, and stepping back still works', async () => {
    window.sessionStorage.setItem(
      `afct.viewer.view.${KEY}`,
      JSON.stringify({
        v: 1,
        zoom: 1,
        pan: { x: 0, y: 0 },
        positions: { '0': { x: 500, y: 500 }, '1': { x: 640, y: 500 } },
        // The layout this viewer opens on: the restore is skipped when they disagree, because
        // one layout's positions over the other's is what made Auto-arranged look inert.
        honorPositions: false,
        modified: true,
        renames: { '0': 'start' },
        history: {
          undo: [
            {
              positions: { '0': { x: 500, y: 500 }, '1': { x: 640, y: 500 } },
              honorPositions: false,
            },
          ],
          redo: [],
        },
      }),
    );

    const { api } = renderViewer({ viewStateKey: KEY });

    // The renames are seeded at mount, but the history comes back with the restore at the very
    // end of the load, so this has to wait for the load rather than for the label.
    await waitFor(() => expect(api().canUndo).toBe(true));
    expect(lastCy().byId('0')?.data('label')).toBe('start');

    act(() => api().undo());

    // Back to the step's own answers, which named no renames at all.
    expect(lastCy().byId('0')?.data('label')).toBe('q0');
    expect(api().canRedo).toBe(true);
  });

  /**
   * A history is keyed by state id the same way an arrangement is, so one machine's steps must
   * never be applied to another's states.
   */
  it('ignores a history that names states this machine does not have', async () => {
    window.sessionStorage.setItem(
      `afct.viewer.view.${KEY}`,
      JSON.stringify({
        v: 1,
        zoom: 1,
        pan: { x: 0, y: 0 },
        positions: { '0': { x: 500, y: 500 }, '1': { x: 640, y: 500 } },
        honorPositions: false,
        history: {
          undo: [{ positions: { '99': { x: 0, y: 0 } }, honorPositions: false }],
          redo: [],
        },
      }),
    );

    const { api } = renderViewer({ viewStateKey: KEY });

    await waitFor(() => expect(api().phase).toBe('ready'));
    // `ready` is set before the restore runs, so give the restore a chance to be wrong.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api().canUndo).toBe(false);
  });
});

/**
 * Drawing a state.
 *
 * The viewer had no way to add anything to a machine before this: it could rename, re-mark and
 * re-word what the file already had, and nothing else. A drawn state is the fifth thing held
 * beside the parsed file rather than in it, so it survives a rebuild and a refresh the same way
 * a rename does, and it is undoable through the same history.
 */
describe('drawing a state on the canvas', () => {
  const KEY = 'submissions:machine.jff';

  beforeEach(() => {
    window.sessionStorage.clear();
  });

  /** A click on empty canvas, at a point in the graph's own coordinates. */
  const tapCanvas = (cy: FakeCy, at: { x: number; y: number }) =>
    act(() => cy.handlers.tap({ target: cy, position: at }));

  /**
   * A viewer with the State tool up.
   *
   * The hook knows only what a click on empty canvas should do, so the tool is a callback that
   * calls back into `addState`. That is a circle (the callback needs what the hook returns), and
   * the viewer breaks it with a ref written during render; here the api handle is enough,
   * because nothing taps the canvas until after the first render.
   */
  const withStateTool = (props: Partial<Parameters<typeof useJffCytoscape>[0]> = {}) => {
    const handle: { api?: () => ReturnType<typeof useJffCytoscape> } = {};
    const view = renderViewer({
      ...props,
      onBackgroundClick: (at) => {
        handle.api?.().addState(at);
        return true;
      },
    });
    handle.api = view.api;
    return view;
  };

  it('does nothing with the Select tool: empty canvas still just clears the panel', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));
    const before = lastCy().nodeList.length;

    tapCanvas(lastCy(), { x: 300, y: 400 });

    expect(lastCy().nodeList).toHaveLength(before);
    expect(api().selectedState).toBeNull();
  });

  it('draws one where the click landed, and opens its properties', async () => {
    const { api } = withStateTool();
    await waitFor(() => expect(instances).toHaveLength(1));

    tapCanvas(lastCy(), { x: 300, y: 400 });

    // The point cytoscape reported, which already has the zoom and the pan in it.
    await waitFor(() => expect(api().selectedState?.name).toBe('q2'));
    const drawn = lastCy().nodeList.find((n) => n.data('label') === 'q2');
    expect(drawn?.position()).toEqual({ x: 300, y: 400 });
    expect(api().parsed?.states.some((st) => st.name === 'q2')).toBe(true);
    // And the toolbar says the drawing is no longer the file.
    expect(api().viewModified).toBe(true);
  });

  it('draws a second one without the tool being chosen again', async () => {
    const { api } = withStateTool();
    await waitFor(() => expect(instances).toHaveLength(1));

    tapCanvas(lastCy(), { x: 300, y: 400 });
    await waitFor(() => expect(api().selectedState?.name).toBe('q2'));
    tapCanvas(lastCy(), { x: 500, y: 400 });

    await waitFor(() => expect(api().selectedState?.name).toBe('q3'));
    expect(api().parsed?.states).toHaveLength(4);
  });

  /** A tap on a state is a different branch entirely, so it can never leave one underneath. */
  it('does not draw one under an existing state', async () => {
    const { api } = withStateTool();
    await waitFor(() => expect(instances).toHaveLength(1));
    const cy = lastCy();

    act(() => cy.handlers.tap({ target: cy.byId('0') }));

    expect(cy.nodeList.filter((n) => !n.hasClass('start') && !n.hasClass('note'))).toHaveLength(2);
    expect(api().selectedState?.name).toBe('q0');
  });

  it('is one undo step, and redo puts it back', async () => {
    const { api } = withStateTool();
    await waitFor(() => expect(instances).toHaveLength(1));
    const drawn = () => lastCy().nodeList.find((n) => n.data('label') === 'q2');

    tapCanvas(lastCy(), { x: 300, y: 400 });
    await waitFor(() => expect(drawn()).toBeDefined());

    act(() => api().undo());

    expect(drawn()).toBeUndefined();
    expect(api().parsed?.states.some((st) => st.name === 'q2')).toBe(false);
    // The panel cannot go on describing a state that is no longer on the machine.
    expect(api().selectedState).toBeNull();

    act(() => api().redo());

    expect(drawn()).toBeDefined();
  });

  it('takes a name nobody is using, including one the reader typed', async () => {
    const { api } = withStateTool();
    await waitFor(() => expect(instances).toHaveLength(1));

    // q2 is the next free name, so claim it by hand first.
    act(() => api().renameState('1', 'q2'));
    tapCanvas(lastCy(), { x: 300, y: 400 });

    await waitFor(() => expect(api().selectedState?.name).toBe('q3'));
  });

  it('comes back after a refresh, like a rename does', async () => {
    const { api } = withStateTool({ viewStateKey: KEY });
    await waitFor(() => expect(api().phase).toBe('ready'));

    tapCanvas(lastCy(), { x: 300, y: 400 });

    await waitFor(() =>
      expect(
        JSON.parse(window.sessionStorage.getItem(`afct.viewer.view.${KEY}`)!).addedStates,
      ).toHaveLength(1),
    );

    // A second visit reads it back and draws it.
    const second = withStateTool({ viewStateKey: KEY });
    await waitFor(() =>
      expect(second.api().parsed?.states.some((st) => st.name === 'q2')).toBe(true),
    );
  });

  it('goes when the machine is put back the way it opened', async () => {
    const { api } = withStateTool({ viewStateKey: KEY });
    await waitFor(() => expect(api().phase).toBe('ready'));
    tapCanvas(lastCy(), { x: 300, y: 400 });
    await waitFor(() => expect(api().parsed?.states.some((st) => st.name === 'q2')).toBe(true));

    act(() => api().resetMachine());

    await waitFor(() => expect(api().parsed?.states.some((st) => st.name === 'q2')).toBe(false));
    expect(api().viewModified).toBe(false);
  });
});

/**
 * Taking something off the drawing.
 *
 * Removals are subtraction from the derived machine rather than surgery on the parse, so they
 * survive a rebuild and undo through the same history as everything else. What is worth
 * checking beyond that is the part with a rule of its own: a transition cannot outlive either
 * of the states it runs between.
 */
describe('deleting from the drawing', () => {
  const KEY = 'submissions:machine.jff';

  beforeEach(() => {
    window.sessionStorage.clear();
  });

  const nodeIds = () =>
    lastCy()
      .nodeList.filter((n) => !n.hasClass('start') && !n.hasClass('note'))
      .map((n) => n.id());

  it('takes a state and every transition that touched it', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));
    expect(api().parsed?.transitions.some((t) => t.from === '0' || t.to === '0')).toBe(true);

    act(() => api().removeState('0'));

    expect(nodeIds()).not.toContain('0');
    expect(api().parsed?.states.some((st) => st.id === '0')).toBe(false);
    // A transition into a state that is not there is not a machine, and would draw a line
    // with nothing on the end of it.
    expect(api().parsed?.transitions.some((t) => t.from === '0' || t.to === '0')).toBe(false);
    expect(lastCy().edgeList.some((e) => e.data('source') === '0')).toBe(false);
    expect(api().selectedState).toBeNull();
    expect(api().viewModified).toBe(true);
  });

  it('puts the state, its lines and all back on undo', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));
    const linesBefore = lastCy().edgeList.length;

    act(() => api().removeState('0'));
    act(() => api().undo());

    expect(nodeIds()).toContain('0');
    expect(api().parsed?.states.some((st) => st.id === '0')).toBe(true);
    expect(lastCy().edgeList).toHaveLength(linesBefore);
  });

  it('takes the transitions a line carries, leaving the states alone', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));
    const onTheLine = (api().parsed?.transitions ?? [])
      .filter((t) => t.from === '0' && t.to === '1')
      .map((t) => t.__idx);
    expect(onTheLine.length).toBeGreaterThan(0);

    act(() => api().removeTransitions(onTheLine));

    expect(api().parsed?.transitions.some((t) => t.from === '0' && t.to === '1')).toBe(false);
    expect(nodeIds()).toEqual(expect.arrayContaining(['0', '1']));
    // The line goes with the last transition drawn on it.
    expect(
      lastCy().edgeList.some((e) => e.data('source') === '0' && e.data('target') === '1'),
    ).toBe(false);

    act(() => api().undo());

    expect(
      lastCy().edgeList.some((e) => e.data('source') === '0' && e.data('target') === '1'),
    ).toBe(true);
  });

  it('is written down, so a refresh does not bring the state back', async () => {
    const { api } = renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(api().phase).toBe('ready'));

    act(() => api().removeState('0'));

    await waitFor(() =>
      expect(
        JSON.parse(window.sessionStorage.getItem(`afct.viewer.view.${KEY}`)!).removed.states,
      ).toEqual(['0']),
    );

    const second = renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(second.api().phase).toBe('ready'));
    expect(second.api().parsed?.states.some((st) => st.id === '0')).toBe(false);
  });

  it('comes back when the machine is put back the way it opened', async () => {
    const { api } = renderViewer({ viewStateKey: KEY });
    await waitFor(() => expect(api().phase).toBe('ready'));
    act(() => api().removeState('0'));
    await waitFor(() => expect(api().parsed?.states.some((st) => st.id === '0')).toBe(false));

    act(() => api().resetMachine());

    await waitFor(() => expect(api().parsed?.states.some((st) => st.id === '0')).toBe(true));
    expect(api().viewModified).toBe(false);
  });
});

/**
 * A machine nobody may change.
 *
 * The palette not offering a State button is not what makes a viewer read-only: anything else
 * that reaches these (a menu item, a shortcut, a pane linked to another) would sail past it.
 * The refusal lives here, with the machine, so there is one answer rather than one per caller.
 */
describe('a viewer that may not edit the machine', () => {
  const readOnly = (props: Partial<Parameters<typeof useJffCytoscape>[0]> = {}) =>
    renderViewer({ ...props, canEditMachine: false });

  it('refuses a rename', async () => {
    const { api } = readOnly();
    await waitFor(() => expect(api().phase).toBe('ready'));

    act(() => api().renameState('0', 'renamed'));

    expect(api().parsed?.states.some((s) => s.name === 'renamed')).toBe(false);
    expect(api().viewModified).toBe(false);
  });

  it('refuses the initial and final marks', async () => {
    const { api } = readOnly();
    await waitFor(() => expect(api().phase).toBe('ready'));
    const wasFinal = api().parsed?.states.find((s) => s.id === '1')?.final;

    act(() => api().setFinalState('1', !wasFinal));
    act(() => api().setInitialState('1'));

    expect(api().parsed?.states.find((s) => s.id === '1')?.final).toBe(wasFinal);
    expect(api().parsed?.states.find((s) => s.id === '1')?.initial).toBe(false);
    expect(api().viewModified).toBe(false);
  });

  it('refuses to draw a state, even when something calls straight through', async () => {
    const { api } = readOnly();
    await waitFor(() => expect(api().phase).toBe('ready'));
    const before = api().parsed?.states.length;

    act(() => api().addState({ x: 300, y: 400 }));

    expect(api().parsed?.states.length).toBe(before);
  });

  it('refuses to delete a state or a line', async () => {
    const { api } = readOnly();
    await waitFor(() => expect(api().phase).toBe('ready'));
    const states = api().parsed?.states.length;
    const transitions = api().parsed?.transitions.length;

    act(() => api().removeState('1'));
    act(() => api().removeTransitions([0]));

    expect(api().parsed?.states.length).toBe(states);
    expect(api().parsed?.transitions.length).toBe(transitions);
  });

  it('refuses to re-word a transition', async () => {
    const { api } = readOnly();
    await waitFor(() => expect(api().phase).toBe('ready'));
    const before = api().parsed?.transitions[0]?.read;

    act(() => api().setTransitionField(0, 'read', 'zzz'));

    expect(api().parsed?.transitions[0]?.read).toBe(before);
  });

  /**
   * Arranging is not editing. Dragging a state and typing its coordinates move the drawing, not
   * the machine, and pulling a crowded diagram apart is how a read-only one gets read.
   */
  it('still lets the drawing be arranged', async () => {
    const { api } = readOnly();
    await waitFor(() => expect(api().phase).toBe('ready'));

    act(() => api().moveState('1', { x: 640, y: 480 }));

    expect(lastCy().byId('1')?.position()).toEqual({ x: 640, y: 480 });
  });
});

/**
 * Drawing a transition between two states.
 *
 * The seventh thing held beside the parsed file rather than in it. A drawn line has no place in
 * the file's own numbering, so it takes an index above everything the file used and above every
 * one already handed out: that number is its name in `transitionEdits`, in a deletion and in the
 * `__idx` the derived machine gives it, and it is the same number after a rebuild, a refresh, an
 * undo and a redo.
 */
describe('drawing a transition on the canvas', () => {
  const KEY = 'submissions:machine.jff';

  beforeEach(() => {
    window.sessionStorage.clear();
  });

  /**
   * A viewer with the Transition tool up.
   *
   * The hook is told only what two clicks, one state and then another, mean; the viewer decides
   * that they mean a transition. Same circle as the State tool, broken the same way.
   */
  const withTransitionTool = (props: Partial<Parameters<typeof useJffCytoscape>[0]> = {}) => {
    const handle: { api?: () => ReturnType<typeof useJffCytoscape> } = {};
    const view = renderViewer({
      honorPositionsDefault: true,
      ...props,
      onStateLink: (from, to) => handle.api?.().addTransition(from, to),
    });
    handle.api = view.api;
    return view;
  };

  /** Where a state is on the graph. The canvas has no box in jsdom, so client is model. */
  const at = (id: string) => lastCy().byId(id)!.position();
  const canvas = () => screen.getByTestId('canvas');

  /**
   * A click on the canvas at a point in the graph's own coordinates. No button held.
   *
   * Both halves of what a browser does: the pointer event this gesture listens for, and then
   * cytoscape's own tap on whatever was under it, which arrives on release. Modelled because
   * the order is the whole question: the tap comes second, so without it a test cannot see the
   * tap selecting the state a line had just been joined to and closing the panel about the
   * line itself.
   */
  const clickAt = (to: { x: number; y: number }) => {
    fireEvent.pointerDown(canvas(), { clientX: to.x, clientY: to.y, pointerId: 1 });
    const cy = lastCy();
    const under = cy.nodeList.find(
      (n) =>
        !n.hasClass('start') &&
        !n.hasClass('note') &&
        !n.hasClass('preview') &&
        Math.hypot(n.position().x - to.x, n.position().y - to.y) <= 29,
    );
    cy.handlers.tap?.(under ? { target: under } : { target: cy, position: to });
  };
  const hoverAt = (to: { x: number; y: number }) =>
    fireEvent.pointerMove(canvas(), { clientX: to.x, clientY: to.y, pointerId: 1 });
  const nowhere = { x: 5000, y: 5000 };

  /** The whole two-click gesture: one state, then another. */
  const link = (fromId: string, to: { x: number; y: number }) => {
    clickAt(at(fromId));
    clickAt(to);
  };
  const classesOn = (id: string) => [...lastCy().byId(id)!.classes];

  const transitionsOf = (api: () => ReturnType<typeof useJffCytoscape>) =>
    api().parsed?.transitions.map((t) => `${t.from}->${t.to}`) ?? [];

  it('makes one where the second click landed, and opens its properties', async () => {
    const { api } = withTransitionTool();
    await waitFor(() => expect(api().phase).toBe('ready'));

    act(() => link('1', at('0')));

    await waitFor(() => expect(transitionsOf(api)).toContain('1->0'));
    // Its label starts empty in every field this machine type has, which is what an empty
    // element in a .jff parses to.
    const drawn = api().parsed?.transitions.find((t) => t.from === '1' && t.to === '0');
    expect(drawn?.read).toBe('');
    // And the panel is on it, so it can be labelled at once. By name, which is how the panel
    // describes a transition. The state the line was joined to must NOT be what ends up
    // selected: cytoscape's own tap on that state arrives after this, and it used to take the
    // new transition's place and put a state's properties in front of somebody who was about
    // to type a symbol.
    expect(api().selectedState).toBeNull();
    expect(api().selectedTransition?.from).toBe('q1');
    expect(api().selectedTransition?.to).toBe('q0');
    expect(api().selectedTransition?.transitions.map((t) => t.index)).toEqual([drawn!.__idx]);
    expect(api().viewModified).toBe(true);
  });

  /**
   * Three things a state can be during this gesture, and none of them is "selected".
   *
   * Before a line is started the state under the pointer is where one could begin; after it is
   * started the state under the pointer is where it could end, and the state it came from stays
   * dressed as its source until the line is finished or given up.
   */
  it('says what a click on the state under the pointer would do', async () => {
    const { api } = withTransitionTool();
    await waitFor(() => expect(api().phase).toBe('ready'));

    act(() => hoverAt(at('0')));
    expect(classesOn('0')).toContain('link-candidate');
    expect(classesOn('0')).not.toContain('highlighted');

    // Off the state again, and the invitation goes with it.
    act(() => hoverAt(nowhere));
    expect(classesOn('0')).not.toContain('link-candidate');

    act(() => clickAt(at('0')));
    expect(classesOn('0')).toContain('link-source');
    // Nothing was made and nothing was opened: the first click only says where to start.
    expect(api().canUndo).toBe(false);
    expect(api().selectedState).toBeNull();
    expect(api().viewModified).toBe(false);

    act(() => hoverAt(at('1')));
    expect(classesOn('1')).toContain('link-target');
    expect(classesOn('1')).not.toContain('link-candidate');
    // And the source is still plainly the source.
    expect(classesOn('0')).toContain('link-source');
  });

  it('draws a line from the source to the pointer, with no button held', async () => {
    const { api } = withTransitionTool();
    await waitFor(() => expect(api().phase).toBe('ready'));
    expect(lastCy().edgeList.some((e) => e.hasClass('preview'))).toBe(false);

    act(() => clickAt(at('0')));

    const preview = lastCy().edgeList.find((e) => e.hasClass('preview'));
    expect(preview?.data('source')).toBe('0');

    act(() => hoverAt({ x: 640, y: 480 }));

    expect(lastCy().byId('__afct-link-preview')?.position()).toEqual({ x: 640, y: 480 });
    // And it is nobody's transition: the machine has not changed.
    expect(api().parsed?.transitions.some((t) => t.from === '0' && t.to === undefined)).toBe(false);
  });

  it('does nothing when the canvas is clicked with no line started', async () => {
    const { api } = withTransitionTool();
    await waitFor(() => expect(api().phase).toBe('ready'));
    const before = api().parsed?.transitions.length;

    act(() => clickAt(nowhere));

    expect(api().parsed?.transitions.length).toBe(before);
    expect(lastCy().edgeList.some((e) => e.hasClass('preview'))).toBe(false);
    expect(api().canUndo).toBe(false);
  });

  it('gives the line up when the canvas is clicked, and stays in the tool', async () => {
    const { api } = withTransitionTool();
    await waitFor(() => expect(api().phase).toBe('ready'));
    act(() => clickAt(at('0')));

    act(() => clickAt(nowhere));

    expect(classesOn('0')).not.toContain('link-source');
    expect(lastCy().edgeList.some((e) => e.hasClass('preview'))).toBe(false);
    expect(api().canUndo).toBe(false);
    // Still listening: the next two clicks draw a line.
    act(() => link('1', at('0')));
    await waitFor(() => expect(transitionsOf(api)).toContain('1->0'));
  });

  it('takes its own clothes off the states when the line is finished', async () => {
    const { api } = withTransitionTool();
    await waitFor(() => expect(api().phase).toBe('ready'));

    act(() => link('1', at('0')));

    await waitFor(() => expect(transitionsOf(api)).toContain('1->0'));
    expect(classesOn('1')).not.toContain('link-source');
    expect(classesOn('0')).not.toContain('link-target');
    expect(lastCy().edgeList.some((e) => e.hasClass('preview'))).toBe(false);
  });

  /**
   * The state a line has just been joined to must not be dressed as "click here to start a
   * line" in the same instant. That put two meanings on one circle, next to a transition that
   * was selected and had its properties open, and the pointer had not moved to say either.
   */
  it('leaves nothing dressed up on the state it was just joined to', async () => {
    const { api } = withTransitionTool();
    await waitFor(() => expect(api().phase).toBe('ready'));

    act(() => link('1', at('0')));

    await waitFor(() => expect(transitionsOf(api)).toContain('1->0'));
    expect(classesOn('0')).not.toContain('link-candidate');
    expect(classesOn('0')).not.toContain('link-target');
    expect(classesOn('0')).not.toContain('link-source');
    // What IS true: the new transition is what is selected, and the tool is still up.
    expect(api().selectedTransition?.from).toBe('q1');
    expect(api().selectedState).toBeNull();
  });

  it('says "start here" again the moment the pointer moves', async () => {
    const { api } = withTransitionTool();
    await waitFor(() => expect(api().phase).toBe('ready'));
    act(() => link('1', at('0')));
    await waitFor(() => expect(transitionsOf(api)).toContain('1->0'));

    act(() => hoverAt(at('0')));

    expect(classesOn('0')).toContain('link-candidate');
  });

  /**
   * A click asks where the states are, not what is dressed up. So the state just joined to,
   * wearing nothing after the fix above, still starts the next line from a standing pointer.
   */
  it('starts the next line from the state just joined to, with no pointer movement', async () => {
    const { api } = withTransitionTool();
    await waitFor(() => expect(api().phase).toBe('ready'));
    act(() => link('1', at('0')));
    await waitFor(() => expect(api().selectedTransition).not.toBeNull());

    act(() => clickAt(at('0')));

    expect(classesOn('0')).toContain('link-source');
    expect(lastCy().edgeList.some((e) => e.hasClass('preview'))).toBe(true);
    // And it is a draft, not a transition: nothing has been made by that click.
    expect(transitionsOf(api).filter((t) => t === '0->0')).toHaveLength(0);
  });

  it('starts the next line from a third state, with no pointer movement', async () => {
    const { api } = withTransitionTool();
    await waitFor(() => expect(api().phase).toBe('ready'));
    act(() => link('1', at('0')));
    await waitFor(() => expect(transitionsOf(api)).toContain('1->0'));

    // Straight into the next one: the tool is still up and no click on it was needed.
    act(() => link('0', at('1')));

    await waitFor(() => expect(transitionsOf(api).filter((t) => t === '0->1')).toHaveLength(2));
  });

  /**
   * A label that has not been placed is drawn along the middle of its own line, which is what a
   * newly drawn transition looked like: an epsilon sitting on the arrow it belonged to.
   */
  it('lifts the new label clear of the line it belongs to', async () => {
    const { api } = withTransitionTool();
    await waitFor(() => expect(api().phase).toBe('ready'));

    act(() => link('1', at('0')));

    await waitFor(() => expect(transitionsOf(api)).toContain('1->0'));
    const line = lastCy().edgeList.find(
      (e) => e.data('source') === '1' && e.data('target') === '0',
    );
    await waitFor(() => expect(line!.style()['text-margin-x']).toBeDefined());
  });

  it('makes a self-loop when the drag ends where it began', async () => {
    const { api } = withTransitionTool();
    await waitFor(() => expect(api().phase).toBe('ready'));

    // Away and back again: the state a line starts from is a valid state to finish it on.
    act(() => {
      clickAt(at('0'));
      hoverAt(nowhere);
      clickAt(at('0'));
    });

    await waitFor(() => expect(transitionsOf(api)).toContain('0->0'));
  });

  it('makes nothing when the drag ends on empty canvas', async () => {
    const { api } = withTransitionTool();
    await waitFor(() => expect(api().phase).toBe('ready'));
    const before = api().parsed?.transitions.length;

    act(() => link('0', nowhere));

    expect(api().parsed?.transitions.length).toBe(before);
    // Nothing to undo either: a given-up gesture never touched the machine.
    expect(api().canUndo).toBe(false);
    expect(api().viewModified).toBe(false);
  });

  it('gives the line up on the first Escape and keeps the tool', async () => {
    const { api } = withTransitionTool();
    await waitFor(() => expect(api().phase).toBe('ready'));
    const before = api().parsed?.transitions.length;
    act(() => clickAt(at('0')));
    expect(classesOn('0')).toContain('link-source');

    // The answer is what tells the viewer whether the key was spent here or on the tool.
    let spent = false;
    act(() => {
      spent = api().cancelLinkDraft();
    });

    expect(spent).toBe(true);
    expect(classesOn('0')).not.toContain('link-source');
    expect(lastCy().edgeList.some((e) => e.hasClass('preview'))).toBe(false);
    expect(api().parsed?.transitions.length).toBe(before);
    // And with nothing half-drawn, the key is not spent here, so it goes on to the tool.
    expect(api().cancelLinkDraft()).toBe(false);
  });

  /**
   * The important one: with this tool up, a drag draws a line rather than moving the state.
   *
   * Asserted on the graph's own two switches rather than on where the state ended up, because
   * they are what actually decides it: states are held still for as long as the tool is up, and
   * the canvas is pinned for the length of a gesture so it cannot slide away under the drag.
   */
  it('holds the states still while the tool is up', async () => {
    const { api, rerender } = withTransitionTool();
    await waitFor(() => expect(api().phase).toBe('ready'));
    expect(lastCy().ungrabbed).toBe(true);

    const before = { ...at('0') };
    act(() => link('0', at('1')));

    expect(lastCy().byId('0')!.position()).toEqual(before);
    // Grabbable again the moment the tool goes, so Select still drags states about.
    act(() => rerender({ onStateLink: null }));
    expect(lastCy().ungrabbed).toBe(false);
  });

  it('takes the half-drawn line off the canvas when the tool changes', async () => {
    const { api, rerender } = withTransitionTool();
    await waitFor(() => expect(api().phase).toBe('ready'));
    act(() => clickAt(at('0')));
    act(() => hoverAt(nowhere));
    expect(lastCy().edgeList.some((e) => e.hasClass('preview'))).toBe(true);

    act(() => rerender({ onStateLink: null }));

    expect(lastCy().edgeList.some((e) => e.hasClass('preview'))).toBe(false);
    expect(lastCy().nodeList.some((n) => n.hasClass('preview'))).toBe(false);
    expect(classesOn('0')).not.toContain('link-source');
    // And clicking two states afterwards makes nothing, because nothing is listening.
    const before = api().parsed?.transitions.length;
    act(() => link('1', at('0')));
    expect(api().parsed?.transitions.length).toBe(before);
  });

  it('is one undo step, and redo puts it back', async () => {
    const { api } = withTransitionTool();
    await waitFor(() => expect(api().phase).toBe('ready'));
    act(() => link('1', at('0')));
    await waitFor(() => expect(transitionsOf(api)).toContain('1->0'));

    act(() => api().undo());

    expect(transitionsOf(api)).not.toContain('1->0');

    act(() => api().redo());

    expect(transitionsOf(api)).toContain('1->0');
  });

  it('shares a line with the transitions already between the same two states', async () => {
    const { api } = withTransitionTool();
    await waitFor(() => expect(api().phase).toBe('ready'));
    const linesBetween = () =>
      lastCy().edgeList.filter(
        (e) => e.data('source') === '0' && e.data('target') === '1' && !e.hasClass('preview'),
      );
    expect(linesBetween()).toHaveLength(1);

    act(() => link('0', at('1')));

    await waitFor(() => expect(transitionsOf(api).filter((t) => t === '0->1')).toHaveLength(2));
    // One line, two labels on it: the same way the file's own parallel transitions are drawn.
    expect(linesBetween()).toHaveLength(1);
  });

  it('is a transition like any other: named, deleted, and undeleted', async () => {
    const { api } = withTransitionTool();
    await waitFor(() => expect(api().phase).toBe('ready'));
    act(() => link('1', at('0')));
    await waitFor(() => expect(api().selectedTransition?.from).toBe('q1'));
    const idx = api().parsed!.transitions.find((t) => t.from === '1' && t.to === '0')!.__idx;

    act(() => api().setTransitionField(idx, 'read', 'b'));
    expect(api().parsed?.transitions.find((t) => t.__idx === idx)?.read).toBe('b');

    act(() => api().removeTransitions([idx]));
    expect(transitionsOf(api)).not.toContain('1->0');

    act(() => api().undo());
    expect(transitionsOf(api)).toContain('1->0');
    // The label came back with it, rather than the line coming back blank.
    expect(api().parsed?.transitions.find((t) => t.__idx === idx)?.read).toBe('b');
  });

  it('goes when a state it touches is deleted, and comes back with it', async () => {
    const { api } = withTransitionTool();
    await waitFor(() => expect(api().phase).toBe('ready'));
    act(() => link('1', at('0')));
    await waitFor(() => expect(transitionsOf(api)).toContain('1->0'));

    act(() => api().removeState('0'));

    expect(transitionsOf(api)).not.toContain('1->0');

    act(() => api().undo());

    expect(transitionsOf(api)).toContain('1->0');
  });

  it('cannot be drawn twice under the same name, even after an undo', async () => {
    const { api } = withTransitionTool();
    await waitFor(() => expect(api().phase).toBe('ready'));
    act(() => link('1', at('0')));
    await waitFor(() => expect(transitionsOf(api)).toContain('1->0'));
    const first = api().parsed!.transitions.find((t) => t.from === '1' && t.to === '0')!.__idx;

    act(() => api().undo());
    act(() => {
      clickAt(at('0'));
      clickAt(at('0'));
    });

    await waitFor(() => expect(transitionsOf(api)).toContain('0->0'));
    const second = api().parsed!.transitions.find((t) => t.from === '0' && t.to === '0')!.__idx;
    // A reused index would make an edit to one of them silently change the other.
    expect(second).not.toBe(first);
    expect(api().parsed!.transitions.map((t) => t.__idx)).toHaveLength(
      new Set(api().parsed!.transitions.map((t) => t.__idx)).size,
    );
  });

  it('comes back after a refresh, like a drawn state does', async () => {
    const { api } = withTransitionTool({ viewStateKey: KEY });
    await waitFor(() => expect(api().phase).toBe('ready'));

    act(() => link('1', at('0')));

    await waitFor(() =>
      expect(
        JSON.parse(window.sessionStorage.getItem(`afct.viewer.view.${KEY}`)!).addedTransitions,
      ).toHaveLength(1),
    );

    const second = withTransitionTool({ viewStateKey: KEY });
    await waitFor(() => expect(transitionsOf(second.api)).toContain('1->0'));
  });

  it('is written into the machine that leaves the viewer', async () => {
    const { api } = withTransitionTool();
    await waitFor(() => expect(api().phase).toBe('ready'));

    act(() => link('1', at('0')));

    await waitFor(() => expect(transitionsOf(api)).toContain('1->0'));
    // What "Download this arrangement" writes out is this machine, so a drawn line reaches the
    // file the same way a drawn state does.
    const xml = toJflapXml(api().parsed!);
    expect(parseJflap(xml).transitions.map((t) => `${t.from}->${t.to}`)).toContain('1->0');
  });

  it('is refused when the machine may not be edited', async () => {
    const { api } = renderViewer({ canEditMachine: false, honorPositionsDefault: true });
    await waitFor(() => expect(api().phase).toBe('ready'));
    const before = api().parsed?.transitions.length;

    act(() => api().addTransition('0', '1'));

    expect(api().parsed?.transitions.length).toBe(before);
  });

  it('refuses an end that is not on the machine', async () => {
    const { api } = withTransitionTool();
    await waitFor(() => expect(api().phase).toBe('ready'));
    const before = api().parsed?.transitions.length;

    act(() => api().addTransition('0', 'nowhere'));

    expect(api().parsed?.transitions.length).toBe(before);
  });
});

/**
 * Putting the selection down.
 *
 * Selecting lights one element and dims the rest, so dropping the selection has to undo both.
 * It used to set the three pieces of React state and nothing else, which closed the panel and
 * left the drawing insisting something was still selected: the state lit up, the machine behind
 * it faded, and no way back except clicking the canvas.
 */
describe('clearing a selection', () => {
  const tapNode = (id: string) => {
    const cy = lastCy();
    act(() => cy.handlers.tap({ target: cy.byId(id) }));
  };
  const lit = () =>
    lastCy()
      .nodeList.filter((n) => n.hasClass('highlighted'))
      .map((n) => n.id());
  const dimmed = () =>
    [...lastCy().nodeList, ...lastCy().edgeList].filter((e) => e.hasClass('faded')).length;

  it('takes the light off the state and the dimming off everything else', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(api().phase).toBe('ready'));
    tapNode('0');
    expect(lit()).toEqual(['0']);
    expect(dimmed()).toBeGreaterThan(0);

    act(() => api().clearSelectedState());

    expect(lit()).toEqual([]);
    expect(dimmed()).toBe(0);
    expect(api().selectedState).toBeNull();
  });

  it('takes it off when the selected state is deleted, since nothing else would', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(api().phase).toBe('ready'));
    tapNode('0');
    expect(dimmed()).toBeGreaterThan(0);

    act(() => api().removeState('0'));

    expect(dimmed()).toBe(0);
  });

  it('takes it off when the selected line is deleted', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(api().phase).toBe('ready'));
    act(() => {
      const cy = lastCy();
      cy.handlers.tap({ target: cy.edgeList[0] });
    });
    expect(dimmed()).toBeGreaterThan(0);

    act(() => api().removeTransitions([0]));

    expect(dimmed()).toBe(0);
  });
});

/**
 * Snap to grid, during the drag rather than after it.
 *
 * The setting says the states sit on a lattice, and what it used to do was let one follow the
 * pointer exactly and then jump when it was let go. These are about the difference.
 *
 * The fixture here matters: cytoscape drags a node by shifting it from where it currently is by
 * the distance the pointer moved since the last event, so `dragBy` shifts the node and then
 * fires `drag`, which is the order and the arithmetic the real thing uses. A mock that set an
 * absolute position instead would make the interesting bug untestable.
 */
describe('snapping a state to the grid as it is dragged', () => {
  const GRID = 24;

  const putAt = (id: string, at: { x: number; y: number }) => {
    lastCy().byId(id)!.position(at);
  };
  const positionOf = (id = '0') => lastCy().byId(id)!.position();
  const grab = (id = '0') => act(() => lastCy().handlers['grab']?.({ target: lastCy().byId(id) }));
  const drop = (id = '0') =>
    act(() => lastCy().handlers['dragfree']?.({ target: lastCy().byId(id) }));

  /** One pointer move: cytoscape shifts the node, then says it dragged. */
  const dragBy = (dx: number, dy: number, id = '0') => {
    const cy = lastCy();
    const node = cy.byId(id)!;
    const at = node.position();
    node.position({ x: at.x + dx, y: at.y + dy });
    act(() => cy.handlers['drag']?.({ target: node }));
    return node.position();
  };

  const withSnap = async () => {
    const view = renderViewer({ honorPositionsDefault: true });
    await waitFor(() => expect(view.api().phase).toBe('ready'));
    act(() => view.api().toggleSnapToGrid());
    await waitFor(() => expect(view.api().snapToGrid).toBe(true));
    return view;
  };

  it('leaves the state exactly under the pointer when the setting is off', async () => {
    const { api } = renderViewer({ honorPositionsDefault: true });
    await waitFor(() => expect(api().phase).toBe('ready'));
    putAt('0', { x: 96, y: 96 });
    grab();

    expect(dragBy(5, 3)).toEqual({ x: 101, y: 99 });
    expect(dragBy(5, 3)).toEqual({ x: 106, y: 102 });
  });

  it('holds the state on its grid point until the pointer crosses the halfway line', async () => {
    await withSnap();
    putAt('0', { x: 96, y: 96 });
    grab();

    // Eleven units along: still nearer 96 than 120, so the state has not moved.
    dragBy(11, 0);
    expect(positionOf()).toEqual({ x: 96, y: 96 });

    // Two more takes the pointer past 108, the midpoint, and the state steps a whole cell.
    dragBy(2, 0);
    expect(positionOf()).toEqual({ x: 120, y: 96 });
  });

  /**
   * The one that the obvious implementation gets wrong. Cytoscape's shift is relative to where
   * the node is, so snapping and writing back throws away the part of the movement that did not
   * reach the next cell; a run of small frames each rounds to nothing and the state sits still
   * under a pointer that has crossed two cells.
   */
  it('follows a slow drag, rather than sticking on frames too small to round', async () => {
    await withSnap();
    putAt('0', { x: 96, y: 96 });
    grab();

    // Fifteen units in three-unit steps: enough to pass the midpoint, none of them enough on
    // its own to round anywhere.
    for (let i = 0; i < 5; i += 1) dragBy(3, 0);

    expect(positionOf()).toEqual({ x: 120, y: 96 });
  });

  it('writes nothing while the pointer stays in the cell it is already on', async () => {
    await withSnap();
    putAt('0', { x: 96, y: 96 });
    grab();
    dragBy(1, 1);
    const node = lastCy().byId('0')!;
    const before = { ...node.position() };

    // A frame with no movement at all: the node is where it should be, so nothing is written.
    act(() => lastCy().handlers['drag']?.({ target: node }));

    expect(node.position()).toEqual(before);
  });

  it('still puts the final position on the lattice when it is let go', async () => {
    // The invariant, kept whatever the drag did: a coalesced frame, the setting turned on
    // halfway, or a state moved by something that is not a drag at all.
    await withSnap();
    putAt('0', { x: 37, y: 61 });

    grab();
    drop();

    expect(positionOf()).toEqual({ x: 48, y: 72 });
  });

  it('is one undo step, however many grid points it stepped through', async () => {
    const { api } = await withSnap();
    putAt('0', { x: 96, y: 96 });
    expect(api().canUndo).toBe(false);

    grab();
    for (let i = 0; i < 8; i += 1) dragBy(GRID, 0);
    drop();

    await waitFor(() => expect(api().canUndo).toBe(true));
    act(() => api().undo());
    expect(api().canUndo).toBe(false);
  });

  it("measures the lattice in the graph's own units, whatever the zoom", async () => {
    // The painted grid scales with the graph, so a cell is 24 model units at any magnification.
    // Snapping in rendered pixels would put the states between the lines at anything but 100%.
    const { api } = await withSnap();
    act(() => api().setZoom(2.5));
    putAt('0', { x: 96, y: 96 });
    grab();

    dragBy(13, 0);

    expect(positionOf()).toEqual({ x: 120, y: 96 });
  });

  it('leaves a note and the start marker alone', async () => {
    // Neither is a state: one is the author's words and the other hangs off the initial state,
    // and both are placed by code that would only be fighting this.
    await withSnap();
    const cy = lastCy();
    const marker = cy.nodeList.find((n) => n.hasClass('start'));
    expect(marker).toBeDefined();
    marker!.position({ x: 37, y: 61 });

    act(() => cy.handlers['drag']?.({ target: marker }));

    expect(marker!.position()).toEqual({ x: 37, y: 61 });
  });
});

/**
 * Picking out several states at once.
 *
 * Ctrl on Windows and Linux, Cmd on a Mac, which is how every editor spells "and this one too".
 * There is no mode to be in: a plain click still replaces the selection.
 *
 * The inspector is unchanged and still describes one state. It closes for two because the
 * question "which state is this panel about" has no answer, not because it knows anything about
 * multiple selection.
 */
describe('selecting more than one state', () => {
  const tap = (id: string, modifier?: 'ctrlKey' | 'metaKey') => {
    const cy = lastCy();
    act(() =>
      cy.handlers['tap']?.({
        target: cy.byId(id),
        ...(modifier ? { originalEvent: { [modifier]: true } } : {}),
      }),
    );
  };
  const tapBackground = () => {
    const cy = lastCy();
    act(() => cy.handlers['tap']?.({ target: cy, position: { x: 900, y: 900 } }));
  };
  const tapEdge = () => {
    const cy = lastCy();
    act(() => cy.handlers['tap']?.({ target: cy.edgeList[0] }));
  };
  const lit = () =>
    lastCy()
      .nodeList.filter((n) => n.hasClass('highlighted'))
      .map((n) => n.id())
      .sort();

  const ready = async () => {
    const view = renderViewer({ honorPositionsDefault: true });
    await waitFor(() => expect(view.api().phase).toBe('ready'));
    return view;
  };

  it('replaces the selection on a plain click', async () => {
    const { api } = await ready();

    tap('0');
    expect(api().selectedStateIds).toEqual(['0']);
    expect(api().selectedState?.name).toBe('q0');

    tap('1');
    expect(api().selectedStateIds).toEqual(['1']);
    expect(api().selectedState?.name).toBe('q1');
  });

  it('adds a state with ctrl, and with cmd', async () => {
    const { api } = await ready();

    tap('0');
    tap('1', 'ctrlKey');
    expect(api().selectedStateIds).toEqual(['0', '1']);

    tap('0');
    tap('1', 'metaKey');
    expect(api().selectedStateIds).toEqual(['0', '1']);
  });

  it('takes a state back out when it is clicked again with the key held', async () => {
    const { api } = await ready();
    tap('0');
    tap('1', 'ctrlKey');

    tap('1', 'ctrlKey');

    expect(api().selectedStateIds).toEqual(['0']);
  });

  it('starts a selection with the key held, from nothing', async () => {
    const { api } = await ready();

    tap('0', 'ctrlKey');

    expect(api().selectedStateIds).toEqual(['0']);
  });

  it('shuts the inspector for two states and opens it again for one', async () => {
    const { api } = await ready();
    tap('0');
    expect(api().selectedState).not.toBeNull();

    tap('1', 'ctrlKey');

    // Still selected, both of them: it is the panel that goes, not the selection.
    expect(api().selectedStateIds).toEqual(['0', '1']);
    expect(api().selectedState).toBeNull();
    expect(api().selectedStatePosition).toBeNull();

    tap('1', 'ctrlKey');

    expect(api().selectedState?.name).toBe('q0');
    expect(api().selectedStatePosition).not.toBeNull();
  });

  it('lights every selected state, and dims the rest', async () => {
    await ready();

    tap('0');
    expect(lit()).toEqual(['0']);

    tap('1', 'ctrlKey');
    expect(lit()).toEqual(['0', '1']);
  });

  it('puts the states down when a transition is clicked, and the other way round', async () => {
    const { api } = await ready();
    tap('0');
    tap('1', 'ctrlKey');

    tapEdge();

    expect(api().selectedStateIds).toEqual([]);
    expect(api().selectedTransition).not.toBeNull();

    tap('0');

    expect(api().selectedTransition).toBeNull();
    expect(api().selectedStateIds).toEqual(['0']);
  });

  it('clears everything on a click on empty canvas', async () => {
    const { api } = await ready();
    tap('0');
    tap('1', 'ctrlKey');

    tapBackground();

    expect(api().selectedStateIds).toEqual([]);
    expect(lit()).toEqual([]);
  });

  it('is not a change to the machine, so it is not on the undo stack', async () => {
    const { api } = await ready();

    tap('0');
    tap('1', 'ctrlKey');
    tap('1', 'ctrlKey');
    tapBackground();

    expect(api().canUndo).toBe(false);
    expect(api().viewModified).toBe(false);
  });

  it('moves only the state that was dragged', async () => {
    // Group dragging is a separate feature with its own history question. Cytoscape's own
    // notion of selection is deliberately not used, which is what keeps this true.
    const { api } = await ready();
    tap('0');
    tap('1', 'ctrlKey');
    const before = { ...lastCy().byId('1')!.position() };

    act(() => lastCy().handlers['grab']?.({ target: lastCy().byId('0') }));
    lastCy().byId('0')!.position({ x: 400, y: 400 });
    act(() => lastCy().handlers['dragfree']?.({ target: lastCy().byId('0') }));

    expect(lastCy().byId('0')!.position()).toEqual({ x: 400, y: 400 });
    expect(lastCy().byId('1')!.position()).toEqual(before);
    // And the selection survived the drag.
    expect(api().selectedStateIds).toEqual(['0', '1']);
  });

  it('drops a state undo has taken off the machine, and keeps the rest', async () => {
    const { api } = await ready();
    act(() => api().addState({ x: 300, y: 300 }));
    await waitFor(() => expect(api().selectedStateIds).toHaveLength(1));
    const drawn = api().selectedStateIds[0]!;
    tap('0', 'ctrlKey');
    expect(api().selectedStateIds).toEqual([drawn, '0']);

    act(() => api().undo());

    expect(api().selectedStateIds).toEqual(['0']);
  });
});

/** What comes back after a refresh, which is a selection of any size. */
describe('remembering which states were selected', () => {
  const KEY = 'submissions:machine.jff';

  beforeEach(() => {
    window.sessionStorage.clear();
  });

  const stored = () =>
    JSON.parse(window.sessionStorage.getItem(`afct.viewer.view.${KEY}`)!).selection;

  it('writes one state the way it always has, and several as a list', async () => {
    const { api } = renderViewer({ viewStateKey: KEY, honorPositionsDefault: true });
    await waitFor(() => expect(api().phase).toBe('ready'));
    const cy = lastCy();

    act(() => cy.handlers['tap']?.({ target: cy.byId('0') }));
    await waitFor(() => expect(stored()).toEqual({ kind: 'state', id: '0' }));

    act(() => cy.handlers['tap']?.({ target: cy.byId('1'), originalEvent: { ctrlKey: true } }));
    await waitFor(() => expect(stored()).toEqual({ kind: 'state', id: '0', ids: ['0', '1'] }));
  });

  it('brings a whole selection back, with the inspector still shut', async () => {
    const { api } = renderViewer({ viewStateKey: KEY, honorPositionsDefault: true });
    await waitFor(() => expect(api().phase).toBe('ready'));
    const cy = lastCy();
    act(() => cy.handlers['tap']?.({ target: cy.byId('0') }));
    act(() => cy.handlers['tap']?.({ target: cy.byId('1'), originalEvent: { ctrlKey: true } }));
    await waitFor(() => expect(stored().ids).toEqual(['0', '1']));

    const second = renderViewer({ viewStateKey: KEY, honorPositionsDefault: true });

    await waitFor(() => expect(second.api().selectedStateIds).toEqual(['0', '1']));
    expect(second.api().selectedState).toBeNull();
  });

  /** An entry written before a selection could name more than one state still opens. */
  it('restores an older entry that names a single state', async () => {
    window.sessionStorage.setItem(
      `afct.viewer.view.${KEY}`,
      JSON.stringify({
        v: 1,
        zoom: 1,
        pan: { x: 0, y: 0 },
        positions: { '0': { x: 10, y: 20 }, '1': { x: 100, y: 20 } },
        honorPositions: true,
        selection: { kind: 'state', id: '1' },
      }),
    );

    const { api } = renderViewer({ viewStateKey: KEY, honorPositionsDefault: true });

    await waitFor(() => expect(api().selectedStateIds).toEqual(['1']));
    expect(api().selectedState?.name).toBe('q1');
  });
});

/**
 * Lining up and spreading out the states that are picked out.
 *
 * The arrangement rather than the machine, like a drag: it moves the drawing, the file it came
 * from is untouched, and the whole command is one undo step however many states it moved.
 */
describe('arranging the selected states', () => {
  const tap = (id: string, modifier?: 'ctrlKey' | 'metaKey') => {
    const cy = lastCy();
    act(() =>
      cy.handlers['tap']?.({
        target: cy.byId(id),
        ...(modifier ? { originalEvent: { [modifier]: true } } : {}),
      }),
    );
  };
  const positionOf = (id: string) => lastCy().byId(id)!.position();
  const putAt = (id: string, at: { x: number; y: number }) => lastCy().byId(id)!.position(at);

  const ready = async () => {
    const view = renderViewer({ honorPositionsDefault: true });
    await waitFor(() => expect(view.api().phase).toBe('ready'));
    return view;
  };

  it('brings the selected states onto one line, leaving the other axis alone', async () => {
    const { api } = await ready();
    putAt('0', { x: 10, y: 100 });
    putAt('1', { x: 90, y: 40 });
    tap('0');
    tap('1', 'ctrlKey');

    act(() => api().alignStates('left'));

    expect(positionOf('0')).toEqual({ x: 10, y: 100 });
    expect(positionOf('1')).toEqual({ x: 10, y: 40 });
  });

  it('spreads three out evenly, keeping the two on the ends', async () => {
    const { api } = await ready();
    act(() => api().addState({ x: 200, y: 0 }));
    await waitFor(() => expect(api().parsed?.states).toHaveLength(3));
    const drawn = api().selectedStateIds[0]!;
    putAt('0', { x: 0, y: 0 });
    putAt('1', { x: 10, y: 0 });
    putAt(drawn, { x: 100, y: 0 });
    tap('0');
    tap('1', 'ctrlKey');
    act(() =>
      lastCy().handlers['tap']?.({
        target: lastCy().byId(drawn),
        originalEvent: { ctrlKey: true },
      }),
    );

    act(() => api().distributeStates('horizontal'));

    expect(positionOf('0').x).toBe(0);
    expect(positionOf('1').x).toBe(50);
    expect(positionOf(drawn).x).toBe(100);
  });

  it('is one undo step, however many states it moved', async () => {
    const { api } = await ready();
    // Both states have to move, or one step and one step per state look the same.
    putAt('0', { x: 10, y: 100 });
    putAt('1', { x: 90, y: 40 });
    tap('0');
    tap('1', 'ctrlKey');
    expect(api().canUndo).toBe(false);

    act(() => api().alignStates('middle'));

    expect(positionOf('0').y).toBe(70);
    expect(positionOf('1').y).toBe(70);
    await waitFor(() => expect(api().canUndo).toBe(true));

    act(() => api().undo());

    expect(positionOf('0')).toEqual({ x: 10, y: 100 });
    expect(positionOf('1')).toEqual({ x: 90, y: 40 });
    expect(api().canUndo).toBe(false);
  });

  it('records nothing when the states are already where the command wants them', async () => {
    const { api } = await ready();
    putAt('0', { x: 10, y: 40 });
    putAt('1', { x: 90, y: 40 });
    tap('0');
    tap('1', 'ctrlKey');

    act(() => api().alignStates('top'));

    expect(api().canUndo).toBe(false);
  });

  it('does nothing with fewer states than the command needs', async () => {
    const { api } = await ready();
    putAt('0', { x: 10, y: 100 });
    putAt('1', { x: 90, y: 40 });
    tap('0');

    act(() => api().alignStates('left'));
    expect(positionOf('0')).toEqual({ x: 10, y: 100 });
    expect(api().canUndo).toBe(false);

    // Two is enough to line up and not enough to spread out.
    tap('1', 'ctrlKey');
    act(() => api().distributeStates('horizontal'));
    expect(positionOf('0')).toEqual({ x: 10, y: 100 });
    expect(api().canUndo).toBe(false);
  });

  it('leaves the states nobody picked out where they are', async () => {
    const { api } = await ready();
    putAt('0', { x: 10, y: 100 });
    putAt('1', { x: 90, y: 40 });
    tap('0');

    // One selected is too few to align, so nothing moves at all; the point is that the
    // command reads the selection rather than the whole machine.
    act(() => api().alignStates('left'));

    expect(positionOf('1')).toEqual({ x: 90, y: 40 });
  });

  it('puts the labels back in step with the states it moved', async () => {
    const { api } = await ready();
    putAt('0', { x: 10, y: 100 });
    putAt('1', { x: 90, y: 40 });
    tap('0');
    tap('1', 'ctrlKey');

    const line = lastCy().edgeList.find(
      (e) => e.data('source') === '0' && e.data('target') === '1',
    )!;
    // Cleared first, so this is about the align putting them back rather than about the load
    // having set them once at the start.
    line.style_ = {};

    act(() => api().alignStates('middle'));

    await waitFor(() => expect(line.style()['text-margin-x']).toBeDefined());
  });
});

/**
 * Several transitions on one line, managed one at a time.
 *
 * Parallel transitions between the same two states share a line and a panel. Each is its own
 * record with its own index, and that index is what a deletion names: the number the panel
 * shows is where it sits in the list and nothing more.
 */
describe('one line, several transitions', () => {
  const bundled = `<?xml version="1.0"?>
<structure>
  <type>fa</type>
  <automaton>
    <state id="0" name="q0"><x>10</x><y>20</y><initial/></state>
    <state id="1" name="q1"><x>100</x><y>20</y><final/></state>
    <transition><from>0</from><to>1</to><read>0</read></transition>
    <transition><from>0</from><to>1</to><read>8</read></transition>
  </automaton>
</structure>`;

  const ready = async () => {
    global.fetch = fetchOk(bundled) as unknown as typeof fetch;
    const view = renderViewer({ honorPositionsDefault: true });
    await waitFor(() => expect(view.api().phase).toBe('ready'));
    return view;
  };
  const reads = (api: () => ReturnType<typeof useJffCytoscape>) =>
    (api().parsed?.transitions ?? []).map((t) => t.read);
  const selectLine = () => {
    const cy = lastCy();
    act(() => cy.handlers['tap']?.({ target: cy.edgeList[0] }));
  };

  it('takes off the one that was named, and leaves the other', async () => {
    const { api } = await ready();
    selectLine();
    const eight = api().parsed!.transitions.find((t) => t.read === '8')!.__idx;

    act(() => api().removeTransitions([eight]));

    expect(reads(api)).toEqual(['0']);
    // The line is still there, and so is the panel: one of two went, not the pair.
    expect(api().selectedTransition?.transitions).toHaveLength(1);
  });

  it('lets the line go only when the last transition on it does', async () => {
    const { api } = await ready();
    selectLine();
    const [first, second] = api().parsed!.transitions.map((t) => t.__idx);

    act(() => api().removeTransitions([first!]));
    expect(api().selectedTransition).not.toBeNull();

    act(() => api().removeTransitions([second!]));

    expect(api().selectedTransition).toBeNull();
    expect(
      lastCy().edgeList.some((e) => e.data('source') === '0' && e.data('target') === '1'),
    ).toBe(false);
  });

  it('puts the right one back on undo, and takes it off again on redo', async () => {
    const { api } = await ready();
    selectLine();
    const eight = api().parsed!.transitions.find((t) => t.read === '8')!.__idx;

    act(() => api().removeTransitions([eight]));
    expect(reads(api)).toEqual(['0']);

    act(() => api().undo());
    expect(reads(api).sort()).toEqual(['0', '8']);

    act(() => api().redo());
    expect(reads(api)).toEqual(['0']);
  });

  it('writes out only what is left', async () => {
    const { api } = await ready();
    selectLine();
    const eight = api().parsed!.transitions.find((t) => t.read === '8')!.__idx;

    act(() => api().removeTransitions([eight]));

    const back = parseJflap(toJflapXml(api().parsed!));
    expect(back.transitions.map((t) => t.read)).toEqual(['0']);
  });

  it('adds another between the same two states, and writes that out too', async () => {
    const { api } = await ready();
    selectLine();

    act(() => api().addTransitionToSelected());

    // A real transition on the same line: three records, one edge.
    expect(api().parsed?.transitions).toHaveLength(3);
    expect(api().selectedTransition?.transitions).toHaveLength(3);
    expect(
      lastCy().edgeList.filter((e) => e.data('source') === '0' && e.data('target') === '1'),
    ).toHaveLength(1);

    act(() => api().setTransitionField(api().parsed!.transitions[2]!.__idx, 'read', 'z'));
    const back = parseJflap(toJflapXml(api().parsed!));
    expect(back.transitions.map((t) => t.read).sort()).toEqual(['0', '8', 'z']);
  });

  it('gives the new one an index of its own, and leaves the others theirs', async () => {
    const { api } = await ready();
    selectLine();
    const before = api().parsed!.transitions.map((t) => t.__idx);

    act(() => api().addTransitionToSelected());

    const after = api().parsed!.transitions.map((t) => t.__idx);
    expect(after.slice(0, 2)).toEqual(before);
    expect(new Set(after).size).toBe(3);
  });

  it('is one history step, undone and redone whole', async () => {
    const { api } = await ready();
    selectLine();

    act(() => api().addTransitionToSelected());
    expect(api().parsed?.transitions).toHaveLength(3);

    act(() => api().undo());
    expect(api().parsed?.transitions).toHaveLength(2);

    act(() => api().redo());
    expect(api().parsed?.transitions).toHaveLength(3);
  });

  it('edits one without touching the other', async () => {
    const { api } = await ready();
    selectLine();
    const zero = api().parsed!.transitions.find((t) => t.read === '0')!.__idx;

    act(() => api().setTransitionField(zero, 'read', 'x'));

    expect(reads(api).sort()).toEqual(['8', 'x']);
  });

  it('refuses both when the machine may not be edited', async () => {
    global.fetch = fetchOk(bundled) as unknown as typeof fetch;
    const { api } = renderViewer({ honorPositionsDefault: true, canEditMachine: false });
    await waitFor(() => expect(api().phase).toBe('ready'));
    selectLine();
    const eight = api().parsed!.transitions.find((t) => t.read === '8')!.__idx;

    act(() => api().removeTransitions([eight]));
    act(() => api().addTransitionToSelected());

    expect(api().parsed?.transitions).toHaveLength(2);
  });

  it('does nothing when no line is selected', async () => {
    const { api } = await ready();

    act(() => api().addTransitionToSelected());

    expect(api().parsed?.transitions).toHaveLength(2);
  });
});

/**
 * Where a bundle's label sits, on the drawn graph.
 *
 * The unit tests above cover the arithmetic. These are about the label cytoscape is actually
 * given: that the margins written to an edge grow with the transitions on it and shrink again
 * when one goes, and that undo puts the old spacing back with the old transitions.
 */
describe('the standoff of a bundled label', () => {
  const twoWays = `<?xml version="1.0"?>
<structure>
  <type>fa</type>
  <automaton>
    <state id="0" name="q0"><x>10</x><y>20</y><initial/></state>
    <state id="1" name="q1"><x>200</x><y>20</y><final/></state>
    <transition><from>0</from><to>1</to><read>a</read></transition>
    <transition><from>0</from><to>1</to><read>b</read></transition>
    <transition><from>0</from><to>1</to><read>c</read></transition>
    <transition><from>1</from><to>0</to><read>x</read></transition>
  </automaton>
</structure>`;

  const ready = async (xml: string) => {
    global.fetch = fetchOk(xml) as unknown as typeof fetch;
    const view = renderViewer({ honorPositionsDefault: true });
    await waitFor(() => expect(view.api().phase).toBe('ready'));
    return view;
  };

  const lineFor = (from: string, to: string) =>
    lastCy().edgeList.find((e) => e.data('source') === from && e.data('target') === to)!;
  const standoff = (from: string, to: string) => {
    const style = lineFor(from, to).style();
    return Math.hypot(Number(style['text-margin-x'] ?? 0), Number(style['text-margin-y'] ?? 0));
  };

  it('pushes a bundle further out than a single transition', async () => {
    await ready(twoWays);

    await waitFor(() => expect(standoff('0', '1')).toBeGreaterThan(0));
    // Three transitions one way, one the other, on the same pair of states.
    expect(String(lineFor('0', '1').data('label')).split('\n')).toHaveLength(3);
    expect(standoff('0', '1')).toBeGreaterThan(standoff('1', '0'));
  });

  it('keeps the two directions on opposite sides of the pair', async () => {
    await ready(twoWays);
    await waitFor(() => expect(standoff('0', '1')).toBeGreaterThan(0));

    const forward = Number(lineFor('0', '1').style()['text-margin-y'] ?? 0);
    const back = Number(lineFor('1', '0').style()['text-margin-y'] ?? 0);

    // One block above the pair and one below, which is what stops them interleaving.
    expect(Math.sign(forward)).not.toBe(Math.sign(back));
  });

  it('grows when a transition is added and shrinks when one goes', async () => {
    const { api } = await ready(twoWays);
    await waitFor(() => expect(standoff('1', '0')).toBeGreaterThan(0));
    const one = standoff('1', '0');

    act(() => api().addTransition('1', '0'));
    await waitFor(() => expect(standoff('1', '0')).toBeGreaterThan(one));
    const two = standoff('1', '0');

    const added = api().parsed!.transitions.filter((t) => t.from === '1' && t.to === '0');
    act(() => api().removeTransitions([added[added.length - 1]!.__idx]));

    await waitFor(() => expect(standoff('1', '0')).toBe(one));
    expect(two).toBeGreaterThan(one);
  });

  it('puts the old spacing back with the old transitions, on undo and redo', async () => {
    const { api } = await ready(twoWays);
    await waitFor(() => expect(standoff('1', '0')).toBeGreaterThan(0));
    const one = standoff('1', '0');

    act(() => api().addTransition('1', '0'));
    await waitFor(() => expect(standoff('1', '0')).toBeGreaterThan(one));
    const two = standoff('1', '0');

    act(() => api().undo());
    await waitFor(() => expect(standoff('1', '0')).toBe(one));

    act(() => api().redo());
    await waitFor(() => expect(standoff('1', '0')).toBe(two));
  });

  it('leaves a self-loop label to the loop geometry', async () => {
    // Loops are aimed and labelled by their own code, which lifts the label past the arc.
    await ready(`<?xml version="1.0"?>
<structure>
  <type>fa</type>
  <automaton>
    <state id="0" name="q0"><x>10</x><y>20</y><initial/></state>
    <transition><from>0</from><to>0</to><read>a</read></transition>
  </automaton>
</structure>`);

    const loop = lastCy().edgeList.find((e) => e.data('isLoop') === 1);
    expect(loop).toBeDefined();
    // The edge standoff never touched it: what it has came from the loop pass.
    await waitFor(() => expect(loop!.style()['text-margin-y']).toBeDefined());
  });
});

/**
 * The comments a reader writes over a machine are not part of it, and this hook never reads
 * what they say. They ride in the snapshot so that one history covers the whole drawing: see
 * `useViewerTextBoxes`, which owns them and hands this pair in.
 */
describe('comments on the undo history', () => {
  const box = (id: string, text: string) => ({
    id,
    x: 10,
    y: 20,
    width: 200,
    height: 80,
    text,
  });

  /** Stands in for the comment layer: what is on the drawing, and what a step puts back. */
  const commentLayer = () => {
    let boxes: ReturnType<typeof box>[] = [];
    return {
      get: () => boxes,
      set: (next: ReturnType<typeof box>[]) => {
        boxes = next;
      },
      props: {
        readTextBoxes: () => boxes,
        restoreTextBoxes: (next: readonly ReturnType<typeof box>[]) => {
          boxes = [...next];
        },
      },
    };
  };

  it('steps back through a comment written after the step was recorded', async () => {
    const comments = commentLayer();
    const { api } = renderViewer(comments.props);
    await waitFor(() => expect(instances).toHaveLength(1));

    // What the layer does when a box is made: record how things stand, then add the box.
    act(() => api().textBoxHistory.record());
    comments.set([box('text-1', 'this loop is the bug')]);

    await waitFor(() => expect(api().canUndo).toBe(true));
    act(() => api().undo());
    expect(comments.get()).toEqual([]);

    act(() => api().redo());
    expect(comments.get()).toEqual([box('text-1', 'this loop is the bug')]);
  });

  it('leaves the comments where they were when the step is about the machine', async () => {
    const comments = commentLayer();
    comments.set([box('text-1', 'written before anything moved')]);
    const { api } = renderViewer(comments.props);
    await waitFor(() => expect(instances).toHaveLength(1));
    const cy = lastCy();
    const before = { ...cy.byId('0')!.position() };

    dragState('0', { x: 500, y: 500 });
    // A second comment, after the drag. Undoing the drag is undoing the drag.
    comments.set([box('text-1', 'written before anything moved'), box('text-2', 'and after')]);

    await waitFor(() => expect(api().canUndo).toBe(true));
    act(() => api().undo());
    expect(cy.byId('0')?.position()).toEqual(before);
    // The step is the whole drawing as it stood, so the second comment goes with the drag.
    expect(comments.get()).toEqual([box('text-1', 'written before anything moved')]);
  });

  it('is unbothered by a viewer with no comment layer at all', async () => {
    const { api } = renderViewer();
    await waitFor(() => expect(instances).toHaveLength(1));

    act(() => api().textBoxHistory.record());
    await waitFor(() => expect(api().canUndo).toBe(true));
    expect(() => act(() => api().undo())).not.toThrow();
  });
});
