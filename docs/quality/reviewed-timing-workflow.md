# Bar4Bar reviewed timing workflow

The first collection is the frozen 150-recording Gold Edition playlist. The existing audit found 94 word-timed and 56 estimated results. None has yet passed acoustic review. This workflow does not claim a coverage increase.

## Recording identity

Spotify playback now retains its track ID, ISRC when returned, explicit flag, album, and unrounded duration. The Spotify ID remains separate from the Apple Music playback ID. The TV carries recording identity into the prepared-timing request and cache. Apple Music songs carry their MusicKit ID and ISRC when available.

The cache now hashes full metadata and identity instead of collapsing cleaned titles into five-second duration buckets. This invalidates earlier lyric caches and gives editions separate sync offsets. Cached lyrics display immediately and revalidate when a track loads; failed lookups do not downgrade saved word timing. Identified, word-timed prepared results take precedence over catalog timing. Cross-provider matching only accepts a shared ISRC with a known matching explicit flag; conflicting provider IDs, ISRCs or explicit flags are rejected.

The prepared store uses recording identity keys, without a database schema migration. Legacy metadata-only entries remain readable to legacy queries; an identified request cannot accept one. Publish an artifact with both service IDs when the same reviewed audio is confirmed for both services. An ISRC-only entry is not automatically searched when a provider track ID is supplied. Catalog providers still match by title/artist/duration; they do not become exact or verified merely because our request has an ID.

## Prepare and review

1. Resolve a queued Spotify ID to the exact authorized audio, exact duration, lyrics and edition. Preserve the original audio start, including intro silence. Do not use a music video or alternate edit as a substitute.
2. Prepare timings locally. The current aligner is English oriented and can leave uncertain words; it does not turn confidence into measured accuracy.
3. Make a reference containing every displayed sung word, with start/end times in seconds from the original recording. Review omissions, repeated words, ad-libs and overlapping vocals. Have a second person review the reference. Do not generate the reference by copying the predicted times.
4. Correct uncertain timing, rerun the measurement, and publish only passing artifacts.

Example preparation (replace every placeholder with actual files/metadata):

```sh
node scripts/prepare-tv-timings.mjs --audio recording.wav --lyrics recording.lrc --artist Artist --track Title --album Album --spotify-id SPOTIFY_TRACK_ID --isrc RECORDING_ISRC --explicit true --output prepared.json
```

A reference JSON has `meta.duration`, `meta.recording` (same fields as the prepared artifact), `review: {"status":"reviewed","reviewer":"actual reviewer","secondReviewer":"actual second reviewer"}`, and `words: [{"text":"actual word","start":1.23,"end":1.56}, ...]`. These are structure examples, not review evidence.

```sh
node scripts/check-timing-release.mjs prepared.json reviewed-reference.json release-report.json
node --env-file=SERVER_ENV_FILE scripts/publish-tv-timings.mjs prepared.json reviewed-reference.json
```

The publisher repeats the check against the supplied files before writing. It requires recording identity, matching audio duration, two distinct named reviewers, no estimated timelines, no missing/extra words, no words beyond the audio, and at least 95% of word starts within 100 ms of the reviewed reference. The report stores hashes of the exact artifact and reference. Reviewer names are attestations, not independently authenticated evidence.

This is an initial **word-start acceptance target**, not a perfect-timing certification. It does not measure word-end accuracy or TV/audio output delay. All submitted word ends still require listening review. Actual Apple TV playback, pause/resume, seek recovery and audio-route latency require a separate device pass.

## Current work queue

- [All 150 recordings and their pending review states](gold-edition-review-queue-2026-09-11.json)
- [56 recordings missing word timing](gold-edition-timing-gaps-2026-09-11.md)
- [Provider coverage request, prepared but not sent](word-timing-provider-request.md)

The next external inputs are provider evaluation access or matching authorized audio and lyrics. No new real-song prepared artifacts have been published, and no provider purchase or contact has been made.
