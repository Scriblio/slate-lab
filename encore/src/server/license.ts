// The laptop's side of licensing. It holds the signed pass the license service
// gave this installation (supabase/functions/encore-license), checks it against the
// public key built into the app, and turns it into one state (src/shared/license.ts).
//
//   - The pass is saved in the data folder, so Encore starts and runs a show with no internet.
//   - It's checked on start, every 12 hours, and after sign-in, a trial or an unlock code.
//   - A pass lasts two weeks. Past that without a check-in, Encore asks to go online.
//   - The pass is bound to this installation and this account, so another laptop's
//     pass, or one for another KJ, is no use here.
//   - Buying is Stripe's page in the KJ's own browser. This only asks the service for the
//     page's address, then looks every few seconds for the purchase to go through and
//     picks up the new pass. Nothing is unlocked by opening a page, or by a screen saying so.
//
// Nothing here decides anything from what the screens say: access comes only from a
// pass the service signed. A show that is already running is never cut off; that
// promise lives in access.ts, which asks this for the plan.

import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { importPassKeys, readPass, type PassKey, type PassPayload } from '../../supabase/functions/encore-license/pass.ts';
import { stripePage } from '../../supabase/functions/encore-license/stripe.ts';
import { LICENSE_PUBLIC_KEYS } from '../shared/license-key.ts';
import { accessOf, daysLeft, stateOf, type Access, type LicenseState, type LicenseView } from '../shared/license.ts';
import { Account, OfflineError } from './account.ts';
import { writeFileAtomic } from './atomicfile.ts';
import { UserError } from './show.ts';

export interface LicenseOptions {
  dataDir: string;
  /** This installation's id (config.installId): the pass is made out to it. */
  installId: string;
  account: Account;
  /** The license service, e.g. https://<ref>.supabase.co/functions/v1/encore-license */
  functionUrl: string;
  /** The project's publishable key. */
  key: string;
  /** The keys a pass may be signed by. */
  publicKeys?: readonly { kid: string; key: string }[];
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (text: string) => void;
  /** The plan may have changed. */
  onChange?: () => void;
  /** After a payment page is opened: how often to look for the purchase, and for how long (defaults: 10 seconds, 15 minutes). */
  watchEveryMs?: number;
  watchForMs?: number;
}

/** What the license service answers. */
interface Reply {
  ok: boolean;
  pass?: string;
  trialAvailable?: boolean;
  trial?: 'started' | 'account' | 'install' | 'owned';
  /** Payments are switched on, Encore Monthly can be offered, and this account has a Stripe billing page. */
  payments?: boolean;
  monthly?: boolean;
  billing?: boolean;
  /** The address of a payment page (checkout and portal answers). */
  url?: string;
  error?: string;
  code?: string;
}

interface Saved {
  pass: string;
  /** When it was last checked online, ms since 1970. */
  checkedAt: number;
  trialAvailable: boolean;
}

const CHECK_EVERY = 12 * 60 * 60 * 1000;
const WATCH_EVERY = 10_000;
const WATCH_FOR = 15 * 60_000;

export class License {
  private pass: PassPayload | null = null;
  private checkedAt: number | undefined;
  private trialAvailable = false;
  /** The service says payments are switched on / this account has a billing page. Learned from every answer, not saved. */
  private payments = false;
  private monthly = false;
  private billing = false;
  /** A payment page was opened, and we're looking for the purchase to go through. */
  private watch: { timer: ReturnType<typeof setInterval>; until: number; before: string; looking: boolean } | undefined;
  /** The last thing that went wrong, in plain words, until something works. */
  private problem: string | undefined;
  private keys: PassKey[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly clock: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(private opts: LicenseOptions) {
    this.clock = opts.now ?? Date.now;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private get file(): string {
    return join(this.opts.dataDir, 'license.json');
  }

  /** Read what was saved, and trust it only if it's a good pass made out to this installation. */
  async load(): Promise<void> {
    this.keys = await importPassKeys(this.opts.publicKeys ?? LICENSE_PUBLIC_KEYS);
    await this.opts.account.load();
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as Partial<Saved>;
      const pass = typeof saved.pass === 'string' ? await readPass(saved.pass, this.keys) : null;
      if (pass && this.isMine(pass)) {
        this.pass = pass;
        this.checkedAt = Number.isFinite(saved.checkedAt) ? saved.checkedAt : undefined;
        this.trialAvailable = Boolean(saved.trialAvailable);
      }
    } catch {
      // nothing saved, or not readable: just as if there was no pass
    }
  }

  /** Check in now (if signed in) and every 12 hours. Resolves when that first check is done and its pass is kept. */
  start(): Promise<void> {
    if (this.timer) return Promise.resolve();
    this.timer = setInterval(() => void this.refresh(), CHECK_EVERY);
    this.timer.unref?.();
    return this.refresh();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.stopWatching();
  }

  // --- what the pass means ----------------------------------------------------------------

  /** The time, as far as the pass can tell: never before it was made, so turning the clock back doesn't help. */
  now(): number {
    return Math.max(this.clock(), (this.pass?.iat ?? 0) * 1000);
  }

  state(): LicenseState {
    return stateOf(this.pass, this.now());
  }

  access(): Access {
    return accessOf(this.pass, this.now());
  }

  view(): Omit<LicenseView, 'showOpen'> {
    const now = this.now();
    const state = stateOf(this.pass, now);
    const p = this.pass;
    const trialEnds = p?.trialUntil ? Date.parse(p.trialUntil) : undefined;
    const hasApp = state === 'owner' || state === 'licensed';
    return {
      state,
      ...(p?.email || this.opts.account.email ? { email: p?.email ?? this.opts.account.email } : {}),
      app: hasApp,
      cloud: accessOf(p, now).cloud,
      ...(state === 'licensed' && p?.cloudUntil ? { cloudUntil: p.cloudUntil } : {}),
      ...(state === 'licensed' && p?.appUntil ? { appUntil: p.appUntil } : {}),
      ...(p?.trialUntil ? { trialEndsAt: p.trialUntil } : {}),
      ...(state === 'trial' && trialEnds !== undefined ? { trialDaysLeft: daysLeft(trialEnds, now) } : {}),
      ...(p?.source && state !== 'offline-expired' ? { source: p.source } : {}),
      ...(this.trialAvailable && this.opts.account.signedIn && !hasApp ? { trialAvailable: true } : {}),
      ...(this.payments && this.opts.account.signedIn ? { payments: true } : {}),
      ...(this.payments && this.monthly && this.opts.account.signedIn ? { monthly: true } : {}),
      ...(this.billing && this.opts.account.signedIn ? { billing: true } : {}),
      ...(this.watch ? { buying: true } : {}),
      ...(this.checkedAt ? { checkedAt: new Date(this.checkedAt).toISOString() } : {}),
      ...(p ? { validUntil: new Date(p.exp * 1000).toISOString() } : {}),
      ...(this.problem ? { problem: this.problem } : {}),
    };
  }

  // --- what the KJ can do ---------------------------------------------------------------------

  sendCode(email: string): Promise<void> {
    return this.opts.account.sendCode(email);
  }

  /** Sign in with the emailed code. A new account's free trial starts right away. */
  signIn(email: string, code: string): Promise<void> {
    return this.changing(async () => {
      const session = await this.opts.account.verify(email, code);
      // A different account than before: the old pass isn't theirs.
      if (this.pass && this.pass.sub !== session.userId) await this.forget();
      this.problem = undefined;
      await this.refresh();
      if (this.trialAvailable) await this.startTrial().catch((err: Error) => this.fail(err));
    });
  }

  signOut(): Promise<void> {
    return this.changing(async () => {
      await this.opts.account.signOut();
      await this.forget();
    });
  }

  /** Start the free trial, if this account and this laptop haven't had one. */
  startTrial(): Promise<void> {
    return this.changing(async () => {
      const reply = await this.ask({ action: 'startTrial' });
      if (reply.trial === 'install') this.problem = 'This computer has already had a free trial, under another email.';
      else if (reply.trial === 'account') this.problem = 'This account has already had its free trial.';
    });
  }

  /** Use an unlock code. Throws, in plain words, if it won't work. */
  redeem(code: string): Promise<void> {
    return this.changing(async () => {
      await this.ask({ action: 'redeem', code: String(code ?? '') });
      this.problem = undefined;
    });
  }

  /**
   * Ask the service what this account has now. In the background, trouble is only noted
   * (the saved pass carries on); with `report`, the KJ asked, so it's thrown to them.
   */
  refresh(opts: { report?: boolean } = {}): Promise<void> {
    return this.changing(async () => {
      if (!this.opts.account.signedIn) return;
      try {
        await this.ask({ action: 'status' });
        this.problem = undefined;
      } catch (err) {
        this.fail(err as Error);
        if (opts.report) throw err;
      }
    });
  }

  // --- paying ---------------------------------------------------------------------------------

  /**
   * The address of a Stripe page to buy Encore, subscribe to Encore Monthly, or add a year of Cloud, on.
   * The KJ pays there, in their own browser; meanwhile this looks every few seconds for the purchase to go through.
   */
  async checkout(kind: 'app' | 'cloud' | 'monthly'): Promise<string> {
    const url = this.pageOf(await this.call({ action: 'checkout', kind }));
    this.watchPurchase();
    return url;
  }

  /** The address of Stripe's page for seeing payments, changing a card or cancelling Cloud. */
  async billingPortal(): Promise<string> {
    return this.pageOf(await this.call({ action: 'portal' }));
  }

  /**
   * One look for a purchase going through. True once the plan has changed; the watch ends then,
   * or when the time is up or the KJ has signed out, and the screens are told.
   */
  async checkPurchase(): Promise<boolean> {
    const watch = this.watch;
    if (!watch || watch.looking) return false;
    if (this.clock() >= watch.until || !this.opts.account.signedIn) {
      this.stopWatching();
      this.opts.onChange?.();
      return false;
    }
    watch.looking = true;
    let changed = false;
    try {
      await this.ask({ action: 'status' });
      changed = this.planKey() !== watch.before;
    } catch {
      // no internet for a moment, say: the next look tries again
    } finally {
      watch.looking = false;
    }
    if (changed) {
      this.stopWatching();
      this.problem = undefined;
      this.opts.onChange?.();
    }
    return changed;
  }

  /** Only a page that is really Stripe's goes to the browser. */
  private pageOf(reply: Reply): string {
    try {
      return stripePage(reply.url);
    } catch {
      throw new UserError('Encore got a payment page it couldn’t trust, so it didn’t open it. Update Encore and try again.', 'bad-page');
    }
  }

  private watchPurchase(): void {
    this.stopWatching();
    const timer = setInterval(() => void this.checkPurchase(), this.opts.watchEveryMs ?? WATCH_EVERY);
    timer.unref?.();
    this.watch = { timer, until: this.clock() + (this.opts.watchForMs ?? WATCH_FOR), before: this.planKey(), looking: false };
    this.opts.onChange?.();
  }

  private stopWatching(): void {
    if (this.watch) clearInterval(this.watch.timer);
    this.watch = undefined;
  }

  /** What a purchase changes: whether Encore is theirs, and until when Cloud (or a subscription) lasts. */
  private planKey(): string {
    return `${this.pass?.app}|${this.pass?.cloudUntil}|${this.pass?.appUntil}|${this.pass?.owner}|${this.pass?.source}`;
  }

  // --- inside --------------------------------------------------------------------------------

  /** Whatever happens, even a failure, the screens are told to look again: the pass may have just gone stale or been forgotten. */
  private async changing<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } finally {
      this.opts.onChange?.();
    }
  }

  private isMine(pass: PassPayload): boolean {
    return pass.installId === this.opts.installId && (!this.opts.account.userId || pass.sub === this.opts.account.userId);
  }

  private fail(err: Error): void {
    this.opts.log?.(`  License check: ${err.message}`);
    if (err instanceof OfflineError) {
      this.problem = this.pass
        ? `Couldn’t reach Encore to check your license. What this laptop has is good until ${new Date(this.pass.exp * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}.`
        : err.message;
    } else this.problem = err.message;
  }

  /** One question to the license service, and the pass in the answer kept. */
  private async ask(body: Record<string, unknown>): Promise<Reply> {
    const reply = await this.call(body);
    await this.accept(reply);
    return reply;
  }

  /** One question to the license service: its answer, or the reason in plain words that there isn't one. */
  private async call(body: Record<string, unknown>): Promise<Reply> {
    const account = this.opts.account;
    let token = await account.accessToken();
    if (!token) {
      if (!account.signedIn) await this.forget(); // the session ended since we last looked
      throw new UserError('Sign in to Encore first.', 'signed-out');
    }
    let res = await this.post(token, body);
    if (res.status === 401) {
      // The service doesn't accept that token: get a fresh one once, and if the session is over, say so.
      token = (await account.renew())?.accessToken ?? null;
      if (!token) {
        await this.forget();
        throw new UserError('You’ve been signed out. Sign in again.', 'signed-out');
      }
      res = await this.post(token, body);
    }
    const reply = res.json;
    if (!reply?.ok) {
      const message = reply?.error;
      // A reply that isn't ours (an outage page, say) is a hiccup; one of ours is the answer the KJ should hear.
      // ("Buying isn't switched on" is ours too, though it comes with a 503 like "licensing isn't switched on".)
      if (message && typeof message === 'string' && (res.status < 500 || reply?.code === 'payments-off')) throw new UserError(message, reply?.code);
      throw new UserError(res.status === 503 ? 'Encore’s license service isn’t switched on yet.' : 'Encore’s license service had a problem. Try again in a minute.', 'server');
    }
    return reply;
  }

  private async post(token: string, body: Record<string, unknown>): Promise<{ status: number; json: Reply | null }> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.functionUrl, {
        method: 'POST',
        headers: { apikey: this.opts.key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installId: this.opts.installId, ...body }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new OfflineError();
    }
    const json = (await res.json().catch(() => null)) as Reply | null;
    return { status: res.status, json: json && typeof json === 'object' ? json : null };
  }

  /** Keep a pass from the service, if it's good and meant for this laptop and this account. */
  private async accept(reply: Reply): Promise<void> {
    const pass = typeof reply.pass === 'string' ? await readPass(reply.pass, this.keys) : null;
    if (!pass || !this.isMine(pass)) throw new UserError('Encore’s license service gave an answer this copy of Encore couldn’t check. Update Encore and try again.', 'bad-pass');
    this.pass = pass;
    this.checkedAt = this.clock();
    this.trialAvailable = Boolean(reply.trialAvailable);
    this.payments = Boolean(reply.payments);
    this.monthly = Boolean(reply.monthly);
    this.billing = Boolean(reply.billing);
    await this.save(reply.pass!);
    // A computer clock far ahead of the real time would make every fresh pass look too old.
    if (this.clock() >= pass.exp * 1000) {
      throw new UserError('This computer’s date and time look wrong, so Encore can’t tell if your license is current. Fix the clock in Windows and try again.', 'clock');
    }
  }

  private async save(token: string): Promise<void> {
    const saved: Saved = { pass: token, checkedAt: this.checkedAt ?? this.clock(), trialAvailable: this.trialAvailable };
    await mkdir(this.opts.dataDir, { recursive: true });
    await writeFileAtomic(this.file, JSON.stringify(saved), { mode: 0o600 });
  }

  /** Forget the pass (signed out, or it was another account's). */
  private async forget(): Promise<void> {
    this.stopWatching();
    this.pass = null;
    this.checkedAt = undefined;
    this.trialAvailable = false;
    this.payments = false;
    this.monthly = false;
    this.billing = false;
    this.problem = undefined;
    await rm(this.file, { force: true });
  }
}
