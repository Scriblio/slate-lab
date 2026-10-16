// The join page's service worker, run in a sandbox with a fake browser around it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

type Listener = (event: Record<string, unknown>) => void;
interface Shown {
  title: string;
  options: { body: string; tag: string; requireInteraction: boolean; data: { url: string } };
}

function loadWorker(origin = 'https://sing.example') {
  const listeners: Record<string, Listener> = {};
  const shown: Shown[] = [];
  const opened: string[] = [];
  const focused: string[] = [];
  let windows: { url: string }[] = [];
  const self = {
    location: new URL(`${origin}/sw.js`),
    addEventListener: (type: string, fn: Listener) => (listeners[type] = fn),
    skipWaiting: () => {},
    registration: { showNotification: async (title: string, options: Shown['options']) => void shown.push({ title, options }) },
    clients: {
      claim: async () => {},
      matchAll: async () => windows.map((w) => ({ url: w.url, focus: async () => void focused.push(w.url) })),
      openWindow: async (url: string) => void opened.push(url),
    },
  };
  runInNewContext(readFileSync(join(import.meta.dirname, '../src/sw/sw.js'), 'utf8'), { self, URL, String });
  const fire = async (type: string, init: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = [];
    listeners[type]!({ ...init, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  };
  const push = (data: unknown) => fire('push', { data: { json: () => (data instanceof Error ? (() => { throw data; })() : data) } });
  const click = (url?: string) => fire('notificationclick', { notification: { close: () => {}, data: { url } } });
  return { push, click, shown, opened, focused, setWindows: (w: { url: string }[]) => (windows = w) };
}

const url = 'https://sing.example/#abcdefghjk.key';

describe('the join page’s service worker', () => {
  it('shows the laptop’s alert, keeping a "your turn" alert up until it’s seen', async () => {
    const sw = loadWorker();
    await sw.push({ kind: 'next', title: 'You’re up next!', body: 'Get ready.', url });
    await sw.push({ kind: 'called', title: 'It’s your turn!', body: 'Head to the stage.', url });
    expect(sw.shown.map((s) => [s.title, s.options.tag, s.options.requireInteraction])).toEqual([
      ['You’re up next!', 'encore-turn', false],
      ['It’s your turn!', 'encore-turn', true],
    ]);
    expect(sw.shown[1]!.options).toMatchObject({ body: 'Head to the stage.', data: { url } });
  });

  it('still shows something for a message it can’t read', async () => {
    const sw = loadWorker();
    await sw.push(new Error('not JSON'));
    expect(sw.shown[0]!.title).toBe('Karaoke');
  });

  it('only ever opens its own site', async () => {
    const sw = loadWorker();
    await sw.push({ title: 'x', url: 'https://evil.example/phish' });
    expect(sw.shown[0]!.options.data.url).toBe('https://sing.example/');
    await sw.click('javascript:alert(1)');
    expect(sw.opened).toEqual(['https://sing.example/']);
  });

  it('brings the open page forward when tapped, or opens it again', async () => {
    const sw = loadWorker();
    await sw.click(url);
    expect(sw.opened).toEqual([url]);
    sw.setWindows([{ url: 'https://sing.example/other' }, { url }]);
    await sw.click(url);
    expect(sw.focused).toEqual([url]);
    expect(sw.opened).toHaveLength(1);
  });
});
