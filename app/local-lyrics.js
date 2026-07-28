// Parse artist/track hints from a lyrics filename.
// Supports "Artist - Track.lrc", "Track.lrc", "Artist_-_Track.srt".
//
// Keep this extension list in step with `EXT` in providers/formats/index.js —
// an unrecognised extension leaks into the track name ("Song.ttml").

export function parseLyricsFilename(filename) {
  const base = filename.replace(/\.(lrc|srt|ass|ssa|ttml|yrc|xml)$/i, '').trim();
  const dash = base.match(/^(.+?)\s[-–—_]\s(.+)$/);
  if (dash) {
    return { artist: dash[1].trim(), track: dash[2].trim() };
  }
  return { artist: '', track: base };
}

export function basenameWithoutExt(name) {
  return name.replace(/\.[^.]+$/, '');
}
