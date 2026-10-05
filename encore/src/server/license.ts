// The laptop's side of licensing. It holds the signed pass the license service
// gave this installation (supabase/functions/encore-license), checks it against the
// public key built into the app, and turns it into one state (src/shared/license.ts).
//
//   - The pass is saved in the data folder, so Encore starts and runs a show with no internet.
//   - It's checked on start, every 12 hours, and after sign-in, a trial or an unlock code.
//   - A pass lasts two weeks. Past that without a check-in, Encore asks to go online.
//   - The pass is bound to this installation and this account, so another laptop's
//     pass, or one for another KJ, is no use here.
//
// Nothing here decides anything from what the screens say: access comes only from a
// pass the service signed. A show that is already running is never cut off; that
// promise lives in access.ts, which asks this for the plan.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { importPassKeys, readPass, type PassKey, type PassPayload } from '../../supabase/functions/encore-license/pass.ts';
import { LICENSE_PUBLIC_KEYS } from '../shared/license-key.ts';
import { accessOf, daysLeft, stateOf, type Access, type LicenseState, type LicenseView } from '../shared/license.ts';
import { Account, OfflineError } from './account.ts';
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
}

/** What the license service answers. */
interface Reply {
  ok: boolean;
  pass?: string;
  trialAvailable?: boolean;
  trial?: 'started' | 'account' | 'install' | 'owned';
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

export class License {
  private pass: PassPayload | null = null;
  private checkedAt: number | undefined;
  private trialAvailable = false;
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

  /** Check in now (if signed in) and every 12 hours. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), CHECK_EVERY);
    this.timer.unref?.();
    void this.refresh();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
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
      ...(p?.trialUntil ? { trialEndsAt: p.trialUntil } : {}),
      ...(state === 'trial' && trialEnds !== undefined ? { trialDaysLeft: daysLeft(trialEnds, now) } : {}),
      ...(p?.source && state !== 'offline-expired' ? { source: p.source } : {}),
      ...(this.trialAvailable && this.opts.account.signedIn && !hasApp ? { trialAvailable: true } : {}),
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
      if (message && typeof message === 'string' && res.status < 500) throw new UserError(message, reply?.code);
      throw new UserError(res.status === 503 ? 'Encore’s license service isn’t switched on yet.' : 'Encore’s license service had a problem. Try again in a minute.', 'server');
    }
    await this.accept(reply);
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
    await this.save(reply.pass!);
    // A computer clock far ahead of the real time would make every fresh pass look too old.
    if (this.clock() >= pass.exp * 1000) {
      throw new UserError('This computer’s date and time look wrong, so Encore can’t tell if your license is current. Fix the clock in Windows and try again.', 'clock');
    }
  }

  private async save(token: string): Promise<void> {
    const saved: Saved = { pass: token, checkedAt: this.checkedAt ?? this.clock(), trialAvailable: this.trialAvailable };
    await mkdir(this.opts.dataDir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(saved), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  /** Forget the pass (signed out, or it was another account's). */
  private async forget(): Promise<void> {
    this.pass = null;
    this.checkedAt = undefined;
    this.trialAvailable = false;
    this.problem = undefined;
    await rm(this.file, { force: true });
  }
}
