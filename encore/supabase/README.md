# Encore's Supabase project

The project `encore` (ref `oohgawkfnwhjlqlihhju`) does three jobs:

1. **The online join link.** Phones and the KJ laptop exchange end-to-end encrypted messages over Realtime broadcast. Nothing to deploy; it needs only the publishable key in `src/shared/cloud.ts`.
2. **YouTube search** for every copy of Encore, through one YouTube API key: the `youtube-search` Edge Function, a few tables, and a catalog of popular karaoke videos.
3. **Licensing:** KJs sign in with an emailed code, get a 14-day free trial, and can use unlock codes you give them (the `encore-license` Edge Function and a few tables). See [Licensing](#licensing-sign-in-the-free-trial-and-unlock-codes) below.
4. **Payments:** KJs buy Encore, or keep Cloud going, on Stripe's own pages (the `stripe-webhook` Edge Function, two more actions of `encore-license`, and a few more columns). Deployed (2026-10-17), **not switched on yet**: it needs the four Stripe secrets. See [Payments (Stripe)](#payments-stripe) below.

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

Do these in order. Steps 1 and 3 change the live project, so check with Matthew first. **On the live `encore` project all five are done:** steps 1 and 3 on 2026-10-05 with his go-ahead, and steps 2, 4 and 5 by Matthew by 2026-10-16. The list is also how to set up another project, or redo this one.

1. **Apply the migration** (SQL editor, or `supabase db push`): `migrations/20261005000000_licensing.sql`. It makes the tables and the functions below, and gives the public keys no access to any of them.
2. **Make the signing key.** From the `encore/` folder, run `npm run license:key`. It writes the public key into `src/shared/license-key.ts` (commit that file) and the private key to a file in your home folder, without showing it. Add that file's one line as the Edge Function secret `LICENSE_SIGNING_KEY` (Dashboard → Edge Functions → Secrets), keep a copy in a password manager, then delete the file. Never put it in the code, a commit or a chat. If it's ever lost, run the script again and ship a new release: every installed copy only trusts the public key built into it. (To change keys without breaking installed copies, see the comments at the top of `scripts/make-license-key.mjs`.)
3. **Deploy the function** with JWT verification **on**, which is the default and the opposite of `youtube-search` (callers are signed-in KJs): `supabase functions deploy encore-license`.
4. **Set up the sign-in email** (Dashboard → Authentication):
   - **Providers → Email:** on, with "Allow new users to sign up" on. Nobody types a password. Set **Email OTP Length** to **6**: a new project sends 8-digit codes, and the app and its docs say 6 (the app accepts 6 to 10, so it works either way, but the words would be wrong).
   - **Emails → Templates:** edit **both** "Magic link or OTP" (used by KJs who've signed in before) and "Confirm sign up" (used the first time). Replace the whole message body so the email shows the code and no link, for example `<h2>Your Encore code</h2><p>Type this into Encore: <strong>{{ .Token }}</strong></p><p>It expires soon. If you didn't ask for it, ignore this email.</p>`, and change the subjects too (they still say "sign-in link" and "Confirm Your Signup").
     - Why both, and why the whole body: the stock emails hold a link, `{{ .ConfirmationURL }}`, which opens the project's Site URL (`http://localhost:3000` until it's changed). A customer who clicks it sees "Unable to connect" and never gets the code. Clicking it also confirms the address, which is easy to mistake for it working.
   - **Emails → SMTP Settings:** use your own sender. Supabase's built-in one has rate limits and isn't meant for production. With Resend: host `smtp.resend.com`, port `465`, username `resend`, and as the password a Resend API key made for this project (Resend → API Keys → Sending access), pasted straight into the dashboard and never into chat or code. The sender address must be on a domain verified in Resend. On the live project it's `hello@scriblio.co`, named Encore, on the domain the Scriblio project already uses, so no new DNS records were needed.
   - **Optional:** Authentication → URL Configuration → Site URL: set it to a real page such as `https://sing.scriblio.co/encore`, so no link ever leads to localhost.
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

### When something's off

- **The app says "Encore's license service isn't switched on yet":** the secret `LICENSE_SIGNING_KEY` isn't set (Dashboard → Edge Functions → Secrets, where only the names and a digest are shown), or isn't a usable key (the function's logs then say `LICENSE_SIGNING_KEY is not a usable key`). The 14-day trial doesn't start while this is the case. Add it, wait a minute, press **Check again**.
- **The sign-in email has a link, or the link opens localhost:** the templates still hold `{{ .ConfirmationURL }}` (see step 4). Fix both templates.
- **No email arrives:** look in spam, then Authentication → Logs for a send error, and Resend → Logs. Supabase allows one code per account a minute, and the built-in sender only a few emails an hour.
- **"The Auth server turned down a token" in the function's logs:** the KJ's session is no longer valid. They sign in again.
- **The codes are wrong or used up:** `select c.note, c.uses, c.max_uses, c.revoked from unlock_codes c order by c.created_at desc;` (see "Giving out and turning off unlock codes").

## Payments (Stripe)

`functions/stripe-webhook`, two more actions of `functions/encore-license` (`checkout` and `portal`), and the migration `migrations/20261016000000_stripe.sql` let a KJ buy Encore ($149 once, with a year of Cloud) and keep Cloud going ($49 a year) on Stripe's own pages. The plan and how it works are in [`docs/LICENSING.md`](../docs/LICENSING.md) ("Step 2: as built"). **Applied and deployed to the live project on 2026-10-17, and dark.** Until the Stripe secrets exist, everything here is off: the console shows no prices and no buttons, and the webhook answers "not switched on".

Nothing here touches YouTube, and no purchase changes a YouTube feature (YouTube's policies forbid charging for them).

### Switching it on, in this order

Do the whole thing in **Stripe's test mode** first (the "Test mode" switch at the top of the Stripe Dashboard). Test and live mode have separate keys, products, webhooks and customers, so you do it all again, with the live ones, when you're ready. Steps 4 and 5 change the live Supabase project, so check with Matthew first. **Done so far (2026-10-17):** the sandbox side of steps 2 and 3, with the ids in `docs/HANDOFF.md`, and steps 4 and 5 on the live Supabase project (with Matthew's go-ahead). Left: step 6, the four secrets, and trying a purchase. Nothing is in live mode.

1. **The join site's `/thanks` page,** where Stripe sends a KJ after paying (`sing.scriblio.co/thanks`; it only says "thank you" and what to do if Encore hasn't noticed). **Already live** (2026-10-17): Vercel's production branch is `main`, and the page is in the join site's build.
2. **In Stripe, make the two prices** (Product catalog → Add product):
   - **Encore:** a one-time price, $149 USD.
   - **Encore Cloud:** a recurring price, $49 USD every year.

   Copy each price's id (it starts `price_`).
3. **In Stripe, set up the rest:**
   - **Settings → Billing → Customer portal:** turn it on. Let customers update their payment method and cancel subscriptions (at the end of the period is the kinder choice). Save. Without this, *Manage billing* fails.
   - **Settings → Customer emails:** turn on emails for successful payments, so customers get a receipt.
   - **Workbench (the Developers drawer) → Webhooks → Add destination:** scope *Your account*, payload style *Snapshot*, the account's current API version (the function reads both the old and the new shape of an invoice, so any recent version works), type *Webhook endpoint*. The URL is `https://oohgawkfnwhjlqlihhju.supabase.co/functions/v1/stripe-webhook`, and the events are exactly these four: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid` and `invoice.payment_failed`. After creating it, the destination's page shows the **Signing secret** (it starts `whsec_`; the eye icon reveals it).
   - **Developers → API keys:** the **Secret key** (starts `sk_test_` in test mode). For live mode, a restricted key is safer: let it write Checkout Sessions and Customer portal sessions, and read Subscriptions and Customers. If the function's logs ever say "Stripe 403", add the permission it names.
4. **Apply the migration** `migrations/20261016000000_stripe.sql` (SQL editor, or `supabase db push`). It adds two columns to `licenses`, a table of Stripe event ids, and two functions only the service can run (`license_stripe_apply`, and `revoke_purchase` which you run by hand for a refund).
5. **Deploy the functions.** The webhook with JWT verification **off**, since Stripe sends no Supabase token (what keeps strangers out is Stripe's signature); `encore-license` as before, with it **on**:
   - `supabase functions deploy stripe-webhook --no-verify-jwt`
   - `supabase functions deploy encore-license`
6. **Add the secrets** (Dashboard → Edge Functions → Secrets), pasted straight into the dashboard and never into chat or code:
   - `STRIPE_SECRET_KEY`: the secret key from step 3.
   - `STRIPE_PRICE_APP` and `STRIPE_PRICE_CLOUD`: the two price ids from step 2.
   - `STRIPE_WEBHOOK_SECRET`: the signing secret from step 3.

   Buying switches on once the first three exist; the webhook, once the fourth does. Add all four before telling anyone, or someone could pay before the webhook can hear about it (Stripe retries a failed webhook for a few days, so nothing is lost, but they'd wait).

   Optional: `STRIPE_AUTOMATIC_TAX=true` (have Stripe work out sales tax or VAT; needs Stripe Tax set up first), `STRIPE_GRACE_DAYS` (default 7: how long Cloud stays on after a renewal fails), and `PAYMENT_SUCCESS_URL`, `PAYMENT_CANCEL_URL`, `PAYMENT_RETURN_URL` (default to `https://sing.scriblio.co/thanks`, `/encore` and `/thanks`).
7. **Update `TERMS.md` and `PRIVACY.md`** before real money: the terms still say Encore isn't on sale yet, and the privacy policy doesn't mention Stripe. Proposed wording, and the choices in it (refund window, tax), are in `docs/LICENSING.md`; nothing has been changed in either file.

### Trying it

Your own account is the owner, which is refused a checkout (it already has everything), so use a second email, such as `you+test@gmail.com`.

1. Sign in to Encore with that email. The trial starts.
2. Settings → Your Encore → **Buy Encore · $149**. Stripe's page opens in your browser. Pay with the test card `4242 4242 4242 4242`, any future date, any three digits and any postcode.
3. Within about ten seconds Encore says **Encore is yours. Cloud until** a year from today, and *Manage billing* appears. *Check again* does the same if you're impatient.
4. To try renewing Cloud, make its end close: `update licenses set cloud_until = now() + interval '10 days' where user_id = (select id from auth.users where email = 'you+test@gmail.com');`, press *Check again*, and **Keep Cloud going** appears. Pay; the end moves out a year, from where it was.
5. See what Stripe sent: Stripe → Workbench → Webhooks → the destination → Event deliveries (each should say 200). A failed one can be resent from there once the cause is fixed.
6. Start over for that email: `select revoke_purchase('you+test@gmail.com');` (their trial and unlock codes are left alone).

To rehearse a failed renewal or a year passing, use Stripe's **test clocks** (search the Dashboard for "test clocks"), and the test card `4000 0000 0000 0341`, which saves fine and then fails when charged.

**Before going live,** clear the test purchases out of the database, because a test customer id means nothing to live mode and would break *Manage billing* for that account: for each test account `select revoke_purchase('…');` and then `update licenses set stripe_customer_id = null, stripe_subscription_id = null where stripe_customer_id is not null;` (only safe while every customer in there is a test one), and `delete from stripe_events;`. Then repeat steps 2, 3 and 6 with live mode's prices, webhook and keys.

### Who has paid, refunds, and when something's off

```sql
select u.email, l.app_forever, l.cloud_until, l.stripe_customer_id, l.stripe_subscription_id
from licenses l join auth.users u on u.id = l.user_id
where l.stripe_customer_id is not null
order by l.updated_at desc;

select * from stripe_events order by received_at desc limit 20;   -- what the webhook has applied
```

- **A refund:** refund in Stripe (Payments → the payment → Refund), then `select revoke_purchase('them@example.com');`. That takes back Encore and Cloud and leaves their trial and unlock codes alone. To take back only the last year of Cloud: `update licenses set cloud_until = cloud_until - interval '1 year' where user_id = (select id from auth.users where lower(email) = 'them@example.com');`. Encore notices at the next check-in (at most 12 hours, or when they press *Check again*; a laptop that's offline keeps its last pass for up to 14 days).
- **"Buying isn't switched on yet" in Encore:** one of `STRIPE_SECRET_KEY`, `STRIPE_PRICE_APP` or `STRIPE_PRICE_CLOUD` is missing. The console also hides the buttons then.
- **Paid, but Encore didn't unlock:** look at the destination's Event deliveries in Stripe. **503** means `STRIPE_WEBHOOK_SECRET` isn't set. **400** means the secret is wrong (a test secret for a live endpoint, say) or the call wasn't Stripe's. **409** means the customer wasn't linked to an account yet; Stripe retries by itself. **500** means a database error: is the migration applied? The function's logs say which. Once fixed, resend the event from Stripe. Then press *Check again* in Encore.
- **A renewal was paid but the date didn't move:** check that `invoice.paid` is one of the endpoint's events.
- **"Stripe 400 … resource_missing" in the function's logs:** a price id doesn't exist in the mode the secret key belongs to (a live price with a test key, or the other way round).
- **"Cloud is already set to renew":** the account has a running subscription in Stripe. *Manage billing* is the place to change or cancel it.