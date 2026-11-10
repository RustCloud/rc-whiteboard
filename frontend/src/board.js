// The board's file on the cloud: the plugin's routes, called with the token
// the plugin gave this board (`/app/rc-whiteboard/board/<id>` …), and the
// autosave that decides when to call them.

import { etagOf } from './format.js';

/** Why saving or the lock failed; `code` tells what to do. */
export class BoardError extends Error {
  /**
   * @param {'changed'|'locked'|'read-only'|'too-large'|'no-space'|'offline'|'not-found'|'failed'} code
   */
  constructor(code, message, details = {}) {
    super(message || code);
    this.name = 'BoardError';
    this.code = code;
    this.details = details;
  }
}

/** Errors worth trying again by themselves a little later. */
export const TRANSIENT = new Set(['offline', 'failed']);

/**
 * The file of a board.
 *
 * `session`: `{ token, write, lock }` from the plugin; `renew()` asks the page
 * for a new one when the token runs out (it resolves to a new session).
 */
export class Board {
  constructor({ app, file, session, renew, fetch: fetchImpl = (...args) => fetch(...args) }) {
    this.app = app;
    this.file = file;
    this.session = session;
    this.renew = renew;
    this.fetch = fetchImpl;
    /** The ETag of what the board last read or wrote. */
    this.etag = '';
  }

  get write() {
    return Boolean(this.session.write && this.session.lock);
  }

  url(path, suffix, query) {
    const search = query ? `?${new URLSearchParams(query)}` : '';
    return `${this.app}${path}/${encodeURIComponent(this.file)}${suffix}${search}`;
  }

  /**
   * A request with the token; once more with a new token if it ran out.
   * `query` is a function: after a renewal the lock may be another.
   */
  async call(path, options = {}, renewed = false) {
    const { suffix = '', query, method = 'GET', headers = {}, body, keepalive = false } = options;
    let response;
    try {
      response = await this.fetch(this.url(path, suffix, query?.()), {
        method,
        body,
        keepalive,
        cache: 'no-store',
        credentials: 'omit',
        headers: { ...headers, authorization: `Bearer ${this.session.token}` },
      });
    } catch (err) {
      throw new BoardError('offline', String(err?.message || err));
    }
    if (response.status === 401 && !renewed && this.renew) {
      this.session = await this.renew();
      return this.call(path, options, true);
    }
    return response;
  }

  /** The file's content as text; remembers its ETag. */
  async load() {
    const response = await this.call('/board');
    if (!response.ok) throw await failure(response);
    this.etag = etagOf(response.headers.get('etag'));
    return response.text();
  }

  /** `{ name, size, etag, updated_at }` of the file as it is now. */
  async info() {
    const response = await this.call('/board', { suffix: '/info' });
    if (!response.ok) throw await failure(response);
    return response.json();
  }

  /**
   * Saves the board's JSON over the version it read (`If-Match`), under its
   * lock. `overwrite`: over whatever the file is now.
   */
  async save(text, { overwrite = false, keepalive = false } = {}) {
    if (!this.write) throw new BoardError('read-only', 'The board is open read-only');
    if (overwrite) this.etag = (await this.info()).etag;
    const response = await this.call('/board', {
      method: 'PUT',
      query: () => ({ lock: this.session.lock }),
      headers: { 'content-type': 'application/json', 'if-match': `"${this.etag}"` },
      body: text,
      keepalive,
    });
    if (!response.ok) throw await failure(response);
    const saved = await response.json();
    this.etag = saved.etag;
    return saved;
  }

  /** Renews the lock (the plugin keeps it 30 minutes). */
  async refreshLock() {
    if (!this.write) return;
    const response = await this.call('/lock', {
      method: 'POST',
      query: () => ({ lock: this.session.lock, action: 'refresh' }),
    });
    if (!response.ok) throw await failure(response);
  }

  /** Ends the lock: the board is closed. */
  async unlock({ keepalive = false } = {}) {
    if (!this.write) return;
    const response = await this.call('/lock', {
      method: 'POST',
      query: () => ({ lock: this.session.lock, action: 'unlock' }),
      keepalive,
    });
    if (!response.ok && response.status !== 404) throw await failure(response);
  }
}

/** A failed answer of the plugin as a BoardError. */
async function failure(response) {
  const answer = await response.json().catch(() => ({}));
  const message = answer.message ?? `HTTP ${response.status}`;
  switch (response.status) {
    case 401:
    case 403:
      return new BoardError('read-only', message);
    case 404:
      return new BoardError('not-found', message);
    case 409:
      return answer.error === 'locked'
        ? new BoardError('locked', message, { by: answer.by, app: answer.locked_by })
        : new BoardError('changed', message);
    case 413:
      return new BoardError('too-large', message);
    case 507:
      return new BoardError('no-space', message);
    default:
      return new BoardError('failed', message);
  }
}

/**
 * When to save: a while after the last change (`delay`), not more often than
 * `gap`, one save at a time; a change during a save saves again after it.
 *
 * `save()` resolves when saved, throws a BoardError otherwise. `onState`
 * gets `{ state: 'saved'|'dirty'|'saving'|'error', error? }`.
 */
export class Autosave {
  constructor({ save, onState, delay = 2000, gap = 5000, retry = 10000, now = () => Date.now() }) {
    this.saveNow = save;
    this.onState = onState;
    this.delay = delay;
    this.gap = gap;
    this.retry = retry;
    this.now = now;
    this.timer = null;
    this.running = null;
    this.dirty = false;
    this.lastSave = 0;
    this.stopped = false;
  }

  /** The board changed. */
  changed() {
    if (this.stopped) return;
    this.dirty = true;
    this.onState({ state: 'dirty' });
    if (!this.running) this.schedule(this.delay);
  }

  schedule(ms) {
    clearTimeout(this.timer);
    const wait = Math.max(ms, this.lastSave + this.gap - this.now());
    this.timer = setTimeout(() => this.run(), wait);
  }

  async run() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.running || !this.dirty || this.stopped) return this.running;
    this.dirty = false;
    this.onState({ state: 'saving' });
    this.running = (async () => {
      try {
        await this.saveNow();
        this.lastSave = this.now();
        this.onState({ state: this.dirty ? 'dirty' : 'saved' });
      } catch (error) {
        this.dirty = true;
        this.onState({ state: 'error', error });
        if (error instanceof BoardError && TRANSIENT.has(error.code) && !this.stopped) this.schedule(this.retry);
        throw error;
      } finally {
        this.running = null;
      }
      if (this.dirty) this.schedule(this.delay);
    })();
    return this.running.catch(() => {});
  }

  /** Saves now what is not saved yet; waits for a save under way. Throws what saving threw. */
  async flush() {
    if (this.running) await this.running.catch(() => {});
    if (!this.dirty) return;
    clearTimeout(this.timer);
    this.dirty = false;
    this.onState({ state: 'saving' });
    try {
      await this.saveNow();
      this.lastSave = this.now();
      this.onState({ state: 'saved' });
    } catch (error) {
      this.dirty = true;
      this.onState({ state: 'error', error });
      throw error;
    }
  }

  /** No more saves (read-only, conflict, closed). */
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  resume() {
    this.stopped = false;
    if (this.dirty) this.schedule(this.delay);
  }
}
