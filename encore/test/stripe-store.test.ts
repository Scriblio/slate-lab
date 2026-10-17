// The webhook's REST store (supabase/functions/stripe-webhook/store.ts): that it asks the
// database for the function the migration really defines, by the parameter names it
// really has. stripe-sql.test.ts covers what the function does; this catches a typo
// between the two.

import { describe, expect, it } from 'vitest';
import type { ApplyArgs } from '../supabase/functions/stripe-webhook/core.ts';
import { restStore } from '../supabase/functions/stripe-webhook/store.ts';
import { definedFunctions, stripeMigration } from './licensedb.ts';

const args: ApplyArgs = { event: 'evt_1', type: 'invoice.paid', user: 'u', customer: 'cus_1', subscription: 'sub_1', app: false, addYear: false, from: '2026-10-16T00:00:00.000Z', to: '2027-10-16T00:00:00.000Z', grace: null };

describe('the Stripe webhook REST store', () => {
  it('only calls a database function that exists, with parameters it has', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json('ok');
    }) as typeof fetch;
    await restStore('https://project.supabase.co/', 'sb_secret_test', fetchImpl).apply(args);

    const defined = definedFunctions(stripeMigration());
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    const name = url.replace('https://project.supabase.co/rest/v1/rpc/', '');
    expect(defined.has(name), `${name} is in the migration`).toBe(true);
    expect(Object.keys(JSON.parse(String(init.body))).sort()).toEqual([...defined.get(name)!].sort());
    expect(init.method).toBe('POST');
  });

  it('sends every field of the event to the right parameter', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return Response.json('ok');
    }) as typeof fetch;
    await restStore('https://project.supabase.co', 'k', fetchImpl).apply({ ...args, app: true, addYear: true, grace: '2026-10-23T00:00:00.000Z' });
    expect(sent).toEqual({
      p_event: 'evt_1',
      p_type: 'invoice.paid',
      p_user: 'u',
      p_customer: 'cus_1',
      p_subscription: 'sub_1',
      p_app: true,
      p_cloud_add_year: true,
      p_cloud_from: '2026-10-16T00:00:00.000Z',
      p_cloud_to: '2027-10-16T00:00:00.000Z',
      p_cloud_grace_until: '2026-10-23T00:00:00.000Z',
    });
  });

  it('sends the secret key as the apikey only, since new secret keys are not JWTs', async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return Response.json('ok');
    }) as typeof fetch;
    await restStore('https://project.supabase.co', 'sb_secret_test', fetchImpl).apply(args);
    expect(headers.apikey).toBe('sb_secret_test');
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('authorization');
  });

  it('passes the three answers through', async () => {
    const answers: unknown[] = ['ok', 'duplicate', 'unknown-account'];
    const fetchImpl = (async () => Response.json(answers.shift())) as typeof fetch;
    const store = restStore('https://project.supabase.co', 'k', fetchImpl);
    expect(await store.apply(args)).toBe('ok');
    expect(await store.apply(args)).toBe('duplicate');
    expect(await store.apply(args)).toBe('unknown-account');
  });

  it('fails loudly, so Stripe tries again, when the database errors or answers something unexpected', async () => {
    const boom = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    await expect(restStore('https://project.supabase.co', 'k', boom).apply(args)).rejects.toThrow(/database 500: boom/);
    const odd = (async () => Response.json({ surprise: true })) as typeof fetch;
    await expect(restStore('https://project.supabase.co', 'k', odd).apply(args)).rejects.toThrow(/database answered/);
  });
});
