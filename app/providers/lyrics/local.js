import { parseLyricsFilename } from '../../local-lyrics.js';

export async function fetchFromLocal(file) {
  if (!file) return null;
  const text = await file.text();
  const parsed = parseLyricsFilename(file.name);
  const format = file.name.split('.').pop()?.toLowerCase() || 'lrc';
  return {
    text,
    format,
    meta: {
      trackName: parsed.track,
      artistName: parsed.artist,
      source: 'local',
    },
    source: 'local',
  };
}

export function localFileBasename(name) {
  return name.replace(/\.[^.]+$/, '');
}

export function basenamesMatch(a, b) {
  return localFileBasename(a).toLowerCase() === localFileBasename(b).toLowerCase();
}
