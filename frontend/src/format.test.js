import { describe, expect, it } from 'vitest';

import { NotABoard, SOURCE, copyName, etagOf, isEmptyScene, parseBoard, sceneKey, serializeBoard } from './format.js';

const rect = { id: 'r1', type: 'rectangle', version: 3, versionNonce: 11, isDeleted: false };

describe('parseBoard', () => {
  it('reads Excalidraw files', () => {
    const file = {
      type: 'excalidraw',
      version: 2,
      source: 'https://excalidraw.com',
      elements: [rect],
      appState: { viewBackgroundColor: '#fff', gridSize: 20 },
      files: { f1: { id: 'f1', mimeType: 'image/png', dataURL: 'data:image/png;base64,AA==' } },
    };
    const board = parseBoard(JSON.stringify(file));
    expect(board.scene.elements).toEqual([rect]);
    expect(board.scene.appState.gridSize).toBe(20);
    expect(Object.keys(board.scene.files)).toEqual(['f1']);
    expect(board.extra).toEqual({});
    expect(board.empty).toBe(false);
  });

  it('reads Nextcloud Whiteboard files and keeps their keys', () => {
    // As Nextcloud writes them: keys sorted, files [] when empty, no type in templates.
    const text =
      '{"appState":{"viewBackgroundColor":"#ffffff"},"elements":[{"id":"r1","type":"rectangle","version":3,' +
      '"versionNonce":11,"customData":{"creator":{"uid":"bob"},"creatorProof":"v1:ab"}}],"files":[],' +
      '"libraryItems":[{"id":"l1"}],"libraryRef":{"scope":"user","name":"x"},"scrollToContent":true}';
    const board = parseBoard(text);
    expect(board.scene.elements[0].customData.creator.uid).toBe('bob');
    expect(board.scene.files).toEqual({});
    expect(board.extra).toEqual({
      libraryItems: [{ id: 'l1' }],
      libraryRef: { scope: 'user', name: 'x' },
      scrollToContent: true,
    });
  });

  it('takes empty files as new boards', () => {
    for (const text of ['', ' ', '\n\t ']) {
      const board = parseBoard(text);
      expect(board.empty).toBe(true);
      expect(board.scene.elements).toEqual([]);
    }
    expect(parseBoard('{"elements":[],"scrollToContent":true}').scene.elements).toEqual([]);
    expect(parseBoard('{"type":"excalidraw"}').scene.elements).toEqual([]);
  });

  it('unwraps {"data": …}', () => {
    expect(parseBoard(JSON.stringify({ data: { elements: [rect] } })).scene.elements).toEqual([rect]);
  });

  it('refuses what is not a board', () => {
    for (const text of ['nope', '[1,2]', '"x"', '{}', '{"type":"excalidrawlib","libraryItems":[]}', '{"elements":{}}']) {
      expect(() => parseBoard(text), text).toThrow(NotABoard);
    }
  });
});

describe('serializeBoard', () => {
  const serialized = JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'https://cloud.example.com',
    elements: [rect],
    appState: { gridSize: 20, viewBackgroundColor: '#ffffff' },
    files: {},
  });

  it('writes what both Excalidraw and Nextcloud read', () => {
    const out = JSON.parse(serializeBoard(serialized));
    expect(out.type).toBe('excalidraw');
    expect(out.version).toBe(2);
    expect(out.elements).toEqual([rect]);
    expect(out.scrollToContent).toBe(true);
    // Not the cloud's address.
    expect(out.source).toBe(SOURCE);
  });

  it('keeps the keys read with the board', () => {
    const extra = { libraryItems: [{ id: 'l1' }], scrollToContent: false, elements: 'ignored' };
    const out = JSON.parse(serializeBoard(serialized, extra));
    expect(out.libraryItems).toEqual([{ id: 'l1' }]);
    expect(out.scrollToContent).toBe(false);
    expect(out.elements).toEqual([rect]);
  });

  it('reads back what it writes', () => {
    const extra = { libraryRef: { scope: 'user', name: 'x' } };
    const again = parseBoard(serializeBoard(serialized, extra));
    expect(again.scene.elements).toEqual([rect]);
    expect(again.extra).toEqual({ libraryRef: { scope: 'user', name: 'x' }, scrollToContent: true });
  });
});

describe('helpers', () => {
  it('tells empty scenes', () => {
    expect(isEmptyScene([])).toBe(true);
    expect(isEmptyScene([{ ...rect, isDeleted: true }])).toBe(true);
    expect(isEmptyScene([rect])).toBe(false);
  });

  it('keys scenes by what is saved', () => {
    const key = sceneKey([rect], { viewBackgroundColor: '#fff', scrollX: 1 });
    expect(sceneKey([rect], { viewBackgroundColor: '#fff', scrollX: 500 })).toBe(key);
    expect(sceneKey([{ ...rect, version: 4 }], { viewBackgroundColor: '#fff' })).not.toBe(key);
    expect(sceneKey([rect], { viewBackgroundColor: '#000' })).not.toBe(key);
  });

  it('reads ETags', () => {
    expect(etagOf('"abc"')).toBe('abc');
    expect(etagOf('W/"abc"')).toBe('abc');
    expect(etagOf(null)).toBe('');
  });

  it('names copies', () => {
    expect(copyName('Plan.whiteboard')).toBe('Plan.excalidraw');
    expect(copyName('Plan.excalidraw')).toBe('Plan.excalidraw');
    expect(copyName('')).toBe('board.excalidraw');
  });
});
