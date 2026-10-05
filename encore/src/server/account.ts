// The KJ's sign-in. The laptop's server talks to Supabase Auth: a 6-digit code is
// emailed and typed into Encore (a link would open a browser instead of the app),
// and the session is kept in the data folder, like relay.json. The console never
// talks to Supabase Auth itself; it asks the server over the DJ socket.
//
// Talks to Auth's REST endpoints directly rather than through supabase-js: it needs
// four calls, and this keeps the app free of another dependency.
//
//   POST /auth/v1/otp                           email a code (creating the account the first time)
//   POST /auth/v1/verify                        trade email + code for a session
//   POST /auth/v1/token?grant_type=refresh_token  a new session from the refresh token
//   POST /auth/v1/logout?scope=local            end this session

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UserError } from './show.ts';

export interface Session {
  userId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  /** When the access token stops working, ms since 1970. */
  expiresAt: number;
}

export interface AccountOptions {
  dataDir: string;
  /** The Supabase project, e.g. https://<ref>.supabase.co */
  url: string;
  /** Its publishable key. */
  key: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** No answer from Encore's servers: not a reason to sign anyone out. */
export class OfflineError extends UserError {
  constructor() {
    super('Couldn’t reach Encore’s servers. Is this laptop online?', 'offline');
  }
}

interface AuthReply {
  status: number;
  json: Record<string, unknown> | null;
}

/** Auth's own words for "this refresh token is finished": the session is over, not just unreachable. */
const SESSION_OVER = new Set(['refresh_token_not_found', 'refresh_token_already_used', 'session_not_found', 'session_expired', 'invalid_grant']);

export const looksLikeEmail = (s: string) => s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

export class Account {
  private session: Session | undefined;
  /** Only one refresh at a time: a refresh token works once, so two at once would end the session. */
  private refreshing: Promise<Session | null> | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private opts: AccountOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  private get file(): string {
    return join(this.opts.dataDir, 'account.json');
  }

  async load(): Promise<void> {
    try {
      const s = JSON.parse(await readFile(this.file, 'utf8')) as Partial<Session>;
      if (typeof s.userId === 'string' && typeof s.email === 'string' && typeof s.accessToken === 'string' && typeof s.refreshToken === 'string' && Number.isFinite(s.expiresAt)) {
        this.session = s as Session;
      }
    } catch {
      // not signed in
    }
  }

  get email(): string | undefined {
    return this.session?.email;
  }

  get userId(): string | undefined {
    return this.session?.userId;
  }

  get signedIn(): boolean {
    return Boolean(this.session);
  }

  /** Email a sign-in code. The first time, this also makes the account. */
  async sendCode(rawEmail: string): Promise<void> {
    const email = String(rawEmail ?? '').trim().toLowerCase();
    if (!looksLikeEmail(email)) throw new UserError('That doesn’t look like an email address.', 'bad-email');
    const { status, json } = await this.call('/otp', { email, create_user: true });
    if (status >= 200 && status < 300) return;
    throw new UserError(this.sendProblem(status, json), status === 429 ? 'rate-limit' : 'send-failed');
  }

  /** Trade the emailed code for a session. */
  async verify(rawEmail: string, rawCode: string): Promise<Session> {
    const email = String(rawEmail ?? '').trim().toLowerCase();
    const token = String(rawCode ?? '').replace(/\D/g, '');
    if (!looksLikeEmail(email)) throw new UserError('That doesn’t look like an email address.', 'bad-email');
    if (token.length < 6 || token.length > 10) throw new UserError('Type the code from the email (it’s 6 digits).', 'bad-code');
    const { status, json } = await this.call('/verify', { email, token, type: 'email' });
    if (status >= 200 && status < 300 && json) return this.keep(json, email);
    if (status === 429) throw new UserError('Too many tries. Wait a minute, then try again.', 'rate-limit');
    if (status >= 500) throw new UserError('Encore’s sign-in service had a problem. Try again in a minute.', 'server');
    throw new UserError('That code didn’t work. It may have been typed wrong or have expired. Send a new code and try again.', 'bad-code');
  }

  /** A working access token, renewed if it's about to stop. Null when signed out (or the session has ended). */
  async accessToken(): Promise<string | null> {
    if (!this.session) return null;
    if (this.session.expiresAt - this.now() > 60_000) return this.session.accessToken;
    return (await this.renew())?.accessToken ?? null;
  }

  /** Renew the session now, even if the token still has time (the server turned it down). Null if it has ended. */
  renew(): Promise<Session | null> {
    this.refreshing ??= this.refresh().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  async signOut(): Promise<void> {
    const token = this.session?.accessToken;
    this.session = undefined;
    await rm(this.file, { force: true });
    // Best effort: the session ends here either way.
    if (token) await this.call('/logout?scope=local', {}, token).catch(() => {});
  }

  // --- inside -----------------------------------------------------------------------

  private async refresh(): Promise<Session | null> {
    const current = this.session;
    if (!current) return null;
    const { status, json } = await this.call('/token?grant_type=refresh_token', { refresh_token: current.refreshToken });
    if (status >= 200 && status < 300 && json) return this.keep(json, current.email);
    const reason = String(json?.error_code ?? json?.error ?? '');
    if ((status === 400 || status === 401 || status === 403) && SESSION_OVER.has(reason)) {
      // Signed out for good (from another device, or the token was used twice): say so instead of failing quietly.
      this.session = undefined;
      await rm(this.file, { force: true });
      return null;
    }
    // Anything else (a hiccup at the server) isn't the KJ's doing, so the session stays.
    throw new OfflineError();
  }

  private async keep(json: Record<string, unknown>, fallbackEmail: string): Promise<Session> {
    const user = (json.user ?? {}) as { id?: unknown; email?: unknown };
    const accessToken = json.access_token;
    const refreshToken = json.refresh_token;
    if (typeof accessToken !== 'string' || typeof refreshToken !== 'string' || typeof user.id !== 'string') {
      throw new UserError('Encore’s sign-in service gave an answer Encore didn’t understand. Try again.', 'server');
    }
    const expiresIn = Number(json.expires_in);
    const session: Session = {
      userId: user.id,
      email: typeof user.email === 'string' && user.email ? user.email : fallbackEmail,
      accessToken,
      refreshToken,
      expiresAt: typeof json.expires_at === 'number' ? json.expires_at * 1000 : this.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
    };
    this.session = session;
    await this.save(session);
    return session;
  }

  /** Written whole to a temp file and renamed, so a crash can't leave half a session (a refresh token works once). */
  private async save(session: Session): Promise<void> {
    await mkdir(this.opts.dataDir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(session), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  private async call(path: string, body: unknown, bearer?: string): Promise<AuthReply> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.url.replace(/\/$/, '')}/auth/v1${path}`, {
        method: 'POST',
        headers: { apikey: this.opts.key, 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12_000),
      });
    } catch {
      throw new OfflineError();
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, json: json && typeof json === 'object' ? json : null };
  }

  private sendProblem(status: number, json: Record<string, unknown> | null): string {
    const reason = String(json?.error_code ?? '');
    if (status === 429 || reason.includes('rate_limit')) return 'Too many sign-in emails just now. Wait a minute, then try again.';
    if (reason === 'email_address_invalid' || reason === 'validation_failed') return 'That doesn’t look like an email address Encore can send to.';
    if (reason === 'signup_disabled' || reason === 'otp_disabled' || reason === 'email_provider_disabled') return 'Signing in by email is switched off right now. Try again later.';
    if (status >= 500) return 'Encore’s sign-in service had a problem. Try again in a minute.';
    return 'Couldn’t send the sign-in email. Check the address and try again.';
  }
}
