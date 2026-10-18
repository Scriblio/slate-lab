# Encore Karaoke: Privacy Policy

**Last updated:** October 17, 2026

Encore Karaoke ("Encore") is software that a karaoke host (KJ) runs on their own computer. It's made by Scriblio, a brand of ALM Partners LLC ("Scriblio", "we"). This policy explains what information Encore handles and where it goes. It's published at https://sing.scriblio.co/privacy.

## The short version

- Everything Encore stores about a show stays on the KJ's computer. Scriblio does not receive it.
- When singers join through the online link, their messages are end-to-end encrypted between their phone and the KJ's computer. The relay in between can't read them.
- Singers don't need an account and never give an email address. KJs sign in with their email to use Encore, and Scriblio keeps that email and their license record (see "KJ accounts and licenses" below).
- If a KJ buys Encore, the payment is taken by Stripe. Scriblio never sees the card number, and keeps only what the account has bought (see "Payments" below).
- Encore has no advertising and no analytics or tracking. It never asks anyone to sign in with Google.
- If the KJ uses YouTube features, YouTube (Google) receives the requests involved. YouTube searches pass through Scriblio's search service, which keeps the search text and results (not who searched) for up to 30 days.

## What Encore stores, and where

On the KJ's computer, in Encore's data folder:

- **Singer names** that singers type when they join, or that the KJ enters.
- **Song requests and tonight's history:** which singer sang which song, and when.
- **Song keys:** the musical key of library songs, worked out from the KJ's own files on their computer or set by the KJ.
- **Key preferences:** when a singer or the KJ changes a library song's key, the singer's name, the song and the key, so it comes up in their key next time. Each one is forgotten after a year without use.
- **Settings:** the show name, the KJ's music folder locations, the DJ PIN, and a random installation ID (used to share YouTube search limits fairly, and to tie a license to this computer).
- **Sign-in and license:** the KJ's email address, the sign-in session, and the signed note Scriblio's license service last gave this computer. They're kept in two small files in the same folder (account.json and license.json), and signing out deletes them.
- **Lock-screen alert subscriptions**, for singers who turn alerts on: the address the phone's push service gave their browser, and the keys to encrypt alerts to it. They're kept for tonight's show only and deleted when the singer leaves or the KJ starts a new show.

When the KJ starts a new show, the previous show's list is archived in the same data folder. The KJ can delete the folder at any time; menu **Show → Open Data Folder** opens it.

On a singer's phone, the browser keeps a random code so the singer keeps their place if the page reloads, plus the name they last used. If they turn on lock-screen alerts, it also keeps their browser's push subscription and a note that alerts are on. Nothing else is stored on the phone.

## What is shared over the network

- **Online join link:** the QR code may open a page at sing.scriblio.co, hosted by Vercel. The phone and the KJ's computer then exchange messages through Supabase Realtime. Those messages are encrypted end to end with a key that exists only in the QR code and on the two devices, so neither Scriblio, Vercel nor Supabase can read names or song requests. Like any website, Vercel and Supabase see connection details such as IP addresses and timing, under their own privacy policies. The KJ can turn the online link off in Settings.
- **Lock-screen alerts (only if a singer turns them on):** the KJ's computer sends "you're up" notifications through the push service of the singer's browser (Apple, Google, Mozilla or Microsoft, depending on the browser). Each notification is encrypted end to end, so the push service can't read it. Like any delivery service, it sees that a notification was sent, when, and its size, under its own privacy policy. Scriblio isn't involved.
- **On the venue's local network:** with the Wi-Fi link, phones connect directly to the KJ's computer to join the list and request songs. Other singers' phones see singer names in the queue and the song currently being performed. They see upcoming song titles only if the KJ turns that on.
- **KJ sign-in and license checks:** to sign in, the KJ's computer sends their email address to Scriblio's sign-in service (hosted by Supabase), which emails a 6-digit code. After that, when Encore starts and about every 12 hours, the computer asks Scriblio's license service what the account has, sending the installation ID (and the unlock code, if the KJ uses one). The answer is a signed note saying what the account may do. Nothing about shows, singers or songs is sent. Details are under "KJ accounts and licenses" below.
- **Buying (only if a KJ buys):** pressing a buy button asks Scriblio's license service for a payment page. The service asks Stripe to make it, giving Stripe the KJ's email address and account ID so the payment can be matched to the account, and Encore opens the page in the KJ's browser. The card and billing details are typed on Stripe's page and go to Stripe only. When Stripe says the payment went through, it tells Scriblio's payment service (hosted by Supabase) which account paid and for what period. Details are under "Payments" below.
- **With YouTube (Google), only when YouTube features are used:**
  - YouTube videos play through YouTube's embedded player, which loads inside a page on sing.scriblio.co (hosted by Vercel) so YouTube can tell which site is embedding it. Vercel sees that the page was loaded, like any website. Nothing about the show is sent to it.
  - Encore remembers, on the KJ's computer only, the ids of YouTube videos that wouldn't play there, for 30 days.
  - When a singer taps **Preview** on a YouTube song, their phone loads YouTube's player (the privacy-enhanced youtube-nocookie.com version) directly from YouTube.
  - Searches made from Encore go to Scriblio's YouTube search service (hosted by Supabase), which sends the search text to the YouTube Data API. The service receives the search text, the installation ID and the KJ computer's IP address. It keeps the search text and YouTube's results for up to 30 days so repeat searches don't use up the daily quota, and keeps a daily count of searches per installation ID and per IP address (the address only as a one-way hash that changes every day) for a few days. Singer names and song requests are never sent to it. When a YouTube video won't play inside Encore, or the KJ marks it "not karaoke", Encore tells the service the video's id. The service keeps that report, with one-way hashes of the installation ID and IP address, for up to 30 days, so videos many KJs found broken can be skipped for everyone.
  - Thumbnails load from YouTube's servers.

Apart from KJ sign-in, license checks and buying, YouTube searches and the player page described above, Encore sends nothing to Scriblio.

## KJ accounts and licenses

Running a show needs a KJ account. The KJ signs in with their email address, which starts a free 14-day trial, and can later use an unlock code or buy Encore. Singers never need an account.

- **What Scriblio keeps** (in its Supabase project, which sends the sign-in codes through an email delivery service):
  - the KJ's email address and account ID, and their sign-in sessions;
  - the license record: when the free trial started and ends, whether they own Encore or Encore Cloud and until when (or, for Encore Monthly, the end of the last month that was paid for), and whether they are the owner;
  - if they buy anything, Stripe's customer and subscription ids for the account, and the ids of the messages Stripe has sent about their payments, so that each payment is counted once;
  - which unlock codes the account used and when, with the codes themselves kept only as a one-way fingerprint;
  - the random installation ID of the computer that started a trial, so a trial is once per computer (if the account is deleted, this stays without any link to a person), and of the computer that used each code;
  - counts of unlock-code tries each hour, per account and per network address (the address only as a one-way hash), to stop code guessing. They are deleted after a couple of days.
- **What it is used for:** deciding what the KJ's Encore may do. It is not used for advertising or analytics, and is not sold. It is shared only with the services that run Encore: Supabase (hosting and sign-in), the email service that sends sign-in codes, and Stripe (payments).
- **What it never includes:** singer names, song requests, the KJ's music library, or anything else about a show. Singers give no email address.
- **Keeping and deleting:** it is kept while the account exists. To close an account and delete its records, email us at the address below and we'll do it within 7 days. Records of payments are kept for as long as the law requires, even after an account is closed. Signing out of Encore deletes the sign-in and license files from the KJ's computer.

**Payments.** If a KJ buys Encore, Encore Cloud or Encore Monthly, the payment is taken by Stripe, which receives their card and billing details under [its own privacy policy](https://stripe.com/privacy). Scriblio never sees the card number. It keeps Stripe's customer and subscription ids so it can tell what the account has bought and open its billing page, and it can see each payment's amount, date and email address in its Stripe account. Stripe emails the KJ a receipt. These are kept while the account exists, and for as long as the law requires us to keep records of payments.

## YouTube API Services

Encore uses YouTube API Services to search YouTube and to play YouTube videos. By using Encore's YouTube features, you agree to be bound by the [YouTube Terms of Service](https://www.youtube.com/t/terms), and Google's use of information is covered by the [Google Privacy Policy](https://policies.google.com/privacy).

- **What Encore gets from YouTube:** public information about videos: ids, titles, channel names, thumbnails, durations, and whether a video may be embedded. Encore never asks for access to anyone's Google or YouTube account, so it has no access to private account data. If you ever want to check which apps can reach your Google account, you can do that in your [Google security settings](https://security.google.com/settings/security/permissions).
- **What's stored, and for how long:**
  - Search results, in Scriblio's search service, are kept up to 30 days so repeat searches don't use up YouTube's daily quota.
  - A catalog of popular karaoke videos is also kept there: public video information from a few karaoke channels, listed through the YouTube Data API. It holds no information about anyone using Encore, and it's refreshed before any entry is 30 days old.
  - The ids of videos reported as not playing, or as not karaoke, are kept up to 30 days, along with one-way hashes of who reported them.

  Anything older than 30 days is deleted automatically.
- **Cookies and similar technologies:** Encore itself sets no cookies. YouTube's embedded player can store cookies or similar data on the device it plays on, under Google's policies. The phone page keeps a few values in the browser's local storage, described above.
- **Deleting your information:** everything about a show lives on the KJ's computer, and the KJ can delete it at any time (**Show → Open Data Folder**). Singers can clear the phone page's data by clearing the site's data in their browser. To ask us to delete anything held by Scriblio's search service, email us at the address below. We'll delete it within 7 days. It's also deleted automatically within 30 days.

## Children

Encore is a tool for karaoke hosts at venues. It isn't directed at children and doesn't knowingly collect information from them.

## Changes

If this policy changes, the new version will be posted at this address with a new date.

## Contact

Scriblio (ALM Partners LLC) · [encore-support@scriblio.co](mailto:encore-support@scriblio.co)
