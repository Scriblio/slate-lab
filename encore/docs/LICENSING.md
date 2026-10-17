# Encore: accounts, trial, unlock codes and payments

This is the brief for selling Encore. It was agreed with Matthew. Read `docs/HANDOFF.md` first for how the app works; this file covers only licensing.

The work comes in three steps (with a step 2b, Encore Monthly, built after step 2). **Step 1 is built and live** (accounts, a free trial, unlock codes and the checks in the app, with no payments yet; see "Step 1: as built" below; the set-up steps are in `supabase/README.md` under "Licensing"). **Step 2 (Stripe) is built, tested and deployed to the live project (17 October 2026), and not switched on:** the migration is applied and both functions are deployed, but none of the four Stripe secrets exist yet, so nothing can be bought (see "Step 2: as built" below, and "Payments" in `supabase/README.md` for the steps that switch it on). Matthew gives codes to a few KJ friends as beta testers and watches what the cloud costs per KJ, then switches on payments in Stripe's test mode first.

## Decisions already made (don't revisit)

- **Payments go through Stripe, not Microsoft Store billing.** Store policy 10.8.1 lets apps other than games use their own payment system for digital items. The Store listing is only for certification and distribution.
- **Pricing:**
  - **Encore, $149 once.** The app is the KJ's forever. The price includes the first year of Encore Cloud.
  - **Encore Cloud, $49 a year after that.** It's optional: without it Encore still works, with phones joining over the venue Wi-Fi.
  - **Encore Monthly, $29 a month** (decided 17 October 2026): Encore and Cloud together, for as long as the months are paid for. The cheaper way in for someone who isn't ready for $149. It never competes with the $149 on price: five payments ($145) are still under $149, so buying once is cheaper for anyone who stays longer than five months, and the console says so.
    - When it's cancelled it runs to the end of the month that was paid for, then goes back to the trial-ended state (the console opens, no new shows).
    - A subscriber may buy Encore outright at any time. The subscription is then switched off from renewing, there's no credit at launch, and they keep the month they paid for.
    - Three days of grace after the last paid month, so a renewal that lands while a laptop is offline at a gig doesn't lock anyone out.
    - Refunds: none for the month in progress; the $149 keeps its 30 days.
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
- **The backend is live and switched on.** On 5 October 2026, with Matthew's go-ahead, the migration was applied to the live `encore` project and `encore-license` was deployed (JWT verification on). Checked live: RLS on everywhere, the public keys can't run any of the functions, and the SQL's output matches the app's. The SQL is also tested in an in-process Postgres (PGlite) as part of `npm test`. Matthew then added the secret `LICENSE_SIGNING_KEY` and set up the sign-in email (Resend; both templates show the code), and on 16 October made his own account the owner. A real sign-in, a pass signed on Deno, the trial and the owner state have all been seen working in the installed app. While the secret is missing the service answers "not switched on yet" and the trial doesn't start. `ENCORE_LICENSE=off` skips the check when running from source.
- **First build with sign-in: 0.2.0.** The public preview `encore-v0.1.0-preview` (0.1.0, no sign-in) stays as it is while Google's YouTube API Services review is open: Matthew told them on 16 October that the installer in the original submission needs no account. Beta builds go out as a separate pre-release, `encore-v0.2.0-beta`.

## Step 2: Stripe

The plan was: two Stripe products ("Encore", $149 once, which also gives Cloud for a year; "Encore Cloud", $49 a year), test mode first, keys only as Edge Function secrets; a function to start Checkout, one for Stripe's customer portal, and a webhook; *Buy Encore* and *Renew Cloud* buttons in the console; a refund policy in `TERMS.md`.

### Step 2: as built

Built on the branch `claude/encore-stripe` (merged as PR #5). **Applied and deployed to the live project on 17 October 2026, with Matthew's go-ahead:** the migration (recorded as `20261017124619_stripe`), `stripe-webhook` (version 1) and `encore-license` (version 4). The steps that switch it on are in `supabase/README.md` under "Payments (Stripe)". Until the Stripe secrets exist, everything here is dark: the webhook answers "not switched on", the license service offers no page to pay on, and the console shows no prices and no buttons.

**What a purchase is.** Stripe only ever sets the same two columns an unlock code's grants sit beside, `licenses.app_forever` and `licenses.cloud_until`, plus `stripe_customer_id`, `stripe_subscription_id` and `source = 'stripe'`. So the pass, the laptop and every state in the app needed no new idea of what a customer has: a purchase is `app_forever`, and the pass says `source: 'purchase'`. Unlock-code grants are still worked out at each check-in, and stack with a purchase.

**The webhook** (`supabase/functions/stripe-webhook/`, deployed with JWT verification **off**, because Stripe sends no Supabase token; what keeps strangers out is Stripe's signature). `core.ts` and `signature.ts` have no Deno imports, like the other services, so the tests run them in Node.

| Stripe event | What it does |
| --- | --- |
| `checkout.session.completed`, `checkout.session.async_payment_succeeded` | Encore bought and paid: `app_forever` on, and a year of Cloud added after any Cloud the account already has. A Cloud subscription's checkout only links the customer and the subscription; the paid year comes with its invoice. A payment that hasn't settled (bank debits) waits for `async_payment_succeeded`. |
| `invoice.paid` (of a subscription) | Adds the paid period's length to Cloud, after the later of the Cloud already there and the period's start, so paying early loses nothing. The receipt for the one-time purchase has no subscription and is ignored. Both the old and the new shape of Stripe's invoice are read. |
| `invoice.payment_failed` | The first failed attempt only: Cloud stays on until a week from then (`STRIPE_GRACE_DAYS`). It never shortens Cloud, and Stripe's retries don't extend it. |

Anything else is acknowledged and ignored. There are no `customer.subscription.*` handlers on purpose: Cloud's end is the sum of what was paid for, so cancelling just stops it renewing and Cloud runs to the end of the year paid, with no event needed.

- **Checked by hand against Stripe's rules:** the signature is HMAC-SHA256 over `timestamp.body` with the endpoint's secret, compared in constant time, with a five-minute tolerance and more than one signature allowed (a secret being rotated).
- **Each event is applied once,** by its id (table `stripe_events`), inside the database function `license_stripe_apply`, so Stripe retrying, or sending one twice at once, changes nothing.
- **An event for a customer no account is linked to yet is refused** (409) and not recorded, so Stripe tries again later; that's what happens when a renewal's invoice arrives before the checkout that links the customer. How a payment finds its account: checkout starts with the account's id (`client_reference_id` and metadata, also put on the subscription so its invoices carry it), and the Stripe customer id is saved on the license row.

**Starting a payment** is two more actions of `encore-license` (not separate functions: same sign-in check, same rate limits): `checkout { kind: 'app' | 'cloud' }` and `portal`. The answer is only the address of a Stripe-hosted page, which the service checks really is on `checkout.stripe.com` or `billing.stripe.com`, and the laptop checks again before opening it. Asking gives nothing; only the webhook does. A page is refused where it would be a mistake rather than a sale: the owner's account, Encore bought twice, Cloud without Encore, Cloud that never ends, and a second Cloud subscription (looked up in Stripe). No page to pay on is offered while the service couldn't sign a pass for what's bought. An account may ask for 20 pages an hour. The status answer says `payments` (Stripe is switched on) and `billing` (this account has paid by card); neither is part of the signed pass.

**The laptop and console.** `License.checkout(kind)` and `License.billingPortal()` (DJ actions `checkout` and `billing`) return the page's address, and the console opens it in the browser (the desktop app hands it to the default browser). After a checkout the laptop looks for the purchase every 10 seconds for 15 minutes (`checkPurchase`), picks up the new pass and the console updates by itself; later, the usual 12-hourly check or *Check again* finds a payment that came late. The buttons are in Settings → Your Encore and in the notice when the trial has ended: *Buy Encore · $149* (trial or ended), *Keep Cloud going · $49 a year* (Cloud over, never included, or ending within 60 days), and *Manage billing* (anyone who has paid by card). `offersOf` in `src/shared/license.ts` decides which show, and `PRICES` there is the one place the console names a price: it must match the two prices in Stripe, and Checkout shows the real amount before anyone pays. Only the console shows any of this; the singer's phone gets nothing, and `test/license-app.test.ts` checks it in every state.

**Still no YouTube in any plan.** Nothing in the webhook, the checkout or the buttons touches YouTube, and `test/license-app.test.ts` checks YouTube search, pasted links and the player page after a purchase as well as in every other state.

**Money matters, left for Matthew:**
- **Tax:** off. `STRIPE_AUTOMATIC_TAX=true` asks Stripe Tax to work out sales tax or VAT at checkout, but Stripe Tax has to be set up in Stripe first (and registrations are needed where tax is due). Ask an accountant; not tax advice from here.
- **Refunds are by hand.** Refund in Stripe, then in the SQL editor `select revoke_purchase('them@example.com');` takes back Encore and Cloud (their trial and unlock codes are left alone). To take back only the last year of Cloud: `update licenses set cloud_until = cloud_until - interval '1 year' where user_id = (select id from auth.users where lower(email) = 'them@example.com');`.
- **The terms.** `TERMS.md` still says Encore isn't on sale yet, and must be updated before payments are switched on. Proposed wording, for Matthew to approve or change (30 days is a common default, and a refunded sale costs less than a dispute):

  > **Buying.** Encore costs $149, once, and includes one year of Encore Cloud. After that, Encore Cloud is optional at $49 a year; it renews every year, and you can stop it any time from *Manage billing* in Encore (it stays on until the year you paid for ends). Payments are handled by Stripe, so we never see your card number. The price is shown before you pay[, with sales tax or VAT added where it applies]. If you got Encore from the Microsoft Store, the Store's terms apply to the download.
  >
  > **Refunds.** If Encore isn't right for you, email us within 30 days of buying and we'll refund your purchase in full. A Cloud renewal can be refunded within 14 days. Once we've refunded you, that purchase and the Cloud time that came with it are turned off.
- **The privacy policy** needs a line about Stripe before real money too. Proposed, for "KJ accounts and licenses" in `PRIVACY.md` (and "payments" added to what Scriblio keeps there):

  > **Payments.** If a KJ buys Encore or Encore Cloud, the payment is taken by Stripe, which receives their card and billing details under [its own privacy policy](https://stripe.com/privacy). Scriblio never sees the card number. It keeps Stripe's customer and subscription ids, so it can tell what the account has bought and open its billing page, and it can see each payment's amount, date and email address in its Stripe account. These are kept while the account exists, and for as long as the law requires us to keep records of payments.

**Tests** (all in `npm test`): the migration and `license_stripe_apply` run for real in PGlite (`stripe-sql.test.ts`, 18 tests: a purchase, repeats, stacking years, early and late Cloud, subscription periods, renewals, an invoice before its checkout, grace, `revoke_purchase`, and that the public keys can run none of it); the webhook with signed payloads and the signature check (`stripe-webhook.test.ts`); that the REST layer calls the functions the migration really defines (`stripe-store.test.ts`); the checkout and portal rules against both the in-memory store and the real SQL, and exactly what is asked of Stripe (`billing.test.ts`); and the laptop and the app (`license.test.ts`, `license-app.test.ts`, `license-state.test.ts`).

**Seen working in a browser** against a fake backend and a fake Stripe: Buy Encore in Settings and in the trial-ended notice, the "finish paying in your browser" note, the console turning to "Encore is yours" a few seconds after the payment landed, *Keep Cloud going* and *Manage billing*, and the notice reverting to the unlock code box alone when payments are switched off. Not yet seen: a real Stripe Checkout page in test mode, which needs Matthew's Stripe test keys.

## Step 2b: Encore Monthly

Built on the branch `claude/encore-monthly` (stacked on the docs branch). **Applied and deployed to the live project on 2026-10-17 (Matthew said "deploy Monthly"), against Stripe's sandbox:** the migration, both functions redeployed, and the secret `STRIPE_PRICE_MONTHLY`. It changes nothing for anyone until that secret exists (the console then shows *Subscribe · $29 a month* beside *Buy Encore*; without it everything behaves as in step 2).

**The idea.** It is paid for the way a Cloud year is, and reads the same way: the sum of the periods that were paid for. Nothing has to hear that a subscription was cancelled. The database keeps one new date, `licenses.app_until` (the end of the last paid month; `app_forever` outranks it). The license service gives Encore and Cloud while `now < app_until + 3 days` (`SUBSCRIPTION_GRACE_DAYS` in `functions/encore-license/core.ts`), and signs the pass with `source: 'subscription'`, the paid-until date as `appUntil` (so Settings can say so), and an expiry that never runs past the grace, so a lapsed subscription can't be coasted on even offline.

| What | How |
| --- | --- |
| Checkout | `checkout { kind: 'monthly' }`: a Stripe subscription page for the price in `STRIPE_PRICE_MONTHLY`, stamped `kind: monthly` (on the session and on the subscription, so its invoices say what they are). Not offered without the secret (`monthly: false` in the status answer). |
| `invoice.paid` of a monthly subscription | The webhook adds the paid period to `app_until` (`license_stripe_apply`'s new `p_app_from`/`p_app_to`): after the later of the time already there and the period's start, so paying early loses nothing and paying late doesn't give back the days in between. An invoice counts as monthly when the subscription says so, or failing that when a line carries the monthly price; anything else is a Cloud year, as before. |
| `invoice.payment_failed` | Nothing for a monthly subscription: the three days of grace are the grace. Cloud's week of grace is unchanged. |
| Buying Encore outright while subscribed | Allowed. After the purchase is recorded, the webhook sets the customer's monthly subscription to cancel at the period's end (`stripe-webhook/stripe.ts`: only ever `cancel_at_period_end`, only for `kind: monthly`), and does it again if Stripe sends the event again, so a failure is retried. |
| Refused | For the owner or anyone with Encore for good (a purchase or an unlock code); a second subscription while Stripe has one going (paid up, set to end, or being retried: asked of Stripe, so a cancelled one can be taken out again even in its days of grace); Cloud for a subscriber, which they have. |
| A lapsed subscriber | Is offered *Buy Encore* and *Subscribe* again, and is told that Encore Monthly ended ("Encore Monthly ended on 13 October 2026.", and "Your Encore Monthly has ended" across the console), never that a free trial did. The pass keeps naming `appUntil` after the grace so the console can say so, and the service no longer offers a free trial to someone who has paid for a month (they are not a newcomer). Found on 2026-10-17 by trying it on the installed app: before this, the console said "This computer has already had its free trial" to a subscriber whose month had run out. |
| Singers | See nothing. The YouTube rule is unchanged: no plan touches a YouTube feature, and `test/license-app.test.ts` now checks that on Encore Monthly too. |

**The console.** *Subscribe · $29 a month* appears beside *Buy Encore* for someone on the trial or whose trial is over, with a plain note: Encore and Cloud while subscribed, cancel any time in Manage billing (it keeps working to the end of the month paid), and buying once costs less if they'll use Encore for more than five months (`MONTHS_TO_BREAK_EVEN`). A subscriber sees "Encore Monthly: paid until 17 November 2026. Cloud is included.", *Buy Encore* (which stops the renewals) and *Manage billing*; in the few days of grace the sentence says the month has ended and where to update the card. The wording for what to do after the trial says "buy Encore, subscribe or use an unlock code" only when Encore Monthly can be subscribed to.

**Money matters, left for Matthew:** the proposed wording for `TERMS.md` gains a paragraph (below), and Microsoft Store policy 10.8.4 means the listing states all three prices (see `STORE.md`). The Store's policy 10.8.6 allows third-party subscriptions in a non-game app, on condition that value isn't taken away from people who have paid, and that if a subscription is ever discontinued, what was paid for is honoured until it runs out. Both hold here.

> **Encore Monthly.** Encore Monthly is $29 a month and includes Encore Cloud while it lasts. It renews every month until you stop it, which you can do any time from *Manage billing* in Encore; it keeps working to the end of the month you paid for. There are no refunds for a month that has begun. You can buy Encore once ($149) at any time, which also stops the monthly renewals. If a renewal doesn't go through, Encore carries on for three days so you can fix your card.

**Tests** (all in `npm test`): the new migration and function against a real Postgres (`stripe-sql.test.ts`: months added, renewals, early and late payments, repeats, an invoice before its checkout, `revoke_purchase`); the webhook reading monthly invoices in both shapes and by price, whole flows, and stopping the renewals (`stripe-webhook.test.ts`, `stripe-renewals.test.ts`); the REST layer against the migration (`stripe-store.test.ts`); the checkout rules, the pass and its grace on both the in-memory store and the real SQL (`billing.test.ts`, `license-service.test.ts`, `license-pass.test.ts`); and the laptop and the console (`license.test.ts`, `license-app.test.ts`, `license-state.test.ts`). **Seen working in a browser** against a fake backend: the Subscribe button beside Buy Encore, the subscriber's Settings, the days of grace and a lapsed subscription. **Seen working for real (2026-10-17, installed app, live project, Stripe sandbox):** subscribing with the test card (the webhook recorded the invoice and the checkout once each; "paid until" came out exactly a month on, and Stripe's subscription carries `kind: monthly` and the account), the days of grace (the sentence, *Buy Encore* and *Manage billing*, and a pass that works offline for the three days), and the lapse once the grace is over, with the fix deployed and the new installer: "Encore Monthly ended on 13 October 2026." in Settings and "Your Encore Monthly has ended" across the console, with *Buy Encore*, *Subscribe* and *Manage billing* ("See your payments or update your card."), a normal two-week pass, and no free-trial wording anywhere; and **buying Encore outright while subscribed**: the purchase was recorded (Encore for good, Cloud a year on), and Stripe's monthly subscription went to "Cancels Nov 17, 2026 / No further invoice" at the moment of the purchase (Stripe's activity log shows the webhook's request, 200 OK), so the month already paid for is kept and nothing more is charged. **Not seen yet:** a second month actually renewing (the database function was dry-run on the live project, and the webhook's reading of a renewal invoice is tested with Stripe's invoice shapes, but no real renewal has happened; Stripe's test clocks can run one) and a failed renewal.

## Step 3: selling

- **A pricing page on `sing.scriblio.co`** (static, like `/encore`): $149 once with a year of Cloud, $49 a year for Cloud, $29 a month for both, and the 14-day trial.
- **Update `docs/YOUTUBE_AUDIT.md`:** monetization answers that match the YouTube rules above.
- **Fill in the Microsoft Store identity values** (`STORE.md`).

## The four questions, answered (Matthew, 4 October 2026)

1. **After the trial ends with nothing bought:** the console opens but there are no new shows, as written above. No allowance.
2. **Time offline before a check-in is needed:** 14 days.
3. **The trial needs an email sign-in:** yes.
4. **Email service for the sign-in codes:** Resend.
