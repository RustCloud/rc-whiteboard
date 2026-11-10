// End-to-end check: the plugin in a real cloud, the board served by the
// service through the cloud's [[proxy]], in Chromium. Usage (run.sh):
//   node board.mjs <cloud url>     with /plugin.zip and the service at http://whiteboard:8080
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.argv[2];
const H = { 'x-requested-with': 'e2e' };
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const shot = (page, name) => page.screenshot({ path: `out/${name}.png` });
let step = '';
const log = (text) => console.log(`✓ ${text}`);

async function ok(reply, what) {
  if (!reply.ok()) throw new Error(`${what}: ${reply.status()} ${await reply.text()}`);
  return reply;
}
const json = async (reply, what) => (await ok(reply, what)).json();

/** A browser context of a user, logged in. */
async function userContext(username, register = false) {
  const context = await browser.newContext({ baseURL: base, locale: 'ru-RU', viewport: { width: 1280, height: 800 } });
  const data = { username, password: 'password123' };
  if (register) await ok(await context.request.post('/api/v1/auth/register', { data }), 'register');
  else await ok(await context.request.post('/api/v1/auth/login', { data }), 'login');
  // Opening a file by its link asks first; the user said "don't ask again".
  await context.addInitScript(() => localStorage.setItem('rustcloud.openWith.rc-whiteboard', '1'));
  return context;
}

async function upload(api, folder, name, content) {
  const node = await json(
    await api.post(`/api/v1/files/${folder}/upload?name=${encodeURIComponent(name)}`, { headers: H, data: content }),
    `upload ${name}`,
  );
  return node.id;
}

const content = async (api, id) => (await ok(await api.get(`/api/v1/files/${id}/content`), 'content')).text();
const lockOf = async (api, id) => (await json(await api.get(`/api/v1/files/${id}`), 'file')).node.lock ?? null;

/** Opens a file in the Whiteboard and waits for the board's frame. */
async function openBoard(page, id) {
  await page.goto(`/#/app/rc-whiteboard/edit?file=${id}`);
  const board = await waitFrame(page, (frame) => frame.url().includes('/whiteboard/'));
  await board.locator('.excalidraw').waitFor({ timeout: 30000 });
  return board;
}

async function waitFrame(page, test, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const found = page.frames().find(test);
    if (found) return found;
    await page.waitForTimeout(200);
  }
  throw new Error('frame did not come');
}

async function status(board) {
  return (await board.locator('.rc-status').textContent()).trim();
}

async function waitStatus(board, text, timeout = 20000) {
  await board.locator('.rc-status', { hasText: text }).waitFor({ timeout });
}

/** Draws a rectangle on the board. */
async function drawRectangle(page, board, x, y) {
  const canvas = board.locator('canvas.interactive');
  await canvas.click({ position: { x: 600, y: 650 } });
  await page.keyboard.press('r');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 160, y + 100, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press('Escape');
}

const RECT = {
  id: 'r1', type: 'rectangle', x: 100, y: 100, width: 200, height: 120, angle: 0, strokeColor: '#1e1e1e',
  backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100,
  groupIds: [], frameId: null, roundness: null, seed: 1, version: 3, versionNonce: 11, isDeleted: false,
  boundElements: null, updated: 1, link: null, locked: false,
};

try {
  step = 'setup';
  const admin = await userContext('admin', true);
  const api = admin.request;
  await json(await api.post('/api/v1/admin/plugins', { headers: H, data: readFileSync('/plugin.zip') }), 'install');
  await json(
    await api.put('/api/v1/admin/plugins/rc-whiteboard/settings', { headers: H, data: { service_url: 'http://whiteboard:8080' } }),
    'settings',
  );
  await json(await api.put('/api/v1/admin/plugins/rc-whiteboard', { headers: H, data: { enabled: true } }), 'enable');
  const report = await json(await api.get('/app/rc-whiteboard/status'), 'status');
  if (report[0]?.level !== 'ok') throw new Error(`status: ${JSON.stringify(report)}`);
  log(`status: ${report[0].text.en}`);
  const apps = await json(await api.get('/api/v1/apps'), 'apps');
  if (!JSON.stringify(apps).includes('rc-whiteboard')) throw new Error('plugin not listed');

  const root = (await json(await api.get('/api/v1/files/root'), 'root')).id;
  const plan = await upload(api, root, 'Plan.excalidraw', JSON.stringify({ type: 'excalidraw', version: 2, elements: [RECT], appState: {}, files: {} }));
  const nextcloud = await upload(
    api,
    root,
    'Old.whiteboard',
    JSON.stringify({ elements: [{ ...RECT, customData: { creator: { uid: 'bob' } } }], files: [], libraryItems: [{ id: 'l1' }], scrollToContent: true }),
  );
  const blank = await upload(api, root, 'New.whiteboard', '');
  // The template of "New".
  const template = JSON.parse(await (await ok(await api.get('/app/rc-whiteboard/templates/empty.excalidraw'), 'template')).text());
  if (template.type !== 'excalidraw') throw new Error('template');

  step = 'open and draw';
  const page = await admin.newPage();
  const statuses = {};
  admin.on('response', (response) => {
    if (!response.url().includes('/whiteboard/')) return;
    statuses[response.status()] = (statuses[response.status()] ?? 0) + 1;
  });
  const fonts = { local: 0, cdn: 0 };
  admin.on('request', (request) => {
    if (!request.url().includes('/fonts/')) return;
    if (request.url().startsWith(`${base}/whiteboard/`)) fonts.local += 1;
    else fonts.cdn += 1;
  });
  // Nothing but the cloud: the board works without internet.
  const outside = new Set();
  admin.on('request', (request) => {
    if (!request.url().startsWith(base) && !/^(data|blob):/.test(request.url())) outside.add(request.url().slice(0, 80));
  });
  admin.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('esm.sh')) console.log(`  [console] ${m.text()}`);
  });
  let board = await openBoard(page, plan);
  await waitStatus(board, 'Сохранено');
  const lock = await lockOf(api, plan);
  if (lock?.app_id !== 'rc-whiteboard') throw new Error(`no lock: ${JSON.stringify(lock)}`);
  log(`opened, locked by ${lock.app_id}`);
  await drawRectangle(page, board, 500, 300);
  await waitStatus(board, 'Сохранение');
  await waitStatus(board, 'Сохранено');
  const saved = JSON.parse(await content(api, plan));
  if (saved.elements.filter((e) => !e.isDeleted).length !== 2) throw new Error(`elements: ${saved.elements.length}`);
  if (saved.type !== 'excalidraw' || saved.scrollToContent !== true || saved.source.includes('cloud')) {
    throw new Error(`format: ${JSON.stringify({ ...saved, elements: undefined })}`);
  }
  log('drawn and autosaved (2 elements, union format)');
  await board.locator('canvas.interactive').dblclick({ position: { x: 300, y: 600 } });
  await page.keyboard.type('Привет, доска');
  await page.keyboard.press('Escape');
  await waitStatus(board, 'Сохранено');
  await page.waitForTimeout(500);
  if (!fonts.local) throw new Error('no font from the service for the text');
  log(`text written; ${fonts.local} font files from the service`);
  await shot(page, 'board');

  step = 'lock keeps others out';
  const overwrite = await api.put(`/api/v1/files/${plan}/content`, { headers: H, data: '{}' });
  if (overwrite.status() !== 409) throw new Error(`overwrite while open: ${overwrite.status()}`);
  log('the panel cannot overwrite the open board (409)');

  step = 'another tab takes over';
  // Access of apps to a file is its owner's (a share gives none): the one who
  // can take a board over is the same user, in another tab.
  const tab = await admin.newPage();
  const tabBoard = await openBoard(tab, plan);
  await waitStatus(tabBoard, 'Сохранено');
  await drawRectangle(page, board, 300, 500);
  await board.getByText('открыли в другой вкладке').waitFor({ timeout: 20000 });
  await waitStatus(board, 'Только чтение');
  log('a second tab takes the board over: the first one turns read-only');
  await shot(page, 'taken-over');
  await board.getByRole('button', { name: 'Скачать копию' }).waitFor();
  await tab.close();
  await page.waitForTimeout(1500);
  await board.getByRole('button', { name: 'Понятно' }).click();
  await board.locator('.rc-top-right .rc-button').click();
  await page.waitForURL(/#\/files/, { timeout: 10000 });
  board = await openBoard(page, plan);
  await waitStatus(board, 'Сохранено');

  step = 'close';
  await board.locator('.rc-top-right .rc-button').click();
  await page.waitForURL(/#\/files/, { timeout: 10000 });
  await page.waitForTimeout(500);
  if (await lockOf(api, plan)) throw new Error('lock left after close');
  log('closed: back to files, lock released');

  step = 'nextcloud file';
  board = await openBoard(page, nextcloud);
  await waitStatus(board, 'Сохранено');
  await drawRectangle(page, board, 500, 300);
  await waitStatus(board, 'Сохранено');
  const nc = JSON.parse(await content(api, nextcloud));
  if (JSON.stringify(nc.libraryItems) !== '[{"id":"l1"}]' || nc.elements[0].customData?.creator?.uid !== 'bob') {
    throw new Error(`nextcloud keys lost: ${JSON.stringify(nc).slice(0, 300)}`);
  }
  log('.whiteboard: saved, Nextcloud keys kept');
  await board.locator('.rc-top-right .rc-button').click();
  await page.waitForURL(/#\/files/, { timeout: 10000 });

  step = 'empty file';
  board = await openBoard(page, blank);
  await waitStatus(board, 'Сохранено');
  await page.waitForTimeout(3000);
  await board.locator('.rc-top-right .rc-button').click();
  await page.waitForURL(/#\/files/, { timeout: 10000 });
  if ((await content(api, blank)) !== '') throw new Error('an untouched empty board was written');
  log('empty .whiteboard: opened as a new board, not written untouched');

  step = 'versions';
  // The server makes no version of saves by the same user within 5 minutes
  // of the last one or of the file's creation: an autosaving editor would fill the list.
  const { versions } = await json(await api.get(`/api/v1/files/${plan}/versions`), 'versions');
  log(`versions of Plan.excalidraw: ${versions.length} (saves within 5 minutes of its upload fold)`);
  log(`board's requests through the proxy by status: ${JSON.stringify(statuses)}`);
  if (outside.size || fonts.cdn) throw new Error(`requests outside the cloud: ${[...outside].slice(0, 3)}`);
  log(`no requests outside the cloud; fonts from the service: ${fonts.local}`);
  console.log('E2E OK');
} catch (err) {
  console.error(`✗ ${step}: ${err.stack || err}`);
  for (const context of browser.contexts()) {
    for (const [i, page] of context.pages().entries()) await shot(page, `fail-${i}`).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await browser.close();
}
