// Quick-tip buttons: the KJ's Venmo, Cash App or PayPal.me link, turned into
// links that open the payment app with an amount filled in. These are the
// services' own public links; Encore never handles the money, and the singer
// can still change the amount before paying.

export type TipService = 'venmo' | 'cashapp' | 'paypal';

/** What phones get when the KJ hasn't changed them. */
export const DEFAULT_TIP_AMOUNTS = [1, 5, 10];
const MAX_AMOUNTS = 4;
const MAX_AMOUNT = 500;

// Venmo pages that aren't someone's profile.
const VENMO_PAGES = new Set(['u', 'pay', 'code', 'signup', 'login', 'account', 'legal', 'about', 'paymentlinks', 'business']);

/** Which service a tip link belongs to, and whose account it is. Null for anything else. */
export function parseTipLink(link: string): { service: TipService; handle: string } | null {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  if (host === 'venmo.com' || host === 'account.venmo.com') {
    // venmo.com/u/name or venmo.com/name
    const user = parts[0]?.toLowerCase() === 'u' ? parts[1] : parts[0];
    return user && /^[A-Za-z0-9_-]{1,40}$/.test(user) && !VENMO_PAGES.has(user.toLowerCase()) ? { service: 'venmo', handle: user } : null;
  }
  if (host === 'cash.app' || host === 'cash.me') {
    const tag = decodeURIComponent(parts[0] ?? '');
    return /^\$[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(tag) ? { service: 'cashapp', handle: tag } : null;
  }
  if (host === 'paypal.me' || host === 'paypal.com') {
    // paypal.me/name (maybe with an amount already), or paypal.com/paypalme/name
    const user = host === 'paypal.me' ? parts[0] : parts[0]?.toLowerCase() === 'paypalme' ? parts[1] : undefined;
    return user && /^[A-Za-z0-9]{1,20}$/.test(user) ? { service: 'paypal', handle: user } : null;
  }
  return null;
}

/** "5", or "2.50" for amounts with cents. */
export function formatTipAmount(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

/** The tip link with `amount` filled in, or null when the service can't do that. */
export function tipLinkWithAmount(link: string, amount: number, note = 'Karaoke tip'): string | null {
  const p = parseTipLink(link);
  if (!p || !(amount > 0)) return null;
  const a = formatTipAmount(amount);
  switch (p.service) {
    case 'venmo':
      return `https://venmo.com/${p.handle}?txn=pay&amount=${a}&note=${encodeURIComponent(note)}`;
    case 'cashapp':
      return `https://cash.app/${p.handle}/${a}`;
    case 'paypal':
      return `https://paypal.me/${p.handle}/${a}`;
  }
}

/**
 * The KJ's amount buttons, from a list or text like "1, 5, 10": positive, at
 * most $500, cents at most, no repeats, smallest first, up to four.
 */
export function parseTipAmounts(v: unknown): number[] {
  const raw = Array.isArray(v) ? v : String(v ?? '').split(/[\s,;]+/);
  const out = new Set<number>();
  for (const item of raw) {
    const n = Math.round(Number(String(item).replace(/^\$/, '')) * 100) / 100;
    if (Number.isFinite(n) && n > 0 && n <= MAX_AMOUNT) out.add(n);
  }
  return [...out].sort((a, b) => a - b).slice(0, MAX_AMOUNTS);
}
