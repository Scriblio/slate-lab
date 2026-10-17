// The one thing the webhook asks Stripe to do (supabase/functions/stripe-webhook/stripe.ts): when
// someone on Encore Monthly buys Encore outright, stop that subscription renewing. It must only
// ever switch renewal off, only for Encore Monthly, and never leak the key.

import { describe, expect, it } from 'vitest';
import { stripeRenewals } from '../supabase/functions/stripe-webhook/stripe.ts';

const KEY = 'sk_test_never_logged_or_sent_anywhere_else';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: URLSearchParams;
}

/** A Stripe that answers a list of subscriptions, and records everything it was sent. */
function stripe(list: unknown, over: { status?: number; json?: unknown } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', headers: init?.headers as Record<string, string>, body: new URLSearchParams(String(init?.body ?? '')) });
    if (over.status) return Response.json(over.json ?? {}, { status: over.status });
    return init?.method === 'POST' ? Response.json({ id: 'sub_updated' }) : Response.json(list);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('stopping Encore Monthly renewing', () => {
  it('switches off renewal for Encore Monthly subscriptions that are still going, and only those', async () => {
    const s = stripe({
      data: [
        { id: 'sub_m1', status: 'active', metadata: { kind: 'monthly' } },
        { id: 'sub_m2', status: 'past_due', metadata: { kind: 'monthly' } },
        { id: 'sub_cloud', status: 'active', metadata: { kind: 'cloud' } }, // a Cloud year may well be wanted
        { id: 'sub_unstamped', status: 'active', metadata: {} },
        { id: 'sub_ended', status: 'canceled', metadata: { kind: 'monthly' } },
        { id: 'sub_going', status: 'active', cancel_at_period_end: true, metadata: { kind: 'monthly' } }, // already stopping
        { status: 'active', metadata: { kind: 'monthly' } }, // no id to act on
      ],
    });
    await stripeRenewals(KEY, s.fetchImpl).stopRenewing('cus_up');

    const [look, ...changes] = s.calls;
    expect(look).toMatchObject({ method: 'GET', url: 'https://api.stripe.com/v1/subscriptions?customer=cus_up&status=all&limit=10' });
    expect(changes.map((c) => [c.method, c.url, Object.fromEntries(c.body)])).toEqual([
      ['POST', 'https://api.stripe.com/v1/subscriptions/sub_m1', { cancel_at_period_end: 'true' }],
      ['POST', 'https://api.stripe.com/v1/subscriptions/sub_m2', { cancel_at_period_end: 'true' }],
    ]);
  });

  it('only ever sets "cancel at period end": nothing is deleted, refunded or prorated', async () => {
    const s = stripe({ data: [{ id: 'sub_m1', status: 'active', metadata: { kind: 'monthly' } }] });
    await stripeRenewals(KEY, s.fetchImpl).stopRenewing('cus_up');
    const post = s.calls.find((c) => c.method === 'POST')!;
    expect([...post.body.keys()]).toEqual(['cancel_at_period_end']);
    expect(s.calls.map((c) => c.method)).not.toContain('DELETE');
  });

  it('does nothing when there is nothing to stop', async () => {
    for (const list of [{ data: [] }, {}, { data: [{ id: 'sub_x', status: 'active', metadata: { kind: 'cloud' } }] }]) {
      const s = stripe(list);
      await stripeRenewals(KEY, s.fetchImpl).stopRenewing('cus_none');
      expect(s.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    }
  });

  it('sends the key as a bearer token only, never in an address', async () => {
    const s = stripe({ data: [{ id: 'sub_m1', status: 'active', metadata: { kind: 'monthly' } }] });
    await stripeRenewals(KEY, s.fetchImpl).stopRenewing('cus_up');
    for (const c of s.calls) {
      expect(c.headers.Authorization).toBe(`Bearer ${KEY}`);
      expect(c.url).not.toContain('sk_');
    }
    expect(s.calls[0]!.headers).not.toHaveProperty('Content-Type');
  });

  it('reports a failure as Stripe’s status and code, without the key or anything about the customer', async () => {
    const s = stripe({}, { status: 401, json: { error: { type: 'invalid_request_error', code: 'api_key_expired', message: `Expired API Key provided: ${KEY} for cus_up` } } });
    const err = await stripeRenewals(KEY, s.fetchImpl)
      .stopRenewing('cus_up')
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe('Stripe 401 invalid_request_error/api_key_expired');
    expect(String((err as Error).stack)).not.toContain(KEY);
    expect((err as Error).message).not.toContain('cus_up');
  });

  it('copes with an error that is not JSON at all', async () => {
    const fetchImpl = (async () => new Response('<html>bad gateway</html>', { status: 502 })) as typeof fetch;
    await expect(stripeRenewals(KEY, fetchImpl).stopRenewing('cus_up')).rejects.toThrow('Stripe 502');
  });
});
