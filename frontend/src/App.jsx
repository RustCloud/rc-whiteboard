import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  restore,
  serializeAsJSON,
  useHandleLibrary,
} from '@excalidraw/excalidraw';

import { Autosave, Board, BoardError } from './board.js';
import { NotABoard, copyName, isEmptyScene, parseBoard, sceneKey, serializeBoard } from './format.js';
import { download, listen, renewSession, tell } from './host.js';
import { excalidrawLang, say, texts } from './i18n.js';

/** The lock lasts 30 minutes; renewed well before. */
const LOCK_REFRESH_MS = 10 * 60 * 1000;
/** A new token this long before the old one runs out. */
const TOKEN_MARGIN_MS = 15 * 60 * 1000;
/** keepalive requests (when the page goes away) carry at most 64 KB. */
const KEEPALIVE_BYTES = 60 * 1024;
const LIBRARY_KEY = 'rc-whiteboard.library';

/** The user's shape library, in this browser (the board runs on the cloud's origin). */
const libraryAdapter = {
  load() {
    try {
      const items = JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? 'null');
      return Array.isArray(items) ? { libraryItems: items } : null;
    } catch {
      return null;
    }
  },
  save({ libraryItems }) {
    try {
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(libraryItems));
    } catch {
      // Full or blocked: the library lives until the board closes.
    }
  },
};

export default function App({ start }) {
  const t = texts(start.lang);
  const [api, setApi] = useState(null);
  const [write, setWrite] = useState(start.session.write);
  const [readOnlyWhy, setReadOnlyWhy] = useState(start.session.write ? null : start.session.readOnly);
  const [lockedBy, setLockedBy] = useState(start.session.lockedBy);
  /** Autosave's state: saved, dirty, saving, error. */
  const [save, setSave] = useState({ state: 'saved' });
  /** A dialog: changed (conflict), lost (lock), close-unsaved. */
  const [dialog, setDialog] = useState(null);

  const loaded = useRef(null);
  const lastKey = useRef(null);
  const apiRef = useRef(null);
  apiRef.current = api;

  const board = useMemo(
    () =>
      new Board({
        app: start.app,
        file: start.file,
        session: start.session,
        renew: () => renewSession({ readOnly: !start.session.write }),
      }),
    [start],
  );

  /** The board's JSON as it is on the screen now. */
  const currentText = useCallback(() => {
    const excalidraw = apiRef.current;
    const serialized = serializeAsJSON(
      excalidraw.getSceneElements(),
      excalidraw.getAppState(),
      excalidraw.getFiles(),
      'local',
    );
    return serializeBoard(serialized, loaded.current?.extra ?? {});
  }, []);

  const saveNow = useCallback(
    async ({ overwrite = false, keepalive = false } = {}) => {
      const excalidraw = apiRef.current;
      if (!excalidraw) return;
      // A new board nobody drew on stays the empty file it was.
      if (loaded.current?.empty && isEmptyScene(excalidraw.getSceneElements())) return;
      const text = currentText();
      if (keepalive && text.length > KEEPALIVE_BYTES) throw new BoardError('too-large', 'too large for keepalive');
      await board.save(text, { overwrite, keepalive });
      if (loaded.current) loaded.current.empty = false;
    },
    [board, currentText],
  );

  /** The board turned read-only: why, and whether unsaved changes are lost. */
  const becomeReadOnly = useCallback(
    (why, app = '') => {
      autosave.stop();
      setWrite(false);
      setLockedBy(app);
      setDialog({ kind: 'lost', why, app, unsaved: autosave.dirty });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onSaveState = useCallback((next) => {
    setSave(next);
    const error = next.error;
    if (!(error instanceof BoardError)) return;
    if (error.code === 'changed') {
      autosave.stop();
      setDialog({ kind: 'changed' });
    } else if (error.code === 'locked') {
      becomeReadOnly(error.details.by ?? 'user', error.details.app);
    } else if (error.code === 'read-only') {
      becomeReadOnly('read-only');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const autosave = useMemo(() => new Autosave({ save: () => saveNow(), onState: (s) => onSaveStateRef.current(s) }), [
    saveNow,
  ]);
  const onSaveStateRef = useRef(onSaveState);
  onSaveStateRef.current = onSaveState;

  // Reading the board: once, before Excalidraw shows it.
  const initialData = useMemo(
    () =>
      (async () => {
        let text;
        try {
          text = await board.load();
        } catch (err) {
          tell('error', { code: err.code === 'not-found' ? 'not-found' : 'load-failed', message: err.message });
          return null;
        }
        let parsed;
        try {
          parsed = parseBoard(text);
        } catch (err) {
          tell('error', { code: 'not-a-board', message: err instanceof NotABoard ? err.message : String(err) });
          return null;
        }
        loaded.current = { extra: parsed.extra, empty: parsed.empty };
        const scene = restore(parsed.scene, null, null, { repairBindings: true });
        tell('ready');
        return { ...scene, scrollToContent: true, libraryItems: libraryAdapter.load()?.libraryItems ?? [] };
      })(),
    [board],
  );

  useHandleLibrary({ excalidrawAPI: api, adapter: libraryAdapter, validateLibraryUrl: () => false });

  const onChange = useCallback(
    (elements, appState) => {
      const key = sceneKey(elements, appState);
      // The first call is the board as it was read.
      if (lastKey.current === null) {
        lastKey.current = key;
        return;
      }
      if (key === lastKey.current) return;
      lastKey.current = key;
      if (board.write) autosave.changed();
    },
    [autosave, board],
  );

  // The lock lives while the board is open.
  useEffect(() => {
    if (!write) return undefined;
    const timer = setInterval(() => {
      board.refreshLock().catch((err) => {
        if (err.code === 'locked') becomeReadOnly(err.details.by ?? 'user', err.details.app);
        else if (err.code === 'read-only') becomeReadOnly('read-only');
      });
    }, LOCK_REFRESH_MS);
    return () => clearInterval(timer);
  }, [board, write, becomeReadOnly]);

  // A new token before the old one runs out.
  useEffect(() => {
    const expires = Date.parse(board.session.expires);
    if (!expires) return undefined;
    const timer = setTimeout(async () => {
      try {
        board.session = await renewSession({ readOnly: !board.write });
        if (write && !board.session.write) becomeReadOnly('read-only');
      } catch {
        // The next request asks again (401).
      }
    }, Math.max(expires - Date.now() - TOKEN_MARGIN_MS, 60 * 1000));
    return () => clearTimeout(timer);
  }, [board, write, becomeReadOnly]);

  // The page goes away (the panel's ×, a reload): what is left, as far as it goes.
  useEffect(() => {
    const onHide = () => {
      if (board.write && autosave.dirty) saveNow({ keepalive: true }).catch(() => {});
      board.unlock({ keepalive: true }).catch(() => {});
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [board, autosave, saveNow]);

  // The page's messages other than tokens: none yet, but keep the channel open.
  useEffect(() => listen(() => {}), []);

  const close = useCallback(
    async (force = false) => {
      if (!force && board.write) {
        try {
          await autosave.flush();
        } catch {
          setDialog({ kind: 'close-unsaved' });
          return;
        }
      }
      autosave.stop();
      await board.unlock().catch(() => {});
      tell('close');
    },
    [board, autosave],
  );

  const downloadCopy = useCallback(() => {
    if (apiRef.current) download(copyName(start.name), currentText());
  }, [currentText, start.name]);

  const reloadTheirs = useCallback(async () => {
    setDialog(null);
    try {
      const parsed = parseBoard(await board.load());
      loaded.current = { extra: parsed.extra, empty: parsed.empty };
      const scene = restore(parsed.scene, null, null, { repairBindings: true });
      const excalidraw = apiRef.current;
      excalidraw.addFiles(Object.values(scene.files));
      lastKey.current = null;
      excalidraw.updateScene({ elements: scene.elements, captureUpdate: CaptureUpdateAction.NEVER });
      autosave.dirty = false;
      setSave({ state: 'saved' });
      autosave.resume();
    } catch (err) {
      setSave({ state: 'error', error: err });
    }
  }, [board, autosave]);

  const overwriteMine = useCallback(async () => {
    setDialog(null);
    autosave.resume();
    setSave({ state: 'saving' });
    try {
      await saveNow({ overwrite: true });
      autosave.dirty = false;
      setSave({ state: 'saved' });
    } catch (err) {
      onSaveState({ state: 'error', error: err });
    }
  }, [autosave, saveNow, onSaveState]);

  const status = write ? statusText(t, save) : { text: t.readOnly, kind: 'read-only' };
  const errorBanner = save.state === 'error' && save.error instanceof BoardError ? t.errors[save.error.code] : null;

  return (
    <div className={`board theme-${start.theme}`}>
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={initialData}
        onChange={onChange}
        viewModeEnabled={!write}
        theme={start.theme}
        langCode={excalidrawLang(start.lang)}
        name={start.name.replace(/\.(excalidraw|whiteboard)$/i, '')}
        autoFocus
        UIOptions={{
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            toggleTheme: null,
            export: { saveFileToDisk: true },
          },
        }}
        renderTopRightUI={() => (
          <div className="rc-top-right">
            <span className={`rc-status rc-status-${status.kind}`} title={status.title ?? status.text}>
              {status.text}
            </span>
            <button type="button" className="rc-button" onClick={() => close()}>
              {t.close}
            </button>
          </div>
        )}
      >
        <MainMenu>
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          {write && <MainMenu.DefaultItems.ClearCanvas />}
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.Separator />
          <MainMenu.Item onSelect={() => close()}>{t.close}</MainMenu.Item>
        </MainMenu>
      </Excalidraw>

      {!write && readOnlyWhy && !dialog && (
        <div className="rc-banner">{say(t.readOnlyWhy[readOnlyWhy] ?? t.readOnly, lockedBy)}</div>
      )}
      {write && errorBanner && (
        <div className="rc-banner rc-banner-error">
          {errorBanner}{' '}
          <button type="button" className="rc-link" onClick={downloadCopy}>
            {t.download}
          </button>
        </div>
      )}

      {dialog?.kind === 'changed' && (
        <Dialog title={t.changed.title} text={t.changed.text}>
          <button type="button" className="rc-button rc-primary" onClick={overwriteMine}>
            {t.changed.overwrite}
          </button>
          <button type="button" className="rc-button" onClick={reloadTheirs}>
            {t.changed.reload}
          </button>
          <button type="button" className="rc-button" onClick={downloadCopy}>
            {t.download}
          </button>
        </Dialog>
      )}
      {dialog?.kind === 'lost' && (
        <Dialog
          text={[
            dialog.why === 'self'
              ? t.lost.self
              : dialog.why === 'app'
                ? say(t.lost.app, dialog.app)
                : dialog.why === 'read-only'
                  ? t.lost.readOnly
                  : t.lost.user,
            dialog.unsaved ? t.lost.unsaved : null,
          ]}
        >
          {dialog.unsaved && (
            <button type="button" className="rc-button rc-primary" onClick={downloadCopy}>
              {t.download}
            </button>
          )}
          <button type="button" className="rc-button" onClick={() => setDialog(null)}>
            {t.dismiss}
          </button>
        </Dialog>
      )}
      {dialog?.kind === 'close-unsaved' && (
        <Dialog title={t.closeUnsaved.title} text={[t.closeUnsaved.text, errorBanner]}>
          <button type="button" className="rc-button rc-primary" onClick={() => setDialog(null)}>
            {t.closeUnsaved.stay}
          </button>
          <button type="button" className="rc-button" onClick={downloadCopy}>
            {t.download}
          </button>
          <button type="button" className="rc-button rc-danger" onClick={() => close(true)}>
            {t.closeUnsaved.closeAnyway}
          </button>
        </Dialog>
      )}
    </div>
  );
}

function statusText(t, save) {
  switch (save.state) {
    case 'saving':
      return { text: t.saving, kind: 'saving' };
    case 'dirty':
      return { text: t.saving, kind: 'saving', title: t.dirty };
    case 'error':
      return { text: t.notSaved, kind: 'error', title: save.error?.message };
    default:
      return { text: t.saved, kind: 'saved' };
  }
}

function Dialog({ title, text, children }) {
  const lines = (Array.isArray(text) ? text : [text]).filter(Boolean);
  return (
    <div className="rc-overlay" role="dialog" aria-modal="true">
      <div className="rc-dialog">
        {title && <h2>{title}</h2>}
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
        <div className="rc-actions">{children}</div>
      </div>
    </div>
  );
}
