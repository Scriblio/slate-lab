# Encore Karaoke: Privacy Policy

*Draft. Fill in the bracketed parts and host this page (for example at scriblio.co) before submitting to the Microsoft Store. It is a starting point, not legal advice.*

**Last updated:** [date]

Encore Karaoke ("Encore") is software that a karaoke host (KJ) runs on their own computer. This policy explains what information Encore handles and where it goes.

## The short version

- Everything Encore stores stays on the KJ's computer. [Scriblio] does not receive it.
- When singers join through the online link, their messages are end-to-end encrypted between their phone and the KJ's computer. The relay in between can't read them.
- Encore has no accounts, no advertising and no analytics or tracking.
- If the KJ uses YouTube features, YouTube (Google) receives the requests involved. YouTube searches pass through [Scriblio]'s search service, which keeps the search text and results (not who searched) for up to 30 days.

## What Encore stores, and where

On the KJ's computer, in Encore's data folder:

- **Singer names** that singers type when they join, or that the KJ enters.
- **Song requests and tonight's history:** which singer sang which song, and when.
- **Settings:** the show name, the KJ's music folder locations, the DJ PIN, and a random installation ID (used only to share YouTube search limits fairly).

When the KJ starts a new show, the previous show's list is archived in the same data folder. The KJ can delete the folder at any time; menu **Show → Open Data Folder** opens it.

On a singer's phone, the browser keeps a random code so the singer keeps their place if the page reloads, plus the name they last used. Nothing else is stored on the phone.

## What is shared over the network

- **Online join link:** the QR code may open a page at [sing.scriblio.co], hosted by Vercel. The phone and the KJ's computer then exchange messages through Supabase Realtime. Those messages are encrypted end to end with a key that exists only in the QR code and on the two devices, so neither [Scriblio], Vercel nor Supabase can read names or song requests. Like any website, Vercel and Supabase see connection details such as IP addresses and timing, under their own privacy policies. The KJ can turn the online link off in Settings.
- **On the venue's local network:** with the Wi-Fi link, phones connect directly to the KJ's computer to join the list and request songs. Other singers' phones see singer names in the queue and the song currently being performed. They see upcoming song titles only if the KJ turns that on.
- **With YouTube (Google), only when YouTube features are used:**
  - YouTube videos play through YouTube's embedded player, which loads inside a page on [sing.scriblio.co] (hosted by Vercel) so YouTube can tell which site is embedding it. Vercel sees that the page was loaded, like any website. Nothing about the show is sent to it.
  - Encore remembers, on the KJ's computer only, the ids of YouTube videos that wouldn't play there, for 30 days.
  - When a singer taps **Preview** on a YouTube song, their phone loads YouTube's player (the privacy-enhanced youtube-nocookie.com version) directly from YouTube.
  - Searches made from Encore go to [Scriblio]'s YouTube search service (hosted by Supabase), which sends the search text to the YouTube Data API. The service receives the search text, the installation ID and the KJ computer's IP address. It keeps the search text and YouTube's results for up to 30 days so repeat searches don't use up the daily quota, and keeps a daily count of searches per installation ID and per IP address (the address only as a one-way hash that changes every day) for a few days. Singer names and song requests are never sent to it.
  - Thumbnails load from YouTube's servers.

  YouTube's use of this information is covered by the [Google Privacy Policy](https://policies.google.com/privacy). By using YouTube features, users are also bound by the [YouTube Terms of Service](https://www.youtube.com/t/terms).

Apart from YouTube searches and the player page described above, Encore sends nothing to [Scriblio].

## Children

Encore is a tool for karaoke hosts at venues. It isn't directed at children and doesn't knowingly collect information from them.

## Changes

If this policy changes, the new version will be posted at this address with a new date.

## Contact

[Scriblio] · [support email] · [mailing address if required in your region]
