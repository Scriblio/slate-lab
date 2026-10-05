// POST { action: 'status', installId } -> { ok: true, pass, trialAvailable }
// POST { action: 'startTrial', installId } -> { ok: true, pass, trialAvailable, trial }
// POST { action: 'redeem', installId, code } -> { ok: true, pass, trialAvailable } | { ok: false, error, code }
//
// Called by a signed-in KJ's laptop, with the KJ's session token in Authorization,
// so this one is deployed with verify_jwt ON (the platform turns away anything
// without a valid user token before this code runs). It still asks the Auth server
// who the token belongs to, which also catches a session that was signed out.
//
// Secrets: LICENSE_SIGNING_KEY (required): the Ed25519 private key that signs passes,
// as 43 characters of base64url (npm run license:key makes one). Optionally
// LICENSE_KEY_ID (default k1; goes in the pass header), LICENSE_PASS_DAYS (default 14),
// LICENSE_TRIAL_DAYS (default 14), LICENSE_REDEEM_PER_HOUR and LICENSE_REDEEM_PER_IP_HOUR
// (default 10 and 30). Nothing here may ever be logged or sent anywhere.

import { DEFAULT_LIMITS, handleRedeem, handleStartTrial, handleStatus, PASS_DAYS, TRIAL_DAYS, type Caller, type Deps, type Reply } from './core.ts';
import { importSigningKey } from './pass.ts';
import { restStore } from './store.ts';

const env = (name: string) => Deno.env.get(name) || undefined;
const num = (name: string, fallback: number) => {
  const n = Number(env(name));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

function secretKey(): string {
  try {
    const keys = JSON.parse(env('SUPABASE_SECRET_KEYS') ?? '{}') as Record<string, string>;
    if (keys.default) return keys.default;
  } catch {
    // fall through to the legacy key
  }
  return env('SUPABASE_SERVICE_ROLE_KEY') ?? '';
}

function publishableKey(): string {
  try {
    const keys = JSON.parse(env('SUPABASE_PUBLISHABLE_KEYS') ?? '{}') as Record<string, string>;
    if (keys.default) return keys.default;
  } catch {
    // fall through to the legacy key
  }
  return env('SUPABASE_ANON_KEY') ?? '';
}

const supabaseUrl = (env('SUPABASE_URL') ?? '').replace(/\/$/, '');
const store = restStore(supabaseUrl, secretKey());
// Network addresses are only ever kept as a hash, salted with something only this function knows.
const salt = env('LICENSE_SALT') ?? secretKey();

// The key is read once and kept; a bad or missing one means "not switched on yet", never a crash.
let signing: Promise<Deps['signing']> | undefined;
function signingKey(): Promise<Deps['signing']> {
  signing ??= (async () => {
    const secret = env('LICENSE_SIGNING_KEY');
    if (!secret) return undefined;
    try {
      return { key: await importSigningKey(secret), kid: env('LICENSE_KEY_ID') ?? 'k1' };
    } catch (err) {
      console.error('LICENSE_SIGNING_KEY is not a usable key:', (err as Error).message);
      return undefined;
    }
  })();
  return signing;
}

/** Who the session token belongs to, according to the Auth server (null if it's not a live session). */
async function whoIs(token: string): Promise<Caller | null> {
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: publishableKey(), Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const user = (await res.json()) as { id?: unknown; email?: unknown };
    return typeof user.id === 'string' && typeof user.email === 'string' && user.email ? { userId: user.id, email: user.email } : null;
  } catch {
    return null;
  }
}

const json = (reply: Reply) => Response.json(reply.body, { status: reply.status, headers: { 'Cache-Control': 'no-store' } });
const refuse = (status: number, code: string, error: string) => json({ status, body: { ok: false, code, error } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return refuse(405, 'bad-request', 'Use POST.');
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() || 'unknown';
  try {
    const token = /^Bearer (.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
    const caller = token ? await whoIs(token) : null;
    if (!caller) return refuse(401, 'unauthorized', 'Sign in to Encore again.');
    const input = await req.json().catch(() => null);
    const deps: Deps = {
      store,
      signing: await signingKey(),
      limits: {
        redeemPerAccount: num('LICENSE_REDEEM_PER_HOUR', DEFAULT_LIMITS.redeemPerAccount),
        redeemPerIp: num('LICENSE_REDEEM_PER_IP_HOUR', DEFAULT_LIMITS.redeemPerIp),
      },
      passDays: num('LICENSE_PASS_DAYS', PASS_DAYS),
      trialDays: num('LICENSE_TRIAL_DAYS', TRIAL_DAYS),
      salt,
    };
    const action = (input as { action?: unknown } | null)?.action;
    if (action === 'status') return json(await handleStatus(input, caller, deps));
    if (action === 'startTrial') return json(await handleStartTrial(input, caller, deps));
    if (action === 'redeem') return json(await handleRedeem(input, caller, ip, deps));
    return refuse(400, 'bad-request', 'Update Encore to check your license.');
  } catch (err) {
    console.error(err);
    return refuse(500, 'server', 'Encore’s license service hit a snag. Try again in a minute.');
  }
});
