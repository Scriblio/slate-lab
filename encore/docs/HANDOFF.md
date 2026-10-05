# Encore: handoff notes

Encore is a karaoke hosting (KJ) app by Scriblio (Matthew Lancaster). It's being built toward a paid Microsoft Store release. This file is for whoever picks the work up next: a person, or a local Claude Code session.

## Where things are

- **Code:** repo `Scriblio/slate-lab`, folder `encore/`. Nothing else in the repo belongs to Encore except `.github/workflows/encore-desktop.yml`.
- **Branch:** `claude/upbeat-turing-tqyy0p`.
- **Pull request:** [Scriblio/slate-lab#4](https://github.com/Scriblio/slate-lab/pull/4), still a draft. Its description is the most complete feature list and should be kept up to date.
- **Stack:** Node 22 + TypeScript (run with tsx), Socket.IO, React 19 + Vite, Electron desktop shell, vitest. Tests and typecheck must stay green.

## Commands (run in `encore/`)

| What | Command |
| --- | --- |
| Install | `npm ci` (use `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci` if you don't need Electron) |
| Typecheck | `npm run typecheck` |
| Tests | `npm test` (269 tests) |
| Run with a demo library | `npm run demo`, then open http://localhost:4747/dj (venue screen at `/display`, phone page at `/join`) |
| Desktop app | `npm run build:desktop && npm run desktop` |
| Windows installer | built by GitHub Actions on every push to the branch: download the "Encore-Karaoke-Windows" artifact from the run; `npm run dist:win` needs Windows |
| Online join page | `npm run build:sing` builds `dist-sing/`; Vercel builds it on push |

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

## Infrastructure (set up by Matthew; never commit secrets)

- **Supabase** project `encore`, ref `oohgawkfnwhjlqlihhju` (Scriblio org):
  - Realtime relay;
  - the `youtube-search` Edge Function, deployed with `verify_jwt` off;
  - tables `yt_search_cache`, `yt_search_usage`, `yt_reports` and the `yt_catalog*` tables (RLS on, no policies);
  - a `pg_cron` job, `yt-catalog-tick`, that keeps the karaoke catalog built (see `supabase/README.md`);
  - Edge Function secret `YOUTUBE_API_KEY`.

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

## Done recently (all on the branch, tested)

- **Break music folder with only karaoke files:** a KJ pointed the break folder at their karaoke folder, which has only MP3+G pairs. Break music leaves those out on purpose (so a folder that mixes karaoke and music is fine), so it found nothing and the card just said so. `BreakStatus.karaoke` now counts the left-out files, and the console card and Settings say "that folder only has karaoke songs; pick a different one".
- **Stale save files:** `Show.load` deletes `show.json.<pid>.tmp` files left when an earlier session was closed between writing and renaming (a real install had about 20). Saves themselves were working.

- **First-run guide:** `src/client/dj/SetupGuide.tsx`, opened by `FirstRun` in `DjApp.tsx` when `config.setupDone` is false (`dj:config`), or by the `encore:setup` event (Settings → Help). `setupDone` defaults to true when the saved config already has library folders, so an upgrade doesn't show it (`test/config.test.ts`). Finishing, skipping or closing it saves `setupDone: true`.
- **Phone header:** it shrinks to the name row once the song list is scrolled (the "you're up next" and "you're called" cards stay), using the measured `--head-h` so the pinned search box and A-Z bar follow.

- **Printed QR codes:** Settings → Print QR codes (`src/client/dj/PrintSheet.tsx`, print styles at the end of `dj.css`): table tent, poster, table cards and just the code. The table tent prints one half upside down so both sides read upright once folded: the bottom half for a sign holder (fold at the bottom), the top half for a tent that stands by itself. Its how-to text names the phone's real buttons (*Taking a break*, *Can't sing right now*, *Leave the list*, rejoin code), so keep it in step if those change. The sheet is portalled into `<body>` and everything else is hidden in `@media print`. The desktop app prints through `webContents.print()` (IPC `encore:print`); browsers use `window.print()`. The code comes from `/api/print-qr.svg` and `DjView.print`: the online link whenever online join is on (its room and key are saved in `relay.json`, so printed codes keep working), else the Wi-Fi link with `lasting: false` and a warning.
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

1. **Real-world checks** (the cloud sandbox couldn't reach YouTube):
   - YouTube playback through the site-hosted player;
   - whether it plays more videos than before;
   - vibration, chime and wake lock on real iPhone and Android phones;
   - key change by ear on real karaoke tracks: how ±2 and ±4 sound, and that CD+G lyrics still feel in time;
   - lock-screen alerts on a real Android phone (Chrome), and on an iPhone from the home screen. Check whether the home-screen app reopens straight into the show: the manifest has no `start_url`, so it should keep the link from the QR code. If it doesn't, the singer can still get back in with their rejoin code.
2. **YouTube quota extension:** the answers and evidence are ready in `docs/YOUTUBE_AUDIT.md`. The PDFs are in `docs/youtube-audit/` and aren't committed; regenerate them from the live pages if needed. Matthew submits the form. Apply through the YouTube API Services audit before launch. The free quota is about 99 uncached searches a day across all customers. Caps can be raised with the Supabase secrets `YT_DAILY_SEARCHES`, `YT_DAILY_PER_INSTALL` and `YT_DAILY_PER_IP`.
3. **Terms of Use:** say that users of YouTube features agree to the YouTube Terms of Service. Finish `PRIVACY.md` (placeholders in brackets) and host it.
4. **Microsoft Store:** fill in the Partner Center identity values in `electron-builder.yml` (see `STORE.md`).
5. **Ideas Matthew liked but didn't build yet:**
   - a tighter YouTube query using YouTube's own NOT operators (e.g. `-reaction -tutorial`);
   - an "Approve YouTube requests only" setting.
6. **After merging PR #4:** switch Vercel's production branch back to `main`.
