// A stand-in for Encore's Supabase project, for the tests of the laptop's sign-in and
// license checks. It plays Supabase Auth (emailed codes, sessions, refresh tokens that
// work once) and runs the real license service logic (supabase/functions/encore-license/core.ts)
// against an in-memory database, signing with a throwaway key. All of it answers through a
// fake `fetch`, so nothing touches the network.

import { randomBytes } from 'node:crypto';
import { handleRedeem, handleStartTrial, handleStatus, type Caller, type Deps } from '../supabase/functions/encore-license/core.ts';
import type { World } from './licenseworld.ts';

export const SUPABASE_URL = 'https://fake.supabase.test';
export const SUPABASE_KEY = 'sb_publishable_fake';
export const LICENSE_URL = `${SUPABASE_URL}/functions/v1/encore-license`;

export interface FakeCall {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  bearer: string | undefined;
}

export interface FakeSupabase {
  fetch: typeof fetch;
  /** No internet: every request fails the way a dead connection does. */
  online: boolean;
  /** Auth refuses to send more emails (it limits them). */
  emailLimited: boolean;
  calls: FakeCall[];
  /** The calls to one endpoint, such as '/auth/v1/otp'. */
  to(path: string): FakeCall[];
  /** The code in the latest email sent to this address. */
  codeFor(email: string): string;
  /** The license service stops accepting access tokens issued so far (refresh tokens still work). */
  revokeAccessTokens(): void;
  /** Every session ends, from another device say: refresh tokens stop working too. */
  endSessions(): void;
  /** The next call to the license service gets this answer instead of the real one. */
  overrideLicense(reply: () => Response): void;
  /** Brand-new accounts made so far. */
  accounts(): Caller[];
}

interface Session {
  caller: Caller;
  ended: boolean;
}

export function fakeSupabase(opts: {
  world: World;
  signing: CryptoKey;
  kid?: string;
  /** The server's clock: session expiry and the pass's `iat`. */
  now?: () => number;
  /** How long an access token lasts (default an hour, as Auth's does). */
  accessSeconds?: number;
  deps?: Partial<Deps>;
}): FakeSupabase {
  const now = opts.now ?? Date.now;
  const accessSeconds = opts.accessSeconds ?? 3600;
  const codes = new Map<string, string>();
  const accounts = new Map<string, Caller>();
  const access = new Map<string, { session: Session; expiresAt: number }>();
  const refresh = new Map<string, { session: Session; used: boolean }>();
  const revoked = new Set<string>();
  const sessions: Session[] = [];
  let override: (() => Response) | undefined;

  const token = () => randomBytes(24).toString('base64url');
  const json = (body: unknown, status = 200) => Response.json(body, { status });

  function issue(session: Session): Response {
    const a = token();
    const r = token();
    const expiresAt = now() + accessSeconds * 1000;
    access.set(a, { session, expiresAt });
    refresh.set(r, { session, used: false });
    return json({ access_token: a, token_type: 'bearer', expires_in: accessSeconds, expires_at: Math.floor(expiresAt / 1000), refresh_token: r, user: { id: session.caller.userId, email: session.caller.email } });
  }

  const fake: FakeSupabase = {
    online: true,
    emailLimited: false,
    calls: [],
    to: (path) => fake.calls.filter((c) => c.path === path),
    codeFor(email) {
      const code = codes.get(email.toLowerCase());
      if (!code) throw new Error(`no email was sent to ${email}`);
      return code;
    },
    revokeAccessTokens() {
      for (const a of access.keys()) revoked.add(a);
    },
    endSessions() {
      for (const s of sessions) s.ended = true;
    },
    overrideLicense(reply) {
      override = reply;
    },
    accounts: () => [...accounts.values()],
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      if (!fake.online) throw new TypeError('fetch failed');
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      const bearer = /^Bearer (.+)$/.exec(headers.get('authorization') ?? '')?.[1];
      fake.calls.push({ method: init?.method ?? 'GET', path: url.pathname, body, bearer });
      if (headers.get('apikey') !== SUPABASE_KEY) return json({ message: 'Invalid API key' }, 401);

      if (url.pathname === '/auth/v1/otp') {
        if (fake.emailLimited) return json({ code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' }, 429);
        const email = String(body?.email ?? '');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ code: 400, error_code: 'email_address_invalid', msg: 'Email address is invalid' }, 400);
        codes.set(email, String(Math.floor(100000 + Math.random() * 900000)));
        return json({});
      }

      if (url.pathname === '/auth/v1/verify') {
        const email = String(body?.email ?? '');
        if (body?.type !== 'email' || codes.get(email) !== String(body?.token)) return json({ code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' }, 403);
        codes.delete(email);
        let caller = accounts.get(email);
        if (!caller) accounts.set(email, (caller = await opts.world.kj(email)));
        const session: Session = { caller, ended: false };
        sessions.push(session);
        return issue(session);
      }

      if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
        const rec = refresh.get(String(body?.refresh_token));
        if (!rec || rec.session.ended) return json({ code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' }, 400);
        if (rec.used) return json({ code: 400, error_code: 'refresh_token_already_used', msg: 'Invalid Refresh Token: Already Used' }, 400);
        rec.used = true;
        return issue(rec.session);
      }

      if (url.pathname === '/auth/v1/logout') {
        const a = bearer ? access.get(bearer) : undefined;
        if (a) a.session.ended = true;
        return new Response(null, { status: 204 });
      }

      if (url.pathname === '/functions/v1/encore-license') {
        const a = bearer ? access.get(bearer) : undefined;
        if (!bearer || !a || a.session.ended || revoked.has(bearer) || a.expiresAt <= now()) return json({ code: 401, message: 'Invalid JWT' }, 401);
        if (override) {
          const reply = override;
          override = undefined;
          return reply();
        }
        const deps: Deps = { store: opts.world.store, signing: { key: opts.signing, kid: opts.kid ?? 'k1' }, now, ...opts.deps };
        const caller = a.session.caller;
        const reply =
          body?.action === 'startTrial'
            ? await handleStartTrial(body, caller, deps)
            : body?.action === 'redeem'
              ? await handleRedeem(body, caller, '203.0.113.7', deps)
              : await handleStatus(body, caller, deps);
        return json(reply.body, reply.status);
      }

      return json({ message: 'not found' }, 404);
    }) as typeof fetch,
  };
  return fake;
}
