import { describe, expect, it, vi } from 'vitest';
import { seededRng } from '../src/shared/rotation.ts';
import type { SongRef } from '../src/shared/protocol.ts';
import { Show } from '../src/server/show.ts';

const yt = (id: string, title = id): SongRef => ({ kind: 'youtube', videoId: id.padEnd(11, 'x'), title });

function makeShow() {
  let t = 1_000_000;
  const commands: { playId: string; cmd: string }[] = [];
  const show = new Show({
    now: () => (t += 1000),
    rng: seededRng(3),
    resolveLocal: () => undefined,
    onChange: () => {},
    onPlayerCommand: (playId, cmd) => commands.push({ playId, cmd: cmd.cmd }),
  });
  return { show, commands };
}

describe('Show', () => {
  it('runs a night: call up, play, finish, next', () => {
    const { show, commands } = makeShow();
    const a = show.join('Alex').singer;
    const b = show.join('Bea').singer;
    show.addEntry(a.id, yt('a1'), { fromPhone: true });
    show.addEntry(b.id, yt('b1'), { fromPhone: true });

    show.callNext();
    const np = show.state.nowPlaying!;
    expect(np.singerName).toBe('Alex');
    expect(np.stage).toBe('intro');
    show.play();
    expect(show.state.nowPlaying!.stage).toBe('playing');
    expect(commands.at(-1)).toEqual({ playId: np.playId, cmd: 'play' });

    show.ended(np.playId);
    expect(show.state.history[0]!.outcome).toBe('finished');
    // autoAdvance is on by default: Bea is already being called up.
    expect(show.state.nowPlaying!.singerName).toBe('Bea');
    expect(show.singer(a.id)!.songsSung).toBe(1);
  });

  it('ignores stale reports from the display', () => {
    const { show } = makeShow();
    const a = show.join('Alex').singer;
    show.addEntry(a.id, yt('a1'), { fromPhone: true });
    show.callNext();
    show.play();
    show.ended('not-the-current-play');
    expect(show.state.nowPlaying).not.toBeNull();
    expect(show.progress('nope', 10)).toBe(false);
  });

  it('a no-show keeps their turn, goes away, and the next singer is called', () => {
    const { show } = makeShow();
    const a = show.join('Alex').singer;
    const b = show.join('Bea').singer;
    show.addEntry(a.id, yt('a1'), { fromPhone: true });
    show.addEntry(b.id, yt('b1'), { fromPhone: true });
    show.callNext();
    show.noShow();
    expect(show.state.nowPlaying!.singerName).toBe('Bea');
    const alex = show.singer(a.id)!;
    expect(alex.status).toBe('away');
    expect(alex.songsSung).toBe(0);
    expect(show.state.entries.map((e) => e.song.title)).toEqual(['a1']);
    expect(show.state.sungThisRound).toEqual([b.id]);

    // Alex comes back from the bar: still owed a turn this round.
    show.setSingerStatus(a.id, 'active');
    show.addEntry(b.id, yt('b2'), { fromPhone: true });
    expect(show.upcoming().map((u) => u.entry.song.title)).toEqual(['a1', 'b2']);
  });

  it('calling someone else from the intro card puts the first singer back untouched', () => {
    const { show } = makeShow();
    const a = show.join('Alex').singer;
    const b = show.join('Bea').singer;
    show.addEntry(a.id, yt('a1'), { fromPhone: true });
    const b1 = show.addEntry(b.id, yt('b1'), { fromPhone: true });
    show.callNext();
    show.callEntry(b1.id);
    expect(show.state.nowPlaying!.singerName).toBe('Bea');
    expect(show.singer(a.id)!.status).toBe('active');
    expect(show.state.history).toHaveLength(0);
    expect(show.upcoming().map((u) => u.entry.song.title)).toEqual(['a1']);
  });

  it('enforces the per-singer limit and duplicates for phones, not for the KJ', () => {
    const { show } = makeShow();
    show.updateSettings({ maxQueuedPerSinger: 2 });
    const a = show.join('Alex').singer;
    show.addEntry(a.id, yt('a1'), { fromPhone: true });
    expect(() => show.addEntry(a.id, yt('a1'), { fromPhone: true })).toThrow(/already on your list/);
    show.addEntry(a.id, yt('a2'), { fromPhone: true });
    expect(() => show.addEntry(a.id, yt('a3'), { fromPhone: true })).toThrow(/2 songs/);
    expect(() => show.addEntry(a.id, yt('a3'), { fromPhone: false })).not.toThrow();
  });

  it('holds phone requests for approval when asked to', () => {
    const { show } = makeShow();
    show.updateSettings({ requireApproval: true });
    const a = show.join('Alex').singer;
    const e = show.addEntry(a.id, yt('a1'), { fromPhone: true });
    expect(e.status).toBe('pending');
    expect(show.callNext()).toBeNull();
    show.approve(e.id);
    expect(show.callNext()?.id).toBe(e.id);
  });

  it('closes sign-ups', () => {
    const { show } = makeShow();
    show.updateSettings({ joinOpen: false });
    expect(() => show.join('Late')).toThrow(/closed/);
  });

  it('cleans names and de-duplicates them', () => {
    const { show } = makeShow();
    expect(show.join('  Sam​ \n ').singer.name).toBe('Sam');
    expect(() => show.join('sam')).toThrow(expect.objectContaining({ code: 'name-taken' }));
    expect(() => show.join('   ')).toThrow(/name/);
  });

  it('never trusts song details from a phone', () => {
    const { show } = makeShow();
    const song = show.resolveSong({ kind: 'youtube', videoId: 'dQw4w9WgXcQ', title: 'x'.repeat(500), durationSec: 1e9 });
    expect(song.title).toHaveLength(140);
    expect(song.durationSec).toBeUndefined();
    expect(song.thumbnail).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg');
    expect(() => show.resolveSong({ kind: 'youtube', videoId: '"><script>' })).toThrow();
    expect(() => show.resolveSong({ kind: 'local', trackId: 'missing' })).toThrow(/library/);
  });

  it('lets a singer reorder only their own songs, keeping First Come slots', () => {
    const { show } = makeShow();
    show.setMode('fifo');
    const a = show.join('Alex').singer;
    const b = show.join('Bea').singer;
    const a1 = show.addEntry(a.id, yt('a1'), { fromPhone: true });
    show.addEntry(b.id, yt('b1'), { fromPhone: true });
    const a2 = show.addEntry(a.id, yt('a2'), { fromPhone: true });
    show.singerAction(a.id, { type: 'moveMyEntry', entryId: a2.id, direction: -1 });
    expect(show.state.entries.map((e) => e.song.title)).toEqual(['a2', 'b1', 'a1']);
    expect(() => show.singerAction(b.id, { type: 'removeMyEntry', entryId: a1.id })).toThrow(/your song/);
  });

  it('auto-starts after the intro countdown', () => {
    vi.useFakeTimers();
    try {
      const { show } = makeShow();
      show.updateSettings({ autoStartSec: 10 });
      const a = show.join('Alex').singer;
      show.addEntry(a.id, yt('a1'), { fromPhone: true });
      show.callNext();
      expect(show.state.nowPlaying!.stage).toBe('intro');
      vi.advanceTimersByTime(10_000);
      expect(show.state.nowPlaying!.stage).toBe('playing');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows phones their place in line without leaking other singers’ songs', () => {
    const { show } = makeShow();
    const a = show.join('Alex').singer;
    const b = show.join('Bea').singer;
    show.addEntry(a.id, yt('a1', 'Alex Secret Pick'), { fromPhone: true });
    show.addEntry(b.id, yt('b1', 'Bea Song'), { fromPhone: true });
    const view = show.singerView(b.id, show.upcoming(), false);
    expect(view.myNextPosition).toBe(2);
    expect(view.upcoming[0]).toEqual({ singerName: 'Alex', isMe: false, etaSec: 0 });
    expect(view.upcoming[1]!.title).toBe('Bea Song');
    const json = JSON.stringify(view);
    expect(json).not.toContain('Alex Secret Pick');
    expect(view.me?.code).toBe(show.singer(b.id)!.code);
    expect(json).not.toContain(`"${show.singer(a.id)!.code}"`);
    expect(json).not.toContain('a1xxxxxxxxx');
  });

  it('gives each phone sign-up one spot per name; a second sign-up must reclaim it', () => {
    const { show } = makeShow();
    const first = show.join('Matt');
    expect(first.singer.code).toMatch(/^\d{4}$/);
    expect(() => show.join('  matt ')).toThrow(expect.objectContaining({ code: 'name-taken', message: 'Matt is already on the list.' }));
    // The KJ can still add a second person with the same name.
    expect(show.addSinger('Matt', false).name).toBe('Matt (2)');
    expect(() => show.join('Matt (2)')).toThrow(expect.objectContaining({ code: 'name-taken' }));
  });

  it('lets a singer reclaim their spot from a new browser with their code', () => {
    const { show } = makeShow();
    const { singer, token } = show.join('Robin');
    const again = show.reclaim('ROBIN', singer.code);
    expect(again.singer.id).toBe(singer.id);
    expect(again.token).not.toBe(token);
    // Both browsers stay signed in as the same singer.
    expect(show.singerForToken(token)?.id).toBe(singer.id);
    expect(show.singerForToken(again.token)?.id).toBe(singer.id);
    expect(() => show.reclaim('Nobody', '0000')).toThrow(expect.objectContaining({ code: 'not-on-list' }));
  });

  it('locks reclaiming after five wrong codes, then unlocks', () => {
    let t = 0;
    const show = new Show({ now: () => t, resolveLocal: () => undefined, onChange: () => {}, onPlayerCommand: () => {} });
    const { singer } = show.join('Kim');
    const wrong = singer.code === '0000' ? '1111' : '0000';
    for (let i = 0; i < 4; i++) expect(() => show.reclaim('Kim', wrong)).toThrow(expect.objectContaining({ code: 'bad-code' }));
    expect(() => show.reclaim('Kim', wrong)).toThrow(expect.objectContaining({ code: 'bad-code' }));
    // Locked now, even with the right code.
    expect(() => show.reclaim('Kim', singer.code)).toThrow(expect.objectContaining({ code: 'locked' }));
    t += 10 * 60_000 + 1;
    expect(show.reclaim('Kim', singer.code).singer.id).toBe(singer.id);
  });

  it('merges a duplicate: songs (without repeats), counts, round and phones move over', () => {
    const { show } = makeShow();
    show.updateSettings({ autoAdvance: false });
    const real = show.join('Alex');
    const dup = show.addSinger('Alex', false);
    show.addEntry(real.singer.id, yt('shared', 'Same Song'), { fromPhone: false });
    show.addEntry(dup.id, yt('shared', 'Same Song'), { fromPhone: false });
    const extra = show.addEntry(dup.id, yt('extra', 'Extra Song'), { fromPhone: false });
    show.pin(extra.id);
    const dupToken = show.reclaim('Alex (2)', dup.code).token;
    show.callEntry(extra.id);
    expect(() => show.mergeSingers(dup.id, real.singer.id)).toThrow(/off stage/);
    show.play();
    show.skip();
    show.addEntry(dup.id, yt('third', 'Third Song'), { fromPhone: false });

    show.mergeSingers(dup.id, real.singer.id);
    expect(show.singer(dup.id)).toBeUndefined();
    const alex = show.singer(real.singer.id)!;
    expect(alex.songsSung).toBe(1);
    expect(show.state.entries.filter((e) => e.singerId === alex.id).map((e) => e.song.title).sort()).toEqual(['Same Song', 'Third Song']);
    expect(show.state.sungThisRound).toContain(alex.id);
    expect(show.state.sungThisRound).not.toContain(dup.id);
    expect(show.singerForToken(dupToken)?.id).toBe(alex.id);
  });

  it('removing a singer drops their songs, pins and tokens', () => {
    const { show } = makeShow();
    const { token, singer } = show.join('Alex');
    const e = show.addEntry(singer.id, yt('a1'), { fromPhone: true });
    show.pin(e.id);
    show.removeSinger(singer.id);
    expect(show.state.entries).toHaveLength(0);
    expect(show.state.playNext).toHaveLength(0);
    expect(show.singerForToken(token)).toBeUndefined();
  });
});

describe('Phone turn alert actions', () => {
  function night() {
    const { show, commands } = makeShow();
    const notices: string[] = [];
    (show as unknown as { deps: { onNotice?: (t: string) => void } }).deps.onNotice = (t) => notices.push(t);
    const [a, b, c] = ['Alex', 'Bea', 'Cam'].map((n) => show.join(n).singer);
    for (const [s, t] of [
      [a!, 'a1'],
      [b!, 'b1'],
      [c!, 'c1'],
    ] as const)
      show.addEntry(s.id, yt(t), { fromPhone: true });
    return { show, commands, notices, a: a!, b: b!, c: c! };
  }

  it('“can’t sing right now” while up next lets two singers go first', () => {
    const { show, notices, a } = night();
    expect(show.upcoming()[0]!.singer.name).toBe('Alex');
    show.singerAction(a.id, { type: 'notNow' });
    expect(show.upcoming().map((u) => u.singer.name)).toEqual(['Bea', 'Cam', 'Alex']);
    expect(notices).toEqual(['Alex can’t sing right now, so the next 2 singers go first.']);
  });

  it('“can’t sing right now” after being called undoes the call and brings up the next singer', () => {
    const { show, a } = night();
    show.callNext();
    expect(show.state.nowPlaying!.singerName).toBe('Alex');
    show.singerAction(a.id, { type: 'notNow' });
    expect(show.state.nowPlaying!.singerName).toBe('Bea');
    expect(show.state.entries.some((e) => e.singerId === a.id)).toBe(true);
    expect(show.state.singers.find((s) => s.id === a.id)).toMatchObject({ songsSung: 0, status: 'active' });
    expect(show.upcoming().map((u) => u.singer.name)).toEqual(['Cam', 'Alex']);
  });

  it('can’t be used mid-song', () => {
    const { show, a } = night();
    show.callNext();
    show.play();
    expect(() => show.singerAction(a.id, { type: 'notNow' })).toThrow(/already singing/);
  });

  it('“I left” takes the singer off the list, and off the stage if they were being called', () => {
    const { show, notices, a } = night();
    show.callNext();
    show.singerAction(a.id, { type: 'leave' });
    expect(show.singer(a.id)).toBeUndefined();
    expect(show.state.entries.some((e) => e.singerId === a.id)).toBe(false);
    expect(show.state.nowPlaying!.singerName).toBe('Bea');
    expect(notices).toEqual(['Alex left and was taken off the list.']);
  });

  it('a no-show by someone else doesn’t eat a waiting singer’s turns', () => {
    const { show, a } = night();
    show.singerAction(a.id, { type: 'notNow' });
    show.callNext(); // Bea, counting Alex down to 1
    expect(show.singer(a.id)!.holdTurns).toBe(1);
    show.noShow(); // Bea isn't here: her call is undone, Cam comes up
    expect(show.state.nowPlaying!.singerName).toBe('Cam');
    expect(show.singer(a.id)!.holdTurns).toBe(1);
  });
});

describe('Changing the song on stage', () => {
  function onStage() {
    const { show } = makeShow();
    const notices: string[] = [];
    (show as unknown as { deps: { onNotice?: (t: string) => void } }).deps.onNotice = (t) => notices.push(t);
    const a = show.join('Alex').singer;
    const b = show.join('Bea').singer;
    show.addEntry(a.id, yt('a1', 'First pick'), { fromPhone: true });
    show.addEntry(a.id, yt('a2', 'Second pick'), { fromPhone: true });
    show.addEntry(b.id, yt('b1'), { fromPhone: true });
    show.callNext();
    return { show, notices, a, b };
  }

  it('puts a brand-new song on the intro card and drops the old one', () => {
    const { show } = onStage();
    const before = show.state.nowPlaying!;
    show.changeStageSong({ kind: 'youtube', videoId: 'newsong0001', title: 'Something else' }, { fromPhone: false });
    const np = show.state.nowPlaying!;
    expect(np).toMatchObject({ singerName: 'Alex', stage: 'intro', entry: { song: { title: 'Something else' } } });
    expect(np.playId).not.toBe(before.playId);
    expect(show.state.entries.map((e) => e.song.title)).toEqual(['Second pick', 'b1']);
    expect(show.state.history).toHaveLength(0);
  });

  it('trades places with one of their own songs, so the old one stays in line', () => {
    const { show } = onStage();
    show.changeStageSong({ kind: 'youtube', videoId: 'a2'.padEnd(11, 'x') }, { fromPhone: false });
    expect(show.state.nowPlaying!.entry.song.title).toBe('Second pick');
    expect(show.state.entries.map((e) => e.song.title)).toEqual(['First pick', 'b1']);
  });

  it('works mid-song for the KJ, going back to the intro card', () => {
    const { show } = onStage();
    show.play();
    show.changeStageSong({ kind: 'youtube', videoId: 'newsong0001', title: 'Swap' }, { fromPhone: false });
    expect(show.state.nowPlaying).toMatchObject({ stage: 'intro', position: 0, startedAt: undefined });
  });

  it('lets the singer change from their phone before the song starts, and tells the KJ', () => {
    const { show, notices, a, b } = onStage();
    show.singerAction(a.id, { type: 'changeMySong', song: { kind: 'youtube', videoId: 'newsong0001', title: 'My new pick' } });
    expect(show.state.nowPlaying!.entry.song.title).toBe('My new pick');
    expect(notices).toEqual(['Alex changed their song to “My new pick”.']);
    expect(() => show.singerAction(b.id, { type: 'changeMySong', song: yt('zz') })).toThrow(/once you’re called up/);
    show.play();
    expect(() => show.singerAction(a.id, { type: 'changeMySong', song: yt('zz') })).toThrow(/already started/);
  });
});

describe('Dropping a request', () => {
  it('takes it from the queue, undoes a call-up, or ends a song in progress', () => {
    const { show } = makeShow();
    const [a, b, c] = ['Alex', 'Bea', 'Cam'].map((n) => show.join(n).singer);
    const ea = show.addEntry(a!.id, yt('a1'), { fromPhone: true });
    const eb = show.addEntry(b!.id, yt('b1'), { fromPhone: true });
    const ec = show.addEntry(c!.id, yt('c1'), { fromPhone: true });
    show.dropRequest(ec.id);
    expect(show.state.entries.map((e) => e.id)).toEqual([ea.id, eb.id]);

    show.callNext(); // Alex
    show.dropRequest(ea.id);
    expect(show.state.nowPlaying!.singerName).toBe('Bea');
    expect(show.singer(a!.id)!.songsSung).toBe(0);
    expect(show.state.history).toHaveLength(0);

    show.play();
    show.dropRequest(eb.id);
    expect(show.state.nowPlaying).toBeNull();
    expect(show.state.history[0]).toMatchObject({ outcome: 'skipped' });
  });

  it('tidies temp save files an earlier session left behind, and keeps the saved show', async () => {
    const { mkdtemp, readdir, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'encore-show-'));
    const mk = () => new Show({ resolveLocal: () => undefined, onChange: () => {}, onPlayerCommand: () => {}, dataDir: dir });
    const first = mk();
    first.addSinger('Saved Sam', false);
    await first.flush();
    await writeFile(join(dir, 'show.json.123.tmp'), '{"half":');
    await writeFile(join(dir, 'show.json.4567.tmp'), '');
    await writeFile(join(dir, 'config.json'), '{}');
    const second = mk();
    await second.load();
    expect((await readdir(dir)).sort()).toEqual(['config.json', 'show.json']);
    expect(second.state.singers.map((x) => x.name)).toEqual(['Saved Sam']);
    first.dispose();
    second.dispose();
    await rm(dir, { recursive: true, force: true });
  });
});

describe('Tipping the KJ', () => {
  const setup = () => {
    let t = 1_000_000;
    const show = new Show({ now: () => t, resolveLocal: () => undefined, onChange: () => {}, onPlayerCommand: () => {} });
    show.updateSettings({ tipLink: 'https://venmo.com/u/dj-matt', autoAdvance: false, autoStartSec: 0 });
    const sing = (singerId: string, id: string, seconds: number, how: 'end' | 'skip' = 'end') => {
      show.addEntry(singerId, yt(id, `Song ${id}`), { fromPhone: true });
      show.callNext();
      show.play();
      const playId = show.state.nowPlaying!.playId;
      t += seconds * 1000;
      if (how === 'end') show.ended(playId);
      else show.skip();
    };
    return { show, sing, advance: (ms: number) => (t += ms), view: (id: string) => show.singerView(id, show.upcoming(10), false) };
  };

  it('gives phones quick-tip buttons for links that can take an amount', () => {
    const { show, view } = setup();
    const me = show.join('Robin').singer;
    expect(view(me.id).tip).toEqual({
      link: 'https://venmo.com/u/dj-matt',
      text: 'Tip your KJ',
      amounts: [1, 5, 10].map((amount) => ({ amount, link: `https://venmo.com/dj-matt?txn=pay&amount=${amount}&note=Karaoke%20tip` })),
    });
    show.updateSettings({ tipAmounts: [20, 3] });
    expect(view(me.id).tip!.amounts.map((a) => a.amount)).toEqual([3, 20]);
    // A link that can't take an amount gets just the one button.
    show.updateSettings({ tipLink: 'https://ko-fi.com/djmatt' });
    expect(view(me.id).tip!.amounts).toEqual([]);
  });

  it('thanks a singer once their song ends, for a while, and only if they really sang', () => {
    const { show, sing, advance, view } = setup();
    const robin = show.join('Robin').singer;
    const sam = show.join('Sam').singer;
    expect(view(robin.id).tipPrompt).toBeUndefined();

    sing(robin.id, 'a', 200);
    const prompt = view(robin.id).tipPrompt;
    expect(prompt).toMatchObject({ title: 'Song a' });
    // Only the singer sees it.
    expect(view(sam.id).tipPrompt).toBeUndefined();
    // It stays through other people's songs, then goes after ten minutes.
    sing(sam.id, 'b', 120);
    expect(view(robin.id).tipPrompt).toEqual(prompt);
    advance(10 * 60_000);
    expect(view(robin.id).tipPrompt).toBeUndefined();

    // Cut off within a minute: not asked. Cut off later: asked.
    sing(robin.id, 'c', 20, 'skip');
    expect(view(robin.id).tipPrompt).toBeUndefined();
    sing(robin.id, 'd', 90, 'skip');
    expect(view(robin.id).tipPrompt).toMatchObject({ title: 'Song d' });

    // While they're up again, it waits.
    show.addEntry(robin.id, yt('e'), { fromPhone: true });
    show.callNext();
    expect(view(robin.id).tipPrompt).toBeUndefined();
    show.skip();

    // The KJ can turn it off, and it's never there without a tip link.
    show.updateSettings({ tipAfterSong: false });
    expect(view(robin.id).tipPrompt).toBeUndefined();
    show.updateSettings({ tipAfterSong: true, tipLink: '' });
    expect(view(robin.id).tipPrompt).toBeUndefined();
  });
});
