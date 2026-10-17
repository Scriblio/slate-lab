// The one database function the webhook calls (migrations/..._stripe.sql), through this
// project's REST API with the secret key, so it only ever runs inside the function.

import type { ApplyArgs, ApplyResult, WebhookStore } from './core.ts';

export function restStore(supabaseUrl: string, secretKey: string, fetchImpl: typeof fetch = fetch): WebhookStore {
  const url = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/license_stripe_apply`;
  // New secret keys go in the apikey header only (they aren't JWTs).
  const headers = { apikey: secretKey, 'Content-Type': 'application/json' };

  return {
    async apply(a: ApplyArgs): Promise<ApplyResult> {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          p_event: a.event,
          p_type: a.type,
          p_user: a.user,
          p_customer: a.customer,
          p_subscription: a.subscription,
          p_app: a.app,
          p_cloud_add_year: a.addYear,
          p_cloud_from: a.from,
          p_cloud_to: a.to,
          p_cloud_grace_until: a.grace,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`database ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const result = (await res.json()) as unknown;
      if (result !== 'ok' && result !== 'duplicate' && result !== 'unknown-account') throw new Error(`database answered ${JSON.stringify(result).slice(0, 80)}`);
      return result;
    },
  };
}
