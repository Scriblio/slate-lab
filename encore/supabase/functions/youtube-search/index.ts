// POST { q, installId } -> { ok: true, results } | { ok: false, error, code }
// POST { action: 'report', installId, videoId, kind } -> { ok: true }
//   kind: 'refused' (won't play inside Encore), 'not_karaoke', or 'plays'
// POST { action: 'check', ids } -> { ok: true, hidden: { [videoId]: kind } }
//
// Deployed with verify_jwt off: Encore sends the project's publishable key,
// which isn't a JWT, and this function does its own checks and limits.
// Secrets: YOUTUBE_API_KEY (required for search), and optionally
// YT_DAILY_SEARCHES, YT_DAILY_PER_INSTALL and YT_DAILY_PER_IP to change the caps,
// YT_REFUSED_REPORTS (default 2) and YT_NOT_KARAOKE_REPORTS (default 3) for how
// many different networks must agree before a video is hidden for everyone.

import { DEFAULT_LIMITS, DEFAULT_THRESHOLDS, handleCheck, handleReport, handleSearch, type Deps } from './core.ts';
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
// Network addresses in reports are kept for up to 30 days, so they're hashed
// with a salt only this function knows (the project's secret key, unless
// YT_REPORT_SALT is set).
const salt = env('YT_REPORT_SALT') ?? secretKey();

Deno.serve(async (req) => {
  if (req.method !== 'POST') return Response.json({ ok: false, error: 'Use POST.', code: 'bad-request' }, { status: 405 });
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() || 'unknown';
  try {
    const input = await req.json().catch(() => null);
    const deps: Deps = {
      store,
      fetch,
      apiKey: env('YOUTUBE_API_KEY'),
      limits: {
        global: num('YT_DAILY_SEARCHES', DEFAULT_LIMITS.global),
        perInstall: num('YT_DAILY_PER_INSTALL', DEFAULT_LIMITS.perInstall),
        perIp: num('YT_DAILY_PER_IP', DEFAULT_LIMITS.perIp),
      },
      thresholds: {
        refused: Math.max(1, num('YT_REFUSED_REPORTS', DEFAULT_THRESHOLDS.refused)),
        notKaraoke: Math.max(1, num('YT_NOT_KARAOKE_REPORTS', DEFAULT_THRESHOLDS.notKaraoke)),
      },
      salt,
    };
    const action = (input as { action?: unknown } | null)?.action;
    const reply =
      action === 'report' ? await handleReport(input, ip, deps) : action === 'check' ? await handleCheck(input, deps) : await handleSearch(input, ip, deps);
    return Response.json(reply.body, { status: reply.status, headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error(err);
    return Response.json({ ok: false, error: 'YouTube search hit a snag. You can still paste a YouTube link.', code: 'server' }, { status: 500 });
  }
});
