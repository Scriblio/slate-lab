# Encore: karaoke hosting for KJs

Encore runs on the KJ's laptop. It does three things:

- **DJ console** (`/dj`): runs the rotation, the stage and song search.
- **Venue screen** (`/display`): plays the song on the TV or projector, introduces each singer, and shows a QR code between songs.
- **Phone sign-up** (`/join`): singers scan the code, type a name, pick a song and watch their place in line. They don't need an app or an account.

Songs come from your own library (MP4/MKV/WebM video, MP3+G, zipped MP3+G) or from YouTube, so a request the library doesn't have can still be played.

![DJ console](docs/dj-console.png)

| Between songs | Calling the next singer | MP3+G lyrics | On a phone |
|---|---|---|---|
| ![Venue screen idle](docs/display-idle.png) | ![Intro card](docs/display-intro.png) | ![CD+G lyrics](docs/display-cdg.png) | ![Phone](docs/phone-line.png) |

## Desktop app (Windows)

Encore also comes as a desktop app. Install it and click the **Encore Karaoke** icon on your desktop: the server starts, and the DJ console opens in its own window. **Open screen** puts the venue screen fullscreen on your second monitor or TV automatically, with no "click to start" step. Demo songs are included until you add your own folders, and **Settings → Browse…** lets you pick those folders.

- **Get the installer:** every push builds one on GitHub (**Actions → Encore desktop → Artifacts**). On a Windows PC you can also run `npm run dist:win` here.
- **Run it from source:** `npm run desktop`.
- **Microsoft Store:** see [STORE.md](STORE.md) for building the Store package and submitting it, plus [PRIVACY.md](PRIVACY.md), a draft privacy policy the Store listing needs.

## Try it in two minutes

You need Node.js 20.12 or newer.

```bash
cd encore
npm install
npm run demo
```

`npm run demo` builds the app, generates a small demo library and starts the server. The demo library has an original song with highlighted CD+G lyrics, the same song zipped, and a test-pattern video if `ffmpeg` is installed. Then:

1. Open **http://localhost:4747/dj** on the laptop.
2. Click **Open screen** and drag that window to the TV. Click it once so the browser allows sound, then press **F** for fullscreen.
3. Scan the QR code with a phone on the same Wi-Fi, join, and pick "Step Up".
4. On the console, press **Call up** (or Space). When the singer is at the mic, press **Start song**.

## Running a real night

```bash
npm install
npm run build
npm start
```

Open **Settings** (the gear icon) to:

- **Add your library folders.** Encore scans them for video files, `.mp3` + `.cdg` pairs and zipped MP3+G, and reads names like `SC8125-01 - Artist - Title`. If your files are named title-first, switch the filename order.
- **Add a YouTube API key** (optional). Pasting a YouTube link always works without one. To *search* YouTube from Encore, create a free YouTube Data API v3 key in the Google Cloud Console. The free quota covers about 100 searches a day, and Encore caches results to stretch it.
- Set the show name, sign-up limits, request approval, auto-advance and auto-start.

Settings and the current show are saved in `encore/data/`. If the laptop restarts mid-show, Encore picks up where it left off, with the song that was playing paused.

Configuration can also come from the environment: `PORT`, `ENCORE_LIBRARY` (folders separated by `:` on macOS/Linux or `;` on Windows), `YOUTUBE_API_KEY`, `DJ_PIN`, `PUBLIC_URL` and `ENCORE_DATA`.

## Rotation modes

Switch modes at any time from the top bar.

| Mode | How the next singer is picked |
|---|---|
| **Classic Rotation** | Everyone sings once before anyone sings twice, in list order. New singers join the bottom and still get a turn this round. Drag singers to reorder. |
| **Fair Play** | Whoever has sung the fewest songs tonight goes next; ties go to whoever has waited longest. Newcomers get on quickly on a busy night. |
| **First Come** | Songs play in the order they were requested, whoever asked. |
| **Shuffle Rounds** | Still one song each per round, but the order is reshuffled every round. |

These work in every mode:

- **Play next** (the pin icon) jumps a song to the front of the line.
- **Away** skips a singer without losing their place. Singers can mark themselves away from their phone.
- **No-show** handles a called singer who isn't there. They keep their turn, are marked away, and the next singer is called. When they come back they still sing this round.
- Each singer can have several songs waiting. Their top song is the one they sing next, and they can reorder their own list. In First Come mode, reordering only changes which song fills each of their slots.

The **Up next** panel shows the running order with estimated wait times, and phones show each singer their own position and wait.

## Night-of controls

| Key | Action |
|---|---|
| Space | Call up the next singer, start the song, or play/pause |
| ← / → | Back / forward 10 seconds |

Click the progress bar to seek. The venue screen shows "Now singing" for the first few seconds of each song and "Up next" in the last 30.

## Other devices

Phones only ever reach the sign-up page. To run the console or a venue screen from another device, such as a smart TV browser, open `/dj` or `/display` there and enter the **DJ PIN**. The PIN is printed at startup and shown in Settings.

If phones can't connect, the venue Wi-Fi is probably isolating clients from each other, which is common on guest networks. Run your own hotspot or router, or put Encore behind a tunnel and set `PUBLIC_URL`. Tunnel traffic is recognized by its forwarding headers and treated as a phone, not the KJ.

## Honest limitations

- **YouTube** needs internet. Some uploaders block their videos from playing outside YouTube; search only returns embeddable videos, and if one still fails the console says so and offers a skip. YouTube may show ads in embedded videos. YouTube's terms and your local performance licensing (ASCAP, BMI, SOCAN, PRS and so on) apply to public playback. Check what your venue is covered for.
- **No key or pitch change yet.** That needs a real-time pitch shifter, which is on the list below.
- **Wait times are estimates.** Local files don't report their length until they've played once, so a default length is used until then.
- **Encore doesn't store or download YouTube media.** It embeds YouTube's player.

## Development

```bash
npm run dev        # server + Vite with live reload on http://localhost:4747
npm test           # rotation engine, CD+G decoder, parsers, server end-to-end
npm run typecheck
```

How the code is organized:

- `src/shared/rotation.ts` is the rotation engine. It is pure functions over the show state, and the same code previews the upcoming order and the wait times.
- `src/server/show.ts` validates and applies every action and saves the show. `src/server/app.ts` is the HTTP and Socket.IO layer, and each client gets a view of the state shaped for its role. Phones never see other singers' private details.
- `src/client/cdg/decoder.ts` is a CD+G decoder written from scratch, so MP3+G lyrics render on a canvas in sync with the audio.
- `src/server/zip.ts` reads zipped MP3+G tracks with no dependencies.
- `src/desktop/` is the Electron shell. It runs the same server in-process and adds native windows, the folder picker and menus. `scripts/build-desktop.mjs` bundles it, `electron-builder.yml` packages it, and `npm run icons` redraws the icons in `build/`.

## Ideas for next

- Key change for local tracks (AudioWorklet pitch shifting)
- Background music between singers
- Singer history across nights (regulars, favorites, "sing it again")
- Printable QR table tents
- Duet requests and tip/priority bumps
