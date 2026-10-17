// The little of Stripe's API the license service needs: a Checkout page to buy Encore or a
// year of Cloud on, the billing portal where a customer manages their card, and a look at
// whether a customer already has a subscription. Plain fetch, no SDK.
//
// The secret key (STRIPE_SECRET_KEY) lives only in this function. It is never logged, never
// put in a URL, and never returned: a failure is reported as Stripe's status and error
// code ("Stripe 400 invalid_request_error/resource_missing") and nothing else.
//
// Nothing here gives anyone anything. A payment only matters when Stripe's webhook
// (../stripe-webhook) says it went through, and it only ever sets whether Encore is theirs
// and how long Cloud lasts. No YouTube feature is for sale.

import type { Payments } from './core.ts';

export interface StripeConfig {
  /** sk_test_... while testing, sk_live_... for real money. */
  secretKey: string;
  /** The one-time price for Encore ($149), and the yearly price for Cloud ($49). */
  priceApp: string;
  priceCloud: string;
  /** Let Stripe work out sales tax or VAT (needs Stripe Tax set up). */
  automaticTax?: boolean;
  /** Where Checkout sends the KJ after paying, and if they back out. */
  successUrl: string;
  cancelUrl: string;
  /** Where the billing portal's "back" button goes. */
  returnUrl: string;
}

export class StripeError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly code: string,
  ) {
    super(`Stripe ${status} ${type}${code ? `/${code}` : ''}`);
  }
}

type Param = string | number | boolean | null | undefined | Param[] | { [key: string]: Param };

/** Stripe's form encoding: nested keys in brackets, lists by position, nothing for a missing value. */
export function encodeForm(params: { [key: string]: Param }): string {
  const pairs: string[] = [];
  const add = (key: string, value: Param): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) value.forEach((v, i) => add(`${key}[${i}]`, v));
    else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) add(`${key}[${k}]`, v);
    else pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  };
  for (const [key, value] of Object.entries(params)) add(key, value);
  return pairs.join('&');
}

/** Subscriptions that are still going, or being retried: another one would charge twice. */
const RUNNING = new Set(['active', 'trialing', 'past_due', 'unpaid']);

const API = 'https://api.stripe.com/v1';

export function stripePayments(cfg: StripeConfig, fetchImpl: typeof fetch = fetch): Payments {
  async function call<T>(method: 'GET' | 'POST', path: string, params: { [key: string]: Param }): Promise<T> {
    const form = encodeForm(params);
    const get = method === 'GET';
    const res = await fetchImpl(`${API}/${path}${get && form ? `?${form}` : ''}`, {
      method,
      headers: { Authorization: `Bearer ${cfg.secretKey}`, ...(get ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) },
      ...(get ? {} : { body: form }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => null)) as { error?: { type?: unknown; code?: unknown } } | null;
    if (!res.ok) throw new StripeError(res.status, String(json?.error?.type ?? '').slice(0, 60), String(json?.error?.code ?? '').slice(0, 60));
    return json as T;
  }

  return {
    async checkout({ kind, userId, email, customer }) {
      const cloud = kind === 'cloud';
      // Stripe hands these back on the events it sends us, which is how a payment finds its account.
      const who = { user_id: userId, kind };
      const session = await call<{ url?: unknown }>('POST', 'checkout/sessions', {
        mode: cloud ? 'subscription' : 'payment',
        line_items: [{ price: cloud ? cfg.priceCloud : cfg.priceApp, quantity: 1 }],
        client_reference_id: userId,
        metadata: who,
        ...(cloud ? { subscription_data: { metadata: who } } : { payment_intent_data: { metadata: who } }),
        // A returning customer keeps their Stripe record (and their saved card); a new one is made, with their sign-in email.
        ...(customer ? { customer } : { customer_email: email }),
        ...(!cloud && !customer ? { customer_creation: 'always' } : {}),
        ...(cfg.automaticTax ? { automatic_tax: { enabled: true }, ...(customer ? { customer_update: { address: 'auto' } } : {}) } : {}),
        success_url: cfg.successUrl,
        cancel_url: cfg.cancelUrl,
      });
      return stripePage(session.url);
    },

    async portal(customer) {
      const session = await call<{ url?: unknown }>('POST', 'billing_portal/sessions', { customer, return_url: cfg.returnUrl });
      return stripePage(session.url);
    },

    async hasSubscription(customer) {
      const list = await call<{ data?: { status?: unknown }[] }>('GET', 'subscriptions', { customer, status: 'all', limit: 10 });
      return (list.data ?? []).some((s) => RUNNING.has(String(s.status)));
    },
  };
}

/** The page Stripe made, if it really is one of Stripe's. The address goes to the KJ's browser, so it's checked on the way. */
export function stripePage(url: unknown): string {
  if (typeof url !== 'string') throw new Error('Stripe sent no page');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !/^(checkout|billing)\.stripe\.com$/.test(parsed.hostname)) throw new Error('Stripe sent a page that isn’t Stripe’s');
  return parsed.toString();
}
