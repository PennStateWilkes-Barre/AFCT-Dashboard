/** @vitest-environment jsdom */

import React from 'react';
import { render, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { CanvasTextLayer } from './CanvasTextLayer';
import type { ViewerTextBoxesApi } from './useViewerTextBoxes';

/**
 * The comment layer on its own, driven at a zoom the viewer's own tests cannot reach.
 *
 * Everywhere else the cytoscape mock reports zoom 1, which makes every counter-scaled number
 * come out as itself and proves nothing. Here the camera is a stub, so a line that should get
 * thinner as the drawing grows can actually be watched doing it.
 */
const BOX = { id: 'text-1', x: 10, y: 20, width: 200, height: 80, text: 'this loop' };

function renderLayer(zoom: number, boxes = [BOX]) {
  const api = {
    boxes,
    readBoxes: () => boxes,
    restore: vi.fn(),
    clearAll: vi.fn(),
    selectedId: null,
    editingId: null,
    select: vi.fn(),
    beginEdit: vi.fn(),
    endEdit: vi.fn(),
    addAt: vi.fn(),
    setText: vi.fn(),
    moveTo: vi.fn(),
    resizeTo: vi.fn(),
    remove: vi.fn(),
  } as unknown as ViewerTextBoxesApi;

  const overlayRef = React.createRef<HTMLDivElement>();
  // Scoped to this render rather than the screen: one test draws the layer at two zooms, and
  // both are in the document by the end of it.
  const view = render(
    <div>
      <div ref={overlayRef} />
      <CanvasTextLayer
        api={api}
        overlayRef={overlayRef}
        viewportNow={() => ({ zoom, pan: { x: 0, y: 0 } })}
        zoom={zoom}
      />
    </div>,
  );
  return within(view.container).getByTestId(`viewer-text-box-${BOX.id}`);
}

describe('the line round a comment', () => {
  it('draws one, so where the note ends does not depend on the shadow', () => {
    const box = renderLayer(1);
    expect(box).toHaveClass('border-input');
    expect(box.style.borderWidth).toBe('1px');
  });

  /**
   * The point of the counter-scaling. The box itself is measured in the graph's own units and
   * grows with the machine; the line round it is furniture and must not, or it is a hairline
   * at 30% and a bar at 300%.
   */
  it('thins as the drawing grows, and thickens as it shrinks', () => {
    expect(renderLayer(2).style.borderWidth).toBe('0.5px');
    expect(renderLayer(0.5).style.borderWidth).toBe('2px');
  });

  it('keeps the box the size that was stored, since the line is drawn inside it', () => {
    const box = renderLayer(1);
    expect(box.style.width).toBe('200px');
    expect(box.style.height).toBe('80px');
  });
});
