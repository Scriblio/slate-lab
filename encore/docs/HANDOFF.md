# Encore: handoff notes

Encore is a karaoke hosting (KJ) app by Scriblio (Matthew Lancaster). It's being built toward a paid Microsoft Store release. This file is for whoever picks the work up next: a person, or a local Claude Code session.

## Where things are

- **Code:** repo `Scriblio/slate-lab`, folder `encore/`. Nothing else in the repo belongs to Encore except `.github/workflows/encore-desktop.yml`.
- **Branch:** `main`. [Scriblio/slate-lab#4](https://github.com/Scriblio/slate-lab/pull/4), which held everything up to licensing step 1, was merged on 2026-10-16, and its description is still the most complete feature list. Work since goes through pull requests from `claude/encore-*` branches: licensing step 2 (Stripe) is `claude/encore-stripe`. The old branch `claude/upbeat-turing-tqyy0p` is kept for now because Vercel's production branch still points at it (see Infrastructure).
- **Stack:** Node 22 + TypeScript (run with tsx), Socket.IO, React 19 + Vite, Electron desktop shell, vitest. Tests and typecheck must stay green.

## Commands (run in `encore/`)

| What | Command |
| --- | --- |
| Install | `npm ci` (use `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci` if you don't need Electron) |
| Typecheck | `npm run typecheck` |
| Tests | `npm test` (642 tests; some run the licensing and payments SQL in an in-process Postgres, so the first start takes a moment) |
| Run with a demo library | `npm run demo`, then open http://localhost:4747/dj (venue screen at `/display`, phone page at `/join`) |
| Desktop app | `npm run build:desktop && npm run desktop` |
| Windows installer | built by GitHub Actions on every push to the branch: download the "Encore-Karaoke-Windows" artifact from the run; `npm run dist:win` needs Windows |
| Online join page | `npm run build:sing` builds `dist-sing/`; Vercel builds it on push |
| Make the license signing key | `npm run license:key` (writes the public key into `src/shared/license-key.ts` and the private key to a file, never to the screen) |
| Run from source without the license check | `ENCORE_LICENSE=off` (`npm run demo` and the tests already do; the installed app ignores it) |

## Architecture in one breath

- **Laptop:** a server (`src/server/app.ts`) runs on the KJ's laptop, in-process in the Electron app, and serves three screens:
  - the console (`src/client/dj`);
  - the venue screen (`src/client/display`);
  - the phone page (`src/client/join`).
- **Show logic:** `src/server/show.ts`. Pure rotation logic is in `src/shared/rotation.ts`.
- **Online join link:** phones on `https://sing.scriblio.co/#<room>.<key>` (Vercel) reach the laptop through an end-to-end encrypted relay over Supabase Realtime (`src/shared/relay.ts`, `src/server/relay.ts`).
- **YouTube search:** goes through one Supabase Edge Function that holds the only API key (`supabase/functions/youtube-search`). YouTube's policies allow one API project per app, and KJs never need a key.
- **YouTube playback:** uses YouTube's own player, loaded from `https://sing.scriblio.co/yt-frame` (`src/ytframe/`), falling back to a direct embed (`src/client/common/youtube-embed.ts`).
- **Key change (library songs only):** `src/shared/pitch.ts` is a phase-vocoder pitch shifter with peak phase locking, pure TypeScript and tested in Node. On the venue screen it runs in an AudioWorklet (`src/client/display/pitch-worklet.ts`). `src/client/display/key-change.ts` routes a media element through it, but only once its key moves off the original. Keys are on `Entry.key` (−6 to +6), changed by `setKey` (KJ) or `request.key` (phone), and remembered per singer name and track in `data/keys.json` (`src/server/keys.ts`).
- **Lock-screen alerts:** on the online link only, a phone can subscribe to Web Push (`src/client/sing/alerts.ts`, service worker `src/sw/sw.js`). The laptop sends the alerts itself when a singer is next and when they're called (`src/server/push.ts`, `src/server/webpush.ts`). They're signed with a key made per installation (`data/push.json`), so there's no cloud piece and no shared secret. The laptop only sends to the browsers' own push services (an allowlist), so a phone can't point it anywhere else.
- **Refused videos:** `src/server/ytguard.ts` remembers videos YouTube refuses to play here, and ones the KJ marked "Not karaoke" (30 days, ids only). It swaps refused requests for another version of the same song.
- **Licensing (sign-in, free trial, unlock codes):** the plan is `docs/LICENSING.md`; set-up steps for Matthew are in `supabase/README.md`.
  - **Sign-in:** an emailed 6-digit code through Supabase Auth's REST endpoints (`src/server/account.ts`, session in `data/account.json`). The console never talks to Auth; it sends DJ actions (`accountSendCode`, `accountVerify`, `accountSignOut`, `startTrial`, `redeemCode`, `refreshLicense`).
  - **The pass:** the `encore-license` Edge Function works out what the account has (owner flag, purchase, 14-day trial, unlock codes used) and signs a **pass**, an Ed25519 JWT (`supabase/functions/encore-license/pass.ts`, shared with the app). `src/server/license.ts` keeps it (`data/license.json`), checks it against the public keys in `src/shared/license-key.ts`, renews it on start and every 12 hours, and turns it into one state (`src/shared/license.ts`): `owner`, `licensed`, `trial`, `ended`, `signed-out`, `offline-expired`. A pass lasts 14 days offline and is made out to one account on one installation.
  - **Access is decided on the server, never by the screens.** `Show` refuses new singers and calling anyone up while the plan is closed (`ShowDeps.closed`; the other ways of calling someone, skip and no-show, end in the same place). `createApp` starts the relay, offers the online link and sends lock-screen alerts only while the plan includes Encore Cloud (`cloudIncluded()`, `syncCloud()`).
  - **A running show is never cut off** (`src/server/access.ts`): the show that had singers while the plan allowed it stays open, online link and alerts included, until the KJ starts a new list or Encore is closed. A new list starts closed if the plan has run out.
  - **Singers see nothing of plans.** A closed show gives phones `SingerView.notOpen`: "This show isn't open yet. Ask the KJ." Plans, prices and buttons exist only in the console (`src/client/dj/License.tsx`: the notice, Settings → Your Encore, the trial badge, the guide's first step).
  - **Switching it off:** `createApp({ license: false })` or `ENCORE_LICENSE=off` (development, `npm run demo`, the tests). Any `license` object, even `{}`, means it's checked and the environment is ignored: the installed app passes `{}`.
- **Payments (Stripe, licensing step 2):** built and tested, not switched on. The plan and how it works are in `docs/LICENSING.md` ("Step 2: as built"); Matthew's steps are in `supabase/README.md` ("Payments (Stripe)").
  - **A purchase only writes `licenses.app_forever`, `cloud_until` and the Stripe ids**, so the pass and the app's states are unchanged (`source: 'purchase'`). Only Stripe's webhook gives anything (`supabase/functions/stripe-webhook/`, JWT verification **off**, Stripe's signature checked by hand); each event is applied once by its id inside the database function `license_stripe_apply`.
  - **Asking to pay gives nothing:** `encore-license` has two more actions, `checkout` and `portal` (`billing.ts`, `stripe.ts`), whose answer is only the address of a Stripe-hosted page. They refuse the owner, Encore bought twice, Cloud without Encore and a second subscription.
  - **The laptop** (`License.checkout`, `billingPortal`, `checkPurchase` in `src/server/license.ts`; DJ actions `checkout` and `billing`) opens the page in the browser, then looks every 10 seconds for 15 minutes for the purchase and picks up the new pass.
  - **The console** (`Offers` in `src/client/dj/License.tsx`; `offersOf` and `PRICES` in `src/shared/license.ts`) shows *Buy Encore · $149*, *Keep Cloud going · $49 a year* and *Manage billing*, only when the service says payments are on. The singer's phone never sees any of it.
  - **Dark until the Stripe secrets exist:** `STRIPE_SECRET_KEY`, `STRIPE_PRICE_APP` and `STRIPE_PRICE_CLOUD` switch on the buttons; `STRIPE_WEBHOOK_SECRET` the webhook.
  - **No YouTube feature is in any plan,** purchase included: `test/license-app.test.ts` checks YouTube in every state, now including after a purchase.

## Infrastructure (set up by Matthew; never commit secrets)

- **Supabase** project `encore`, ref `oohgawkfnwhjlqlihhju` (Scriblio org):
  - Realtime relay;
  - the `youtube-search` Edge Function, deployed with `verify_jwt` off;
  - tables `yt_search_cache`, `yt_search_usage`, `yt_reports` and the `yt_catalog*` tables (RLS on, no policies);
  - a `pg_cron` job, `yt-catalog-tick`, that keeps the karaoke catalog built (see `supabase/README.md`);
  - Edge Function secret `YOUTUBE_API_KEY`.

  - **Licensing: applied and deployed on 2026-10-05 (Matthew approved it), and switched on and working as of 2026-10-16.**
    - The migration is applied: tables `licenses`, `unlock_codes`, `code_redemptions`, `trials` and `license_attempts` (RLS on; a signed-in KJ may read only their own `licenses` row), and the functions Matthew runs in the SQL editor, `make_unlock_code`, `revoke_unlock_code` and `set_owner`. Checked on the live project: RLS on everywhere, the public keys can run none of the functions, and the SQL's output matches the app's (the same hash of a code).
    - The `encore-license` Edge Function is deployed with `verify_jwt` **on**. It also asks the Auth server who a token belongs to, because the platform's check lets an API key through to the function. Without the Edge Function secret `LICENSE_SIGNING_KEY` it answers "Licensing isn't switched on yet" (the app shows "Encore's license service isn't switched on yet").
    - **Switched on:** Matthew added `LICENSE_SIGNING_KEY` (made by `npm run license:key`; it exists nowhere else, so keep a copy in a password manager). Seen working live: a real sign-in with an emailed code, the function signing a pass on Deno, and the 14-day trial. On 2026-10-16 his account was made the owner (`set_owner`) and the installed app showed "Owner. Everything, forever." Redeeming an unlock code ("Encore is yours forever (unlock code)") and turning it off (back to "Free trial") were also checked live on the installed 0.2.0 build, and an upgrade install over 0.1.0 kept the sign-in and settings.
    - **The sign-in email:** the Auth templates "Confirm sign up" and "Magic link or OTP" show `{{ .Token }}` (the stock ones send a link that opens `localhost:3000`, the project's default Site URL, so a customer would see "Unable to connect"). Custom SMTP is on through Resend: sender `hello@scriblio.co`, name Encore, `smtp.resend.com` port 465, user `resend`. It reuses the Resend account and verified `scriblio.co` domain that the Scriblio project (`hvqlizqrcrduzslekbhq`) already uses, so no new DNS was needed (the domain's DNS is at Vercel). A test code requested on 2026-10-16 was accepted by Supabase; that it lands in the inbox from "Encore" is still for Matthew to confirm.
    - **Loose ends, Matthew's:** two DKIM TXT records at `resend._domainkey.scriblio.co` differ by one character (one is likely a typo from an old paste; compare with the key under Resend → Domains and delete the wrong one in Vercel DNS, since it can make some mail providers' checks flaky). Optionally set Auth → URL Configuration → Site URL to a real page such as `https://sing.scriblio.co/encore`.
    - If a valid sign-in is turned away, the function's logs say why (`The Auth server turned down a token`).
  - **Payments: not applied or deployed.** The migration `20261016000000_stripe.sql` (two columns on `licenses`, the table `stripe_events`, the functions `license_stripe_apply` and `revoke_purchase`) and the `stripe-webhook` function are in the repo only; the live `encore-license` doesn't have the `checkout` and `portal` actions yet. Applying and deploying them needs Matthew's go-ahead, and so does anything in his Stripe account.

  Only the publishable key is in the code (`src/shared/cloud.ts`).
- **Google Cloud** project `encore-karaoke-k7m3` owns the YouTube Data API key, which is restricted to YouTube Data API v3.
- **Vercel** project `encore-sing` (root `encore`), serving `sing.scriblio.co`. **All headers live in `encore/vercel.json`:** a strict CSP for the join page, and a separate rule for `/yt-frame`. `build:sing` refuses to build if they're wrong.
  - ⚠️ Its **production branch is temporarily `claude/upbeat-turing-tqyy0p`**, so every push to that branch goes live. After PR #4 merges, set it back to `main` (Vercel → encore-sing → Settings → Git).

## YouTube rules that shape the design (don't break these)

The YouTube API Services policies apply because Encore uses the search API. Breaking them risks the key and the quota-extension audit.

- **One API project for the app.** Never ask KJs for keys, and never ship the key in the app.
- **Show results unmodified** (III.C.5). Don't score or filter results with your own derived data, such as a "karaoke score" (III.E.4.h).
- **Play video only through YouTube's player.** No downloading or analyzing video or audio, and no in-app browser playing youtube.com (III.I.14).
- **Never put overlays on the player.** The venue screen leaves a band at the bottom for lower thirds, and the player is always at least 200×200 px.
- **Never block or skip ads.** YouTube Premium can't be used inside Encore: Google blocks signing in from embedded browsers, and Premium is for personal use only.
- **Store YouTube data for at most 30 days.**
- **No plan, trial or unlock code may include or exclude any YouTube feature** (III.F.3.a: don't charge users to watch content in the player; III.G.1.b: don't sell access to YouTube API Services). Search, pasted links, previews, Not karaoke and the player page work the same in every license state, and Encore Cloud is only the online join link and lock-screen alerts. The player page's address comes from the `cloud` settings as configured (`frameUrl` in `app.ts`), never from the plan. `test/license-app.test.ts` ("YouTube, in every state") guards it.

## Done recently (all on the branch, tested)

- **Licensing, step 1 (sign-in, 14-day trial, unlock codes, checks in the app):** what was built is in `docs/LICENSING.md` ("Step 1: as built"), how it works is under Architecture above, and Matthew's set-up steps are in `supabase/README.md` ("Licensing").
  - **Tests, all in `npm test`:** the migration runs for real in an in-process Postgres (PGlite, a dev dependency: `test/license-sql.test.ts`); the service's rules run against both an in-memory store and that real SQL, which have to agree (`license-service.test.ts`); the laptop's sign-in and pass checks run against a fake Supabase (`account.test.ts`, `license.test.ts`); and the app runs over real sockets (`license-app.test.ts`): a closed show, a running show that isn't cut off, Cloud on and off, and YouTube in every state.
  - **Seen working in a browser** against a fake backend: the guide's first step, signing in with a code, the trial badge, Settings → Your Encore, the notice when the trial ends mid-show, a late singer joining that running show, the show closing after a new list, an unlock code opening it again (the online link starts by itself), and a revoked code stopping at the next check.
  - **Privacy Policy and Terms** now describe KJ accounts, the trial, unlock codes and Cloud. `docs/YOUTUBE_AUDIT.md` has a warning at the top: three of its answers are out of date until licensing step 3.
- **Licensing, step 2 (Stripe): built, tested, not switched on.** What it is is under Architecture above and in `docs/LICENSING.md` ("Step 2: as built"). Tests, all in `npm test`: the migration and `license_stripe_apply` in PGlite (`stripe-sql.test.ts`), the webhook with signed payloads (`stripe-webhook.test.ts`), the checkout and portal rules on both the in-memory store and the real SQL plus exactly what's asked of Stripe (`billing.test.ts`), and the laptop and the app (`license.test.ts`, `license-app.test.ts`). Seen working in a browser against a fake backend and a fake Stripe; not yet against a real Stripe test-mode Checkout page, which needs Matthew's test keys. `TERMS.md` (it still says Encore isn't on sale) and `PRIVACY.md` (a line about Stripe) both need updating before real money; the proposed wording is in `docs/LICENSING.md`, for Matthew to approve, and they haven't been changed.
- **Break music folder with only karaoke files:** a KJ pointed the break folder at their karaoke folder, which has only MP3+G pairs. Break music leaves those out on purpose (so a folder that mixes karaoke and music is fine), so it found nothing and the card just said so. `BreakStatus.karaoke` now counts the left-out files, and the console card and Settings say "that folder only has karaoke songs; pick a different one".
- **Stale save files:** `Show.load` deletes `show.json.<pid>.tmp` files left when an earlier session was closed between writing and renaming (a real install had about 20). Saves themselves were working.

- **First-run guide:** `src/client/dj/SetupGuide.tsx`, opened by `FirstRun` in `DjApp.tsx` when `config.setupDone` is false (`dj:config`), or by the `encore:setup` event (Settings → Help). `setupDone` defaults to true when the saved config already has library folders, so an upgrade doesn't show it (`test/config.test.ts`). Finishing, skipping or closing it saves `setupDone: true`.
- **Phone header:** it shrinks to the name row once the song list is scrolled (the "you're up next" and "you're called" cards stay), using the measured `--head-h` so the pinned search box and A-Z bar follow.

- **Printed QR codes:** Settings → Print QR codes (`src/client/dj/PrintSheet.tsx`, print styles at the end of `dj.css`): table tent, poster, table cards and just the code. The table tent prints one half upside down so both sides read upright once folded: the bottom half for a sign holder (fold at the bottom), the top half for a tent that stands by itself. Its how-to text names the phone's real buttons (*Taking a break*, *Can't sing right now*, *Leave the list*, rejoin code), so keep it in step if those change. The sheet is portalled into `<body>` and everything else is hidden in `@media print`. The desktop app prints through `webContents.print()` (IPC `encore:print`), whose Windows print window can't preview, so it also offers *Save PDF*: `webContents.printToPDF()` (IPC `encore:save-pdf`; Letter in the Letter countries, else A4; 0.4in margins to match the `@page` rule), a save dialog, then `shell.openPath`. Browsers use `window.print()`, which has its own preview. The code comes from `/api/print-qr.svg` and `DjView.print`: the online link whenever online join is on (its room and key are saved in `relay.json`, so printed codes keep working), else the Wi-Fi link with `lasting: false` and a warning.
- **Tip your KJ:** settings `tipLink` and `tipText` (`cleanTipLink` in `show.ts`: https only, no credentials, needs a dot in the host; "venmo.com/u/me" is read as https). The screen gets `tip` and a QR from `/api/tip-qr.svg`; phones get `tip.link` and a button in The line (`rel="noopener noreferrer"`). Encore only shows the link; it never handles payments, which keeps it clear of Store payment rules.
  - Quick-tip amounts (`tipAmounts`, default 1, 5, 10): `src/shared/tips.ts` turns Venmo (`venmo.com/<user>?txn=pay&amount=…&note=…`), Cash App (`cash.app/$tag/<amount>`) and PayPal.me (`paypal.me/<user>/<amount>`) links into prefilled ones. Other links get one button. Phones get them as `tip.amounts`.
  - After-song prompt (`tipAfterSong`, on by default): `SingerView.tipPrompt` is set for 10 minutes after the singer's latest song finished (or was cut off after at least a minute), unless they're on stage again. The phone shows it once per song (`encore.tipPromptSeen` in localStorage), at the top of whatever tab is open (`src/client/join/Tips.tsx`).

- **Name filter:** `src/shared/namefilter.ts`, used by `Show.join` (phone joins only; the KJ's own *Add singer* and renames aren't filtered). Settings `nameFilter` (default on) and `blockedWords` (comma-separated, stored cleaned).
  - Whole-word matching, so Scunthorpe and Cassie pass (tests cover a list of tricky names both ways). A short list of unmistakable words also matches inside longer ones. It sees through spacing, punctuation, accents and leetspeak. "Dyke" is deliberately not on the built-in list because it's a surname (Van Dyke).
  - The phone gets "That name can't go up on the screen", and the KJ a notice that doesn't repeat the name.

- **Speakers:** Settings → *Speakers* (`config.audioOutput`, a browser device id; '' is the system default).
  - It reaches the venue screen (`DisplayView.audioOutput`) and the console (`DjView.audioOutput`, so its preview matches). `src/client/common/audio-output.ts` calls `setSinkId` on every media element and audio context that registers with `routeToOutput` (the song players, the key-change context, break music), and re-applies when a device is plugged in.
  - Names only appear once the app may listen for a microphone, so it asks once and falls back to "Output 1, 2…". YouTube's iframe can't be routed: it uses the default output. The Settings text says so.

- **Break music:** a separate folder (Settings → *Break music*, config `breakFolders`) of audio and video that plays whenever nothing is on stage.
  - The server decides (`src/server/breakmusic.ts`: shuffle bag, no repeats until all have played, skip, pause, gives up after 5 failures in a row). It's "on" when there are tracks, there's no song or the stage is in the intro, and either auto play (the `breakMusic` setting) is on or the KJ pressed Play (DJ action `breakPlay`, which lasts until Stop or the next song). The display gets `breakMusic` in its view and reports `display:breakEnded` and `display:breakError` with the track's `nonce`, so late reports about old tracks are ignored.
  - Files are served like library media at `/media/<id>/main` with the same key (`Library` scans the folder; karaoke files in it are left out).
  - The screen (`src/client/display/BreakLayer.tsx`): video fills the screen (`object-fit: cover`) behind the normal idle and walk-up text, under a 42% dark layer; audio through an analyser into canvas motion graphics (orbs that swell with the bass, spectrum along the bottom). Fades in over 1.4 s and out over 0.9 s. It waits for the screen to be clicked (browsers) before playing, and doesn't count that as a bad track.
  - The console has a *Break music* card (`BreakCard.tsx`) with Skip, Pause, volume and a switch. No music is bundled, on purpose: the folder is the KJ's own.
  - `src/client/common/audio-output.ts` routes sound to a chosen output device; the break music already uses it.

- **Key letters on the phone:** the key picker says which key a change lands in ("G", with "−5" under it), not just the number.
  - A song's key is only known once the console has analysed it, and singers pick a key *before* queuing. So the phone shows a **Check the key** button (nothing is checked unless the singer taps it). It sends `songKey` (also allowed over the relay) and the server tells the console (`dj:detect`) to analyse that song first; `KeyDetector` runs it ahead of the queue. The phone waits up to 12 s (`keyWaitMs`), and the console is asked at most once a minute per song.
  - No console connected, or a file it can't decode: the phone just shows the number, as before.

- **Song list on the phone:** the Find tab shows the whole library to scroll through when nothing is typed (`src/client/join/Browse.tsx`).
  - The server pages it: socket event `browse` (also allowed over the relay), `Library.browse` in `src/server/library.ts`. Each song appears once, preferring a video/MP3+G file over plain audio. Pages are 40 songs, sorted by artist or title, with an A–Z jump (`letter`).
  - The KJ can turn it off with Settings → *Let singers browse the song list* (`allowBrowse`; phones get `canBrowse` in their view). It's refused for phones when off, and the KJ console is unaffected.
  - Also fixed: the search box and header on the phone page never stacked (the `--head-h` variable was never set). `useHeightVar` now measures them, so the search box and the A–Z bar stay pinned under the header.

- **Karaoke catalog:** the top 5,000 videos by views from Sing King (`@SingKingKaraoke`) and KaraFun (`@karafun`).
  - It's built through the API's cheap list calls, about 700 units in all, inside a 2,000-unit-a-day budget, and rebuilt every 25 days.
  - Searches with 2 or more catalog matches never use the quota.
  - Settings and progress are in `yt_catalog_job`. It's deployed as function version 6.

- **Shared YouTube reports:** refusals (auto-detected) and **Not karaoke** marks go to the search service (table `yt_reports`, actions `report` and `check`).
  - A video is hidden from all searches, and swapped out of queues within a minute, once 2 different networks report "won't play" or 3 report "not karaoke". A video that later plays clears it.
  - Only hashes of who reported are kept, for 30 days. It's deployed as function version 5.

- **Song keys by name:**
  - The console detects each queued library song's original key (chroma plus Albrecht & Shanahan profiles: `src/shared/keydetect.ts`, run by `src/client/dj/KeyDetector.tsx`). It's stored per track in `data/song-keys.json` (`src/server/songkeys.ts`, DJ action `setSongKey`), and the KJ's word beats a detection.
  - The stage card shows *≈C → G* and a *Play it in* grid; phones show the resulting key.
  - On synthetic pop progressions it's 81% right, with misses mostly relative minor/major; your test track and the demo come out correct.
- **Key change for library songs:**
  - Singers pick a key when adding a song, and the KJ has −/+ on the stage card (live mid-song).
  - Keys are remembered per singer and song across nights.
  - Lyrics are delayed to match the shifter.
  - YouTube songs say they keep the original key.
  - Tested for pitch accuracy (within 1% at every step), steady volume, chords and block-size independence, and in a real browser's audio engine.
- **Lock-screen alerts (Web Push):** "Alerts when my phone is locked" in My songs, on the online link.
  - The laptop pushes "You're up next!" and then "It's your turn!", once per turn, with a 2-minute cooldown if the KJ rearranges the list.
  - If the laptop restarts, phones quietly subscribe again.
  - iPhones get Add to Home Screen steps.
  - The encryption is tested against RFC 8291's worked example.
- **Online join link, and one spot per singer:** rejoin codes, reclaim, and a KJ merge.
- **Built-in YouTube search:** a shared cache, daily caps, and Terms/Privacy links.
- **Refused-video handling:**
  - a site-hosted player with fallback;
  - an ahead-of-time check in the console's Preview card;
  - automatic swaps to another version.
- **Console Preview card:** click a singer or song to preview it, muted by default.
- **"You're up" phone alert:** vibrate, chime and wake lock, with buttons for I'm ready, Can't sing right now (lets 2 others go first) and I left.
- **Change song once a singer is up:** from the console, or from the phone before the song starts.
- **YouTube preview on the phone** before picking (YouTube songs only).
- **"Not karaoke" KJ button:** removes the request, tells the singer, and hides the video.
- **Layout fixes** for small laptop screens and long YouTube titles. Grids use `minmax(0, 1fr)`.

## Open items

0. **Selling Encore:** the plan is in `docs/LICENSING.md`: $149 once with a year of Encore Cloud, $49 a year for Cloud after that, a 14-day trial, and unlock codes Matthew can give out.
   - **Step 1 is built, live and switched on** (see Infrastructure). The current build asks for a sign-in with an email address and starts a 14-day trial; unlock codes are made in the Supabase SQL editor (`select make_unlock_code('for Dave');`, see `supabase/README.md`). The version is **0.2.0**, the first build with sign-in.
   - **Leave the old public preview alone:** release `encore-v0.1.0-preview` (`Encore-Karaoke-Setup-0.1.0.exe`, linked from `sing.scriblio.co/encore`) has no sign-in, and on 2026-10-16 Matthew told Google's YouTube API Services team that the installer in the original submission needs no account. Don't replace it or change what `/encore` links to until their review is over. Beta builds go out as a separate pre-release, `encore-v0.2.0-beta` (published 2026-10-16: https://github.com/Scriblio/slate-lab/releases/tag/encore-v0.2.0-beta). Five single-use beta codes were made that day with the notes `beta friend 1` to `beta friend 5` (the codes themselves are in Matthew's Documents folder, never in the repo); `supabase/README.md` has the query that shows who has used which.
   - **Step 2 (Stripe) is built and tested, not switched on** (see Architecture and Infrastructure). To switch it on: Matthew makes the two prices, the webhook and the keys in Stripe's **test mode**, then (with his go-ahead) the migration is applied, the functions deployed and the four secrets added, and a purchase is tried with a second account and Stripe's test card; the steps are in `supabase/README.md`. Before real money: approve the refund and tax wording for `TERMS.md` and the Stripe line for `PRIVACY.md` (proposed text in `docs/LICENSING.md`), and repeat the set-up in Stripe's live mode.
   - **Next:** a few beta KJs with unlock codes, Stripe in test mode, then step 3 (pricing page, `docs/YOUTUBE_AUDIT.md`, Store identity). Don't send customers to it before the YouTube quota extension is granted (item 2): the default quota is about 99 uncached searches a day across all KJs.
1. **Real-world checks** (the cloud sandbox couldn't reach YouTube):
   - YouTube playback through the site-hosted player;
   - whether it plays more videos than before;
   - vibration, chime and wake lock on real iPhone and Android phones;
   - key change by ear on real karaoke tracks: how ±2 and ±4 sound, and that CD+G lyrics still feel in time;
   - lock-screen alerts on a real Android phone (Chrome), and on an iPhone from the home screen. Check whether the home-screen app reopens straight into the show: the manifest has no `start_url`, so it should keep the link from the QR code. If it doesn't, the singer can still get back in with their rejoin code.
2. **YouTube quota extension and compliance review (waiting on Google):**
   - Matthew submitted the form on 2026-10-04 (the answers are in `docs/YOUTUBE_AUDIT.md`). On 2026-10-07 Google's YouTube API Services team asked for an English screencast of the whole flow (search, pick, play on the venue screen, the end result), and on 2026-10-16 extended the time to **2026-10-21**.
   - The screencast is on Matthew's YouTube channel, unlisted: https://youtu.be/8ZFxR3iteM0. His reply of 2026-10-16, on Google's email thread, gave the link and the changes since the form: Encore is sold by us through Stripe instead of the Microsoft Store, with a 14-day trial, host sign-in, and no YouTube feature in any plan.
   - If Google asks to run the new build, make them a code: `select make_unlock_code('YouTube review');`.
   - The evidence PDFs are in `docs/youtube-audit/` and aren't committed. The privacy policy and terms PDFs there predate the 2026-10-05 update, so regenerate them from the live pages before sending them again.
   - After approval, raise the caps with the Supabase secrets `YT_DAILY_SEARCHES`, `YT_DAILY_PER_INSTALL` and `YT_DAILY_PER_IP` (see `supabase/README.md`). The free quota is about 99 uncached searches a day across all customers.
3. **Terms of Use:** say that users of YouTube features agree to the YouTube Terms of Service. Finish `PRIVACY.md` (placeholders in brackets) and host it.
4. **Microsoft Store:** not ready to submit. `STORE.md` has the full list ("Where things stand"). The main gaps: the product name reserved in Partner Center and its identity copied into `electron-builder.yml` (Matthew's Partner Center account exists, the one Squatchy is sold from, with the same publisher; it's an individual account, and policy 10.14 prefers a company one for a business, so decide which to use); the `.appx` builds and runs (the Action's "Store package" option, run 38998787282 on 2026-10-17; sideloaded and tried the same night) but on a new PC **Open Data Folder fails and uninstalling deletes the KJ's data, printed-QR identity included**, because Windows redirects a Store app's new AppData folders to a private place; the recommended fix (switch the redirection off in the manifest, needs the restricted capability `unvirtualizedResources`) and how to sideload are in `STORE.md` ("Testing the package"); a demo account for the certifiers, because Encore needs an emailed-code sign-in (policy 10.3.1); the Store listing set to **Free**, with the third-party purchase noted and the prices and trial terms stated (10.8.2, 10.8.4); and everything under items 0 and 2 (Stripe switched on and tried, Google's review and quota extension).
5. **Ideas Matthew liked but didn't build yet:**
   - a tighter YouTube query using YouTube's own NOT operators (e.g. `-reaction -tutorial`);
   - an "Approve YouTube requests only" setting.
6. **PR #4 is merged:** switch Vercel's production branch back to `main` (Vercel → encore-sing → Settings → Environments → Production → Branch Tracking), then promote or redeploy the `main` build, and the old branch can be deleted. The `/thanks` page Stripe sends buyers to only exists on `main`, so do this before payments go live.
