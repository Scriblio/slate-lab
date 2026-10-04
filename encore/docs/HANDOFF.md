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
| Tests | `npm test` (219 tests) |
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
