// Checking that a webhook really came from Stripe
// (https://docs.stripe.com/webhooks#verify-manually). Stripe signs "<timestamp>.<raw body>"
// with HMAC-SHA256 and the endpoint's secret, and sends "t=<timestamp>,v1=<signature>"
// (more than one v1 while a secret is being rotated) in the Stripe-Signature header.
//
// Plain WebCrypto, so it runs the same in Deno and in the tests under Node. Nothing
// here ever logs the body or the secret.

export const TOLERANCE_SECONDS = 300;

export async function verifyStripeSignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string,
  nowMs: number,
  toleranceSeconds = TOLERANCE_SECONDS,
): Promise<boolean> {
  if (!header || !secret) return false;

  let stamp = '';
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === 't') stamp = value;
    else if (key === 'v1' && value) signatures.push(value.toLowerCase());
  }
  const seconds = Number(stamp);
  if (!/^\d+$/.test(stamp) || !Number.isFinite(seconds) || signatures.length === 0) return false;
  // An old delivery replayed later is turned away, even with a correct signature.
  if (Math.abs(nowMs / 1000 - seconds) > toleranceSeconds) return false;

  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${stamp}.${rawBody}`)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  return signatures.some((s) => sameText(s, expected));
}

/** Compare without stopping at the first difference. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
