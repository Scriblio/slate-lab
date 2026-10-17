// The license service: works out what one KJ account may do on one laptop and
// signs a pass saying so (see pass.ts). Three questions, all asked by a signed-in
// KJ's laptop:
//
//   status      what do I have now? (every 12 hours, and after anything changes)
//   startTrial  begin my free trial, if this account and this laptop haven't had one
//   redeem      use an unlock code
//
// What the account has comes from the database (migrations/..._licensing.sql):
// the owner flag, a purchase, the trial, and the codes it has redeemed. A turned-off
// code simply stops counting, so it stops working the next time that laptop checks
// in. The pass is good for two weeks without a check-in.
//
// Paying is two more questions (billing.ts): checkout, which makes a Stripe-hosted page to
// buy Encore, subscribe to Encore Monthly or add a year of Cloud on, and portal, Stripe's page
// for managing a card or a subscription. Neither gives anything: only Stripe's webhook
// (../stripe-webhook) does, by writing the same columns an unlock code's grants sit beside.
//
// Encore Monthly is Encore and Cloud for as long as the months are paid for, plus a few days of
// grace (SUBSCRIPTION_GRACE_DAYS), so a renewal that lands while a laptop is offline at a gig
// doesn't lock anyone out. The pass runs out when the grace does, so a lapsed subscription
// can't be coasted on, even offline.
//
// No YouTube feature is ever part of a pass: YouTube search and playback don't ask
// this service anything, and a plan can't switch them on or off (YouTube's policies
// forbid charging for them).
//
// Plain TypeScript with no Deno or npm imports, so the tests run it in Node against
// an in-memory store and against the real SQL.

import { hashCode, normalizeCode } from './codes.ts';
import { signPass, type PassPayload, type PassSource } from './pass.ts';

export type Grant = 'forever' | 'app' | 'cloud_year';

/** The account's own row, with dates in ms since 1970. */
export interface LicenseRow {
  appForever: boolean;
  cloudUntil: number | null;
  cloudForever: boolean;
  trialEndsAt: number | null;
  owner: boolean;
  /** Set once they have paid by card: Stripe's id for them, which the billing portal needs. */
  stripeCustomerId: string | null;
  /** Encore Monthly: the end of the last month that was paid for. */
  appUntil: number | null;
}

/** Everything needed to work out one account's pass, from one database trip. */
export interface Snapshot {
  license: LicenseRow | null;
  /** Codes this account redeemed that are still switched on. */
  grants: { grants: Grant; redeemedAt: number }[];
  /** Some account has already had its free trial on this laptop. */
  installHadTrial: boolean;
}

/** 'started'; or why not: this account had its trial, this laptop did (under another account), or the app is already theirs. */
export type TrialResult = 'started' | 'account' | 'install' | 'owned';
export type RedeemResult = 'ok' | 'not-found' | 'revoked' | 'expired' | 'already' | 'used-up';

export interface Store {
  snapshot(userId: string, installId: string): Promise<Snapshot>;
  /** Start the trial, once per account and once per laptop. */
  startTrial(userId: string, installId: string, days: number): Promise<TrialResult>;
  /** Use a code (by its hash) for an account, unless it can't take another use. */
  redeem(codeHash: string, userId: string, installId: string): Promise<RedeemResult>;
  /** Count one try against every bucket if all are under their limit; returns the first full bucket, or null. */
  take(buckets: { name: string; limit: number }[], window: string): Promise<string | null>;
  prune(): Promise<void>;
}

export interface Limits {
  /** Unlock code tries an account may make an hour. */
  redeemPerAccount: number;
  /** ... and a network address. */
  redeemPerIp: number;
  /** Checkout and billing pages an account may ask for an hour. */
  billingPerAccount?: number;
}

export type Kind = 'app' | 'cloud' | 'monthly';

/** Taking payment through Stripe (stripe.ts). */
export interface Payments {
  /** Encore Monthly can be offered: its price is set. (Without it, buying and Cloud still work.) */
  readonly monthly: boolean;
  /** The address of a Stripe-hosted page to buy Encore, subscribe to Encore Monthly, or add a year of Cloud, on. */
  checkout(args: { kind: Kind; userId: string; email: string; customer: string | null }): Promise<string>;
  /** The address of Stripe's page for seeing payments and changing a card or a subscription. */
  portal(customer: string): Promise<string>;
  /** This customer already has a Cloud subscription that is running (or being retried). */
  hasSubscription(customer: string): Promise<boolean>;
}

export interface Deps {
  store: Store;
  /** The private key. Unset until the LICENSE_SIGNING_KEY secret is added. */
  signing?: { key: CryptoKey; kid: string };
  /** Unset until the Stripe secrets are added: then nothing can be bought and the console shows no prices. */
  payments?: Payments;
  limits?: Limits;
  /** Days a pass is good for without a check-in. */
  passDays?: number;
  trialDays?: number;
  /** Secret salt for hashing network addresses. */
  salt?: string;
  now?: () => number;
  random?: () => number;
}

/** The signed-in KJ asking, as the Auth server says they are. */
export interface Caller {
  userId: string;
  email: string;
}

export interface Failure {
  ok: false;
  error: string;
  code: string;
}

export type Reply = {
  status: number;
  body:
    | {
        ok: true;
        pass: string;
        trialAvailable: boolean;
        /** Payments are switched on: the console may show Buy buttons. Not part of the pass: nothing here grants anything. */
        payments: boolean;
        /** Encore Monthly can be offered too. */
        monthly: boolean;
        /** This account has paid by card, so Stripe's billing portal has something to show. */
        billing: boolean;
        trial?: TrialResult;
      }
    | Failure;
};

/** The answer to checkout and portal: where to send the KJ's browser. */
export type LinkReply = { status: number; body: { ok: true; url: string } | Failure };

export const DEFAULT_LIMITS: Limits = { redeemPerAccount: 10, redeemPerIp: 30 };
export const DEFAULT_BILLING_PER_HOUR = 20;
export const PASS_DAYS = 14;
export const TRIAL_DAYS = 14;
/** Encore Monthly keeps working this long after the last paid month ends. */
export const SUBSCRIPTION_GRACE_DAYS = 3;

export const DAY = 24 * 60 * 60 * 1000;
export const HOUR = 60 * 60 * 1000;
const INSTALL_ID = /^[A-Za-z0-9_-]{16,64}$/;

// --- what an account has --------------------------------------------------------------

export interface Plan {
  /** Encore is theirs right now: for good (owner, unlock code, purchase) or while Encore Monthly is paid for. */
  app: boolean;
  /** Encore is theirs for good, so a subscription (or a second purchase) would be a mistake. */
  appForever: boolean;
  /** Encore Monthly: the end of the month that was paid for, while it is theirs that way. Null otherwise. */
  appUntil: string | null;
  cloudUntil: string | null;
  trialUntil: string | null;
  owner: boolean;
  source: PassSource | null;
  /** A free trial can still be started: nothing bought, and neither this account nor this laptop has had one. */
  trialAvailable: boolean;
}

/** When Encore Monthly stops working: the end of the last paid month, and a few days on. */
export function subscriptionEnds(snap: Snapshot): number | null {
  const paidTo = snap.license?.appUntil ?? null;
  return paidTo === null ? null : paidTo + SUBSCRIPTION_GRACE_DAYS * DAY;
}

export function evaluate(snap: Snapshot, now = Date.now()): Plan {
  const lic = snap.license;
  const owner = Boolean(lic?.owner);
  const codeApp = snap.grants.some((g) => g.grants === 'forever' || g.grants === 'app');
  const appForever = owner || Boolean(lic?.appForever) || codeApp;
  // Encore Monthly counts only while it's paid for (and never matters to someone who has Encore for good).
  const endsAt = subscriptionEnds(snap);
  const subscribed = !appForever && endsAt !== null && now < endsAt;
  const app = appForever || subscribed;
  const cloudForever = owner || Boolean(lic?.cloudForever) || snap.grants.some((g) => g.grants === 'forever');
  // Each year-of-Cloud code adds a year to the end of whatever Cloud they already have.
  let cloudEnd = lic?.cloudUntil ?? null;
  for (const g of snap.grants.filter((x) => x.grants === 'cloud_year').sort((a, b) => a.redeemedAt - b.redeemedAt)) {
    cloudEnd = addYear(Math.max(cloudEnd ?? 0, g.redeemedAt));
  }
  // Cloud comes with Encore Monthly, for as long as it does.
  if (subscribed) cloudEnd = Math.max(cloudEnd ?? 0, endsAt!);
  const trialEndsAt = lic?.trialEndsAt ?? null;
  return {
    app,
    appForever,
    appUntil: subscribed ? new Date(lic!.appUntil!).toISOString() : null,
    cloudUntil: cloudForever ? 'forever' : cloudEnd === null ? null : new Date(cloudEnd).toISOString(),
    trialUntil: trialEndsAt === null ? null : new Date(trialEndsAt).toISOString(),
    owner,
    source: owner ? 'owner' : codeApp ? 'code' : lic?.appForever ? 'purchase' : subscribed ? 'subscription' : trialEndsAt !== null ? 'trial' : null,
    trialAvailable: !app && trialEndsAt === null && !snap.installHadTrial,
  };
}

function addYear(ms: number): number {
  const d = new Date(ms);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.getTime();
}

// --- the three questions --------------------------------------------------------------

export async function handleStatus(input: unknown, caller: Caller, deps: Deps): Promise<Reply> {
  const installId = readInstallId(input);
  if (!installId) return badInstall();
  if (!deps.signing) return notConfigured();
  return answer(caller, installId, deps);
}

export async function handleStartTrial(input: unknown, caller: Caller, deps: Deps): Promise<Reply> {
  const installId = readInstallId(input);
  if (!installId) return badInstall();
  if (!deps.signing) return notConfigured();
  // Someone who already owns Encore has nothing to start (and shouldn't use up this laptop's trial).
  const trial: TrialResult = evaluate(await deps.store.snapshot(caller.userId, installId), (deps.now ?? Date.now)()).app
    ? 'owned'
    : await deps.store.startTrial(caller.userId, installId, deps.trialDays ?? TRIAL_DAYS);
  return answer(caller, installId, deps, trial);
}

const REFUSALS: Record<Exclude<RedeemResult, 'ok'>, { status: number; code: string; error: string }> = {
  'not-found': { status: 400, code: 'bad-code', error: 'That unlock code isn’t right. Check it and try again.' },
  revoked: { status: 400, code: 'code-off', error: 'That unlock code has been turned off. Ask whoever gave it to you.' },
  expired: { status: 400, code: 'code-expired', error: 'That unlock code has expired.' },
  'used-up': { status: 400, code: 'code-used', error: 'That unlock code has already been used.' },
  already: { status: 400, code: 'code-already', error: 'You’ve already used that unlock code on this account.' },
};

export async function handleRedeem(input: unknown, caller: Caller, ip: string, deps: Deps): Promise<Reply> {
  const body = (input ?? {}) as { code?: unknown; installId?: unknown };
  const installId = readInstallId(input);
  if (!installId) return badInstall();
  if (!deps.signing) return notConfigured();
  const canonical = normalizeCode(body.code);
  if (!canonical) return fail(400, 'bad-code', 'That doesn’t look like an unlock code. They look like ENC-7K4Q-M2XP-9R8T.');

  // Guessing codes is the only way to abuse this, so tries are counted, an hour at a time, per account and per network.
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const now = (deps.now ?? Date.now)();
  const full = await deps.store.take(
    [
      { name: `redeem:account:${caller.userId}`, limit: limits.redeemPerAccount },
      { name: `redeem:ip:${await hashCode(`${ip}|${deps.salt ?? ''}`)}`, limit: limits.redeemPerIp },
    ],
    new Date(Math.floor(now / HOUR) * HOUR).toISOString(),
  );
  if (full) return fail(429, 'limit', 'Too many tries. Please wait an hour and try again.');
  if ((deps.random ?? Math.random)() < 0.02) await deps.store.prune().catch(() => {});

  const result = await deps.store.redeem(await hashCode(canonical), caller.userId, installId);
  if (result !== 'ok') return fail(REFUSALS[result].status, REFUSALS[result].code, REFUSALS[result].error);
  return answer(caller, installId, deps);
}

// --- the pass ---------------------------------------------------------------------------

async function answer(caller: Caller, installId: string, deps: Deps, trial?: TrialResult): Promise<Reply> {
  const now = (deps.now ?? Date.now)();
  const snapshot = await deps.store.snapshot(caller.userId, installId);
  const plan = evaluate(snapshot, now);
  const iat = Math.floor(now / 1000);
  let exp = iat + Math.round(((deps.passDays ?? PASS_DAYS) * DAY) / 1000);
  // A pass that is good only because a subscription is paid for runs out when the paid time (and its grace) does.
  if (plan.source === 'subscription') exp = Math.min(exp, Math.floor(subscriptionEnds(snapshot)! / 1000));
  const payload: PassPayload = {
    v: 1,
    sub: caller.userId,
    email: caller.email,
    installId,
    app: plan.app,
    cloudUntil: plan.cloudUntil,
    trialUntil: plan.trialUntil,
    ...(plan.appUntil ? { appUntil: plan.appUntil } : {}),
    owner: plan.owner,
    source: plan.source,
    iat,
    exp,
  };
  const pass = await signPass(payload, deps.signing!.key, deps.signing!.kid);
  return {
    status: 200,
    body: {
      ok: true,
      pass,
      trialAvailable: plan.trialAvailable,
      payments: Boolean(deps.payments),
      monthly: Boolean(deps.payments?.monthly),
      billing: Boolean(snapshot.license?.stripeCustomerId),
      ...(trial ? { trial } : {}),
    },
  };
}

// --- helpers (billing.ts uses them too) -----------------------------------------------------

export function readInstallId(input: unknown): string | null {
  const id = (input as { installId?: unknown } | null)?.installId;
  return typeof id === 'string' && INSTALL_ID.test(id) ? id : null;
}

export const badInstall = () => fail(400, 'bad-request', 'Update Encore to check your license.');
export const notConfigured = () => fail(503, 'not-configured', 'Licensing isn’t switched on yet.');

export function fail(status: number, code: string, error: string): { status: number; body: Failure } {
  return { status, body: { ok: false, code, error } };
}
