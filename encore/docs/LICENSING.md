# Encore: accounts, trial, unlock codes and payments

This is the brief for selling Encore. It was agreed with Matthew. Read `docs/HANDOFF.md` first for how the app works; this file covers only licensing.

The work comes in three steps. **Step 1 is built** (accounts, a free trial, unlock codes and the checks in the app, with no payments yet; see "Step 1: as built" below). It waits for Matthew to set up the backend, with the steps in `supabase/README.md` under "Licensing". Matthew will give codes to a few KJ friends as beta testers and watch what the cloud costs per KJ, then step 2 adds Stripe.

## Decisions already made (don't revisit)

- **Payments go through Stripe, not Microsoft Store billing.** Store policy 10.8.1 lets apps other than games use their own payment system for digital items. The Store listing is only for certification and distribution.
- **Pricing:**
  - **Encore, $149 once.** The app is the KJ's forever. The price includes the first year of Encore Cloud.
  - **Encore Cloud, $49 a year after that.** It's optional: without it Encore still works, with phones joining over the venue Wi-Fi.
  - **A 14-day free trial with everything.** There's no permanent free tier and no singer cap.
  - **Singers never pay.** Only KJs buy.
- **Unlock codes:**
  - Matthew can give out codes that unlock everything (the app and Cloud) forever, with no payment.
  - Each code carries a note ("for Dave"), works for one KJ unless made otherwise, and can be revoked.
- **The unlock belongs to the KJ's account (their email), not the laptop.** A new computer or a reinstall is just a sign-in.
- **Matthew's own account is marked as the owner**, with everything forever and no code needed.

## Rules that limit the design

- **YouTube (Developer Policies):**
  - Apps must not charge users to watch content in the embedded player (III.F.3.a).
  - Apps must not sell access to YouTube API Services or any part of them (III.G.1.b).
  - So **no YouTube feature may be part of what any paid plan unlocks.** YouTube search, pasted links, previews and the Not karaoke button all work the same in every state where Encore can run a show (owner, bought, code or trial). Encore Cloud must never include YouTube.
  - The money comes from the KJ software as a whole. `docs/YOUTUBE_AUDIT.md` must describe this in its monetization answers before Matthew submits the form.
- **Don't decide access only in the app's interface.** Decisions come from a pass the server signs, which the laptop checks with a public key built into the app.
- **Never cut off a show that's running.** If access runs out mid-show, the show carries on until the KJ starts a new list or the app is closed.
- **Singers never see a sales pitch.** If the KJ's Encore isn't active, phones get a neutral message ("This show isn't open yet. Ask the KJ."). Prices and buttons are only ever in the console.
- **Secrets:**
  - Never commit or paste into chat the Supabase service-role key, the signing private key, or (in step 2) Stripe secret keys.
  - They live only as Supabase Edge Function secrets. The app ships only the publishable Supabase key (`src/shared/cloud.ts`) and the license public key.
- **Production changes need Matthew's go-ahead:**
  - Applying migrations to the `encore` Supabase project and deploying Edge Functions change production at once, so check with Matthew first.
  - Every push to the branch also deploys `sing.scriblio.co` (see HANDOFF).

## What Encore Cloud is

Cloud is the part that costs money to run every month: the **online join link** (the Supabase Realtime relay plus the `sing.scriblio.co` page) and **lock-screen alerts** (Web Push needs the online link).

Without Cloud, phones join with the Wi-Fi link, which is already the fallback today (`joinUrl()` in `src/server/app.ts`). Printed QR codes then use the Wi-Fi address and Settings warns that it can change (`DjView.print.lasting`).

YouTube search is **not** part of Cloud (see the rules above).

## Step 1: accounts, trial, unlock codes, checks in the app

### Signing in

- **Use Supabase Auth with email codes, not magic links.**
  - A link opens the browser, not the desktop app. A 6-digit code is typed into Encore: `signInWithOtp({ email })`, then `verifyOtp({ email, token, type: 'email' })`.
  - The email template has to show `{{ .Token }}`.
- **The laptop server holds the session.**
  - The console never talks to Supabase Auth itself: it asks the server over the existing DJ socket (new DJ actions: `accountSendCode`, `accountVerify`, `accountSignOut`, `redeemCode`, `refreshLicense`).
  - The server keeps the session in the data folder (`data/account.json`, mode 0600, like `relay.json`).
- **Matthew sets up the email side before launch:**
  - Turn on the Email provider with OTP.
  - Add his own SMTP (for example Resend or Postmark). Supabase's built-in email sender is limited to a few emails an hour, which is enough for testing but not for customers.

### The license service (a Supabase Edge Function, `encore-license`)

- **Runs with `verify_jwt` on,** since callers are signed-in KJs. Keep the logic in a `core.ts` with a swappable store, like `youtube-search`, so it can be tested without Supabase.
- **Actions:**
  - `status { installId }`: works out what this KJ has and returns a fresh signed pass.
  - `startTrial { installId }`: starts the 14-day trial if this account and this laptop haven't had one, then returns a pass. One trial per account and one per installation, so new emails on the same laptop don't buy endless trials.
  - `redeem { code, installId }`: checks the code (not revoked, not expired, uses left, not already used by this account), records the redemption and returns a pass. Rate-limit attempts per account and per IP (for example 10 an hour).
- **The pass:**
  - A JWT signed with a private key kept only as the Edge Function secret `LICENSE_SIGNING_KEY` (Ed25519, or ES256 if Deno or Node gives trouble). The public key is committed in the app (`src/shared/license-key.ts`).
  - Payload: `sub` (user id), `email`, `installId`, `app` (true when the app is theirs: owner, code or purchase), `cloudUntil` (an ISO date, `"forever"` or null), `trialUntil` (an ISO date or null), `owner` (bool), `iat`, and `exp`.
  - `exp` is about 14 days out. That's how long the laptop can go without internet before it needs to check in again.
- **Tables** (one migration; RLS on everywhere):
  - **`licenses`:** one row per user (`user_id` primary key, referencing `auth.users`), with `app_forever`, `cloud_until` (null means none), `cloud_forever`, `trial_ends_at`, `owner`, `source`, `created_at` and `updated_at`.
    - KJs may read their own row (policy `auth.uid() = user_id`). Only the Edge Function writes, using the service role.
  - **`unlock_codes`:** `id`, `code_hash` (SHA-256 of the normalized code, unique; plain codes are never stored), `note`, `grants` (`'forever'` for the app and Cloud forever, `'app'`, or `'cloud_year'`), `max_uses` (default 1), `uses`, `revoked`, `expires_at` and `created_at`.
    - No policies: only the service role reads it.
  - **`code_redemptions`:** `code_id`, `user_id`, `install_id` and `redeemed_at`, unique on (`code_id`, `user_id`).
  - **`trials`:** `install_id` (primary key), `user_id` and `started_at`.
- **How Matthew makes and revokes codes:**
  - Add SQL functions he runs in the Supabase SQL editor. They're `security definer` and only callable by the service role or postgres, never the publishable key.
    - `make_unlock_code(note text, grants text default 'forever', max_uses int default 1) returns text`. It creates a code like `ENC-7K4Q-M2XP-9R8T` (Crockford base32, so no I, L, O or U, and 60 random bits), stores only its hash and returns the plain code once.
    - `revoke_unlock_code(code_or_note text)`.
    - `set_owner(email text)`, which marks Matthew's account as the owner after he first signs in.
  - Write the steps in `supabase/README.md`, in plain words.
- **Revoking:** a revoked code stops working at that KJ's next check-in, so within the 14-day pass life.

### The laptop: what's allowed in each state

`src/server/license.ts` keeps the current pass:
- It checks the signature with the built-in public key and refreshes on start, every 12 hours, and after any sign-in, trial or redemption.
- It saves the pass in the data folder, so the app starts offline.
- It turns the pass into one state:

| State | Meaning | Shows (singers join, Call next) | Encore Cloud (online link, lock-screen alerts) |
| --- | --- | --- | --- |
| `owner` | Matthew | yes | yes |
| `licensed` | app forever (a code, or a purchase in step 2) | yes | while `cloudUntil` is in the future or `"forever"` |
| `trial` | inside 14 days | yes | yes |
| `ended` | trial over, nothing bought | no (see below) | no |
| `signed-out` | no account yet | no, until they sign in and start the trial | no |
| `offline-expired` | the pass's `exp` has passed with no internet | as `ended`, but Settings says "connect to the internet to check your license" | no |

- **Turning a show off** (`ended`, `signed-out`, `offline-expired`):
  - The console opens normally, with library, settings and printing, but shows a panel: "Start your free trial / Enter a code" (step 2 adds "Buy Encore").
  - Phone joins and the KJ's *Add singer* are refused. Phones get the neutral message.
  - A show that already has singers keeps running (the never-cut-off rule).
- **Turning Cloud off:**
  - Don't start the relay (`startRelay()`), so `joinUrl()` falls back to the Wi-Fi link.
  - Hide or disable *Alerts when my phone is locked* (`push` in `SingerView`).
  - Settings shows "Encore Cloud: the online link and lock-screen alerts need Cloud".
- **Keep these working:**
  - `npm run demo` and the tests skip the license entirely (for example `ENCORE_LICENSE=off`, or an option on `createApp`).
  - Encore must never refuse to open.

### The console

- **Settings → a new first section, "Your Encore":**
  - **Signed out:** an email box, *Send code*, a code box, *Sign in*.
  - **Signed in:** the email, then the plan in words:
    - "Free trial: 9 days left";
    - "Encore is yours. Cloud until 3 May 2027";
    - "Encore is yours forever (unlock code)";
    - "Owner".
  - Below that: *Have an unlock code?* with a box and *Unlock*, and *Sign out*.
- **A small badge in the console header during the trial** ("Trial: 9 days left") that opens Settings.
- **The first-run guide (`SetupGuide.tsx`) gets a first step:** "Sign in with your email to start your free 14-day trial."

### Words, privacy and terms

- **Write in plain words** in the app and the docs: "trial", "unlock code", "yours forever", "Encore Cloud". Not "entitlement" or "SKU".
- **Update `PRIVACY.md`** (rendered at `sing.scriblio.co/privacy`): KJs' email addresses and license records are kept by Scriblio in Supabase, along with which installation used a trial or code. Singers still give no email.
- **Add to `TERMS.md`:** the trial, that unlock codes are personal and can be revoked if shared publicly, and what Cloud includes.

### Tests (keep `npm test` and `npm run typecheck` green)

- **License core logic, with an in-memory store:**
  - trial once per account and once per installation;
  - code redemption: single use, multi-use limits, revoked, expired, and already redeemed by this account;
  - owner;
  - the pass contents.
- **Checking the pass on the laptop:**
  - a good signature;
  - a tampered payload or a wrong key is rejected;
  - an expired `exp` gives `offline-expired`.
- **The states in the app:**
  - phone join and *Add singer* are refused when `ended`;
  - a running show isn't cut off;
  - without Cloud, the relay doesn't start and `joinUrl()` is the Wi-Fi link;
  - YouTube search works in every state that can run a show (a test that guards the YouTube rule).
- **The code format:** generation and normalization (spaces, lowercase, missing dashes).

### Step 1: as built

Built on PR #4. The service is `supabase/functions/encore-license/`, the tables and the functions Matthew runs are `supabase/migrations/20261005000000_licensing.sql`, the laptop side is `src/server/{account,license,access}.ts` with `src/shared/license*.ts`, and the console is `src/client/dj/License.tsx`. How it differs from the plan above, or adds to it:

- **What a code grants is worked out each time, not copied.** When the service signs a pass it reads the codes the account has used that are still on, so turning a code off takes effect at the next check-in without touching any account. `licenses` holds only what that doesn't cover: the owner flag, a purchase (step 2) and the trial.
- **Signing in starts the trial by itself.** The plan's separate `startTrial` is there too, for a Start button when the automatic one couldn't get through. An account that already owns Encore never uses up its laptop's trial.
- **The pass** also carries `v` (the format) and `source` (`owner`, `code`, `purchase` or `trial`, so Settings can say "unlock code"). It's an Ed25519 JWT with a key id in its header, and the app ships a list of public keys so a key can be replaced without breaking installed copies. The private key is the Edge Function secret `LICENSE_SIGNING_KEY` (43 characters of base64url); `npm run license:key` makes it without ever showing it.
- **Extras on the SQL functions:** `make_unlock_code(note, grants, max_uses, expires_in_days)` takes an optional expiry, and `set_owner(email, make_owner)` can undo itself. Codes stack: a Cloud-year code adds a year after whatever Cloud the account already has.
- **"Never cut off a show that's running" is a ticket** (`src/server/access.ts`). The show that had singers while the plan allowed it stays open, with its online link and alerts, until the KJ starts a new list or Encore is closed. It's kept in memory only, so a restart ends it. Cloud is held separately from the show.
- **Turning the clock back doesn't help.** The laptop's time never runs earlier than the pass was made, and a clock far ahead is called out in plain words instead of making every fresh pass look stale.
- **The YouTube player page doesn't follow the plan.** Its address is built from the Cloud settings as configured, never from whether the KJ's plan includes Cloud, so YouTube plays the same on every plan. `test/license-app.test.ts` checks YouTube search, pasted links and that page in all six states.
- **The backend is applied but not switched on.** On 5 October 2026, with Matthew's go-ahead, the migration was applied to the live `encore` project and `encore-license` was deployed (JWT verification on). Checked live: RLS on everywhere, the public keys can't run any of the functions, and the SQL's output matches the app's. The SQL is also tested in an in-process Postgres (PGlite) as part of `npm test`. Still to do by Matthew: the secret `LICENSE_SIGNING_KEY`, the sign-in email, and marking his account as the owner. Until then a copy built from this branch can't start a show, because no pass can be signed. Not yet seen live: a real sign-in, and the function signing a pass on Deno. `ENCORE_LICENSE=off` skips the check when running from source.

## Step 2: Stripe (later, after the beta)

- **Products:** "Encore" ($149 once, which also sets Cloud for one year) and "Encore Cloud" ($49 a year, recurring). Test mode first, with keys only as Edge Function secrets.
- **Edge Functions:**
  - `stripe-checkout` creates a Checkout session for a signed-in KJ.
  - `stripe-portal` opens Stripe's customer portal (cards, invoices, cancelling Cloud).
  - `stripe-webhook` checks Stripe's signature and handles duplicate deliveries, since Stripe retries.
    - `checkout.session.completed` sets `app_forever` and `cloud_until = now + 1 year`.
    - `customer.subscription.updated` and `.deleted` keep `cloud_until` in step.
    - `invoice.payment_failed`: keep Cloud for 7 days of grace while Stripe retries.
  - Turn on Stripe Tax.
- **Console:** *Buy Encore* and *Renew Cloud* buttons open Checkout in the browser. When the KJ comes back, `refreshLicense`.
- **Docs:** a refund policy in `TERMS.md`.

## Step 3: selling

- **A pricing page on `sing.scriblio.co`** (static, like `/encore`): $149 once with a year of Cloud, $49 a year for Cloud, and the 14-day trial.
- **Update `docs/YOUTUBE_AUDIT.md`:** monetization answers that match the YouTube rules above.
- **Fill in the Microsoft Store identity values** (`STORE.md`).

## The four questions, answered (Matthew, 4 October 2026)

1. **After the trial ends with nothing bought:** the console opens but there are no new shows, as written above. No allowance.
2. **Time offline before a check-in is needed:** 14 days.
3. **The trial needs an email sign-in:** yes.
4. **Email service for the sign-in codes:** Resend.
