# Selling Encore on the Microsoft Store

Encore ships as a Windows desktop app built with Electron. The same code makes two Windows files:

| File | What it's for | How to build |
|---|---|---|
| `Encore-Karaoke-Setup-x.y.z.exe` | Installer for your own laptop and testers. Adds a desktop icon and a Start menu entry. | `npm run dist:win` on Windows, or the **Encore desktop** GitHub Action |
| `Encore-Karaoke-x.y.z.appx` | The package you upload to the Microsoft Store | `npm run dist:store` on Windows, or run the Action with **Store package** ticked |

**How Encore is sold.** The Store listing is a **free download**. KJs get a 14-day free trial inside Encore and, once it's over, pay through Encore's own checkout on Stripe (see `docs/LICENSING.md`). Microsoft allows this for apps that aren't games. Policy 10.8.1 makes the Store's own checkout mandatory only for **games** and for products on **Xbox consoles**; "non-game products made available on PC devices" may use either a secure third-party purchase API or the Store's, and 10.8.6 says the same for subscriptions (Cloud). Microsoft's own getting-started page says non-game apps can choose their own commerce platform and keep 100% of the revenue (the Store's checkout costs 15% for apps). So in Partner Center **set the price to Free, and don't use the Store's trial or add-ons.** The Store signs the `.appx` for you, so you don't need a code-signing certificate to distribute through it.

**Why an outside checkout isn't a rejection here.** For a game or an Xbox product, 10.8.1 does say the product must not direct users to any purchase mechanism other than the Store's. For a non-game Windows app it doesn't: 10.8.2 lists the conditions for using a third party and even says that after installation "users may be directed to a browser to complete" transactions. Encore meets them (see "Submit"). The things a certifier could still stumble on are: the app being treated as a **game** (it's a KJ tool, so use the category *Music* and never call it a game), the **Partner Center check box** for third-party purchases not being ticked, and the **account type** (section 2, step 1). If a certifier still objects, the options, in order: answer with the policy text (the notes below quote it); ship the Store build without a Buy button, so KJs buy on the website and type an unlock code (Electron reports a Store package as `process.windowsStore`, so one build could hide the button; not built, and to be checked against the real package and with Microsoft); or use the Store's own purchase API for the Store build (15% to Microsoft, and a native bridge from Electron that doesn't exist yet).

The policies quoted here are Microsoft Store Policies 7.20 (14 September 2026): <https://learn.microsoft.com/en-us/windows/apps/publish/store-policies>. They change, so re-read the sections named below before you submit.

## Where things stand (17 October 2026)

| | State |
|---|---|
| The app, sign-in, 14-day trial, unlock codes | Built, and working in the installed 0.2.0 build. |
| Stripe payments | Built, tested, deployed to the live Supabase project and **tried for real in Stripe's test mode on 17 October** (the $149, the $49 Cloud renewal and Encore Monthly, with Matthew's test card); **live mode isn't set up** (steps in `supabase/README.md`, "Payments (Stripe)" and "Encore Monthly"). The console names Stripe at the point of purchase, and says in advance what the end of the trial changes, because the Store requires both (10.8.2 and 10.8.4). |
| The Store package (`.appx`) | **Builds, runs, and keeps its data like the installer.** The Action builds it (run 39000957034 on 17 October: `Encore-Karaoke-0.2.0.appx`, 157 MB, version `0.2.0.0`, a full-trust desktop app with the three network capabilities, unsigned as expected because the Store signs it), and electron-builder's last step patches it so Windows doesn't redirect its AppData (`scripts/patch-appx.mjs`). The first, unpatched build was sideloaded and showed that on a new PC *Open Data Folder* failed and uninstalling deleted the KJ's data; the patched one was tried the same way and now keeps the data in the real `%APPDATA%\Encore Karaoke`, opens it, and leaves it after an uninstall. The patch needs the restricted capability `unvirtualizedResources`, which Partner Center asks a reason for and certification can question. Not tried yet: sign-in from the package, phones over Wi-Fi, an update over an older version, a real Store-signed install, the App Certification Kit. See "Testing the package". |
| Partner Center account | **Exists**: the one Squatchy is published from, with publisher display name Scriblio. Per my notes from setting up Squatchy it is an *individual* account (check in Partner Center → Account settings). Policy 10.14 says businesses, and anyone acting in relation to their trade or profession, must use a *company* account, and Microsoft's getting-started page says the same about selling apps as part of a business. Since May 2026 a company account is free to register. Squatchy was accepted from this one, but decide before submitting (see section 2): of everything Microsoft could object to, this is likelier to hold Encore up than the Stripe checkout. |
| Product identity in `electron-builder.yml` | Still the placeholder `CN=00000000-…`. The publisher is the same for every app on the account: Squatchy's installed manifest says `CN=BFB91569-38F5-414F-860A-C7113DA89E49`. Only the product name has to be reserved in Partner Center, and its Package/Identity/Name copied in. |
| A demo account for the certifiers | Not made. Encore needs a sign-in, so policy 10.3.1 requires one (see below). |
| Google's YouTube review and quota extension | Waiting for Google's answer (Matthew's reply of 16 October, with the screencast, met their 21 October deadline). Don't send customers before the extension is granted: the free quota is about 99 uncached searches a day across everyone. |
| Wording for `TERMS.md` and `PRIVACY.md` | Drafted on the branch `claude/encore-legal` (draft PR #8) with the support address `encore-support@scriblio.co`, which exists since 2026-10-17 as an alias on the `scriblio@scriblio.co` mailbox (`scriblio.co`'s mail is a GoDaddy-run Microsoft 365). A test email to it arrived in the `scriblio@` inbox on 2026-10-17. Waiting for Matthew's approval; both must be published before real money. |
| Real-world checks | Open (`docs/HANDOFF.md`, item 1): real phones, a real YouTube playback at a venue, key change by ear. The beta KJs are the way to cover them. |

## 1. Get the installer (desktop icon)

1. On GitHub, open **Actions → Encore desktop** and click the latest green run.
2. Download **Encore-Karaoke-Windows** under *Artifacts* and unzip it.
3. Run `Encore-Karaoke-Setup-….exe`. It installs and puts **Encore Karaoke** on the desktop.

Because this installer isn't code-signed, Windows SmartScreen may say "Windows protected your PC". Click **More info → Run anyway**. Store installs don't show this. If you also want to sell the `.exe` directly from your own website, buy a code-signing certificate so the warning goes away.

The first time Encore starts, Windows Firewall asks whether it may use the network. Allow **Private networks**, otherwise phones can't join.

## 2. Set up the Store listing

1. **Choose the Partner Center account** ([Partner Center](https://partner.microsoft.com/dashboard), Apps and games). You already have one, which Squatchy is sold from. Policy 10.14 says businesses, and anyone acting in relation to their trade or profession, must use a **company** account, and a customer could read "Scriblio" as a business. Squatchy, a paid app, was accepted from the individual account, so Encore may be too, but the policy's wording fits Encore, so pick one on purpose: carry on with the individual account (a chance that certification or a later account review asks for a company one), or open a company account for the business that sells Encore (Scriblio, a brand of ALM Partners LLC). Microsoft's getting-started page says people who distribute apps "in relation to their business, trade, or profession" should choose a company account. Its 7 May 2026 Windows Developer Blog post says company registration is now **free** (the $99 fee is gone): business verification takes a D-U-N-S number (free from Dun & Bradstreet) or documents such as formation papers, an email address on the company's own domain helps, and a failed verification can be appealed only three times, so send the right documents the first time. Neither says whether an individual account can be converted, so assume this is a new account, which would carry its own publisher ID (so `electron-builder.yml` takes the new one) and show customer support contact details on the listing in some regions (use a support address, not a personal one). Squatchy would stay where it is. The recommendation is the company account: Encore is sold for $149 by a business, it costs nothing now, and verification is the slowest step, so start it before anything else here.
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

**What the first test found (16–17 October, the build as electron-builder makes it).**

- **It works:** it starts with the package's identity; the console renders; a new user gets the first-run guide, signed out; the local server answers on port 4747 (`/dj`, `/join`, `/display`); a YouTube search from inside the package returns results, so the internet works from the container; Windows made an allow rule for private networks, so phones on the venue Wi-Fi can reach it.
- **Defect: *Show → Open Data Folder* failed on a new PC.** Windows redirects the new `AppData` folders a Store app creates to a private place, `%LOCALAPPDATA%\Packages\<package family>\LocalCache\Roaming\Encore Karaoke`, which only the app sees. Explorer can't find the folder the app asks for, and said "Location is not available" for `…\AppData\Roaming\Encore Karaoke\data`.
- **Risk: uninstalling deleted the data.** The redirected folder is removed with the package: the settings, song keys, show history, the online join link's room and key (so **printed QR codes stop working**), the lock-screen alert keys and the sign-in. The installer version keeps its data when it is uninstalled.
- **Only new installs were affected.** If the PC already has `%APPDATA%\Encore Karaoke` (someone upgrading from the beta installer), the package uses that folder in place and nothing is redirected. That is how Microsoft says it should carry on from an unpackaged copy.

**The fix, built and tried (17 October): `scripts/patch-appx.mjs`.** It switches the redirection off for the Store build, so it behaves like the installer. After electron-builder makes the `.appx`, the script unpacks it, adds `<desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>` to the manifest's `<Properties>` (with its namespace, marked ignorable so older Windows skips it) and the restricted capability `<rescap:Capability Name="unvirtualizedResources"/>` it requires, and packs it again with `makeappx`, which also checks the manifest. electron-builder runs it by itself: `electron-builder.yml` names `scripts/after-all-artifact-build.cjs` as its `afterAllArtifactBuild` step, which patches every `.appx` it has just made and fails the build if it can't, so the Action's Store build and `npm run dist:store` both come out patched, with nothing to remember. It takes about 15 seconds. By hand, on a package that is already built, `npm run store:patch` patches `release/*.appx` (add `-- --check` to only check; it exits 1 if one isn't patched). `test/appx-patch.test.ts` covers the manifest edit (it refuses a manifest shaped differently from electron-builder's, instead of shipping an unpatched package) and, wherever the Windows SDK is installed, builds a small real package from the repo's own tile files and runs the real `makeappx` and the hook over it.

Tried on a new-PC profile, sideloaded the same way as above, with the patched package:

- The data lands in the real `%APPDATA%\Encore Karaoke\data` (`config.json`, `push.json`, the demo songs), and the package's private folder is never created.
- ***Show → Open Data Folder* opens that folder** in Explorer.
- **Uninstalling the package leaves the data in place.**

Two things to know:

- **Partner Center asks for a reason for a restricted capability, and certification can question it.** A true one: "The app keeps its settings, show history and the room and key behind its printed QR codes in AppData. They must survive an uninstall, be reachable by the user (Show → Open Data Folder), and be shared with the same app's installer version." If Microsoft refuses it, the fallback is to leave the patch out, point *Open Data Folder* at the private folder, add a backup/export, and say in the listing that uninstalling removes your data; that is a worse deal for a KJ's printed QR codes.
- **Never publish a build that redirects and later switch the patch on.** The data a KJ already has would sit in the private place, where the new build can't see it. The first Store version has to carry the patch.

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
- **Say that payments use a third party.** Policy 10.8.2 requires you to note the use of a secure third-party purchase API in Partner Center during submission, and since policy version 7.19 (September 2025) that is a **check box** in Partner Center: tick it (it belongs to the submission, so it appears once the product name is reserved; I haven't seen where it sits, so look through the submission's sections). Say it in the *Notes for certification* below as well, and answer any in-app purchase question Partner Center asks to match. Encore meets the policy's other conditions by design: the console names Stripe where you buy, the KJ is signed in, each purchase is confirmed on Stripe's own page (so every transaction is confirmed by the buyer), Stripe's hosted Checkout handles the card (PCI DSS), and sign-in happens in the app while only the payment goes to the browser after install.
- **Properties:** category *Music*, and the privacy policy URL <https://sing.scriblio.co/privacy>. Encore handles singers' names and KJs' email addresses. Add the Stripe line to the policy first (proposed wording in `docs/LICENSING.md`).
- **Age ratings:** fill in the IARC questionnaire. Encore has no user-to-user chat; singers only enter a name and a song request, and names go through a filter.
- **Packages:** upload the `.appx`.
- **Store listing:** a description and screenshots (at least one, 1366×768 or larger; `src/site/encore-console.png` is 1600×1000). The listing and the app must be clear about the purchases (policy 10.8.4: the types of in-product purchase and the range of prices, and the scope and terms of the trial). Suggested wording for the description:

  > Free to download, with a 14-day free trial of everything. After the trial you can keep opening Encore and using your library, settings and printing; to start new shows you buy Encore once ($149, including a year of Encore Cloud), subscribe to Encore Monthly ($29 a month, Cloud included, cancel any time) or use an unlock code. Encore Cloud, the online join link and lock-screen alerts, is optional after buying at $49 a year. Payments are handled by Stripe. YouTube search and playback are included in every plan.

- **Submission options → Notes for certification.** Policy 10.3.1 says that if your product requires login credentials you must provide a working demo account here, and 10.3.2 that any server it needs must be working. Encore needs a sign-in, and the sign-in is an emailed code, so a tester has to be able to open an inbox:
  1. Make a mailbox only for this (a free Outlook.com or Gmail address, say), and keep its password out of the repo.
  2. Sign in to Encore with it once, then in the Supabase SQL editor run `select set_owner('that address');` and press *Check again* in Encore. That gives it everything, so a tester never runs into the trial's end, even on a resubmission weeks later.
  3. Keep the Supabase project, the sign-in email (Resend) and the YouTube search service running while the submission is under review.
  4. Suggested text:

  > Encore is a karaoke hosting app. It opens a DJ console window. To run a show you sign in with an email address: Encore emails a 6-digit code, which you type into Encore. Please use this test account: email ADDRESS, and open its inbox at WEBMAIL-ADDRESS with the password PASSWORD to read the code (it can take a minute to arrive). That account has full access, so no payment is needed. Demo songs are included, so no library is needed: type a name in "Add a walk-up singer", search "step", click +, then "Call up" and "Start song". The venue screen opens from "Open screen" (top right) and plays the song with lyrics. Singers normally join from their phones by scanning the QR code, which opens a secure web page; that part is optional for testing. The app also runs a small local web server on port 4747 so phones on the same Wi-Fi can join without internet, which is why it needs network server capabilities. Encore is not a game. Its optional paid license (Encore $149 once, Encore Monthly $29 a month, Encore Cloud $49 a year) is sold with a secure third-party purchase API, which policy 10.8.1 allows for non-game products on PC: Stripe's hosted Checkout, opened in the browser from Settings → Your Encore after installation (policy 10.8.2). The screen names Stripe, the buyer is signed in to their Encore account, and the buyer confirms every purchase on Stripe's own page; Encore never sees card details. This is also declared with the Partner Center check box. Testers don't need to buy anything.

- **Restricted capability `runFullTrust`:** Partner Center will ask why the app needs it. Every Electron (Win32) desktop app requires it; say it is "a desktop app packaged with the Desktop Bridge".
- **Restricted capability `unvirtualizedResources`:** the package asks for it (`scripts/patch-appx.mjs`) so its settings and show data stay in the real AppData folder. Partner Center will ask why; see "Testing the package" above for the wording, and for what to do if it is refused.

Certification usually takes a few business days. If it fails, the report says why. Fix the problem, bump the version, and resubmit.

## Things to decide before charging money

- **Stripe live mode.** Everything is built to be tried in Stripe's test mode first (`supabase/README.md`). The Stripe account is already activated for live payments (no open tasks on 2026-10-17), but it is an *Individual* account in Matthew's own name while the Terms name ALM Partners LLC, so decide who sells first. Real money then needs the live prices, webhook and keys, the terms and privacy wording approved, a refund routine, and a decision on tax.
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
