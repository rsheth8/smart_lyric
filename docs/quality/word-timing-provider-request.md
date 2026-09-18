# Bar4Bar: word-timing coverage evaluation

Draft for a lyric-data provider. Prepared for review; not sent.

Primary candidate: **Musixmatch Pro API Grow** (published at $199/month). Live pricing on 2026-09-11 lists Time-synced lyrics under Includes, defined as line-by-line and word-by-word, plus an App Store certificate. Caching is not included; Scale ($499) adds quota only. Enterprise ($2,000+/month) is the first tier that lists licensed caching.

Secondary candidate: [LyricFind word-by-word display](https://www.lyricfind.com/products/lyric-display). Quote only; no public price.

Bar4Bar is an Apple TV app that displays word-by-word lyrics while the user plays Apple Music on the TV or Spotify on another device. We need the same recording-matched word timestamps for both sources. Apple Music is the lock-to-syllable path (live MusicKit playhead). Spotify is follow-mode and must use the same lyric asset.

Please evaluate every recording, including unavailable entries, and return a result for each Spotify track ID. We need to distinguish word-level timestamps, line-only timestamps, plain lyrics, and no coverage. Please specify whether timestamps contain both word starts and ends, how lead vocals and overlapping backing vocals are represented, and how clean/explicit, remix, live, and alternate edits are matched.

Our inventory includes artist, title, album, Spotify track ID/link, observed explicit badge, and displayed duration. Durations are rounded to whole seconds, and ISRCs are not yet populated. Please tell us which additional identifiers you require and return your matched recording ID, ISRC, duration, and edition with each result. Do not silently substitute another recording.

Please provide evaluation access or representative samples for timing validation against the exact recordings. We would also like details of update frequency, corrections, coverage commitments, API availability and limits, geographic availability, attribution requirements, and permissions for TV display, timing storage/caching, and redistribution to app clients.

Please quote evaluation and production pricing, minimum commitments, and any usage-based charges. We have not committed to a subscription or minimum spend.

Playlist: https://open.spotify.com/playlist/37i9dQZF1DWXnexX7CktaI

Inventory to attach: [all 150 recordings](gold-edition-tracks-2026-09-11.json).

For our evaluation, please return these fields per recording:

| Field | Requested detail |
| --- | --- |
| Spotify track ID | Original requested ID |
| Match | Exact recording, uncertain, or unavailable |
| Matched metadata | Provider ID, artist, title, album, ISRC, exact duration, explicit edition |
| Timing format | Word starts/ends, line only, plain text, or none |
| Restrictions | Territory, attribution, caching, or other display conditions |
| Evaluation | Sample/access available and any known timing issues |

Provider candidate: [LyricFind word-by-word display](https://www.lyricfind.com/products/lyric-display). Its public product description establishes the offering, not coverage of our playlist, price, or an approved license.
