# Encore's Supabase project

The project `encore` (ref `oohgawkfnwhjlqlihhju`) does three jobs:

1. **The online join link.** Phones and the KJ laptop exchange end-to-end encrypted messages over Realtime broadcast. Nothing to deploy; it needs only the publishable key in `src/shared/cloud.ts`.
2. **YouTube search** for every copy of Encore, through one YouTube API key: the `youtube-search` Edge Function, a few tables, and a catalog of popular karaoke videos.
3. **Licensing:** KJs sign in with an emailed code, get a 14-day free trial, and can use unlock codes you give them (the `encore-license` Edge Function and a few tables). See [Licensing](#licensing-sign-in-the-free-trial-and-unlock-codes) below.

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

## Licensing: sign-in, the free trial and unlock codes

`functions/encore-license` and the migration `migrations/20261005000000_licensing.sql` decide what each KJ's Encore may do. A KJ signs in with their email (a 6-digit code, no password), gets a 14-day free trial, and can use an unlock code you give them. The laptop asks this function what the account has and gets back a **pass**: a small note, signed with a key only this function holds, saying what the account may do. The app checks it with the public key built into it (`src/shared/license-key.ts`) and keeps running a show with no internet for up to 14 days on one pass. The plan is in [`docs/LICENSING.md`](../docs/LICENSING.md).

Nothing here touches YouTube. Search, pasted links and the player page don't ask this service anything, and no plan or code changes them (YouTube's policies forbid charging for them).

### Setting it up, once

Do these in order. Steps 1 and 3 change the live project, so check with Matthew first. **On the live `encore` project, steps 1 and 3 were done on 2026-10-05 with his go-ahead; steps 2, 4 and 5 are still his.** The list is also how to set up another project, or redo this one.

1. **Apply the migration** (SQL editor, or `supabase db push`): `migrations/20261005000000_licensing.sql`. It makes the tables and the functions below, and gives the public keys no access to any of them.
2. **Make the signing key.** From the `encore/` folder, run `npm run license:key`. It writes the public key into `src/shared/license-key.ts` (commit that file) and the private key to a file in your home folder, without showing it. Add that file's one line as the Edge Function secret `LICENSE_SIGNING_KEY` (Dashboard → Edge Functions → Secrets), keep a copy in a password manager, then delete the file. Never put it in the code, a commit or a chat. If it's ever lost, run the script again and ship a new release: every installed copy only trusts the public key built into it. (To change keys without breaking installed copies, see the comments at the top of `scripts/make-license-key.mjs`.)
3. **Deploy the function** with JWT verification **on**, which is the default and the opposite of `youtube-search` (callers are signed-in KJs): `supabase functions deploy encore-license`.
4. **Set up the sign-in email** (Dashboard → Authentication):
   - **Providers → Email:** on, with "Allow new users to sign up" on. Nobody types a password.
   - **SMTP settings:** use your own sender. Supabase's built-in one sends only a few emails an hour, fine for testing and no good for customers. With Resend: host `smtp.resend.com`, port `465`, username `resend`, password a Resend API key, and a sender address on a domain you've verified with Resend (Resend's SMTP page has the current settings).
   - **Email templates:** edit **both** "Magic link" (used by KJs who've signed in before) and "Confirm signup" (used the first time) so they show the code instead of a link. For example: `<h2>Your Encore code</h2><p>Type this into Encore: <strong>{{ .Token }}</strong></p><p>It expires soon. If you didn't ask for it, ignore this email.</p>`
5. **Make yourself the owner.** Sign in to Encore once with your email (that makes the account), then in the SQL editor run `select set_owner('you@example.com');` and press **Check again** in Encore, under Settings → Your Encore. `select set_owner('you@example.com', false);` undoes it, which is handy for trying the trial yourself.

### Giving out and turning off unlock codes

Run these in the SQL editor. Only you (there) and the function can; the public keys can't.

```sql
select make_unlock_code('for Dave');                           -- Encore and Cloud, forever, for one KJ
select make_unlock_code('the band', 'app', 3);                 -- Encore forever, no Cloud, for three KJs
select make_unlock_code('contest prize', 'cloud_year', 1, 30); -- a year of Cloud, good for 30 days
```

It shows the code once, like `ENC-7K4Q-M2XP-9R8T`. Only a fingerprint is kept, so copy it then. KJs can type it any way: lower case, with spaces, without the dashes. The note is for you ("for Dave"); it's never shown to anyone.

```sql
select revoke_unlock_code('for Dave');             -- by note (every code with that note)...
select revoke_unlock_code('ENC-7K4Q-M2XP-9R8T');   -- ...or by the code itself
```

A turned-off code stops counting the next time that KJ's laptop checks in: when Encore starts, every 12 hours, and whenever they press Check again. A laptop that's offline keeps its last pass for up to 14 days, so it's two weeks at the very most.

To see who has what:

```sql
select c.note, c.grants, c.uses, c.max_uses, c.revoked, u.email, r.redeemed_at
from unlock_codes c
left join code_redemptions r on r.code_id = c.id
left join auth.users u on u.id = r.user_id
order by c.created_at desc;

select u.email, l.owner, l.trial_ends_at, l.app_forever, l.cloud_until
from licenses l join auth.users u on u.id = l.user_id
order by l.created_at desc;
```

### How it works

- **Questions the laptop asks** (`POST`, with the KJ's session token): `{ action: 'status' }`, `{ action: 'startTrial' }` and `{ action: 'redeem', code }`, each with the laptop's `installId`. The answer is `{ ok: true, pass, trialAvailable }`, or `{ ok: false, error, code }` with `error` written for the KJ to read.
- **The free trial** starts by itself when a KJ signs in. There's one per account and one per laptop, so a new email on the same laptop doesn't get another. The laptop's trial is remembered (without a link to a person) even if the account is deleted.
- **Unlock codes** are stored only as a SHA-256 hash. What a code grants isn't copied onto the account; the function works it out from the codes the account has used each time it's asked, which is why turning a code off works. A year of Cloud adds a year after whatever Cloud the account already has.
- **The pass** is a JWT signed with Ed25519: the account, the email, the laptop it's for, whether Encore is theirs, when Cloud and the trial end, whether they're the owner, and when it stops being good (14 days). A pass made out to another laptop or another account is no use.
- **Guessing codes** is the one thing to guard against, so tries are counted an hour at a time, per account (10) and per network address (30). Addresses are only kept as a salted hash.
- **The code** is in `functions/encore-license/`: `core.ts` has no Deno imports, `pass.ts` and `codes.ts` are shared with the app, and `store.ts` is the REST layer over the database functions. `test/license-*.test.ts` run it all, including the real SQL in an in-process Postgres (PGlite).

Secrets: `LICENSE_SIGNING_KEY` (required). Optional: `LICENSE_KEY_ID` (default `k1`, goes in the pass header), `LICENSE_PASS_DAYS` and `LICENSE_TRIAL_DAYS` (default 14), `LICENSE_REDEEM_PER_HOUR` (10), `LICENSE_REDEEM_PER_IP_HOUR` (30), and `LICENSE_SALT` (defaults to the project's secret key). The Supabase URL and keys the function needs are provided automatically.