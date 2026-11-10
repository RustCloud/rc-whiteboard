// What the board knows of the cloud: the session the plugin's page put in the
// URL's fragment, and messages to and from that page (through the panel,
// which shows the board in a frame over the page).

const SOURCE = 'rc-whiteboard';

/**
 * Reads the fragment (`#file=…&token=…`) and removes it from the address, so
 * the token stays out of the history and of copied links.
 */
export function takeSession(win = window) {
  const params = new URLSearchParams(win.location.hash.replace(/^#/, ''));
  if (win.location.hash) win.history.replaceState(null, '', win.location.pathname + win.location.search);
  const token = params.get('token');
  if (!token || !params.get('file')) return null;
  return {
    file: params.get('file'),
    name: params.get('name') ?? '',
    app: params.get('app') || '/app/rc-whiteboard',
    theme: params.get('theme') === 'dark' ? 'dark' : 'light',
    lang: params.get('lang') ?? 'en',
    session: sessionOf({
      token,
      expires: params.get('expires'),
      write: params.get('write') === '1',
      lock: params.get('lock'),
      ro: params.get('ro'),
      by: params.get('by'),
    }),
  };
}

/** A session from the page's answer. */
export function sessionOf({ token, expires, write, lock, ro, by }) {
  return {
    token,
    expires: expires || '',
    write: Boolean(write) && Boolean(lock),
    lock: lock || '',
    readOnly: ro || (write && lock ? '' : 'requested'),
    lockedBy: by || '',
  };
}

/** A message to the plugin's page. */
export function tell(type, data = {}) {
  if (window.parent === window) return;
  window.parent.postMessage(JSON.stringify({ source: SOURCE, type, ...data }), window.location.origin);
}

/** The page's messages of a type, until the returned function is called. */
export function listen(handler) {
  const onMessage = (event) => {
    if (event.source !== window.parent || event.origin !== window.location.origin) return;
    let message = event.data;
    if (typeof message === 'string') {
      try {
        message = JSON.parse(message);
      } catch {
        return;
      }
    }
    if (message && typeof message === 'object' && message.source === SOURCE) handler(message);
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}

/** Asks the page for a new token (and the lock, if it can still be had). */
export function renewSession({ readOnly = false, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error('The page did not give a new token'));
    }, timeoutMs);
    const stop = listen((message) => {
      if (message.type === 'token') {
        clearTimeout(timer);
        stop();
        resolve(sessionOf(message));
      } else if (message.type === 'token-failed') {
        clearTimeout(timer);
        stop();
        reject(new Error(message.message || message.code || 'token-failed'));
      }
    });
    tell('token', { readOnly });
  });
}

/** Has the browser save `text` as a file. */
export function download(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
