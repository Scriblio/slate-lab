// "You're up" alerts for phones that are locked or in a pocket. A phone that
// joined through the online link can subscribe (Web Push); the laptop then
// sends the alert itself when that singer is next, and again when they're
// called to the stage. See webpush.ts for the protocol.
//
// Subscriptions are kept for tonight's show only: they're dropped when the
// singer leaves, when the KJ starts a new show, or when the phone's push
// service says the subscription has ended.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ShowState, UpcomingItem } from '../shared/types.ts';
import { UserError } from './show.ts';
import {
  generateVapidKeys,
  importVapidKeys,
  parseSubscription,
  sendPush,
  type PushSubscriptionData,
  type SavedVapidKeys,
  type VapidKeys,
} from './webpush.ts';

export type TurnKind = 'next' | 'called';

export interface TurnAlert {
  singerId: string;
  kind: TurnKind;
  /** Changes with each new turn: the call-up's playId, or the entry that's next. */
  key: string;
  songTitle: string;
}

/** What the notification says. `url` reopens the join page on tonight's show. */
export interface TurnMessage {
  kind: TurnKind;
  title: string;
  body: string;
  url?: string;
}

/** Who should be alerted right now: the singer being called up, and whoever is next. */
export function turnAlerts(state: ShowState, list: UpcomingItem[]): TurnAlert[] {
  const alerts: TurnAlert[] = [];
  const np = state.nowPlaying;
  if (np?.stage === 'intro') alerts.push({ singerId: np.entry.singerId, kind: 'called', key: np.playId, songTitle: np.entry.song.title });
  const next = list[0];
  if (next && next.singer.status === 'active' && next.singer.id !== np?.entry.singerId) {
    alerts.push({ singerId: next.singer.id, kind: 'next', key: next.entry.id, songTitle: next.entry.song.title });
  }
  return alerts;
}

export function turnMessage(alert: TurnAlert, url?: string): TurnMessage {
  return alert.kind === 'called'
    ? { kind: 'called', title: 'It’s your turn!', body: `Head to the stage for “${alert.songTitle}”.`, url }
    : { kind: 'next', title: 'You’re up next!', body: `Get ready to sing “${alert.songTitle}” and stay close to the stage.`, url };
}

/** How long a push service may hold each alert for a phone that's offline. */
const TTL: Record<TurnKind, number> = { next: 10 * 60, called: 5 * 60 };
/** Someone dragged around the list shouldn't get buzzed over and over. */
const NEXT_COOLDOWN_MS = 2 * 60_000;

export interface PushNotifierOptions {
  /** Where push.json (the signing key) and tonight's subscriptions live; omit for tests. */
  dataDir?: string;
  /** VAPID subject: the join page's origin. */
  subject: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (...args: unknown[]) => void;
}

interface SavedSubscriptions {
  showId: string;
  subs: Record<string, PushSubscriptionData>;
}

export class PushNotifier {
  private vapid: VapidKeys | undefined;
  private subs = new Map<string, PushSubscriptionData>();
  private showId = '';
  /** The turn each singer was last seen in, e.g. "next:<entryId>". */
  private lastTurn = new Map<string, string>();
  private lastNextAt = new Map<string, number>();
  private inFlight = new Set<Promise<void>>();
  private saving: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private opts: PushNotifierOptions) {
    this.now = opts.now ?? Date.now;
  }

  async load(showId: string): Promise<void> {
    this.showId = showId;
    const dir = this.opts.dataDir;
    if (!dir) {
      this.vapid = importVapidKeys(generateVapidKeys());
      return;
    }
    const keyFile = join(dir, 'push.json');
    let saved: SavedVapidKeys;
    try {
      saved = JSON.parse(await readFile(keyFile, 'utf8')) as SavedVapidKeys;
      this.vapid = importVapidKeys(saved);
    } catch {
      saved = generateVapidKeys();
      await mkdir(dir, { recursive: true });
      await writeFile(keyFile, JSON.stringify(saved), { mode: 0o600 });
      this.vapid = importVapidKeys(saved);
    }
    try {
      const file = JSON.parse(await readFile(join(dir, 'push-subscriptions.json'), 'utf8')) as SavedSubscriptions;
      if (file.showId === showId) {
        for (const [id, raw] of Object.entries(file.subs ?? {})) {
          const sub = parseSubscription(raw);
          if (sub) this.subs.set(id, sub);
        }
      }
    } catch {
      // none saved yet
    }
  }

  /** The key phones subscribe with (VAPID public key, base64url). */
  get publicKey(): string {
    if (!this.vapid) throw new Error('PushNotifier.load() has not run.');
    return this.vapid.publicKey;
  }

  has(singerId: string): boolean {
    return this.subs.has(singerId);
  }

  get count(): number {
    return this.subs.size;
  }

  subscribe(singerId: string, raw: unknown): void {
    const sub = parseSubscription(raw);
    if (!sub) throw new UserError('This browser’s alerts can’t be used here.');
    this.subs.set(singerId, sub);
    this.persist();
  }

  unsubscribe(singerId: string): void {
    if (this.subs.delete(singerId)) this.persist();
  }

  /** The KJ merged a duplicate into the real singer: their phone's alerts come along. */
  transfer(fromId: string, intoId: string): void {
    const sub = this.subs.get(fromId);
    if (!sub) return;
    this.subs.delete(fromId);
    if (!this.subs.has(intoId)) this.subs.set(intoId, sub);
    this.persist();
  }

  /** Forget everyone who isn't on the list any more. */
  retain(singerIds: Set<string>): void {
    let changed = false;
    for (const id of this.subs.keys()) {
      if (!singerIds.has(id)) {
        this.subs.delete(id);
        changed = true;
      }
    }
    for (const id of this.lastTurn.keys()) if (!singerIds.has(id)) this.lastTurn.delete(id);
    if (changed) this.persist();
  }

  /** A new show: nobody is subscribed any more. */
  reset(showId: string): void {
    this.showId = showId;
    this.subs.clear();
    this.lastTurn.clear();
    this.lastNextAt.clear();
    this.persist();
  }

  /**
   * Called on every change to the show. Sends an alert when a subscribed
   * singer moves into a new turn (next, or called up), once per turn.
   */
  update(alerts: TurnAlert[], url?: string): void {
    const now = this.now();
    const current = new Map(alerts.map((a) => [a.singerId, a]));
    for (const id of this.lastTurn.keys()) if (!current.has(id)) this.lastTurn.delete(id);
    for (const alert of alerts) {
      const turn = `${alert.kind}:${alert.key}`;
      if (this.lastTurn.get(alert.singerId) === turn) continue;
      this.lastTurn.set(alert.singerId, turn);
      const sub = this.subs.get(alert.singerId);
      if (!sub) continue;
      if (alert.kind === 'next') {
        if (now - (this.lastNextAt.get(alert.singerId) ?? -Infinity) < NEXT_COOLDOWN_MS) continue;
        this.lastNextAt.set(alert.singerId, now);
      }
      this.send(alert.singerId, sub, turnMessage(alert, url), alert.kind);
    }
  }

  private send(singerId: string, sub: PushSubscriptionData, message: TurnMessage, kind: TurnKind): void {
    const run = sendPush(sub, message, {
      vapid: this.vapid!,
      subject: this.opts.subject,
      ttl: TTL[kind],
      topic: 'encore-turn',
      fetchImpl: this.opts.fetchImpl,
      now: this.now(),
    })
      .then((res) => {
        if (res.gone && this.subs.get(singerId) === sub) this.unsubscribe(singerId);
        else if (!res.ok) this.opts.log?.(`  Lock-screen alert not delivered (push service answered ${res.status}).`);
      })
      .catch((err: Error) => this.opts.log?.(`  Lock-screen alert not sent: ${err.message}`));
    this.inFlight.add(run);
    void run.finally(() => this.inFlight.delete(run));
  }

  /** Wait for alerts being sent right now (tests, shutdown). */
  async settle(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }

  /** Saves run one at a time, each writing the latest list, so two never race on the file. */
  private persist(): void {
    const dir = this.opts.dataDir;
    if (!dir) return;
    const file = join(dir, 'push-subscriptions.json');
    const run = async () => {
      const data: SavedSubscriptions = { showId: this.showId, subs: Object.fromEntries(this.subs) };
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
      await rename(tmp, file);
    };
    this.saving = this.saving.then(run, run).catch((err: Error) => this.opts.log?.(`  Could not save alert subscriptions: ${err.message}`));
  }

  /** Wait for pending saves (tests, shutdown). */
  flush(): Promise<void> {
    return this.saving;
  }
}
