# YouTube quota extension: what to put in the form

The form is at **https://support.google.com/youtube/contact/yt_api_form**. Sign in as the Google account that owns the Cloud project `encore-karaoke-k7m3`. Matthew submits it himself: the attestations at the end are his to make.

Section by section, the answers below match the form's fields. Text in quote blocks can be pasted as is.

## Section 1: Request type

**Complete a compliance audit to request for additional quota.**

## Section 2: Organization and contact

| Field | Answer |
|---|---|
| Applying as | An organization |
| Your full legal name | Matthew Lancaster |
| Organization's legal name | ALM Partners LLC |
| Parent company | (leave blank) |
| Organization's primary website | https://scriblio.co |
| Legal address | the LLC's registered address (type it yourself) |
| Category | Media and Entertainment |
| Organization size / type | Startup (fewer than 10 employees) |
| Primary contact | Matthew Lancaster · mattclancaster@gmail.com |
| Technical contact / business contact | Same as primary contact |

## Section 3: Business model

**Describe your organization's work as it relates to YouTube:**

> ALM Partners LLC, under the Scriblio brand, makes Encore Karaoke, desktop software for karaoke hosts (KJs) who run karaoke nights in bars and venues. Encore runs the singer rotation: singers sign up from their phones by scanning a QR code, and the KJ calls them up in a fair order. It then plays each singer's song on the venue screen.
>
> Songs come from the KJ's own licensed karaoke files or from YouTube. For YouTube, Encore uses the YouTube Data API to let the KJ, or a singer from their phone, search for karaoke versions of a song. The chosen video then plays on the venue screen in YouTube's official embedded player (IFrame Player API), unaltered and with YouTube's ads. Nothing is drawn over the player, and Encore never downloads, records or analyzes videos.
>
> The value to YouTube: every YouTube song played at a karaoke night is a full, monetized view of a karaoke creator's video, shown to a room full of people. Karaoke creators who allow embedding get plays at live venues that today mostly use paid karaoke subscriptions instead. KJs and singers get the widest song selection without any YouTube account, key or setup.
>
> How Encore keeps its API use small and compliant:
>
> - All copies of Encore share one API project through our own server. The key never ships in the app, and KJs are never asked for keys.
> - Search results are cached for everyone for up to 7 days, and never kept longer than 30 days.
> - A catalog of the most-viewed videos from a few karaoke channels answers common searches without calling search.list. It's built with the cheap channels.list, playlistItems.list and videos.list calls, and refreshed before 30 days.
> - Search results are shown as YouTube returns them, with links to the YouTube Terms of Service and the Google Privacy Policy.
> - Encore never asks users to sign in with Google and uses no OAuth scopes.

| Field | Answer |
|---|---|
| Target audience | **Other:** "Karaoke hosts (KJs) and venues", plus **General Public** (singers using the phone page) |
| Monetization | **Other:** "One-time purchase of the Encore desktop app through the Microsoft Store (not yet launched). YouTube features are included at no extra charge and are never sold separately. No advertising." |
| Ads on or in YouTube content? | Not applicable |
| Google / YouTube representative | No, I do not have a Google representative |
| How did you learn about the API | Google Developer Documentation |
| Content Owner IDs / Google Ads IDs | (leave blank) |

## Section 4: API client

| Field | Answer |
|---|---|
| API client name | Encore Karaoke |
| Contains "YouTube"? | No |
| Primary access URL | https://sing.scriblio.co/encore |
| Privacy Policy URL | https://sing.scriblio.co/privacy |
| Terms of Service URL | https://sing.scriblio.co/terms |
| Publicly accessible? | Yes. The installer is a public GitHub pre-release, linked from /encore. |
| Demo account | None needed. Encore has no accounts. |

**Special instructions for access:**

> Encore has no accounts or sign-in. To try it, install it on Windows 10 or 11 from https://github.com/Scriblio/slate-lab/releases/download/encore-v0.1.0-preview/Encore-Karaoke-Setup-0.1.0.exe (also linked from https://sing.scriblio.co/encore). Windows SmartScreen may warn because the installer isn't code-signed yet: click More info, then Run anyway.
>
> Demo songs are included, so no music library is needed:
>
> 1. Type a name in "Add a walk-up singer" and press Enter.
> 2. In the Songs panel, choose the singer under "Adding for", type a song (e.g. "toto africa") and click "Search YouTube". Click + on a result.
> 3. Click "Open screen" (top right) to open the venue screen, then "Start song". The video plays in YouTube's embedded player.
>
> Singers can also join from a phone by scanning the QR code on the venue screen.

## Section 5: Use case and quota (Project #1)

| Field | Answer |
|---|---|
| Google Cloud project number | from https://console.cloud.google.com/home/dashboard?project=encore-karaoke-k7m3 (the "Project number" on the Welcome card; digits only) |
| Use case categories | **Websites & Mobile Apps**, and **Others** |
| "Others" description | "Desktop app (Windows) for karaoke hosts: searches YouTube for karaoke videos and plays them on a venue screen in the YouTube embedded player." |
| OAuth? | No |
| Derived metrics / data storage section | **Leave unticked.** Encore doesn't need it: no statistics are stored. |
| Expected API usage volume | 1,000 to 10,000 requests per day |

**Endpoints to tick:** `youtube.search.list`, `youtube.videos.list`, `youtube.channels.list`, `youtube.playlistItems.list`.

**Total quota (all endpoints except search.list):** No change / Default quota (10,000). The catalog rebuild uses about 700 units every 25 days, plus about one videos.list unit per uncached search.

**search.list: total per day quota:** `100000`

**search.list: detailed justification:**

> Each uncached search costs 100 units, so the default 10,000 units allow only about 99 searches a day across every copy of Encore. One busy karaoke night can use that up.
>
> Estimate for our first year, with about 100 KJs:
> - Each KJ hosts about 3 nights a week, so about 45 shows on an average day and 80 on Fridays and Saturdays.
> - A show takes about 60 song requests, and about half are YouTube songs.
> - Our shared 7-day cache and our catalog of popular karaoke videos answer most of them without search.list; requests for common songs are matched in the catalog. We estimate about 9 uncached searches per show.
>
> That's about 400 searches (40,000 units) on an average day, and about 720 (72,000 units) at the weekend peak. We're asking for 100,000 units a day of search.list to cover the peak with some headroom.
>
> Usage is capped in our server per installation, per IP address and overall, so it can't exceed the granted quota. We'll come back through this form if growth needs more.

### Evidence uploads (one file each, image or PDF, under 10 MB)

The files are in `docs/youtube-audit/`. They aren't committed: they show other creators' videos and thumbnails.

| Field | File |
|---|---|
| Privacy Policy screenshots | `encore-privacy-policy.pdf` (the live page, printed with its URL in the footer) |
| Homepage screenshot | `encore-homepage.pdf` (https://sing.scriblio.co/encore: the policy links in the footer and the "How Encore uses YouTube" section) |
| Terms of Service documentation | `encore-terms-of-use.pdf` |
| Conditional: Player / Embed screenshots | `encore-player-and-search.pdf`: the console with YouTube search results and the "Results from YouTube" terms line, and the venue screen playing a video in YouTube's embedded player |

## Section 6: Optional materials

| Field | File |
|---|---|
| Architecture diagram | `encore-architecture.pdf` |

## Section 7: Attestations

Read each one, then tick them all and submit. Afterwards, click **Download submission** and keep the copy.

## Before submitting, check

- [ ] https://sing.scriblio.co/privacy, /terms and /encore load.
- [ ] The project number is the right one (encore-karaoke-k7m3).
- [ ] The search caps are still on: the Supabase secrets `YT_DAILY_SEARCHES` etc. aren't raised until Google grants the quota.

## After approval

Raise the caps to match the grant with the Supabase Edge Function secrets `YT_DAILY_SEARCHES` (overall), `YT_DAILY_PER_INSTALL` and `YT_DAILY_PER_IP` (see `supabase/README.md`). For 100,000 units: about 950 overall, 150 per installation and 200 per IP.

Google re-audits periodically. Keep the policies, the 30-day storage limits and the player rules (no overlays, no ad blocking) as they are, and use this same form to tell YouTube before the use case changes.
