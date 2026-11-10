import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Autosave, Board, BoardError } from './board.js';

/** A fetch that answers from a list and remembers the requests. */
function fakeFetch(answers) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, ...init });
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    const { status = 200, body = {}, headers = {} } = answer;
    const text = status === 204 ? null : typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers });
  };
  return { fetch, calls };
}

function board(answers, session = { token: 't1', write: true, lock: 'wb-1' }, renew) {
  const fake = fakeFetch(answers);
  const b = new Board({ app: '/app/rc-whiteboard', file: 'f-1', session, renew, fetch: fake.fetch });
  return { board: b, calls: fake.calls };
}

describe('Board', () => {
  it('loads with the token and keeps the ETag', async () => {
    const { board: b, calls } = board([{ body: '{"elements":[]}', headers: { etag: '"e1"' } }]);
    expect(await b.load()).toBe('{"elements":[]}');
    expect(b.etag).toBe('e1');
    expect(calls[0].url).toBe('/app/rc-whiteboard/board/f-1');
    expect(calls[0].headers.authorization).toBe('Bearer t1');
    expect(calls[0].credentials).toBe('omit');
  });

  it('saves over what it read, under its lock', async () => {
    const { board: b, calls } = board([{ body: { etag: 'e2' } }]);
    b.etag = 'e1';
    await b.save('{}');
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe('/app/rc-whiteboard/board/f-1?lock=wb-1');
    expect(calls[0].headers['if-match']).toBe('"e1"');
    expect(b.etag).toBe('e2');
  });

  it('overwrites over what the file is now', async () => {
    const { board: b, calls } = board([{ body: { etag: 'e9' } }, { body: { etag: 'e10' } }]);
    b.etag = 'e1';
    await b.save('{}', { overwrite: true });
    expect(calls[0].url).toBe('/app/rc-whiteboard/board/f-1/info');
    expect(calls[1].headers['if-match']).toBe('"e9"');
  });

  it('tells conflicts and locks apart', async () => {
    const { board: b } = board([
      { status: 409, body: { error: 'changed' } },
      { status: 409, body: { error: 'locked', by: 'user', locked_by: 'rc-whiteboard' } },
      { status: 413, body: {} },
      new TypeError('Failed to fetch'),
    ]);
    await expect(b.save('{}')).rejects.toMatchObject({ code: 'changed' });
    await expect(b.save('{}')).rejects.toMatchObject({ code: 'locked', details: { by: 'user' } });
    await expect(b.save('{}')).rejects.toMatchObject({ code: 'too-large' });
    await expect(b.save('{}')).rejects.toMatchObject({ code: 'offline' });
  });

  it('asks for a new token once when it ran out', async () => {
    const renew = vi.fn(async () => ({ token: 't2', write: true, lock: 'wb-2' }));
    const { board: b, calls } = board([{ status: 401 }, { body: { etag: 'e2' } }], undefined, renew);
    await b.save('{}');
    expect(renew).toHaveBeenCalledTimes(1);
    expect(calls[1].headers.authorization).toBe('Bearer t2');
    expect(calls[1].url).toContain('lock=wb-2');
  });

  it('does not save read-only', async () => {
    const { board: b, calls } = board([], { token: 't1', write: false, lock: '' });
    await expect(b.save('{}')).rejects.toBeInstanceOf(BoardError);
    await b.unlock();
    expect(calls).toHaveLength(0);
  });

  it('renews and ends the lock', async () => {
    const { board: b, calls } = board([{ body: {} }, { status: 204, body: '' }]);
    await b.refreshLock();
    await b.unlock();
    expect(calls.map((call) => call.url)).toEqual([
      '/app/rc-whiteboard/lock/f-1?lock=wb-1&action=refresh',
      '/app/rc-whiteboard/lock/f-1?lock=wb-1&action=unlock',
    ]);
  });
});

describe('Autosave', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function autosave(save) {
    const states = [];
    const auto = new Autosave({ save, onState: (s) => states.push(s.state), now: () => Date.now() });
    return { auto, states };
  }

  it('saves a while after the last change', async () => {
    const save = vi.fn(async () => {});
    const { auto, states } = autosave(save);
    auto.changed();
    await vi.advanceTimersByTimeAsync(1000);
    auto.changed();
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toBe('saved');
  });

  it('saves again after a change during a save, not more often than the gap', async () => {
    let finish;
    const save = vi.fn(() => new Promise((resolve) => (finish = resolve)));
    const { auto } = autosave(save);
    auto.changed();
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(1);
    auto.changed();
    finish();
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3100);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('tries again later when offline, not after a conflict', async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new BoardError('offline'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new BoardError('changed'));
    const { auto, states } = autosave(save);
    auto.changed();
    await vi.advanceTimersByTimeAsync(2000);
    expect(states.at(-1)).toBe('error');
    await vi.advanceTimersByTimeAsync(10000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toBe('saved');
    auto.changed();
    await vi.advanceTimersByTimeAsync(60000);
    expect(save).toHaveBeenCalledTimes(3);
  });

  it('flushes what is not saved', async () => {
    const save = vi.fn(async () => {});
    const { auto } = autosave(save);
    await auto.flush();
    expect(save).not.toHaveBeenCalled();
    auto.changed();
    await auto.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });
});
