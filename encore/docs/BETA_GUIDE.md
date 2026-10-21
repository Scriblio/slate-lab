# Encore beta: guide for testers

Thank you for trying Encore. This is a beta: it works, but it hasn't met a real venue yet, and you are the first to find out what a real night does to it. This page says how to install it, what to try, and how to tell us what you found. Send it to a tester along with their unlock code.

## What you need

- A Windows 10 or 11 laptop to run the show from.
- A phone or two for singers (iPhone or Android), and ideally a second screen or TV for the "venue screen".
- A few karaoke files (MP3+G or video) if you have them. Encore also searches YouTube for karaoke videos, so you can start without any files.
- The internet, to sign in and to check your license about every two weeks. A show keeps running without it in between.

## Install

1. Download `Encore-Karaoke-Setup-0.2.1.exe` from the beta page: https://github.com/Scriblio/slate-lab/releases/tag/encore-v0.2.1-beta
2. Run it. Windows may say "Windows protected your PC" because the installer isn't code-signed yet: click **More info**, then **Run anyway**.
3. Open Encore. It asks for your email address and emails you a 6-digit code (from "Encore", `hello@scriblio.co`; check your junk folder). Type the code in. That starts a 14-day free trial.
4. Open **Settings → Your Encore**, find **Have an unlock code?**, and type the code you were given. It looks like `ENC-XXXX-XXXX-XXXX`. It unlocks Encore and Encore Cloud for your email address, so please don't share it.

Uninstalling keeps your library and settings in `%APPDATA%\Encore Karaoke` (Encore's menu **Show → Open Data Folder** opens it).

## A practice run (10 minutes)

1. In **Settings**, point Encore at your karaoke folder, or skip that and use YouTube.
2. Click **Open screen** (top right) and put the venue screen on your TV or second monitor.
3. Scan the QR code on the venue screen with a phone. Type a name, pick a song, and sign up.
4. In the console, **Call up** the singer and **Start song**.

## What we'd most like you to try

Please note what happened, and what you expected. "It worked" is useful too.

1. **YouTube.** Search for songs you'd really run. Do the videos play on the venue screen? How many won't play? Do you find the right version quickly?
2. **Phones.** Join from a phone on the venue's Wi-Fi, and then from a phone on mobile data (that one needs Encore Cloud, which your code includes). Does it feel quick? What happens when a phone locks, or the page reloads?
3. **Alerts.** On a phone, turn on lock-screen alerts, lock it, and have the KJ call that singer up. Does "You're up next" arrive, and "It's your turn"? (Android: Chrome. iPhone: add the page to your Home Screen first.) Also the vibration and chime when called, and whether the screen stays awake.
4. **Key change.** Change the key of a library song up and down by 2 and by 4. How does it sound? Do the CD+G lyrics still feel in time?
5. **Printed QR codes.** In **Settings → Print QR codes**, print a table tent or poster, then scan it from another network. It should keep working at your next venue.
6. **A whole real show,** if you can. What got in your way? What would you change? What did singers ask you?

## Tell us

Reply to whoever sent you this, with a few lines and a screenshot where you can. If something breaks, the most useful things are what you clicked, what you saw, and the time. Encore's data folder (above) has your settings; you don't need to send it unless we ask.

## For whoever is running the beta

- **Codes.** Make one per tester in Supabase's SQL editor: `select make_unlock_code('beta friend 6');` (see `supabase/README.md` for options, and for the query that shows who has used which). Codes are single-use and stay in your own Documents folder, never in the repo or in email threads you don't control.
- **Keep the payment state in mind.** Builds from 0.2.1 show buy buttons under Settings → Your Encore, and since Stripe went live (2026-10-18) they open Stripe's real checkout, so a tester who clicks one can really pay. A tester with an unlock code never needs to. (Build 0.2.0 had no buy buttons.)
- **After the first real shows,** look at Supabase's Realtime report to see what Encore Cloud costs per KJ (the estimate is a few dollars a year).
