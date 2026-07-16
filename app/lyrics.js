// Re-export lyrics provider chain for backward compatibility.
export {
  fetchLyrics,
  fetchFromLRCLIB,
  fetchFromLocal,
  normalizeTitle,
  titleScore,
  pickBestMatch,
} from './providers/lyrics/index.js';

import { fetchFromLRCLIB } from './providers/lyrics/lrclib.js';
import * as lrclib from './providers/lyrics/lrclib.js';

export const getSynced = fetchFromLRCLIB;
export const search = lrclib.search;
