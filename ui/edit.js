// The board page (#/app/rc-whiteboard/edit?file=<id>): asks the plugin for a
// lock and a token for the file, and has the panel show the board (the
// whiteboard service on the cloud's address, /whiteboard/) over this page.
// The board talks to this page through the panel: it asks for a new token and
// says when it is done.
(async () => {
  const context = await rustcloud.context;
  const t = texts(context.locale);
  document.documentElement.dataset.theme = context.theme;
  document.documentElement.lang = context.locale;
  const app = document.getElementById('app');

  /** The board must say it is there by then, or the browser can't reach it. */
  const READY_MS = 30000;
  /** What the board's messages carry, so others' are told apart. */
  const SOURCE = 'rc-whiteboard';
  let readyTimer = null;
  let frameOpen = false;
  /** Whether the user agreed to view a board someone else edits. */
  let readOnlyChosen = false;

  const file = context.file ?? (() => {
    const id = new URLSearchParams(location.search).get('file');
    return id ? { id, name: '', write: true } : null;
  })();

  function screen(...children) {
    app.replaceChildren(h('div', { class: 'box' }, ...children));
  }

  function loading(text) {
    screen(h('div', { class: 'spinner', role: 'progressbar', 'aria-label': text }), h('p', {}, text));
  }

  function closeButton() {
    return h('button', { onclick: () => rustcloud.close() }, t.close);
  }

  function closeFrame() {
    clearTimeout(readyTimer);
    if (frameOpen) {
      rustcloud.closeFrame();
      frameOpen = false;
    }
  }

  function fail(code, detail, retry = true) {
    closeFrame();
    screen(
      h('p', {}, t.errors[code] ?? t.errors.failed),
      detail ? h('p', { class: 'detail' }, detail) : null,
      h(
        'div',
        { class: 'actions' },
        retry ? h('button', { class: 'primary', onclick: () => open() }, t.retry) : null,
        closeButton(),
      ),
    );
  }

  /** `POST /session`: a token for the file, and the lock if the user edits it. */
  async function session(readOnly) {
    const query = new URLSearchParams({ file: file.id });
    if (!file.write || readOnly) query.set('write', '0');
    const response = await rustcloud.fetch(`/session?${query}`, { method: 'POST' });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(answer.message ?? `HTTP ${response.status}`);
      err.code = answer.error ?? 'failed';
      throw err;
    }
    return answer;
  }

  async function open() {
    loading(t.opening(file.name || ''));
    let answer;
    try {
      answer = await session(readOnlyChosen);
    } catch (err) {
      return fail(err.code ?? 'failed', err.code ? null : String(err.message || err), err.code !== 'unsupported');
    }
    // Someone else edits it: say so before showing it read-only.
    if (!readOnlyChosen && (answer.read_only === 'locked-by-user' || answer.read_only === 'locked-by-app')) {
      screen(
        h('p', {}, answer.read_only === 'locked-by-app' ? t.lockedByApp(answer.locked_by) : t.lockedByUser),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'primary', onclick: () => ((readOnlyChosen = true), show(answer)) }, t.readOnly),
          closeButton(),
        ),
      );
      return;
    }
    show(answer);
  }

  /** Has the panel show the board; what it needs goes in the URL's fragment. */
  async function show(answer) {
    loading(t.starting);
    const fragment = new URLSearchParams({
      file: file.id,
      name: answer.name ?? file.name ?? '',
      token: answer.token,
      expires: answer.expires_at ?? '',
      write: answer.write ? '1' : '0',
      lock: answer.lock ?? '',
      ro: answer.read_only ?? '',
      by: answer.locked_by ?? '',
      theme: context.theme,
      lang: context.locale,
      app: '/app/rc-whiteboard',
    });
    const url = `${context.origin}${answer.service}#${fragment}`;
    try {
      await rustcloud.openFrame({ url, method: 'get' });
      frameOpen = true;
    } catch (err) {
      return fail('frame-failed', String(err.message || err));
    }
    clearTimeout(readyTimer);
    readyTimer = setTimeout(() => fail('frame-timeout'), READY_MS);
  }

  function post(message) {
    rustcloud.postToFrame(JSON.stringify({ source: SOURCE, ...message }));
  }

  /** The board's messages: JSON text `{ source: 'rc-whiteboard', type, … }`. */
  rustcloud.onFrameMessage(async (data) => {
    let message = data;
    if (typeof data === 'string') {
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
    }
    if (!message || typeof message !== 'object' || message.source !== SOURCE) return;
    switch (message.type) {
      case 'ready':
        clearTimeout(readyTimer);
        break;
      case 'token':
        // The token ran out (or the lock was lost): a new one, with the lock if it can still be had.
        try {
          const answer = await session(readOnlyChosen || message.readOnly === true);
          post({
            type: 'token',
            token: answer.token,
            expires: answer.expires_at,
            write: answer.write,
            lock: answer.lock ?? '',
            ro: answer.read_only ?? '',
            by: answer.locked_by ?? '',
          });
        } catch (err) {
          post({ type: 'token-failed', code: err.code ?? 'failed', message: String(err.message || err) });
        }
        break;
      case 'close':
        closeFrame();
        rustcloud.close();
        break;
      case 'error':
        fail(message.code ?? 'load-failed', message.message);
        break;
      default:
        break;
    }
  });

  if (!file) return fail('no-file', null, false);
  if (!context.origin || !rustcloud.openFrame) return fail('no-origin', null, false);
  open();
})();
