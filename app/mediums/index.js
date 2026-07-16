import { basenamesMatch } from '../providers/lyrics/local.js';

export const mediums = [];

export function registerMedium(medium) {
  mediums.push(medium);
}

export function getMedium(id) {
  return mediums.find((m) => m.id === id) || null;
}

export function listMediums() {
  return mediums.filter((m) => m.canUse());
}

export function tryAutoPairLyrics(audioFileName, lyricsFiles) {
  if (!audioFileName || !lyricsFiles?.length) return null;
  return lyricsFiles.find((f) => basenamesMatch(f.name, audioFileName)) || null;
}
