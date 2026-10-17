// POST { action: 'status', installId } -> { ok: true, pass, trialAvailable, payments, monthly, billing }
// POST { action: 'startTrial', installId } -> { ok: true, pass, trialAvailable, payments, monthly, billing, trial }
// POST { action: 'redeem', installId, code } -> { ok: true, pass, ... } | { ok: false, error, code }
// POST { action: 'checkout', installId, kind: 'app' | 'monthly' | 'cloud' } -> { ok: true, url } | { ok: false, error, code }
// POST { action: 'portal', installId } -> { ok: true, url } | { ok: false, error, code }
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
// (default 10 and 30).
//
// Paying (docs/LICENSING.md, "Step 2"): STRIPE_SECRET_KEY, STRIPE_PRICE_APP and
// STRIPE_PRICE_CLOUD together switch it on; until all three exist, no page is offered and the
// console shows no prices. Adding STRIPE_PRICE_MONTHLY switches on Encore Monthly too (without it
// Encore and Cloud are sold as before). Optionally STRIPE_AUTOMATIC_TAX=true, and PAYMENT_SUCCESS_URL,
// PAYMENT_CANCEL_URL and PAYMENT_RETURN_URL. Nothing here may ever be logged or sent anywhere.

import { DEFAULT_LIMITS, handleRedeem, handleStartTrial, handleStatus, PASS_DAYS, TRIAL_DAYS, type Caller, type Deps, type Reply } from './core.ts';
import { handleCheckout, handlePortal } from './billing.ts';
import { importSigningKey } from './pass.ts';
import { restStore } from './store.ts';
import { stripePayments } from './stripe.ts';

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

// Paying is switched on by having all three Stripe secrets; with any missing, nothing can be bought.
const payments = (() => {
  const key = env('STRIPE_SECRET_KEY');
  const priceApp = env('STRIPE_PRICE_APP');
  const priceCloud = env('STRIPE_PRICE_CLOUD');
  if (!key || !priceApp || !priceCloud) return undefined;
  return stripePayments({
    secretKey: key,
    priceApp,
    priceCloud,
    priceMonthly: env('STRIPE_PRICE_MONTHLY'),
    automaticTax: env('STRIPE_AUTOMATIC_TAX') === 'true',
    successUrl: env('PAYMENT_SUCCESS_URL') ?? 'https://sing.scriblio.co/thanks',
    cancelUrl: env('PAYMENT_CANCEL_URL') ?? 'https://sing.scriblio.co/encore',
    returnUrl: env('PAYMENT_RETURN_URL') ?? 'https://sing.scriblio.co/thanks',
  });
})();

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
    // The Auth server wants a project key beside the token. The publishable one is meant for this; the
    // secret key (which never leaves this function) does if the platform didn't supply it.
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: publishableKey() || secretKey(), Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      // What the answer says about itself, never the token: enough to tell a bad key from a signed-out session in the logs.
      const why = (await res.json().catch(() => null)) as { error_code?: unknown; message?: unknown } | null;
      console.error('The Auth server turned down a token:', res.status, String(why?.error_code ?? why?.message ?? '').slice(0, 80));
      return null;
    }
    const user = (await res.json()) as { id?: unknown; email?: unknown };
    return typeof user.id === 'string' && typeof user.email === 'string' && user.email ? { userId: user.id, email: user.email } : null;
  } catch {
    return null;
  }
}

const json = (reply: Pick<Reply, 'status'> & { body: unknown }) => Response.json(reply.body, { status: reply.status, headers: { 'Cache-Control': 'no-store' } });
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
      payments,
      passDays: num('LICENSE_PASS_DAYS', PASS_DAYS),
      trialDays: num('LICENSE_TRIAL_DAYS', TRIAL_DAYS),
      salt,
    };
    const action = (input as { action?: unknown } | null)?.action;
    if (action === 'status') return json(await handleStatus(input, caller, deps));
    if (action === 'startTrial') return json(await handleStartTrial(input, caller, deps));
    if (action === 'redeem') return json(await handleRedeem(input, caller, ip, deps));
    if (action === 'checkout') return json(await handleCheckout(input, caller, deps));
    if (action === 'portal') return json(await handlePortal(input, caller, deps));
    return refuse(400, 'bad-request', 'Update Encore to check your license.');
  } catch (err) {
    console.error(err);
    return refuse(500, 'server', 'Encore’s license service hit a snag. Try again in a minute.');
  }
});
