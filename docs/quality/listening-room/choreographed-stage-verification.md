# After-dark installation — local verification

Validated on 15 September 2026 in the Apple TV 4K (3rd generation, 1080p) simulator,
tvOS 26.5. Build succeeds. All newly supplied artwork is original native typography
and vector rendering; official font files and licenses are included in the app.

## Automated results

| Check | Result |
| --- | --- |
| Core timing, choreography and audience-event suite | 152 passed |
| Native app, playback, bundled fonts, outline caching and layout suite | 35 passed |
| Complete remote journeys | 10 passed |
| Stage recheck after unfolding/held-word adjustments | 4 passed |
| Picker recheck after taller study buttons | 2 passed |
| Saved availability, incoming handoff, long lyrics, Reduced Motion and cheer recheck | 5 passed |
| Final foreground spacing and automatic guidance recheck | 2 passed |

Core checks cover mixed timing quality, legacy cache decoding, recording/version/
address validation, reviewed priority, estimated-tail hold gating, pause, seek,
revision event suppression and coalesced cheers. Section unfolding freezes on pause,
preserves progress across revisions and resolves seeks immediately.

Native checks verify Fraunces, Fraunces Italic and Manrope registration, fallback
script measurements, cached outline reuse, and the demo sidecar fingerprint.

Remote checks cover first use, remembered intensity, roles, automatic-only estimated
word guidance, long Spanish lyrics with English aid at every intensity, Reduced
Motion entrance/role cues, paused cheers preserving phrase bounds/focus, Headliner
chorus control responsiveness, timing/options recovery, idle hide and pairing.

The complete remote run and focused rechecks are retained in the local simulator's
Xcode test results. Human-readable captures are in `docs/quality/installation`.
Six original CoreText-outlined design studies are in `docs/brand/studies`.

## Local visual review

Reviewed the phrase board, held-word underline/shadow, long lyrics and aid, playback
deck, home invitation, song entries and stage-study preview. The intensity picker
uses its own taller style so two-line descriptions remain readable. Held accents
have reserved vertical space inside the entrance mask. Playback progress uses the
shared vermilion theme; estimated guidance is labeled per phrase, including mixed
source quality.

The follow-up review adds exact-recording saved timing labels to catalog entries
and an advance NEXT VOICE caption in Take turns mode. The current phrase keeps
the same bounds and Stage control retains focus after changing participation.
Cached word-height measurements include row spacing and held-accent reserves;
long phrases fit a 311-point content band at 1400- and 1570-point widths, with a
44-point minimum for unusually long text. The original offline catalog fixture
contains reliable, estimated, mixed and unchecked examples and a long title.

Rendering responsiveness is checked by remote control/focus interaction while the
Headliner chorus runs. This is not a measured physical-TV frame-rate claim.

## Pending participant and dependency work

- Solo singing comparison: pending actual participants.
- Cooperative group comparison, entrances, role comprehension and recovery: pending.
- Logo-hidden recognition comparison, including grayscale: pending participants.
- Physical Apple TV performance profiling: pending device review.
- Adaptive phone listener, connectivity and live learning: separate future dependency.

The original 52-second demo is visual-only, with no audio. This design implementation
does not capture microphone samples, separate stems, train a model or claim to
correct timing by listening. Future timing evidence feeds the existing timing contract.
