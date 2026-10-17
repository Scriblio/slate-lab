// The one thing the webhook asks Stripe to do: when someone who subscribed to Encore Monthly
// buys Encore outright, stop that subscription renewing, so they aren't charged for both. It
// only ever switches renewal off ("cancel at period end"): they keep the month they paid for,
// and nothing is refunded or deleted. Plain fetch, no SDK.
//
// The secret key (STRIPE_SECRET_KEY) is the same one the license service uses. It is never
// logged, never put in a URL, and never returned: a failure is reported as Stripe's status and
// error code, and nothing else.

const API = 'https://api.stripe.com/v1';

/** Subscriptions that are still going, or being retried. */
const RUNNING = new Set(['active', 'trialing', 'past_due', 'unpaid']);

interface Subscription {
  id?: unknown;
  status?: unknown;
  cancel_at_period_end?: unknown;
  metadata?: { kind?: unknown } | null;
}

export function stripeRenewals(secretKey: string, fetchImpl: typeof fetch = fetch): { stopRenewing(customer: string): Promise<void> } {
  async function call<T>(method: 'GET' | 'POST', path: string, params: Record<string, string>): Promise<T> {
    const form = new URLSearchParams(params).toString();
    const get = method === 'GET';
    const res = await fetchImpl(`${API}/${path}${get ? `?${form}` : ''}`, {
      method,
      headers: { Authorization: `Bearer ${secretKey}`, ...(get ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) },
      ...(get ? {} : { body: form }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => null)) as { error?: { type?: unknown; code?: unknown } } | null;
    if (!res.ok) throw new Error(`Stripe ${res.status} ${String(json?.error?.type ?? '').slice(0, 60)}/${String(json?.error?.code ?? '').slice(0, 60)}`);
    return json as T;
  }

  return {
    async stopRenewing(customer) {
      const list = await call<{ data?: Subscription[] }>('GET', 'subscriptions', { customer, status: 'all', limit: '10' });
      for (const s of list.data ?? []) {
        // Only Encore Monthly (a Cloud year is something they may well want to keep), and only if it's still going and still set to renew.
        if (s.metadata?.kind !== 'monthly' || !RUNNING.has(String(s.status)) || s.cancel_at_period_end === true || typeof s.id !== 'string') continue;
        await call('POST', `subscriptions/${encodeURIComponent(s.id)}`, { cancel_at_period_end: 'true' });
      }
    },
  };
}
