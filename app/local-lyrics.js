// Parse artist/track hints from a lyrics filename.
// Supports "Artist - Track.lrc", "Track.lrc", "Artist_-_Track.srt".

export function parseLyricsFilename(filename) {
  const base = filename.replace(/\.(lrc|srt|ass|ssa)$/i, '').trim();
  const dash = base.match(/^(.+?)\s[-–—_]\s(.+)$/);
  if (dash) {
    return { artist: dash[1].trim(), track: dash[2].trim() };
  }
  return { artist: '', track: base };
}

export function basenameWithoutExt(name) {
  return name.replace(/\.[^.]+$/, '');
}
