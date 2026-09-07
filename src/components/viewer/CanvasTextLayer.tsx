'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import { TEXT_BOX_MIN_SIZE, type ViewerTextBox } from '@/lib/viewer-text-boxes';
import type { ViewerTextBoxesApi } from './useViewerTextBoxes';

/** Where the camera is, read live rather than from React state. See useJffCytoscape. */
type ViewportReader = () => { zoom: number; pan: { x: number; y: number } } | null;

/** The corner and edges a box can be dragged by, and what each one changes. */
const HANDLES = [
  { key: 'e', label: 'width', className: 'top-1/2 -right-0.5 -translate-y-1/2 cursor-ew-resize' },
  {
    key: 's',
    label: 'height',
    className: '-bottom-0.5 left-1/2 -translate-x-1/2 cursor-ns-resize',
  },
  { key: 'se', label: 'size', className: '-right-0.5 -bottom-0.5 cursor-nwse-resize' },
] as const;

type HandleKey = (typeof HANDLES)[number]['key'];

/**
 * The reader's own writing, over the machine but not part of it.
 *
 * An HTML layer rather than cytoscape nodes, for one reason: editing. Typing into a box wants a
 * real `<textarea>` with a caret, a selection and the browser's own wrapping, and none of that
 * exists inside a canvas. The layer carries the graph's transform (see `graphOverlayRef` in
 * useJffCytoscape), so a box written beside a state stays beside that state through every pan
 * and zoom, and the text grows and shrinks with the drawing the way a state's label does.
 *
 * The layer itself takes no clicks, only the boxes do, so empty canvas still reaches cytoscape
 * and still means whatever the active tool says it means.
 */
export function CanvasTextLayer({
  api,
  overlayRef,
  viewportNow,
  zoom,
}: {
  api: ViewerTextBoxesApi;
  /** Written to on every frame of a pan by the hook that owns the graph. */
  overlayRef: React.RefObject<HTMLDivElement | null>;
  viewportNow: ViewportReader;
  /** For sizing the furniture, which should not grow with the drawing. A frame behind is fine. */
  zoom: number;
}) {
  const { boxes, selectedId, editingId, select, beginEdit, endEdit, setText, moveTo, resizeTo } =
    api;
  const remove = api.remove;

  // The graph writes this element's transform directly, so on the way in it has none: catch up
  // once, or a layer mounted after the machine was drawn sits at the origin until the next pan.
  useLayoutEffect(() => {
    const el = overlayRef.current;
    const viewport = viewportNow();
    if (!el || !viewport) return;
    el.style.transform = `translate(${viewport.pan.x}px, ${viewport.pan.y}px) scale(${viewport.zoom})`;
  }, [overlayRef, viewportNow, boxes.length]);

  /**
   * Delete removes the selected box, unless the reader is typing.
   *
   * On the window rather than on the box, because the same key has to mean two things: a
   * character while the textarea is open, and the whole box when it is not. Bound only while
   * something is selected and nothing is being edited, so in every other case the key is
   * nobody's business but the browser's. The target check is for the rest of the viewer: the
   * inspector's name and coordinate boxes are on screen at the same time.
   */
  useEffect(() => {
    if (!selectedId || editingId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        return;
      }
      event.preventDefault();
      remove(selectedId);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedId, editingId, remove]);

  return (
    <div
      // Takes no pointer events itself: the canvas underneath goes on working everywhere the
      // boxes are not. Clipped, so a box panned off the machine does not stretch the pane.
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
      data-testid="viewer-text-layer"
    >
      <div ref={overlayRef} className="absolute top-0 left-0 origin-top-left">
        {boxes.map((box) => (
          <TextBoxItem
            key={box.id}
            box={box}
            selected={box.id === selectedId}
            editing={box.id === editingId}
            zoom={zoom}
            viewportNow={viewportNow}
            onSelect={select}
            onBeginEdit={beginEdit}
            onEndEdit={endEdit}
            onChangeText={setText}
            onMove={moveTo}
            onResize={resizeTo}
          />
        ))}
      </div>
    </div>
  );
}

/** A box mid-gesture, before anything is written down. */
type LiveRect = { x: number; y: number; width: number; height: number };

function TextBoxItem({
  box,
  selected,
  editing,
  zoom,
  viewportNow,
  onSelect,
  onBeginEdit,
  onEndEdit,
  onChangeText,
  onMove,
  onResize,
}: {
  box: ViewerTextBox;
  selected: boolean;
  editing: boolean;
  zoom: number;
  viewportNow: ViewportReader;
  onSelect: (id: string | null) => void;
  onBeginEdit: (id: string) => void;
  onEndEdit: () => void;
  onChangeText: (id: string, text: string) => void;
  onMove: (id: string, x: number, y: number) => void;
  onResize: (id: string, width: number, height: number) => void;
}) {
  // While a drag is running the box follows the pointer from here, and storage hears about it
  // once, on release. Writing every frame would put a hundred entries through JSON.stringify to
  // describe one move.
  const [live, setLive] = useState<LiveRect | null>(null);
  const rect = live ?? box;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // A box is created by a click on the canvas, and that click lands on cytoscape's own canvas,
  // which takes focus back on release. So focus after the frame rather than through `autoFocus`,
  // which runs too early to win.
  useEffect(() => {
    if (!editing) return;
    const frame = window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editing]);

  /**
   * Follow the pointer, in the machine's coordinates.
   *
   * The zoom is read once at the start of the gesture and from the graph rather than from React:
   * a wheel cannot turn while a button is held, and a zoom one render out of date turns every
   * pixel the pointer moves into the wrong number of model units.
   */
  const startGesture = useCallback(
    (event: React.PointerEvent, handle: HandleKey | null) => {
      if (editing) return;
      event.stopPropagation();
      const scale = viewportNow()?.zoom || 1;
      const origin = { x: event.clientX, y: event.clientY };
      const from: LiveRect = { x: box.x, y: box.y, width: box.width, height: box.height };
      const target = event.currentTarget as HTMLElement;
      target.setPointerCapture?.(event.pointerId);
      let latest = from;

      const onMovePointer = (move: PointerEvent) => {
        const dx = (move.clientX - origin.x) / scale;
        const dy = (move.clientY - origin.y) / scale;
        latest = handle
          ? {
              ...from,
              width:
                handle === 's' ? from.width : Math.max(TEXT_BOX_MIN_SIZE.width, from.width + dx),
              height:
                handle === 'e' ? from.height : Math.max(TEXT_BOX_MIN_SIZE.height, from.height + dy),
            }
          : { ...from, x: from.x + dx, y: from.y + dy };
        setLive(latest);
      };
      const onUp = () => {
        target.releasePointerCapture?.(event.pointerId);
        target.removeEventListener('pointermove', onMovePointer);
        target.removeEventListener('pointerup', onUp);
        target.removeEventListener('pointercancel', onUp);
        setLive(null);
        if (handle) {
          if (latest.width !== from.width || latest.height !== from.height) {
            onResize(box.id, latest.width, latest.height);
          }
        } else if (latest.x !== from.x || latest.y !== from.y) {
          onMove(box.id, latest.x, latest.y);
        }
      };
      target.addEventListener('pointermove', onMovePointer);
      target.addEventListener('pointerup', onUp);
      target.addEventListener('pointercancel', onUp);
    },
    [box, editing, onMove, onResize, viewportNow],
  );

  // Furniture is measured in screen pixels, so it stays usable at both ends of the zoom range:
  // a handle that scaled with the drawing would be a speck at 30% and a slab at 300%.
  const px = (value: number) => `${value / (zoom || 1)}px`;

  return (
    <div
      // touch-none: without it a finger drag scrolls the page and cancels the gesture, and
      // faculty are testing this on tablets.
      className={cn(
        'pointer-events-auto absolute touch-none rounded-sm',
        // A surface of its own, the same one the palette and the inspector float on, so a note
        // reads as something laid over the machine rather than as stray labels among the state
        // names. The shadow is what lifts it off the grid; without one the fill just looks like
        // a hole cut in the drawing.
        'bg-card shadow-[0_2px_10px_rgba(15,23,42,0.08)] dark:shadow-[0_2px_10px_rgba(0,0,0,0.4)]',
      )}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      data-testid={`viewer-text-box-${box.id}`}
    >
      {editing ? (
        <textarea
          ref={textareaRef}
          value={box.text}
          onChange={(event) => onChangeText(box.id, event.target.value)}
          onBlur={onEndEdit}
          onKeyDown={(event) => {
            // Escape puts the caret down. Stopped here so it does not also reach the viewer,
            // where Escape closes the properties panel and puts the tool back to Select.
            if (event.key === 'Escape') {
              event.stopPropagation();
              onEndEdit();
            }
          }}
          aria-label="Text box"
          className={cn(
            'text-foreground h-full w-full resize-none rounded-sm bg-transparent p-1 text-[14px] leading-snug',
            'ring-primary/60 focus-visible:outline-none',
          )}
          style={{ boxShadow: `0 0 0 ${px(1)} var(--primary)` }}
        />
      ) : (
        <button
          type="button"
          // A button, so it can be reached by Tab and opened with a key like anything else. The
          // words in it are its name; an empty one cannot survive being left, so the fallback is
          // only ever seen mid-edit.
          aria-label={box.text.trim() === '' ? 'Empty text box' : undefined}
          onPointerDown={(event) => {
            onSelect(box.id);
            startGesture(event, null);
          }}
          onDoubleClick={() => onBeginEdit(box.id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === 'F2') {
              event.preventDefault();
              onBeginEdit(box.id);
            }
          }}
          className={cn(
            // Flex rather than block: a button centres its content vertically whatever its
            // display is, so a one-line note in a tall box floated in the middle of it while
            // the same words sat at the top the moment it was opened for editing.
            'text-foreground flex h-full w-full cursor-move items-start justify-start overflow-hidden rounded-sm p-1 text-left text-[14px] leading-snug break-words whitespace-pre-wrap',
            'focus-visible:outline-none',
          )}
          style={selected ? { boxShadow: `0 0 0 ${px(1)} var(--primary)` } : undefined}
        >
          <span className="w-full">{box.text}</span>
        </button>
      )}

      {selected && !editing
        ? HANDLES.map((handle) => (
            // Pointer only, deliberately, and hidden from assistive technology and from Tab.
            // A focusable control that does nothing when it is activated is worse than no
            // control: resizing from the keyboard does not exist yet, and offering three
            // buttons that answer neither Enter nor an arrow key would say it does.
            <div
              key={handle.key}
              aria-hidden="true"
              data-testid={`viewer-text-resize-${handle.key}`}
              onPointerDown={(event) => startGesture(event, handle.key)}
              className={cn('bg-primary absolute rounded-[1px]', handle.className)}
              style={{ width: px(8), height: px(8) }}
            />
          ))
        : null}
    </div>
  );
}
