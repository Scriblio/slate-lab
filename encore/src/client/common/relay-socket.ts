// The phone end of the online join link. Looks enough like a Socket.IO
// client (on / off / emit with acks / connect + disconnect events) that the
// singer app runs on it unchanged. See src/shared/relay.ts for the protocol.

import {
  deriveSessionKeys,
  generateKeyPair,
  hostTopic,
  open,
  phoneTopic,
  randomId,
  seal,
  type JoinTarget,
  type RelayTransport,
  type SessionKeys,
} from '../../shared/relay.ts';

type Listener = (...args: unknown[]) => void;

const PING_EVERY = 20_000;
const HELLO_EVERY = 4_000;
const SILENCE_LIMIT = 45_000;
const GIVE_UP_FIRST = 12_000;

export class RelaySocket {
  connected = false;
  private listeners = new Map<string, Set<Listener>>();
  private readonly sid = randomId(16);
  private keys: SessionKeys | undefined;
  private publicKey = '';
  private sent = 0;
  private lastSent = 0;
  private lastHeard = 0;
  private startedAt = Date.now();
  private epoch = 0;
  private seen = new Set<number>();
  private lastViewN = 0;
  private ackSeq = 0;
  private acks = new Map<number, (res: unknown) => void>();
  private queue: { ev: string; args: unknown[]; ack?: (res: unknown) => void }[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private closed = false;
  private reportedOffline = false;
  /** Last connection error, replayed to listeners that attach after it fired. */
  private lastError: Error | undefined;

  constructor(
    private transport: RelayTransport,
    private target: JoinTarget,
  ) {
    void this.start();
  }

  private async start(): Promise<void> {
    if (!globalThis.crypto?.subtle) {
      this.fail(new Error('This browser can’t open the secure link. Update it, or join on the venue Wi-Fi instead.'));
      return;
    }
    try {
      const pair = await generateKeyPair();
      this.publicKey = pair.publicKey;
      this.keys = await deriveSessionKeys(pair.privateKey, this.target.hostKey, this.target.room);
    } catch {
      this.fail(new Error('This QR code link is damaged. Scan it again.'));
      return;
    }
    this.unsubscribe = this.transport.subscribe(
      phoneTopic(this.target.room, this.sid),
      'h',
      (payload) => void this.receive(payload),
      (online) => online && void this.post({ t: 'hello' }),
    );
    this.timer = setInterval(() => this.tick(), 1000);
  }

  private tick(): void {
    const now = Date.now();
    if (this.connected) {
      if (now - this.lastHeard > SILENCE_LIMIT) {
        this.connected = false;
        this.fire('disconnect', 'transport close');
      } else if (now - this.lastSent > PING_EVERY) void this.post({ t: 'ping' });
      return;
    }
    if (now - this.lastSent > HELLO_EVERY) void this.post({ t: 'hello' });
    if (!this.reportedOffline && now - this.startedAt > GIVE_UP_FIRST) {
      this.reportedOffline = true;
      this.fail(new Error('The KJ’s laptop isn’t answering.'));
    }
  }

  private fail(err: Error): void {
    this.lastError = err;
    this.fire('connect_error', err);
  }

  private async post(msg: Record<string, unknown>): Promise<void> {
    if (!this.keys || this.closed) return;
    this.lastSent = Date.now();
    const box = await seal(this.keys.up, { ...msg, n: ++this.sent });
    this.transport.publish(hostTopic(this.target.room), 'p', { s: this.sid, k: this.publicKey, ...box });
  }

  private async receive(payload: unknown): Promise<void> {
    if (!this.keys || !payload || typeof payload !== 'object') return;
    let msg: { e: number; n: number; t: string; id?: number; res?: unknown; ev?: string; data?: unknown };
    try {
      msg = await open(this.keys.down, payload as { iv: string; ct: string });
    } catch {
      return;
    }
    if (typeof msg.n !== 'number' || typeof msg.e !== 'number') return;
    if (msg.e !== this.epoch) {
      // Only a welcome may start a new, later epoch (the laptop reconnected
      // us); anything else from another epoch is stale or replayed.
      if (msg.t !== 'welcome' || msg.e < this.epoch) return;
      this.epoch = msg.e;
      this.seen.clear();
      this.lastViewN = 0;
    }
    if (this.seen.has(msg.n)) return;
    this.seen.add(msg.n);
    if (this.seen.size > 1000) this.seen = new Set([...this.seen].slice(-500));
    this.lastHeard = Date.now();
    switch (msg.t) {
      case 'welcome': {
        // A welcome after we were already connected means the laptop started
        // a fresh connection for us (it restarted): reconnect like Socket.IO.
        if (this.connected) this.fire('disconnect', 'server restart');
        this.connected = true;
        this.reportedOffline = false;
        this.lastError = undefined;
        this.fire('connect');
        const queued = this.queue.splice(0);
        for (const q of queued) this.send(q.ev, q.args, q.ack);
        break;
      }
      case 'ack':
        if (typeof msg.id === 'number') {
          this.acks.get(msg.id)?.(msg.res);
          this.acks.delete(msg.id);
        }
        break;
      case 'ev':
        if (typeof msg.ev !== 'string') return;
        // Views are full snapshots; drop one that arrives after a newer one.
        if (msg.ev === 'singer:view') {
          if (msg.n < this.lastViewN) return;
          this.lastViewN = msg.n;
        }
        this.fire(msg.ev, msg.data);
        break;
    }
  }

  private send(ev: string, args: unknown[], ack?: (res: unknown) => void): void {
    let id: number | undefined;
    if (ack) {
      id = ++this.ackSeq;
      this.acks.set(id, ack);
    }
    void this.post({ t: 'emit', ev, args, ...(id !== undefined ? { id } : {}) });
  }

  // --- the Socket.IO-like surface --------------------------------------------------

  on(event: string, fn: Listener): this {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn);
    // The app may attach its listeners after an early failure; don't let
    // that leave it showing "Connecting…" forever.
    const err = this.lastError;
    if (event === 'connect_error' && err && !this.connected) queueMicrotask(() => set!.has(fn) && fn(err));
    return this;
  }

  off(event: string, fn?: Listener): this {
    if (fn) this.listeners.get(event)?.delete(fn);
    else this.listeners.delete(event);
    return this;
  }

  emit(event: string, ...args: unknown[]): this {
    const ack = typeof args.at(-1) === 'function' ? (args.pop() as (res: unknown) => void) : undefined;
    if (this.connected) this.send(event, args, ack);
    else this.queue.push({ ev: event, args, ack });
    return this;
  }

  disconnect(): this {
    if (this.closed) return this;
    void this.post({ t: 'bye' });
    this.closed = true;
    clearInterval(this.timer);
    this.unsubscribe?.();
    setTimeout(() => this.transport.close(), 500);
    if (this.connected) {
      this.connected = false;
      this.fire('disconnect', 'io client disconnect');
    }
    return this;
  }

  private fire(event: string, ...args: unknown[]): void {
    for (const fn of [...(this.listeners.get(event) ?? [])]) fn(...args);
  }
}
