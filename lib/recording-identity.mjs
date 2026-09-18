// Mirror the TV identity rules. Metadata similarity cannot override an ID conflict.
export function validateRecording(recording) {
  if (!recording || typeof recording !== 'object' || Array.isArray(recording)) throw new Error('Invalid recording identity.');
  for (const key of ['spotifyID', 'appleMusicID', 'isrc']) {
    if (recording[key] != null && (typeof recording[key] !== 'string'
      || !recording[key].trim() || recording[key].length > 128)) throw new Error(`Invalid ${key}.`);
  }
  if (recording.explicit != null && typeof recording.explicit !== 'boolean') throw new Error('Invalid explicit edition.');
  return recording;
}
export const hasIdentifier = recording => ['spotifyID', 'appleMusicID', 'isrc'].some(key => !!recording?.[key]);
export function recordingMatches(target, candidate) {
  if (!hasIdentifier(target) || !hasIdentifier(candidate)) return false;
  if (target.explicit != null && candidate.explicit != null && target.explicit !== candidate.explicit) return false;
  let shared = false;
  for (const key of ['spotifyID', 'appleMusicID']) {
    if (target[key] && candidate[key]) {
      if (target[key] !== candidate[key]) return false;
      shared = true;
    }
  }
  if (target.isrc && candidate.isrc && target.isrc.toUpperCase() !== candidate.isrc.toUpperCase()) return false;
  return shared || (!!target.isrc && target.isrc.toUpperCase() === candidate.isrc?.toUpperCase()
    && target.explicit != null && target.explicit === candidate.explicit);
}
export function recordingStorageKey(recording) {
  validateRecording(recording);
  if (recording.spotifyID) return `spotify:${recording.spotifyID}`;
  if (recording.appleMusicID) return `apple:${recording.appleMusicID}`;
  if (recording.isrc && recording.explicit != null) return `isrc:${recording.isrc.toUpperCase()}:${recording.explicit}`;
  throw new Error('Prepared timing storage requires a provider track ID or ISRC with a known explicit edition.');
}
