// POST from Stripe (an event, signed with the endpoint's secret) -> what it means for an account.
//
// Deploy with verify_jwt OFF, like youtube-search: Stripe sends no Supabase token. What keeps
// strangers out is the signature, checked against STRIPE_WEBHOOK_SECRET before anything is read.
//
// Secrets: STRIPE_WEBHOOK_SECRET (the endpoint's signing secret, "whsec_..."; until it's set
// every call is answered "not switched on yet"). Optional: STRIPE_GRACE_DAYS (default 7).
// Nothing here may ever log the body, a header or a secret.

import { GRACE_DAYS, handleWebhook } from './core.ts';
import { restStore } from './store.ts';

const env = (name: string) => Deno.env.get(name) || undefined;

function secretKey(): string {
  try {
    const keys = JSON.parse(env('SUPABASE_SECRET_KEYS') ?? '{}') as Record<string, string>;
    if (keys.default) return keys.default;
  } catch {
    // fall through to the legacy key
  }
  return env('SUPABASE_SERVICE_ROLE_KEY') ?? '';
}

const store = restStore((env('SUPABASE_URL') ?? '').replace(/\/$/, ''), secretKey());
const graceDays = Number(env('STRIPE_GRACE_DAYS'));

// Stripe's events are a few kilobytes; nothing bigger is worth reading.
const MAX_BODY = 1_000_000;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Use POST.', { status: 405 });
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return new Response('Too large.', { status: 413 });
  try {
    // The raw text, exactly as sent: the signature is over these bytes.
    const raw = await req.text();
    if (raw.length > MAX_BODY) return new Response('Too large.', { status: 413 });
    const reply = await handleWebhook(raw, req.headers.get('stripe-signature'), {
      secret: env('STRIPE_WEBHOOK_SECRET'),
      store,
      graceDays: Number.isFinite(graceDays) && graceDays > 0 ? graceDays : GRACE_DAYS,
    });
    return Response.json(reply.body, { status: reply.status, headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('stripe-webhook:', (err as Error).message);
    return Response.json({ ok: false, code: 'server' }, { status: 500 });
  }
});
