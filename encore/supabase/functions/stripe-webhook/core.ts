// What Stripe tells us, and what it means for an account. Stripe sends an event for
// everything that happens to a payment; five matter here:
//
//   checkout.session.completed            a KJ paid for Encore (or started Cloud): Encore is theirs
//                                         forever, with a year of Cloud on top of any they have
//   checkout.session.async_payment_succeeded   the same, for payments that settle later
//   invoice.paid                          a Cloud year was paid (the first, or a renewal): add it
//   invoice.payment_failed                a renewal failed: keep Cloud on a week while Stripe retries
//
// Anything else is acknowledged and ignored. Each event is applied once, by its id, in the
// database (migrations/..._stripe.sql), so Stripe retrying or sending it twice changes nothing.
//
// No YouTube feature is touched by any of this: a purchase only ever sets whether Encore is
// theirs and how long Cloud (the online join link and lock-screen alerts) lasts.
//
// Plain TypeScript with no Deno or npm imports, so the tests run it in Node.

import { verifyStripeSignature } from './signature.ts';

/** What one event does to one account, as the database function takes it. */
export interface ApplyArgs {
  event: string;
  type: string;
  user: string | null;
  customer: string | null;
  subscription: string | null;
  app: boolean;
  addYear: boolean;
  from: string | null;
  to: string | null;
  grace: string | null;
}

export type ApplyResult = 'ok' | 'duplicate' | 'unknown-account';

export interface WebhookStore {
  apply(args: ApplyArgs): Promise<ApplyResult>;
}

export interface WebhookDeps {
  /** The endpoint's signing secret (STRIPE_WEBHOOK_SECRET). Unset until payments are switched on. */
  secret?: string;
  store: WebhookStore;
  now?: () => number;
  /** Days Cloud stays on after a renewal fails. */
  graceDays?: number;
}

export interface WebhookReply {
  status: number;
  body: { ok: boolean; result?: string; code?: string; error?: string };
}

export const GRACE_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

export async function handleWebhook(rawBody: string, signature: string | null, deps: WebhookDeps): Promise<WebhookReply> {
  if (!deps.secret) return { status: 503, body: { ok: false, code: 'not-configured', error: 'Payments aren’t switched on yet.' } };
  const now = (deps.now ?? Date.now)();
  if (!(await verifyStripeSignature(rawBody, signature, deps.secret, now))) {
    return { status: 400, body: { ok: false, code: 'bad-signature', error: 'That didn’t come from Stripe.' } };
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { ok: false, code: 'bad-event', error: 'Not an event.' } };
  }
  const args = plan(event, now, deps.graceDays ?? GRACE_DAYS);
  if (args === 'bad') return { status: 400, body: { ok: false, code: 'bad-event', error: 'Not an event.' } };
  if (args === null) return { status: 200, body: { ok: true, result: 'ignored' } };

  const result = await deps.store.apply(args);
  // Not an error to Stripe's eyes only if we say so: a refusal makes it try again later, which is what we want
  // when the invoice arrives before the checkout that links the customer to an account.
  if (result === 'unknown-account') return { status: 409, body: { ok: false, code: 'unknown-account', error: 'No account for that customer yet.' } };
  return { status: 200, body: { ok: true, result } };
}

// --- reading an event ------------------------------------------------------------------

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/** The arguments for the database, null for an event we ignore, or 'bad' for something that isn't an event. */
export function plan(event: unknown, now: number, graceDays: number): ApplyArgs | null | 'bad' {
  const e = obj(event);
  const id = str(e.id);
  const type = str(e.type);
  const object = obj(obj(e.data).object);
  if (!id || !type || Object.keys(object).length === 0) return 'bad';

  const base: ApplyArgs = { event: id, type, user: null, customer: str(object.customer), subscription: null, app: false, addYear: false, from: null, to: null, grace: null };

  switch (type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const user = str(object.client_reference_id) ?? str(obj(object.metadata).user_id);
      const kind = str(obj(object.metadata).kind);
      if (!user) return null; // a checkout we didn't start
      if (object.mode === 'payment' && kind === 'app') {
        // A payment that settles later arrives as async_payment_succeeded; until then it's not paid.
        if (object.payment_status !== 'paid') return null;
        return { ...base, user, app: true, addYear: true };
      }
      if (object.mode === 'subscription' && kind === 'cloud') {
        // Only link the customer and the subscription; the paid year arrives with its invoice.
        return { ...base, user, subscription: str(object.subscription) };
      }
      return null;
    }

    case 'invoice.paid': {
      const subscription = subscriptionOf(object);
      if (!subscription) return null; // the receipt for the one-time purchase, not a Cloud year
      const period = periodOf(object);
      if (!period) return null;
      return { ...base, user: userOf(object), subscription, from: iso(period.from), to: iso(period.to) };
    }

    case 'invoice.payment_failed': {
      const subscription = subscriptionOf(object);
      if (!subscription) return null;
      // Stripe retries a failed payment a few times; only the first failure starts the week of grace.
      if ((num(object.attempt_count) ?? 1) > 1) return null;
      return { ...base, user: userOf(object), subscription, grace: new Date(now + graceDays * DAY).toISOString() };
    }

    default:
      return null;
  }
}

/** The subscription an invoice belongs to, in the old and the new shape of Stripe's invoice. */
function subscriptionOf(invoice: Obj): string | null {
  return str(invoice.subscription) ?? str(obj(obj(invoice.parent).subscription_details).subscription);
}

/** The account named on the subscription when it was started, if Stripe passes it along. */
function userOf(invoice: Obj): string | null {
  return str(obj(obj(invoice.subscription_details).metadata).user_id) ?? str(obj(obj(obj(invoice.parent).subscription_details).metadata).user_id);
}

/** The span the invoice paid for, from its lines (the invoice's own period fields describe when it was made, not what it covers). */
function periodOf(invoice: Obj): { from: number; to: number } | null {
  const lines = obj(invoice.lines).data;
  if (!Array.isArray(lines)) return null;
  let from = Infinity;
  let to = -Infinity;
  for (const line of lines) {
    const p = obj(obj(line).period);
    const start = num(p.start);
    const end = num(p.end);
    if (start !== null && end !== null && end > start) {
      from = Math.min(from, start);
      to = Math.max(to, end);
    }
  }
  return Number.isFinite(from) && Number.isFinite(to) ? { from, to } : null;
}
