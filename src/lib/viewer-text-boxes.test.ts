/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import {
  readTextBoxes,
  writeTextBoxes,
  freeTextBoxId,
  textBoxStorageKey,
  TEXT_BOX_MAX_LENGTH,
  type ViewerTextBox,
} from './viewer-text-boxes';

const BOX: ViewerTextBox = { id: 'text-1', x: 120, y: -40, width: 200, height: 80, text: 'hi' };

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('viewer text boxes', () => {
  it('comes back the way it went in', () => {
    writeTextBoxes('doc-1', [BOX]);
    expect(readTextBoxes('doc-1')).toEqual([BOX]);
  });

  it('keeps one document out of another', () => {
    writeTextBoxes('doc-1', [BOX]);
    expect(readTextBoxes('doc-2')).toEqual([]);
    expect(window.localStorage.getItem(textBoxStorageKey('doc-1'))).not.toBeNull();
  });

  it('reads nothing rather than throwing on a hand-edited entry', () => {
    window.localStorage.setItem(textBoxStorageKey('doc-1'), '{ not json');
    expect(readTextBoxes('doc-1')).toEqual([]);
  });

  it('drops a box that is missing or has the wrong shape, and keeps the rest', () => {
    window.localStorage.setItem(
      textBoxStorageKey('doc-1'),
      JSON.stringify([
        BOX,
        { id: 'text-2', x: 0, y: 0, width: 200, height: 80 },
        { id: 'text-3', x: 'left', y: 0, width: 200, height: 80, text: 'x' },
        { id: 'text-4', x: 0, y: 0, width: 1, height: 1, text: 'too small' },
      ]),
    );
    expect(readTextBoxes('doc-1')).toEqual([BOX]);
  });

  it('reads nothing when the entry is not a list at all', () => {
    window.localStorage.setItem(textBoxStorageKey('doc-1'), JSON.stringify({ id: 'text-1' }));
    expect(readTextBoxes('doc-1')).toEqual([]);
  });

  it('caps the text it stores', () => {
    writeTextBoxes('doc-1', [{ ...BOX, text: 'a'.repeat(TEXT_BOX_MAX_LENGTH + 500) }]);
    expect(readTextBoxes('doc-1')[0].text).toHaveLength(TEXT_BOX_MAX_LENGTH);
  });

  it('removes the entry when the last box goes', () => {
    writeTextBoxes('doc-1', [BOX]);
    writeTextBoxes('doc-1', []);
    expect(window.localStorage.getItem(textBoxStorageKey('doc-1'))).toBeNull();
  });

  it('does nothing without a document to key on', () => {
    writeTextBoxes(null, [BOX]);
    expect(window.localStorage.length).toBe(0);
    expect(readTextBoxes(null)).toEqual([]);
  });

  it('survives storage being blocked outright', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => writeTextBoxes('doc-1', [BOX])).not.toThrow();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readTextBoxes('doc-1')).toEqual([]);
  });

  it('gives out an id nobody is using, including after a delete', () => {
    expect(freeTextBoxId([])).toBe('text-1');
    expect(freeTextBoxId([BOX])).toBe('text-2');
    // text-1 was deleted, so it is free again, and nothing refers to it by then.
    expect(freeTextBoxId([{ ...BOX, id: 'text-2' }])).toBe('text-1');
  });
});
