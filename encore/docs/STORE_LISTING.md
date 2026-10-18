# Encore on the Microsoft Store: ready-to-paste listing

Everything Partner Center asks for, written and checked against Microsoft's limits (as published on Microsoft Learn on 2026-10-18). `STORE.md` has the plan and the reasoning; this file is the copy. Fields in Partner Center can change, so if a name below doesn't match what you see, use the closest one.

**Before you paste:** the demo-account words in capitals (`DATE`, `DEMO_EMAIL`, `WEBMAIL_ADDRESS`, `DEMO_PASSWORD`, `DEMO_PLUS_EMAIL`) are for Matthew to fill in. The password goes only into Partner Center, never into this repo.

## Decisions that are yours

| Decision | Recommendation |
|---|---|
| **The second restricted capability, `unvirtualizedResources`: removed.** Microsoft's capability reference describes it as meant for certain desktop PC games published by Microsoft and its partners (and for apps packaged with external location), and says it isn't intended for other scenarios because it could stop the system uninstalling the app cleanly, and policy 10.2.7 requires a clean uninstall. If Microsoft had refused it, the whole submission would have failed. | **Decided on 2026-10-18, and built:** the Store build keeps its data in `C:\Users\<name>\Encore Karaoke`, outside AppData, so it needs no such capability (`src/desktop/datadir.ts`, tried with the real package). Only `runFullTrust` is left, and the notes below no longer need a paragraph about the other. |
| **Markets** | Start with the **United States** only. No sales tax is collected at launch, and a company account selling in the EU or France has extra consumer-law and contact-information duties (Microsoft's support-info page says so for France). Widen it later. |
| **When it goes live** | In *Submission options → Publishing hold options* choose **Don't publish this submission until I select Publish now**, and press it only after Google grants the YouTube quota extension (until then Encore can do about 99 uncached searches a day across all customers). |
| **OneDrive backups** (a Product declaration, ticked by default) | **Untick it.** The KJ's data lives in their profile folder, not in the package's own data, so there is nothing worth restoring from a backup (and the sign-in in that folder can only be refreshed from one place). |
| **Phone and address in Support info** | Microsoft says these are for regulatory and legal use and are generally not shown to customers browsing the Store. Use the LLC's address. |

## 1. Properties

| Field | What to enter |
|---|---|
| Category | **Music** (it has no subcategory). Optional secondary category: **Entertainment**. Never *Games*. |
| Does the app access, collect or transmit personal information? | **Yes** (KJ email addresses and singer names). The privacy policy is then required. |
| Privacy policy URL | `https://sing.scriblio.co/privacy` |
| Website | `https://sing.scriblio.co/encore` (must be your own site, not the Store listing) |
| Support contact info | `encore-support@scriblio.co` |
| Product declarations | **Tick** "This product allows users to make purchases, but does not use the Microsoft Store commerce system" (this is the third-party payments check box that policy 10.8.2 requires). **Leave unticked:** accessibility (not tested for it), pen and ink, generative AI. Leave the alternate-drives box as it is. Untick OneDrive backups (see above). |
| System requirements | Leave blank. The extra items are under *Store listing → Additional system requirements*. |

## 2. Pricing and availability

| Field | What to enter |
|---|---|
| Price | **Free** |
| Free trial | **No free trial.** Encore's own 14-day trial happens inside Encore. |
| Add-ons | None. Purchases are outside the Store. |
| Markets | United States (see Decisions). |
| Visibility | The default, "available and discoverable", is fine once you press publish. |
| Organizational licensing | Leave the default. |

## 3. Age ratings (IARC questionnaire)

Answer what the form asks, truthfully; Microsoft shares your publisher name and email with IARC. This is how Encore's facts map onto the questions, so the rating comes out right the first time. If the rating comes out higher than you expect, the likely causes are the YouTube and "users interact" answers: both are true, so leave them.

| Question | Answer |
|---|---|
| First question: the category that best describes the app | Pick the one for a utility, productivity or all-other app, not Game and not Social network. The rating follows the answers to the content questions, not the category. |
| Violence, blood, fear, sexual content, nudity, bad language, drugs, alcohol, tobacco, gambling, crude humor | No for all of them, for Encore's own content. Encore has no such content of its own. |
| Does the app let users play, stream or open content from the internet that the developer doesn't control? | Yes, if asked. The KJ can search YouTube and play results in YouTube's own embedded player, and plays files from their own folders. The content isn't Encore's; it is shown as YouTube provides it. |
| Does the app let users interact with each other or share content? | Answer honestly as limited. Singers type a display name and a song request that the KJ sees and that can appear on the venue screen. There is no chat, no messaging between singers and no sharing of photos or files. Names go through a filter and the KJ can remove anyone. |
| Does it share the user's location, or personal information with other users? | No. |
| Can users make purchases? | Yes. Encore sells its license outside the Store (Stripe's hosted Checkout, opened in the browser). If the form asks about in-app purchases or digital goods, declare them: a failed submission has asked for exactly this to be declared. |
| Unrestricted web access | Encore has no web browser of its own. It opens links (Stripe's payment page, Encore's Terms and Privacy pages, YouTube's and Google's terms) in the user's own browser. Say so if the question is asked this way. |

## 4. Store listing (English)

**Product name:** `Encore Karaoke`

**Short description** (recommended under 270 characters; this is 199):

```text
Run the whole karaoke night from one laptop. Singers join from their phones, the rotation stays fair, and songs play from your own library or from YouTube. Free to download, with a 14-day free trial.
```

**Description** (plain text, limit 10,000; this is 3235; Microsoft says no HTML, code or URLs here, and there are none):

```text
Encore Karaoke runs the whole karaoke night from one Windows laptop. Singers sign up from their phones, the rotation stays fair, and the songs play on your venue screen, from your own library or from YouTube.

MADE FOR KARAOKE HOSTS (KJs)

Singers scan a QR code, type a name and pick a song. There is no app to install and no account for them to make. You see every request in your console, and Encore keeps the order fair: everyone gets a turn before anyone sings twice. Choose the rotation that suits the room (Classic Rotation, Fair Play, First Come or Shuffle Rounds), and hold, pin, skip or re-order singers whenever you need to. Each singer gets a "you're up next" alert on their phone, with a vibration and a chime when it's their turn.

YOUR SONGS, OR YOUTUBE

Play MP3+G (CD+G) and video karaoke files from your own folders, and change the key of a library song up or down. Encore remembers each singer's key for next time. You can also search YouTube for karaoke videos without leaving Encore. They play on the venue screen in YouTube's own player, and the search results are shown just as YouTube provides them. Encore never downloads or alters YouTube videos, and you never need a YouTube account or an API key.

A VENUE SCREEN THAT LOOKS THE PART

Put the venue screen on a TV or a second monitor. It shows who is on stage and who is up next, plays your lyrics and videos, and shows a QR code for singers to join. Between singers, break music plays from a folder you choose, over moving graphics. Add a tip link and the screen shows a QR code for it between songs; Encore never touches the money.

WORKS WITH OR WITHOUT THE INTERNET

Phones join over the venue's Wi-Fi, so a show from your own library carries on even when the internet is down. Encore Cloud adds an online join link that works from any phone on any network, and lock-screen alerts, so singers can put their phone away until it's their turn. Print table tents and posters with your QR code, or save them as PDF files.

TRY IT FREE

Encore is free to download and comes with a 14-day free trial of everything. Demo songs are included, so you can run a whole practice show before you add a library.

After the trial you can keep opening Encore and using your library, settings and printing. To start new shows you buy Encore once for $149 (this includes a year of Encore Cloud), subscribe to Encore Monthly for $29 a month (Cloud included, cancel any time), or use an unlock code. After the first year, Encore Cloud is optional at $49 a year. Prices are in US dollars. Payments are handled by Stripe, not by the Microsoft Store, and Encore never sees your card number. A show that is already running is never cut off.

YouTube search and playback are included in every plan, and no plan changes which YouTube features you get.

GOOD TO KNOW

You bring your own legally obtained karaoke tracks, and your venue may need a public-performance license. You sign in to Encore with your email address: it emails you a 6-digit code, so there is no password to remember. Requires Windows 10 or 11. A second screen or TV for the venue screen is recommended.

YouTube is a trademark of Google LLC. Encore Karaoke isn't affiliated with or endorsed by YouTube or Google.
```

**What's new in this version:** leave blank for the first submission.

**Product features** (up to 20, each up to 200 characters; don't add bullets; 13 here). Add one at a time:

1. (108) `Singers join from their phones: scan a QR code, type a name, pick a song. No app and no account for singers.`
2. (111) `Fair rotation: everyone sings once before anyone sings twice, with four rotation styles, holds, pins and skips.`
3. (98) `A "you're up next" alert on the singer's phone, with a vibration and a chime when it's their turn.`
4. (64) `Play MP3+G (CD+G) and video karaoke files from your own folders.`
5. (83) `Change the key of a library song. Encore remembers each singer's key for next time.`
6. (106) `Search YouTube for karaoke videos inside Encore and play them in YouTube's own player on the venue screen.`
7. (103) `A venue screen for your TV or second monitor: who's singing, who's next, the lyrics and a join QR code.`
8. (75) `Break music between singers from a folder you choose, over moving graphics.`
9. (75) `Print table tents and posters with your QR code, or save them as PDF files.`
10. (76) `An optional tip QR code on the venue screen. Encore never touches the money.`
11. (88) `Encore Cloud: an online join link for any phone on any network, plus lock-screen alerts.`
12. (129) `Phones join over the venue's Wi-Fi, so a show from your own library runs even when the internet is down. Demo songs are included.`
13. (93) `Free 14-day trial. Then $149 once (a year of Cloud included) or $29 a month. Cancel any time.`

**Search terms**, if your form has them (up to 7, each up to 40 characters, no more than 21 words in all): `karaoke`, `KJ software`, `karaoke host`, `CD+G`, `karaoke queue`, `singer rotation`, `karaoke night`.

**Copyright and trademark info**, if your form has it (up to 200 characters; this is 171):

```text
© 2026 ALM Partners LLC. Encore Karaoke is a Scriblio product. YouTube is a trademark of Google LLC; Encore Karaoke isn't affiliated with or endorsed by YouTube or Google.
```

**Additional license terms**, if your form has it: leave blank, so Microsoft's standard terms apply. Encore's Terms of Use already say the Store's terms cover the download.

**Additional system requirements** (up to 11 items each, 200 characters each):

- Minimum hardware:
  - `An internet connection to sign in and to check your license (about every 12 hours; it keeps working offline for up to 14 days).`
- Recommended hardware:
  - `A second screen or TV connected to the laptop, for the venue screen.`
  - `A phone for each singer (iPhone or Android).`
  - `Speakers or a PA system connected to the laptop.`

**Store logo:** the 1:1 app tile icon (300 x 300 pixels) is recommended; without it the Store uses the icon in the package. `build/icon.png` is 1024 x 1024, so it needs scaling down to 300 x 300 and saving as PNG. Poster and box art (2:3 and 1:1) are for games, so skip them.

### Screenshots

Requirements: PNG, **at least 1366 x 768**, up to 3840 x 2160, at most 50 MB each; one is required, 4 to 8 are recommended, up to 10 are allowed. Keep the important parts in the top two-thirds, and don't add logos, icons or marketing text on top. Caption limit 200 characters.

| # | File | Size | Caption | Status |
|---|---|---|---|---|
| 1 | `src/site/encore-console.png` | 1600 x 1000 | The DJ console: who's on stage, who's next, and songs from your library or YouTube. | Ready. It's the current console. |
| 2 | venue screen, idle | needs 1920 x 1080 | The venue screen between singers: a QR code to join and who is up next. | `docs/display-idle.png` is only 1280 x 720: retake. |
| 3 | venue screen, singer introduced | needs 1920 x 1080 | The venue screen introduces the singer, with the next singer and the join code. | `docs/display-intro.png` is only 1280 x 720: retake. |
| 4 | phone page, "The line" | needs 1366 x 768 or larger | A singer's phone: their place in line, with no app to install. | `docs/phone-line.png` is a phone-sized 390 x 664: place on a plain background, or skip. |

`docs/dj-console.png` is out of date (it still says "add an API key in Settings to search YouTube", which Encore no longer asks for): don't use it.

## 5. Submission options

### Notes for certification

Policy 10.3.1 requires a working demo account here; 10.3.2 requires the server to be up. Microsoft says a real person reads these, so be polite and brief. Paste this, then fill in the capitals. (1989 characters. Microsoft's page gives no limit for this field, so it is kept under 2,000 in case the form has one.)

```text
Hello, and thank you for testing Encore Karaoke (karaoke hosting software, not a game). Notes dated DATE.

SIGN-IN (10.3.1): Encore signs in with an email address: it emails a 6-digit code (sender "Encore", hello@scriblio.co; check junk mail) and you type it into Encore. Test account: DEMO_EMAIL. Read its code at WEBMAIL_ADDRESS, password DEMO_PASSWORD. The account has full access, so no payment is needed. Encore's services (sign-in, license check, YouTube search) will stay online during testing (10.3.2).

TO TRY IT: demo songs are included. Type a name in "Add a walk-up singer" and click Add. Under "Adding for" choose that singer, search "step", click + next to a song, then click "Call up" and "Start song". "Open screen" (top right) opens the venue screen, which plays the song with lyrics. Phones joining is optional for testing. YouTube search is in the Songs tab.

NETWORK: Encore runs a small local web server (port 4747) so phones on the venue Wi-Fi can join without the internet. Windows asks to allow private networks on first run.

PURCHASES (10.8.1, 10.8.2, 10.8.4): the listing is free. The optional license ($149 once, $29 a month, or Encore Cloud $49 a year) is sold with a secure third-party purchase API, which 10.8.1 allows for non-game PC products: Stripe's hosted Checkout, opened in the browser from Settings > Your Encore after install. The buyer is signed in and confirms every purchase on Stripe's page; Encore never sees card details. This is also declared with the Partner Center check box. The test account is already unlocked, so it shows no Buy buttons; to see them, sign in with DEMO_PLUS_EMAIL (same inbox). Please don't buy anything.

TIPS: Settings > Tips lets a host add their own Venmo, Cash App or PayPal.me link, shown as a QR code on the venue screen. It is a tip to the host, not a purchase in Encore.

YOUTUBE: videos play only in YouTube's own embedded player, unaltered.

Restricted capabilities are explained in that section of this page.
```

**Making the demo account** (this is the part that needs you):

1. Make a mailbox only for this, such as a free Outlook.com or Gmail address, and turn off any step that would block a stranger signing in (a phone check, for example). Keep its password out of the repo.
2. Open Encore (the Store build, or the installer) and sign in with that address once.
3. In the Supabase SQL editor run `select set_owner('that address');` and press *Check again* in Encore. That gives it everything, even on a resubmission weeks later. (A Claude Code session can run it on Matthew's go-ahead.)
4. The `DEMO_PLUS_EMAIL` trick works on Outlook.com and Gmail: `name+trial@outlook.com` arrives in `name@outlook.com`'s inbox, and to Encore it's a different, brand-new account, which shows the free trial and the Buy buttons.
5. Keep Supabase, the sign-in email (Resend) and the YouTube search function running until certification finishes.

### Restricted capability

Partner Center finds the package's restricted capabilities and asks why each is needed and how it is used. There is one, `runFullTrust`.

**`runFullTrust`** (682 characters):

```text
Encore Karaoke is a Windows desktop application built with Electron (Chromium and Node.js) and packaged as MSIX with the Desktop Bridge. It runs as a full-trust, medium-integrity Win32 process, which is the only way an Electron application can run, so the package must declare runFullTrust.

The app needs full trust to: read the host's own karaoke files (MP3, CDG and video) from folders the host chooses; play audio and video; print and save PDFs; and run a small local web server (port 4747) so phones on the same Wi-Fi can join a show.

It does not install services, drivers, scheduled tasks or startup entries, it does not run elevated, and it does not change Windows settings.
```

The package used to ask for a second one, `unvirtualizedResources`. It was removed on 2026-10-18 (see *Decisions that are yours*), so there is nothing else to explain. `STORE.md` ("The data folder") says how the Store build keeps its data without it.

## 6. Before you submit

- [ ] Partner Center company account approved; "Encore Karaoke" reserved (have two other names ready).
- [ ] Package/Identity/Name, Publisher and PublisherDisplayName copied into `electron-builder.yml` (`appx:`), and `version` in `package.json` raised.
- [ ] Store package built (run the *Encore desktop* Action with **Store package** ticked), and tried: signing in with a real email from the package, phones joining over Wi-Fi, a YouTube search.
- [ ] Windows App Certification Kit run on the package (it needs an administrator).
- [ ] Demo account made and tested (section 5); Supabase, Resend and the YouTube search function up.
- [ ] Screenshots made (section 4) and the 300 x 300 icon saved.
- [ ] Everything above pasted; publishing hold set to **Don't publish until I select Publish now**.
