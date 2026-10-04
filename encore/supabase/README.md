# Encore's Supabase project

The project `encore` (ref `oohgawkfnwhjlqlihhju`) does two jobs:

1. **The online join link.** Phones and the KJ laptop exchange end-to-end encrypted messages over Realtime broadcast. Nothing to deploy; it needs only the publishable key in `src/shared/cloud.ts`.
2. **YouTube search** for every copy of Encore, through one YouTube API key: the `youtube-search` Edge Function, a few tables, and a catalog of popular karaoke videos.

## YouTube search

`functions/youtube-search` takes `POST { q, installId }` and returns `{ ok: true, results }` or `{ ok: false, error, code }`. It caches results (fresh for 7 days, kept at most 30, per YouTube's storage rule) and caps uncached searches per day, overall, per installation and per IP address. Counters reset at midnight Pacific time, like YouTube's quota.

Setup, once:

1. Apply the migrations in `migrations/` in order (SQL editor, or `supabase db push`). The catalog migration turns on `pg_cron` and `pg_net` and schedules its own timer; its function URL and publishable key are this project's, so change them for another project.
2. Deploy the function with JWT verification off; Encore sends the publishable key, which isn't a JWT:
   `supabase functions deploy youtube-search --no-verify-jwt`
3. In Google Cloud, create a project for Encore, enable **YouTube Data API v3**, and create an API key restricted to that API.
4. Add it as an Edge Function secret named `YOUTUBE_API_KEY` (Dashboard → Edge Functions → Secrets). It takes effect immediately. Never commit it.

**Current setup:** the key belongs to the Google Cloud project `encore-karaoke-k7m3` and is restricted to YouTube Data API v3. That project is also where to request a quota extension or rotate the key; after rotating, update the `YOUTUBE_API_KEY` secret.

Optional secrets change the daily caps: `YT_DAILY_SEARCHES` (overall, default 90; the free quota of 10,000 units covers about 99), `YT_DAILY_PER_INSTALL` (default 60) and `YT_DAILY_PER_IP` (default 90). Raise them after YouTube grants a quota extension.

### Shared reports

Every copy of Encore reports YouTube videos that won't play inside it (detected from YouTube's own player errors) and videos a KJ marks **Not karaoke**:
- `POST { action: 'report', installId, videoId, kind }`, where kind is `refused`, `not_karaoke`, or `plays` (it played after all, which clears the `refused` reports).
- `POST { action: 'check', ids }`.

A video is hidden from everyone's searches, and swapped out of queues, once enough *different networks* report it in 30 days:
- 2 for "won't play" (`YT_REFUSED_REPORTS`);
- 3 for "not karaoke" (`YT_NOT_KARAOKE_REPORTS`).

What's stored, in table `yt_reports` (30 days):
- the video id and the kind of report;
- a hash of the installation;
- a hash of the network address, salted with the project's secret key (or `YT_REPORT_SALT`).

Reports are capped per installation and per address per day.

### The karaoke catalog

Most searches are answered from a catalog of the most-viewed videos on a few karaoke channels, so they never touch the daily quota. When the catalog has at least 2 matches for a search, YouTube isn't searched; otherwise it is, as before. Results are marked `cached: 'catalog'`.

- **How it's built:** only through the YouTube Data API, never by scraping. A channel's uploads are listed 50 at a time (1 unit per page), then the details of 50 videos at a time (1 unit). The import keeps the most-viewed videos that are public, embeddable and not live. For about 17,000 uploads this costs roughly 700 units, compared with 100 units for a single search.
- **When it runs:** a `pg_cron` job (`yt-catalog-tick`) calls the function every 2 minutes with `{ action: 'catalog', token }`. Each call does up to 25 API calls. Once the catalog is built, ticks do nothing until it's 25 days old. The rebuild replaces the catalog only when it finishes, and `yt_prune` drops anything older than 30 days.
- **What's stored:** table `yt_catalog` holds the video id, title, channel, thumbnail URL and duration. View counts exist only in `yt_catalog_staging` while an import is choosing, and that table is emptied once it's done.
- **Settings:** in the table `yt_catalog_job`, row 1, so changes need no redeploy:
  - `channels`: handles or `UC…` ids, currently `@SingKingKaraoke` and `@karafun`;
  - `keep`: how many videos to keep, 5000;
  - `units_per_day`: the import's daily share of the quota, 2000.

  `state` shows progress, the last error and how many videos were kept. A wrong handle shows up there as `channel not found`.
- **The token:** the job's `token` is made in the database and never leaves it; only the cron job sends it. To force a rebuild, run `update yt_catalog_job set state = '{"phase":"idle"}'; delete from yt_catalog;`.

The logic lives in `core.ts`, which has no Deno imports so `test/youtube-search.test.ts` runs it under Node.
