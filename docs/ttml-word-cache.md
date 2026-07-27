# A TTML-shaped word cache — design sketch

Status: partially shipped, 2026-07-27. Prompted by studying how Apple Music
ships karaoke lyrics.

- ✅ **Gap 1 — entry-level `alignVersion`** (`app/timeline-cache.js`). Stores
  migrate instead of being discarded; stale entries apply provisionally.
- ✅ **Gap 1b — durable sidecar files** (`electron/sidecar.cjs`, `app/sidecar.js`).
  `<audio basename>.lyx.json` next to the file, plus a `userData/alignments`
  store for streaming tracks. localStorage stays the hot path; sidecars are the
  backing store that survives a cache clear and travels with the audio.
- ✅ **Gap 2 — diff-based rebind** (`rebindCachedTiming`).
- ✅ **TTML importer** (`app/providers/formats/ttml.js`), incl. agents,
  `song-part` sections, `x-bg`, `x-translation`/`x-roman`, syllable merging.
- ✅ **Renderer work** — structure rail, duet staging, background vocals
  (`app/display.js`, `app/styles.css`).
- ✅ **Derived song structure** (`app/providers/formats/sections.js`). Authored
  TTML `song-part` wins; otherwise verse/chorus/break are derived from line
  repetition + instrumental gaps, so the rail works on ordinary LRC too.

87 tests added (`test/ttml.test.js`, `test/timeline-rebind.test.js`,
`test/sidecar.test.js`, `test/sidecar-fs.test.js`, `test/sections.test.js`);
suite at 539.

Sidecar content is treated as untrusted (it may have been written on another
machine): `sanitizeCachedTimeline` whitelists and bounds it before anything
reaches the display, and the reader caps file size before parsing.

## What Apple actually does, and what we already do

Apple's model is: **do the hard non-realtime work once, offline, and ship the
result as a data asset alongside the track.** Labels deliver a TTML file through
Transporter 5 days before release; the client never aligns anything. Word spans
are authored by hand for priority releases and by forced alignment for the tail.

We already have the same two halves:

| Apple | Us |
|---|---|
| Forced-alignment pipeline (offline, theirs) | `lib/forced-align.mjs` + `electron/align.cjs`, progressive, on first play |
| TTML asset shipped with the track | `app/timeline-cache.js` — word spans in `localStorage` |
| Client renders pre-timed spans | `app/timeline.js` `Timeline` → Display |

So this is not "build the Apple thing." It is closing three specific gaps
between our cache and their asset.

## Gap 1 — the cache is ephemeral, private, and unshareable

`app/timeline-cache.js` stores into `localStorage` under one key, capped at
`MAX_ENTRIES = 80`, and **discards the entire store** whenever `ALIGN_VERSION`
changes (`loadStore`, `app/timeline-cache.js:39`). Every aligner improvement
throws away every alignment the user has ever paid CPU for.

An Apple-style asset is a *file*, not a browser blob. Proposal: keep
`localStorage` as the hot path, add a durable sidecar.

- For a local audio file `Adele - Someone Like You.mp3`, write
  `Adele - Someone Like You.lyx.json` next to it.
- For streaming tracks, write into an app-data dir keyed by `cacheKey()`
  (`app/timeline-cache.js:16` — already stable, prefers the Spotify id).
- On `ALIGN_VERSION` bump, do **not** drop sidecars. Keep the version *per
  entry* and re-align lazily, best-effort, in the background. A v2 alignment is
  strictly better than no alignment while v3 is computing.

The sidecar is also the export format: shareable, diffable in git, and
hand-correctable — which matters, because the last 5% of sync accuracy is
always a human nudging a word.

## Gap 2 — rebinding is brittle

`applyCachedTiming` (`app/timeline-cache.js:86`) refuses the cache unless line
count, per-line word count, and every normalized word string match, and line
starts are within 2.5 s. That is correct and safe, but it binds the cache to
**the lyric text we happened to re-fetch**, so a provider revising one line's
punctuation or splitting a stanza invalidates the whole song.

Apple's asset has no such problem: the spans are bound to the *recording*, and
the text is carried inside the asset rather than re-fetched.

Proposal: make the sidecar self-contained — it carries the word text it was
aligned against. Then rebinding becomes a diff instead of an equality check:

1. Exact match (current fast path) → apply.
2. Otherwise align the two token sequences (same DP we already own in
   `lib/forced-align.mjs`, run over word tokens instead of CTC labels).
   Matched runs keep their cached spans; inserted/edited words get
   interpolated between the surrounding confident anchors — which is exactly
   the "confidence interpolation" rule already shipped in `applyWordSpans`.
3. Mark rebound lines so the aligner can prioritize re-checking just those.

This turns a provider edit from "re-align the whole song" into "re-align two
lines."

## Gap 3 — no structure, no roles

We have translation and romanization overlays (`attachLineText`,
`app/providers/formats/translation.js:33`), which covers Apple's `x-translation`
and `x-roman`. We have nothing for the other three.

| TTML | Meaning | What it buys us |
|---|---|---|
| `<div itunes:song-part="Chorus">` | section structure | Replaces hysteretic runtime ♪ detection with authored truth; enables section-jump on the Siri Remote |
| `ttm:agent="v1"` | which performer sings the line | Duet left/right staging |
| `ttm:role="x-bg"` | background vocals | Rendered smaller/parenthesized; also lets the aligner *stop trying* to fit backing ad-libs to the lead vocal, which is a real source of bad spans |

`x-bg` is the sleeper. Chorus stacks and ad-libs are where CTC alignment is
worst, and today we treat them as lead-vocal text that must be fitted somewhere.

## Schema

Sidecar is JSON, not XML — it round-trips to TTML but we should not parse XML at
runtime. Shape is a superset of the existing `serializeTimeline` output
(`app/timeline-cache.js:61`), so old cache entries load unchanged.

```jsonc
{
  "v": 1,
  "alignVersion": 3,          // per-entry, replaces the global store version
  "source": "align:ctc",      // or "catalog:yrc" | "catalog:richsync" | "human"
  "duration": 285.4,
  "key": "id:4kflIGfjdZJW4ot2ioixTB",
  "meta": { "artist": "Adele", "track": "Someone Like You" },
  "agents": [{ "id": "v1", "name": "Adele" }],
  "sections": [
    { "part": "Verse",  "start": 14.70, "end": 43.42 },
    { "part": "Chorus", "start": 71.20, "end": 99.80 }
  ],
  "lines": [
    {
      "start": 14.70, "end": 20.10,
      "agent": "v1",
      "roman": null, "english": null,
      "words": [
        { "text": "I",       "start": 14.70, "end": 14.86, "conf": 0.91 },
        { "text": "heard",   "start": 14.86, "end": 15.22, "conf": 0.88 },
        { "text": "that",    "start": 15.22, "end": 15.41, "conf": 0.72 }
      ],
      "bg": [
        { "start": 18.9, "end": 20.1,
          "words": [{ "text": "ooh", "start": 18.9, "end": 20.1 }] }
      ]
    }
  ]
}
```

Notes on the fields that are new:

- **`conf`** — we compute per-word CTC scores already and use them for
  interpolation; persisting them lets a later pass re-align only the weak words
  instead of the whole song, and lets the UI degrade honestly (see the
  confidence/drift meter in the sync self-assessment notes).
- **`sections`** — flat and time-ranged rather than nested `<div>`, because our
  timeline is a flat line list. TTML export nests them; import flattens.
- **`bg`** — parallel to `words`, not interleaved, so the existing renderer
  ignores it until we build the visual for it.
- **`agent`** on the line, ids resolved via `agents`, matching TTML exactly.

## Where it plugs in

Three touch points, all additive:

1. **`app/providers/formats/ttml.js`** (new) — `parseTTML(text)` →
   `Timeline`, registered in `app/providers/formats/index.js` alongside
   `yrc`/`richsync`. Detection: `<tt` in the head, `itunes:timing` attribute.
   This alone lets users drop in a TTML file they got elsewhere. Add `ttml` to
   `WORD_SYNC_FORMATS` (`app/session.js:159`) so it skips forced alignment
   entirely — it is already word-timed.
2. **`app/timeline-cache.js`** — extend `serializeTimeline` with the new
   fields, add the diff-based rebind to `applyCachedTiming`, move
   `ALIGN_VERSION` from store-level to entry-level.
3. **Sidecar I/O** — Electron-side read/write next to the audio file, tried
   before `localStorage` in the `getCachedTimeline` path
   (`app/session.js:160`); `saveAlignedCache` (`app/session.js:192`) writes
   both.

Export to real TTML is a leaf function off the same schema and only matters if
we ever want to hand a file to another player. Not on the critical path.

## Suggested order

1. Entry-level `alignVersion` + stop nuking the store on bump. Smallest change,
   immediately stops throwing away user CPU.
2. Sidecar write/read for local files. Makes alignments survive and be shareable.
3. `parseTTML` importer. Cheap, and makes the format real before we depend on it.
4. Diff-based rebind. The fiddliest; do it once the shape is settled.
5. `sections` and `x-bg`. Needs renderer work, and `x-bg` wants the vocal
   separation from the alignment roadmap to be worth much.
