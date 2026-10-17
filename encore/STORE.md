# Selling Encore on the Microsoft Store

Encore ships as a Windows desktop app built with Electron. The same code makes two Windows files:

| File | What it's for | How to build |
|---|---|---|
| `Encore-Karaoke-Setup-x.y.z.exe` | Installer for your own laptop and testers. Adds a desktop icon and a Start menu entry. | `npm run dist:win` on Windows, or the **Encore desktop** GitHub Action |
| `Encore-Karaoke-x.y.z.appx` | The package you upload to the Microsoft Store | `npm run dist:store` on Windows, or run the Action with **Store package** ticked |

**How Encore is sold.** The Store listing is a **free download**. KJs get a 14-day free trial inside Encore and, once it's over, pay through Encore's own checkout on Stripe (see `docs/LICENSING.md`). Microsoft allows this for apps that aren't games: policy 10.8.1 says non-game products on PC may use a secure third-party purchase API instead of the Store's own, and Microsoft takes no share of those sales. So in Partner Center **set the price to Free, and don't use the Store's trial or add-ons.** The Store signs the `.appx` for you, so you don't need a code-signing certificate to distribute through it.

The policies quoted here are Microsoft Store Policies 7.20 (14 September 2026): <https://learn.microsoft.com/en-us/windows/apps/publish/store-policies>. They change, so re-read the sections named below before you submit.

## Where things stand (17 October 2026)

| | State |
|---|---|
| The app, sign-in, 14-day trial, unlock codes | Built, and working in the installed 0.2.0 build. |
| Stripe payments | Built and tested, **not switched on** (PR #5; steps in `supabase/README.md`, "Payments (Stripe)"). The console names Stripe at the point of purchase, and says in advance what the end of the trial changes, because the Store requires both (10.8.2 and 10.8.4). |
| The Store package (`.appx`) | **Builds and runs, with one defect and one risk about where it keeps data.** The Action built it on 17 October (run 38998787282): `Encore-Karaoke-0.2.0.appx`, 157 MB, version `0.2.0.0`, a full-trust desktop app with the three network capabilities, unsigned as expected (the Store signs it). It was sideloaded and run on the development PC the same night: it starts, serves, and reaches the internet, but on a new PC *Open Data Folder* fails and uninstalling deletes the KJ's data. See "Testing the package", which also says how to fix it. |
| Partner Center account | **Exists**: the one Squatchy is published from, with publisher display name Scriblio. Per my notes from setting up Squatchy it is an *individual* account (check in Partner Center → Account settings). Policy 10.14 says businesses must use a *company* account; Squatchy was accepted from this one, but decide before submitting (see section 2). |
| Product identity in `electron-builder.yml` | Still the placeholder `CN=00000000-…`. The publisher is the same for every app on the account: Squatchy's installed manifest says `CN=BFB91569-38F5-414F-860A-C7113DA89E49`. Only the product name has to be reserved in Partner Center, and its Package/Identity/Name copied in. |
| A demo account for the certifiers | Not made. Encore needs a sign-in, so policy 10.3.1 requires one (see below). |
| Google's YouTube review and quota extension | Waiting (the review's deadline is 21 October). Don't send customers before the extension is granted: the free quota is about 99 uncached searches a day across everyone. |
| Wording for `TERMS.md` and `PRIVACY.md` | Proposed in `docs/LICENSING.md`, waiting for Matthew's approval. Both must be updated before real money. |
| Real-world checks | Open (`docs/HANDOFF.md`, item 1): real phones, a real YouTube playback at a venue, key change by ear. The beta KJs are the way to cover them. |

## 1. Get the installer (desktop icon)

1. On GitHub, open **Actions → Encore desktop** and click the latest green run.
2. Download **Encore-Karaoke-Windows** under *Artifacts* and unzip it.
3. Run `Encore-Karaoke-Setup-….exe`. It installs and puts **Encore Karaoke** on the desktop.

Because this installer isn't code-signed, Windows SmartScreen may say "Windows protected your PC". Click **More info → Run anyway**. Store installs don't show this. If you also want to sell the `.exe` directly from your own website, buy a code-signing certificate so the warning goes away.

The first time Encore starts, Windows Firewall asks whether it may use the network. Allow **Private networks**, otherwise phones can't join.

## 2. Set up the Store listing

1. **Choose the Partner Center account** ([Partner Center](https://partner.microsoft.com/dashboard), Apps and games). You already have one, which Squatchy is sold from. Policy 10.14 says businesses, and anyone acting in relation to their trade or profession, must use a **company** account, and a customer could read "Scriblio" as a business. Squatchy, a paid app, was accepted from the individual account, so Encore may be too, but the policy's wording fits Encore, so pick one on purpose: carry on with the individual account (a small chance that certification asks for a company one), or open a company account for the business that sells Encore (Scriblio, a brand of ALM Partners LLC). As far as I know an account's type can't be converted, so that would be a new account, with identification or business verification (days to weeks) and customer support contact details shown on the listing in some regions; Squatchy would stay where it is.
2. **Reserve the app name.** "Encore Karaoke" may already be taken, so have a few alternatives ready. Search the Store and do a basic trademark check before you commit to a name.
3. **Copy your product identity into the build.** In Partner Center open your app → *Product management* → *Product identity*. Copy three values into `electron-builder.yml` under `appx:`:

   | Partner Center | `electron-builder.yml` |
   |---|---|
   | Package/Identity/Name | `identityName` |
   | Package/Identity/Publisher | `publisher` (starts with `CN=`) |
   | Package/Properties/PublisherDisplayName | `publisherDisplayName` |

   If you change the app name, also update `productName`, `appx.displayName` and the `PRODUCT` constant in `src/desktop/main.ts`.
4. **Build the Store package.** Run the GitHub Action by hand with *Store package* ticked, or run `npm run dist:store` on a Windows PC. Each new submission needs a higher `version` in `package.json`.

### Testing the package

**How to try the package on a PC without a certificate.** An unsigned `.appx` can't be installed directly: Windows refuses with "an unsigned package cannot include Executable activations", which is true of any desktop app. What works:

1. Turn on Developer Mode (Settings → System → For developers).
2. Put the `.appx` at a **short path** such as `C:\encore-test\`. A path of about 260 characters or more gives a misleading "source uri is blocked by MsixAllowedZones policy" error.
3. Unpack it with the Windows SDK's `makeappx` and register the folder: `makeappx unpack /p Encore-Karaoke-0.2.0.appx /d C:\encore-test\layout`, then `Add-AppxPackage -Register C:\encore-test\layout\AppxManifest.xml`. Start it from the Start menu. Remove it with `Get-AppxPackage Scriblio.EncoreKaraoke | Remove-AppxPackage`.
4. To see what a **new customer** gets, first rename `%APPDATA%\Encore Karaoke` (and put it back afterwards). Without that, the package uses the folder an installed copy already has. Also don't run it with an installed copy's `data\account.json` in place: the package refreshes that sign-in, which uses up the installed copy's.

**What the test found (16–17 October, development PC).**

- **It works:** it starts with the package's identity; the console renders; a new user gets the first-run guide, signed out; the local server answers on port 4747 (`/dj`, `/join`, `/display`); a YouTube search from inside the package returns results, so the internet works from the container; Windows made an allow rule for private networks, so phones on the venue Wi-Fi can reach it.
- **Defect: *Show → Open Data Folder* fails on a new PC.** Windows redirects the new `AppData` folders a Store app creates to a private place, `%LOCALAPPDATA%\Packages\<package family>\LocalCache\Roaming\Encore Karaoke`, which only the app sees. Explorer can't find the folder the app asks for, and says "Location is not available" for `…\AppData\Roaming\Encore Karaoke\data`.
- **Risk: uninstalling deletes the data.** The redirected folder is removed with the package: the settings, song keys, show history, the online join link's room and key (so **printed QR codes stop working**), the lock-screen alert keys and the sign-in. The installer version keeps its data when it is uninstalled.
- **Only new installs are affected.** If the PC already has `%APPDATA%\Encore Karaoke` (someone upgrading from the beta installer), the package uses that folder in place and nothing is redirected. That is how Microsoft says it should carry on from an unpackaged copy.

**What to do about the data.** The recommended fix is to switch the redirection off for the Store build, so it behaves like the installer: the data lives in the real `%APPDATA%\Encore Karaoke`, survives an uninstall, is shared with a beta install, and *Open Data Folder* works. In the manifest that is `<desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>` under `<Properties>`, together with the restricted capability `unvirtualizedResources`. Partner Center asks for a reason for a restricted capability; a true one is "the app keeps its settings, show history and printed-QR identity in AppData, which must survive an uninstall and be reachable by the user". electron-builder can't write that property, so a step after the build has to patch the manifest (unpack with `makeappx`, edit, repack), as was done for this test. The alternative is to keep the redirection, point *Open Data Folder* at the private folder, add a backup/export, and say in the listing that uninstalling removes your data; that is a worse deal for a KJ's printed QR codes.

**Not tested yet.**

- Signing in with a real email address from the package.
- Phones joining over Wi-Fi.
- An update over an older version.
- A real Store-signed install. Partner Center can limit a listing to a private audience or hide it, which is the way to try it on other PCs before it goes public.
- The **Windows App Certification Kit** (part of the Windows SDK), which runs most of what certification does. It needs an administrator.
- Sound on the chosen speakers, a second monitor, printing and *Save PDF*, and a clean uninstall (policy 10.2.7) on a real venue setup.

## 3. Submit

In Partner Center, create a submission:

- **Pricing and availability:** **Free.** No Store trial and no add-ons: Encore's trial and purchase happen inside Encore.
- **Say that payments use a third party.** Policy 10.8.2 requires you to note the use of a secure third-party purchase API in Partner Center during submission. Say it in the *Notes for certification* below, and answer any in-app purchase question Partner Center asks to match. Encore meets the policy's other conditions by design: the console names Stripe where you buy, the KJ is signed in, each purchase is confirmed on Stripe's own page (so every transaction is confirmed by the buyer), Stripe's hosted Checkout handles the card (PCI DSS), and sign-in happens in the app while only the payment goes to the browser after install.
- **Properties:** category *Music*, and the privacy policy URL <https://sing.scriblio.co/privacy>. Encore handles singers' names and KJs' email addresses. Add the Stripe line to the policy first (proposed wording in `docs/LICENSING.md`).
- **Age ratings:** fill in the IARC questionnaire. Encore has no user-to-user chat; singers only enter a name and a song request, and names go through a filter.
- **Packages:** upload the `.appx`.
- **Store listing:** a description and screenshots (at least one, 1366×768 or larger; `src/site/encore-console.png` is 1600×1000). The listing and the app must be clear about the purchases (policy 10.8.4: the types of in-product purchase and the range of prices, and the scope and terms of the trial). Suggested wording for the description:

  > Free to download, with a 14-day free trial of everything. After the trial you can keep opening Encore and using your library, settings and printing; to start new shows you buy Encore once ($149, including a year of Encore Cloud) or use an unlock code. Encore Cloud, the online join link and lock-screen alerts, is optional after that at $49 a year. Payments are handled by Stripe. YouTube search and playback are included in every plan.

- **Submission options → Notes for certification.** Policy 10.3.1 says that if your product requires login credentials you must provide a working demo account here, and 10.3.2 that any server it needs must be working. Encore needs a sign-in, and the sign-in is an emailed code, so a tester has to be able to open an inbox:
  1. Make a mailbox only for this (a free Outlook.com or Gmail address, say), and keep its password out of the repo.
  2. Sign in to Encore with it once, then in the Supabase SQL editor run `select set_owner('that address');` and press *Check again* in Encore. That gives it everything, so a tester never runs into the trial's end, even on a resubmission weeks later.
  3. Keep the Supabase project, the sign-in email (Resend) and the YouTube search service running while the submission is under review.
  4. Suggested text:

  > Encore is a karaoke hosting app. It opens a DJ console window. To run a show you sign in with an email address: Encore emails a 6-digit code, which you type into Encore. Please use this test account: email ADDRESS, and open its inbox at WEBMAIL-ADDRESS with the password PASSWORD to read the code (it can take a minute to arrive). That account has full access, so no payment is needed. Demo songs are included, so no library is needed: type a name in "Add a walk-up singer", search "step", click +, then "Call up" and "Start song". The venue screen opens from "Open screen" (top right) and plays the song with lyrics. Singers normally join from their phones by scanning the QR code, which opens a secure web page; that part is optional for testing. The app also runs a small local web server on port 4747 so phones on the same Wi-Fi can join without internet, which is why it needs network server capabilities. The optional paid license is bought on Stripe's own secure web page, opened from Settings → Your Encore (a secure third-party purchase API, policy 10.8.2); testers don't need to buy anything.

- **Restricted capability `runFullTrust`:** Partner Center will ask why the app needs it. Every Electron (Win32) desktop app requires it; say it is "a desktop app packaged with the Desktop Bridge".

Certification usually takes a few business days. If it fails, the report says why. Fix the problem, bump the version, and resubmit.

## Things to decide before charging money

- **Stripe live mode.** Everything is built to be tried in Stripe's test mode first (`supabase/README.md`). Real money also needs the Stripe account activated for live payments, the live prices, webhook and keys, the terms and privacy wording approved, a refund routine, and a decision on tax.
- **YouTube.** Encore plays YouTube through YouTube's official embedded player and never downloads videos. That keeps it within YouTube's terms. Still:
  - Market Encore as KJ software, not as "free karaoke from YouTube".
  - Search goes through your one Google Cloud project, via the `youtube-search` Supabase function; the key never ships inside the app (see [supabase/README.md](supabase/README.md)). The YouTube policies forbid both shipping the key and asking KJs for their own.
  - The free quota is 10,000 units a day: about 99 uncached searches across all customers. Apply for more through the YouTube API Services audit and quota extension form well before launch; it can take weeks. Google's review is open now (see `docs/HANDOFF.md`, item 2).
  - Keep YouTube search part of the product, not a paid add-on: the policies forbid selling access to YouTube API Services. No plan, trial or code in Encore includes or excludes any YouTube feature, and that must stay true.
  - Your Terms of Use should say that users of YouTube features agree to the YouTube Terms of Service, and link the Google Privacy Policy (the app already shows both links next to search results).
  - Encore leaves YouTube's player uncovered and shows YouTube titles unmodified, as the policies require. Keep it that way.
- **Music licensing.** KJs bring their own legally obtained tracks, and venues need public-performance licenses. Say both in your listing and terms of use.
- **Support.** Paying customers will email you. Set up a support address on your own domain before launch (the pages use a personal Gmail address today), and put it in the listing, the Terms and PRIVACY.md. Company accounts must give support contact details for the listing anyway.
- **Mac.** `npm run dist:mac` builds a `.dmg`, but selling on Mac needs an Apple Developer account plus signing and notarization. That's a separate project.
