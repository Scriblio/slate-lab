# Selling Encore on the Microsoft Store

Encore ships as a Windows desktop app built with Electron. The same code makes two Windows files:

| File | What it's for | How to build |
|---|---|---|
| `Encore-Karaoke-Setup-x.y.z.exe` | Installer for your own laptop and testers. Adds a desktop icon and a Start menu entry. | `npm run dist:win` on Windows, or the **Encore desktop** GitHub Action |
| `Encore-Karaoke-x.y.z.appx` | The package you upload to the Microsoft Store | `npm run dist:store` on Windows, or run the Action with **Store package** ticked |

The Microsoft Store signs the `.appx` for you, so you don't need a code-signing certificate to sell through the Store. To charge through the Store's own checkout (paid app, free trial), submit the `.appx`/MSIX package rather than an `.exe`.

## 1. Get the installer (desktop icon)

1. On GitHub, open **Actions → Encore desktop** and click the latest green run.
2. Download **Encore-Karaoke-Windows** under *Artifacts* and unzip it.
3. Run `Encore-Karaoke-Setup-….exe`. It installs and puts **Encore Karaoke** on the desktop.

Because this installer isn't code-signed, Windows SmartScreen may say "Windows protected your PC". Click **More info → Run anyway**. Store installs don't show this. If you also want to sell the `.exe` directly from your own website, buy a code-signing certificate so the warning goes away.

The first time Encore starts, Windows Firewall asks whether it may use the network. Allow **Private networks**, otherwise phones can't join.

## 2. Set up the Store listing

1. **Create a developer account** in [Partner Center](https://partner.microsoft.com/dashboard) (Apps and games). Choose an individual or company account. Check the sign-up page for the current fee, since Microsoft has changed it over time. Company accounts go through a business verification step.
2. **Reserve the app name.** "Encore Karaoke" may already be taken, so have a few alternatives ready. Search the Store and do a basic trademark check before you commit to a name.
3. **Copy your product identity into the build.** In Partner Center open your app → *Product management* → *Product identity*. Copy three values into `electron-builder.yml` under `appx:`:

   | Partner Center | `electron-builder.yml` |
   |---|---|
   | Package/Identity/Name | `identityName` |
   | Package/Identity/Publisher | `publisher` (starts with `CN=`) |
   | Package/Properties/PublisherDisplayName | `publisherDisplayName` |

   If you change the app name, also update `productName`, `appx.displayName` and the `PRODUCT` constant in `src/desktop/main.ts`.
4. **Build the Store package.** Run the GitHub Action by hand with *Store package* ticked, or run `npm run dist:store` on a Windows PC. Each new submission needs a higher `version` in `package.json`.

## 3. Submit

In Partner Center, create a submission:

- **Pricing and availability:** set the price. A free trial works well for KJ software, because people want to try it at a real gig before paying.
- **Properties:** category *Music*, plus a privacy policy URL. The Store requires one because Encore handles singers' names. A ready-to-edit draft is in [PRIVACY.md](PRIVACY.md); host it on scriblio.co.
- **Age ratings:** fill in the IARC questionnaire. Encore has no user-to-user chat; singers only enter a name and a song request.
- **Packages:** upload the `.appx`.
- **Store listing:** a description and screenshots (at least one, 1366×768 or larger). The PNGs in `docs/` are a starting point; take real ones from the app at full size.
- **Submission options → Notes for certification:** testers need to know how to try the app. Suggested text:

  > Encore is a karaoke hosting app. It opens a DJ console window. Demo songs are included, so no library is needed: type a name in "Add a walk-up singer", search "step", click +, then "Call up" and "Start song". The venue screen opens from "Open screen" (top right) and plays the song with lyrics. Singers normally join from their phones by scanning the QR code, which opens a secure web page; that part is optional for testing. The app also runs a small local web server on port 4747 so phones on the same Wi-Fi can join without internet, which is why it needs network server capabilities.

- **Restricted capability `runFullTrust`:** Partner Center will ask why the app needs it. Every Electron (Win32) desktop app requires it; say it is "a desktop app packaged with the Desktop Bridge".

Certification usually takes a few business days. If it fails, the report says why. Fix the problem, bump the version, and resubmit.

## Things to decide before charging money

- **YouTube.** Encore plays YouTube through YouTube's official embedded player and never downloads videos. That keeps it within YouTube's terms. Still:
  - Market Encore as KJ software, not as "free karaoke from YouTube".
  - Search goes through your one Google Cloud project, via the `youtube-search` Supabase function; the key never ships inside the app (see [supabase/README.md](supabase/README.md)). The YouTube policies forbid both shipping the key and asking KJs for their own.
  - The free quota is 10,000 units a day: about 99 uncached searches across all customers. Apply for more through the YouTube API Services audit and quota extension form well before launch; it can take weeks.
  - Keep YouTube search part of the product, not a paid add-on: the policies forbid selling access to YouTube API Services.
  - Your Terms of Use should say that users of YouTube features agree to the YouTube Terms of Service, and link the Google Privacy Policy (the app already shows both links next to search results).
  - Encore leaves YouTube's player uncovered and shows YouTube titles unmodified, as the policies require. Keep it that way.
- **Music licensing.** KJs bring their own legally obtained tracks, and venues need public-performance licenses. Say both in your listing and terms of use.
- **Support.** Paying customers will email you. Set up a support address before launch, and put it in the listing and in PRIVACY.md.
- **Mac.** `npm run dist:mac` builds a `.dmg`, but selling on Mac needs an Apple Developer account plus signing and notarization. That's a separate project.
