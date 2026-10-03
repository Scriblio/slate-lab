# Encore's Supabase project

The project `encore` (ref `oohgawkfnwhjlqlihhju`) does two jobs:

1. **The online join link.** Phones and the KJ laptop exchange end-to-end encrypted messages over Realtime broadcast. Nothing to deploy; it needs only the publishable key in `src/shared/cloud.ts`.
2. **YouTube search** for every copy of Encore, through one YouTube API key: the `youtube-search` Edge Function plus two tables.

## YouTube search

`functions/youtube-search` takes `POST { q, installId }` and returns `{ ok: true, results }` or `{ ok: false, error, code }`. It caches results (fresh for 7 days, kept at most 30, per YouTube's storage rule) and caps uncached searches per day, overall, per installation and per IP address. Counters reset at midnight Pacific time, like YouTube's quota.

Setup, once:

1. Apply `migrations/20261003180000_youtube_search.sql` (SQL editor, or `supabase db push`).
2. Deploy the function with JWT verification off; Encore sends the publishable key, which isn't a JWT:
   `supabase functions deploy youtube-search --no-verify-jwt`
3. In Google Cloud, create a project for Encore, enable **YouTube Data API v3**, and create an API key restricted to that API.
4. Add it as an Edge Function secret named `YOUTUBE_API_KEY` (Dashboard → Edge Functions → Secrets). It takes effect immediately. Never commit it.

**Current setup:** the key belongs to the Google Cloud project `encore-karaoke-k7m3` and is restricted to YouTube Data API v3. That project is also where to request a quota extension or rotate the key; after rotating, update the `YOUTUBE_API_KEY` secret.

Optional secrets change the daily caps: `YT_DAILY_SEARCHES` (overall, default 90; the free quota of 10,000 units covers about 99), `YT_DAILY_PER_INSTALL` (default 60) and `YT_DAILY_PER_IP` (default 90). Raise them after YouTube grants a quota extension.

The logic lives in `core.ts`, which has no Deno imports so `test/youtube-search.test.ts` runs it under Node.
