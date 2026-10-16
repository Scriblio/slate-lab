import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SongRef } from '../src/shared/protocol.ts';
import { seededRng } from '../src/shared/rotation.ts';
import { PushNotifier, turnAlerts } from '../src/server/push.ts';
import { Show, UserError } from '../src/server/show.ts';
import { phoneKeys, pushService } from './pushkit.ts';

const yt = (id: string, title = id): SongRef => ({ kind: 'youtube', videoId: id.padEnd(11, 'x'), title });
const URL_ = 'https://sing.example/#abcdefghjk.key';

function setup() {
  let t = 1_000_000;
  const now = () => t;
  const show = new Show({ now: () => (t += 1000), rng: seededRng(3), resolveLocal: () => undefined, onChange: () => {}, onPlayerCommand: () => {} });
  const service = pushService();
  const push = new PushNotifier({ subject: 'https://sing.example', fetchImpl: service.fetch, now });
  const singers = ['Alex', 'Bea', 'Cat'].map((name) => {
    const s = show.join(name).singer;
    show.addEntry(s.id, yt(`${name}1`, `${name} song`), { fromPhone: true });
    return s;
  });
  const tick = async () => {
    push.update(turnAlerts(show.state, show.upcoming()), URL_);
    await push.settle();
  };
  return { show, push, service, singers, tick, advance: (ms: number) => (t += ms) };
}

const sub = (name: string, p = phoneKeys()) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys: p.keys });

describe('turnAlerts', () => {
  it('names whoever is being called up, and whoever is next', () => {
    const { show, singers } = setup();
    const [alex, bea] = singers;
    expect(turnAlerts(show.state, show.upcoming()).map((a) => [a.kind, a.singerId])).toEqual([['next', alex!.id]]);
    show.callNext();
    expect(turnAlerts(show.state, show.upcoming()).map((a) => [a.kind, a.singerId])).toEqual([
      ['called', alex!.id],
      ['next', bea!.id],
    ]);
    show.play();
    expect(turnAlerts(show.state, show.upcoming()).map((a) => [a.kind, a.singerId])).toEqual([['next', bea!.id]]);
  });
});

describe('PushNotifier', () => {
  it('alerts a subscribed singer once when they’re next, and once when they’re called', async () => {
    const { show, push, service, singers, tick } = setup();
    const [, bea] = singers;
    const keys = phoneKeys();
    await push.load(show.state.id);
    push.subscribe(bea!.id, sub('bea', keys));
    await tick();
    expect(service.sent).toHaveLength(0); // Alex is next, and Alex has no alerts

    show.callNext(); // Alex up, Bea next
    await tick();
    await tick();
    expect(service.messages(sub('bea').endpoint, keys)).toEqual([
      { kind: 'next', title: 'You’re up next!', body: 'Get ready to sing “Bea song” and stay close to the stage.', url: URL_ },
    ]);

    show.play();
    show.ended(show.state.nowPlaying!.playId); // auto-advance calls Bea
    await tick();
    await tick();
    const msgs = service.messages(sub('bea').endpoint, keys);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toEqual({ kind: 'called', title: 'It’s your turn!', body: 'Head to the stage for “Bea song”.', url: URL_ });
    expect(service.sent[1]!.headers.TTL).toBe('300');
    expect(service.sent[1]!.headers.Topic).toBe('encore-turn');
  });

  it('doesn’t buzz someone over and over when the list is rearranged', async () => {
    const { show, push, service, singers, tick, advance } = setup();
    const [alex] = singers;
    await push.load(show.state.id);
    push.subscribe(alex!.id, sub('alex'));
    await tick(); // Alex next: one alert
    show.moveSinger(alex!.id, 2);
    await tick(); // Bea next now
    show.moveSinger(alex!.id, 0);
    await tick(); // Alex next again, a moment later: no second alert
    expect(service.sent).toHaveLength(1);
    show.moveSinger(alex!.id, 2);
    await tick();
    advance(3 * 60_000);
    show.moveSinger(alex!.id, 0);
    await tick(); // a few minutes on, it's worth telling them again
    expect(service.sent).toHaveLength(2);
  });

  it('forgets a subscription the push service says has ended', async () => {
    const { show, push, service, singers, tick } = setup();
    const [alex] = singers;
    await push.load(show.state.id);
    push.subscribe(alex!.id, sub('alex'));
    service.status = 410;
    await tick();
    expect(service.sent).toHaveLength(1);
    expect(push.has(alex!.id)).toBe(false);
  });

  it('turns away subscriptions it won’t send to', async () => {
    const { push, show, singers } = setup();
    await push.load(show.state.id);
    expect(() => push.subscribe(singers[0]!.id, { endpoint: 'https://192.168.1.1/x', keys: phoneKeys().keys })).toThrow(UserError);
    expect(() => push.subscribe(singers[0]!.id, { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'x', auth: 'y' } })).toThrow(UserError);
    expect(push.count).toBe(0);
  });

  it('drops singers who leave, moves a merged duplicate’s alerts, and clears for a new show', async () => {
    const { push, show, singers } = setup();
    const [alex, bea, cat] = singers;
    await push.load(show.state.id);
    push.subscribe(alex!.id, sub('alex'));
    push.subscribe(bea!.id, sub('bea'));
    push.retain(new Set([bea!.id, cat!.id]));
    expect([push.has(alex!.id), push.has(bea!.id)]).toEqual([false, true]);
    push.transfer(bea!.id, cat!.id);
    expect([push.has(bea!.id), push.has(cat!.id)]).toEqual([false, true]);
    push.reset('next-show');
    expect(push.count).toBe(0);
  });

  it('keeps its signing key, and tonight’s subscriptions, across a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'encore-push-'));
    try {
      const first = new PushNotifier({ dataDir: dir, subject: 'https://sing.example' });
      await first.load('show-1');
      first.subscribe('s1', sub('s1'));
      await first.flush();

      const again = new PushNotifier({ dataDir: dir, subject: 'https://sing.example' });
      await again.load('show-1');
      expect(again.publicKey).toBe(first.publicKey);
      expect(again.has('s1')).toBe(true);

      const nextNight = new PushNotifier({ dataDir: dir, subject: 'https://sing.example' });
      await nextNight.load('show-2');
      expect(nextNight.publicKey).toBe(first.publicKey);
      expect(nextNight.has('s1')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
