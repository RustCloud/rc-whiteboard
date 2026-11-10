// The file format of boards: Excalidraw's own JSON (.excalidraw) and Nextcloud
// Whiteboard's (.whiteboard) are the same scene with a few keys more or less.
// A board is read from either and written as the union of both, so either
// program opens what the other saved, and keys this one does not know
// (Nextcloud's libraryItems, libraryRef…) stay in the file.

/** What Excalidraw's serializer writes itself; everything else is kept as read. */
const SCENE_KEYS = ['type', 'version', 'source', 'elements', 'appState', 'files'];

/** What files written here say made them (Excalidraw's serializer puts the page's address there). */
export const SOURCE = 'https://github.com/RustCloud/rc-whiteboard';

export class NotABoard extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotABoard';
  }
}

/**
 * Reads a board file.
 *
 * - empty or only whitespace: a new board (Nextcloud creates them so);
 * - `{"data": {...}}`: unwrapped (Nextcloud's clients send boards so);
 * - an object with `elements` or `type: "excalidraw"`: a scene.
 *
 * @returns {{ scene: { elements: object[], appState: object, files: object }, extra: object, empty: boolean }}
 * `extra`: the keys besides the scene's, to write back as they were; `empty`:
 * the file had no content at all.
 */
export function parseBoard(text) {
  if (text.trim() === '') {
    return { scene: { elements: [], appState: {}, files: {} }, extra: {}, empty: true };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new NotABoard('not JSON');
  }
  if (isObject(data) && isObject(data.data) && !('elements' in data) && !('type' in data)) data = data.data;
  if (!isObject(data)) throw new NotABoard('not a JSON object');
  if (data.type !== undefined && data.type !== 'excalidraw') {
    // A library (excalidrawlib) or something else entirely.
    throw new NotABoard(`a file of type ${JSON.stringify(data.type)}`);
  }
  if (data.elements !== undefined && !Array.isArray(data.elements)) throw new NotABoard('elements is not a list');
  if (data.type === undefined && !Array.isArray(data.elements)) throw new NotABoard('no elements');
  const extra = {};
  for (const [key, value] of Object.entries(data)) {
    if (!SCENE_KEYS.includes(key)) extra[key] = value;
  }
  return {
    scene: {
      elements: data.elements ?? [],
      appState: isObject(data.appState) ? data.appState : {},
      // Nextcloud's PHP writes an empty map as [].
      files: isObject(data.files) ? data.files : {},
    },
    extra,
    empty: false,
  };
}

/**
 * Writes a board: `serialized` is what Excalidraw's `serializeAsJSON(…, "local")`
 * made of the scene (type, version, elements, appState without the window's
 * state, files of the elements left); `extra` the keys read with the board.
 * Nextcloud's `scrollToContent` is always there: it opens boards scrolled to
 * their content.
 */
export function serializeBoard(serialized, extra = {}) {
  const scene = JSON.parse(serialized);
  return JSON.stringify({ ...extra, ...scene, source: SOURCE, scrollToContent: extra.scrollToContent ?? true });
}

/** Whether a scene has nothing on it (deleted elements don't count). */
export function isEmptyScene(elements) {
  return !elements.some((element) => !element.isDeleted);
}

/**
 * What tells whether a scene changed in a way worth saving: the elements'
 * versions and the canvas settings that are saved, not the camera or the
 * selection.
 */
export function sceneKey(elements, appState = {}) {
  let key = `${appState.viewBackgroundColor ?? ''}|${appState.gridModeEnabled ?? ''}|${appState.gridSize ?? ''}`;
  for (const element of elements) key += `|${element.id}:${element.version}:${element.versionNonce}`;
  return key;
}

/** The tag of an ETag header as the plugin takes it in If-Match: without W/ and quotes. */
export function etagOf(header) {
  if (!header) return '';
  return header.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
}

/** The name to download a copy as: the board's, as .excalidraw. */
export function copyName(name) {
  const base = (name || 'board').replace(/\.(excalidraw|whiteboard)$/i, '');
  return `${base}.excalidraw`;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
