# Apple TV timing quality

Bar4Bar's product remains word-by-word lyrics. Word animation is always available when lyrics are present. Estimated timing must stay labeled; changing the label or hiding the word animation does not improve accuracy.

## Gold Edition playlist benchmark — September 11, 2026

The user selected Spotify playlist `37i9dQZF1DWXnexX7CktaI` (Gold Edition). All 150 visible entries were captured with Spotify track IDs, album names, order, and displayed durations. The copied inventory was checked against the browser extraction; no positions or IDs are missing. Durations are whole display seconds, and ISRCs have not been retrieved.

The actual TV lyric client, run on the Mac against the live service, initially selected 71 word-timed and 79 estimated timelines. Fixing featured-artist search and checking up to three closely matching catalog entries increased this to **94 word-timed and 56 estimated timelines**, with zero unavailable tracks and zero losses among the original 71 word-timed tracks. This is 62.7% word-timestamp availability, not measured acoustic accuracy. All 26 focused search, matching, and cache tests passed. The server fix is deployed; no TV binary changed in this pass.

The baseline richsync endpoint returned no data for any of the 150 tracks. Empty HTTP 200 responses do not distinguish upstream access trouble from absent catalog coverage. Do not count this as a working independent word-timing source or as proof those lyrics do not exist commercially.

See [the complete scorecard](gold-edition-scorecard-2026-09-11.md), [snapshot provenance](gold-edition-snapshot-2026-09-11.json), and [recording inventory](gold-edition-tracks-2026-09-11.json). The scorecard has each song's before/after result, source, review flags, and repeatable commands. Pyramids and TYRANT have spans beyond their listed durations; Lost has a provider-duration difference of six seconds. These require review before any verification label.

Use `scripts/tv-coverage` for native parser/selection availability and `scripts/check-tv-coverage.mjs` for provider diagnostics. The latter now looks past metadata-only LRCLIB hits to later timed hits; it must not mistake a metadata-only match for a wrong song. Neither tool measures a listener's actual TV/audio delay.

## Findings from September 10, 2026

- The player consumed all left/right input as a timing adjustment. It now has an explicit controls row and a timing panel with Earlier, Later, Reset, and Done. Arrow/swipe input only moves focus; selecting an adjustment changes timing.
- Cached line estimates never retried the word providers. Fallbacks now revalidate, and a new cache version discards old mismatched or stretched timelines.
- Proxy metadata uses `trackName`/`artistName`; the native decoder expected `track`/`artist`. That hid bad matches. The native client now reads the actual names and rejects mismatched titles, artists, and durations.
- A live query for Drake's user-reported “Too Spent” returned “Too Much” from NetEase. It is now rejected. The exact Spotify recording remains unconfirmed.
- Brent Faiyaz's “other side.” returned line timing, with no word timing from either connected word provider. Availability is not a rendering problem.
- The YRC parser extended words across silence. Richsync could redistribute real offsets based on guessed syllable duration. Both now preserve the supplied timing.
- Server errors and empty word responses were cacheable for 24 hours. These responses now use `no-store`.
- Mac vocal separation and forced alignment were absent from the tvOS retrieval path. A preparation/export tool, protected storage, and TV retrieval path now connect them. This is a preparation workflow for locally supplied audio, not live Spotify audio access.

## Repeatable coverage audit

Run `node scripts/check-tv-coverage.mjs docs/quality/tv-coverage-tracks.json <report.json>`.

The initial six-song diagnostic sample includes the user's reports. It is not representative enough to support a product-wide coverage claim. Expand to 50 exact recordings before a beta release: 10 user favorites, 10 recent releases, 10 rap/dense mixes, 10 sustained/acoustic vocals, and 10 multilingual tracks. Include clean/explicit versions, live/remix recordings, and albums with repeated titles. Record Spotify IDs/ISRCs and actual durations in the test inventory; an unresolved title is a failed test, not a guessed recording.

Report separately: real word timestamps; audio-refined mixed timing; estimated-only; no lyrics; wrong matches rejected; provider failures; and fetch time. Count the full sample in the denominator. “A response exists” does not prove correct timing.

## Acoustic accuracy

Create checked reference JSON `{words:[{text,start,end},...]}` by marking vocal onsets/ends in the exact recording. Have a second listener review ambiguous starts, breaths, ad-libs, sustained syllables, and repeated choruses. A provider timestamp file can be a comparison baseline; it is not automatically human-verified ground truth.

Run `node scripts/check-timing-accuracy.mjs <prepared.json> <checked-reference.json> <report.json>`.

Record matched-word coverage, median/p95/max onset error, and percentages within 100/200 ms. Report absolute timing AND timing after a constant offset; the latter isolates word placement but must never conceal a playback-delay defect. Include omitted and duplicated words. Confidence scores are not timing-error measurements.

Proposed target, not an achieved claim: at least 95% of words within 100 ms and p95 within 200 ms on the agreed recording/device set. These overlapping thresholds should be revisited against real singer perception. Do not advertise “perfect” or “every song” from a six-song availability test or two-song historical benchmark.

## End-to-end TV checks

Run each provider with TV speakers, HDMI receiver, and Bluetooth output; test start, pause/resume, seek, track change, reconnection, app backgrounding, and a 30-minute session. Film the TV and audible speaker output together using a reference marker to measure actual displayed-word/vocal delay. Test lyric availability, source quality, and playback-clock behavior independently. The remote regression suite covers entry/exit, focus movement without adjustment, and explicit adjustment selection.

## Preparing additional word timing

`node scripts/prepare-tv-timings.mjs --audio recording.wav --lyrics matching.lrc --artist Artist --track Title --output prepared.json`

Audio stays on the Mac. The existing separator isolates vocals; the aligner measures word positions and exports confidence/mixed-estimate metadata. The current aligner is English oriented; multilingual coverage needs its own model and evaluation. Listen against the exact recording before publication. Model output can contain mistakes and is not a guarantee of perfect timing.

Provision `docs/word-timings-store.sql` once. Publish a reviewed artifact with `node --env-file=<server-env> scripts/publish-tv-timings.mjs prepared.json reviewed-reference.json`. The publisher now requires recording identity and a passing acoustic-reference check; see [the reviewed timing workflow](reviewed-timing-workflow.md). The TV prefers fully word-timed prepared results tied to its recording ID, then catalog word timing, then mixed audio-refined timing and estimates. Cached lyrics revalidate on track load so newly reviewed timings can arrive. Storage accepts server credentials only; the public endpoint is read-only. Do not put credentials or local recordings in source control.

## Hybrid catalog (current plan)

Ship without paying Musixmatch: prepared/reviewed timings, then NetEase YRC, then line-level LRCLIB. The TV already prefers an identified prepared artifact over catalog guesses.

When `MUSIXMATCH_API_KEY` is set (Grow, $199/month), `/api/richsync` uses the official matcher by ISRC / Spotify ID / Apple Music ID. Licensed hits are not written to the TV lyric cache. Do not subscribe until the App Store submission or about 25–50 paying users. Grow does not include caching; Enterprise is the first published tier that does.

Spotify's currently-playing API provides recording metadata and playback position, not the full recording needed by the aligner: https://developer.spotify.com/documentation/web-api/reference/get-the-users-currently-playing-track

The TV now prefetches the next catalog timeline while the current song plays. Spotify uses `/me/player/queue` (needs a re-pair after the `user-read-playback-state` scope was added). The system Music player does not expose the rest of its queue to MusicKit, so Apple Music still fetches on track change. Prefetch removes first-word delay when the next recording is known; it cannot invent word timestamps for a track that only has line estimates, and it cannot align DRM audio on a server.

Settings ▸ Timing has Listen mode (0 ms) and Sing mode (120 ms). Spotify follow now advances `progress_ms` by half the request RTT and polls faster near the end of a track.
