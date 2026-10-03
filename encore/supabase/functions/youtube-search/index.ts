// POST { q, installId } -> { ok: true, results } | { ok: false, error, code }
//
// Deployed with verify_jwt off: Encore sends the project's publishable key,
// which isn't a JWT, and this function does its own checks and limits.
// Secrets: YOUTUBE_API_KEY (required for search), and optionally
// YT_DAILY_SEARCHES, YT_DAILY_PER_INSTALL and YT_DAILY_PER_IP to change the caps.

import { DEFAULT_LIMITS, handleSearch } from './core.ts';
import { restStore } from './store.ts';

const env = (name: string) => Deno.env.get(name) || undefined;
const num = (name: string, fallback: number) => {
  const n = Number(env(name));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

function secretKey(): string {
  try {
    const keys = JSON.parse(env('SUPABASE_SECRET_KEYS') ?? '{}') as Record<string, string>;
    if (keys.default) return keys.default;
  } catch {
    // fall through to the legacy key
  }
  return env('SUPABASE_SERVICE_ROLE_KEY') ?? '';
}

const store = restStore(env('SUPABASE_URL') ?? '', secretKey());

Deno.serve(async (req) => {
  if (req.method !== 'POST') return Response.json({ ok: false, error: 'Use POST.', code: 'bad-request' }, { status: 405 });
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() || 'unknown';
  try {
    const input = await req.json().catch(() => null);
    const reply = await handleSearch(input, ip, {
      store,
      fetch,
      apiKey: env('YOUTUBE_API_KEY'),
      limits: {
        global: num('YT_DAILY_SEARCHES', DEFAULT_LIMITS.global),
        perInstall: num('YT_DAILY_PER_INSTALL', DEFAULT_LIMITS.perInstall),
        perIp: num('YT_DAILY_PER_IP', DEFAULT_LIMITS.perIp),
      },
    });
    return Response.json(reply.body, { status: reply.status, headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error(err);
    return Response.json({ ok: false, error: 'YouTube search hit a snag. You can still paste a YouTube link.', code: 'server' }, { status: 500 });
  }
});
