# Bar4Bar — an after-dark typographic installation

Monumental, cropped editorial letterforms surround a clear singing foreground.
The native TV journey shares this identity across home, song selection, stage
studies and performance. All new graphics are original typography and native
vectors; no generated imagery is used. Real catalog artwork stays attributed to
its song through the catalog metadata.

## Visual system

Fraunces supplies editorial headings, selective invitations in italic, and cached
CoreText silhouettes. Manrope at weight 600 supplies lyrics and controls. Native
CoreText fallback runs support other scripts. Official font distributions and
SIL Open Font Licenses are bundled under `tvos/Bar4BarTV/Fonts`:

- https://github.com/google/fonts/tree/main/ofl/fraunces
- https://github.com/google/fonts/tree/main/ofl/manrope

Midnight aubergine #19121F, ink #100F15, ivory #F2EBDD, vermilion #EF684B,
lilac #B9A1DC and chartreuse #D8E77B form the shared theme. Verse compositions use
vermilion and lilac; hooks substitute chartreuse for vermilion. Layered silhouettes,
offset print depth and cached stippling replace the geometric side panels and bars.
The foreground is quieter than the surrounding installation, with no lyric blur.
Letter shape, cropping and unequal proportions carry the identity in grayscale.

`studies/installation-studies.svg` contains six original CoreText-outlined vector
studies: home, selection, settings, verse, hook and handoff. Native app-icon layers
and top-shelf compositions are reproducible with `scripts/build-installation-assets.swift`.

## Participation and presentation

Home invites “Your voice, in good company.” with a playable visual study and a clear
song-finding action. Horizontal catalog entries expose artwork, title and artist;
focus expands the title hierarchy and changes the surrounding title initials.
Timing is checked on selection rather than falsely promised by catalog metadata.

The performance board keeps a fixed current phrase, separate upcoming phrase,
entrance guidance, section captions and explicit roles. Long text is measured once
at phrase entrance; revisions update word boundaries without changing its font
size, text or wrapping. Break artwork occupies reserved preview space.

- Focus: largely stationary silhouettes and quiet, distinct section palettes.
- Live (default): expressive entrances and slow layered movement.
- Headliner: deeper print separation, broader hook and reviewed arrival payoffs.

Stage settings remember intensity and read-ahead. One large live preview follows
the focused exhibition study before selection. Solo, Take turns and Everyone are
explicit participation choices; repetition never assigns participants. Side A/B
alternate phrases with an advance caption for the next turn.

Cheer is an explicit remote control. `AudienceAccent` coalesces rapid inputs into
one 1.2-second presentation event. It changes environmental separation and color
only, including a stationary color accent under Reduce Motion. This event seam can
later accept phone input; it does not establish connectivity or edit lyric timing.

Phrase entrances last approximately 240 ms where advance notice permits. Essential
words are immediately visible at onset and after seek. Selected reviewed emphasis
may echo outside the reading area; within text, scale is capped at 8% and enabled
only for spacious Headliner phrases. Held words retain continuous word fill with
an underline and small print-shadow extension. Fast passages recede environmental
motion. Reduce Motion preserves readable cues through stationary layers and color.

## Timing boundaries

The pure `PhraseDirector` consumes recording-validated choreography, corrected
audible time, singer-lead cue time, playback, seek and timing revisions. Reviewed
cues override automatic suggestions. Stable event addresses prevent duplicate
emphasis and arrivals after corrections. Fingerprints ignore timestamps and aids.
Song-driven motion freezes on pause; seeking resolves its destination immediately.
Audience accents are deliberately separate from the song clock.

Estimated words retain continuous approximate progression, including mixed-quality
songs. Long estimated tails do not imply held notes. Automatic sections use lyric
repetition and density, never invented beats or arbitrary stress. Missing, invalid
or mismatched sidecars fall back coherently. Files end in `.choreography.json`.

Song entries identify saved word timing, approximate guidance, or a mixture from
the exact recording's local cache. Unchecked entries say timing is checked on
selection. Cache reads run away from the rendering loop. In Take turns mode, a
separate NEXT VOICE caption counts down to the incoming side using singer-lead
time, while the current phrase and remote focus remain in place.

Phrase fitting uses cached CoreText word widths and heights, including row gaps
and the 24-point held-accent reserve. A phrase's selected size stays frozen across
timing corrections and intensity changes; exceptionally long phrases can use
44-point type to remain within the reading band.

The original 52-second local demo includes reviewed hooks, build, held word,
fast passage, breaks, handoff and final chorus. Stage can switch it to automatic-only
estimated guidance. It is a visual demo with no audio. The optional adaptive phone
listener remains a separate dependency; this revision neither listens nor trains.

Real solo/group singing, physical-TV profiling, and a logo-hidden recognition
comparison remain pending until participants complete them.
