// Run the existing vocal separation + alignment engine and export for Apple TV.
// This does not capture a stream or upload audio. Input must be a local recording.
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { decodeWAV } from '../app/wav.js';
import { parseLRC } from '../app/providers/formats/lrc.js';
import { alignSong, alignModelStatus } from '../electron/align.cjs';
import { separateVocals, separateShutdown } from '../electron/separate.cjs';
import { validateTimings } from '../lib/word-timings.mjs';

const { values } = parseArgs({ options: {
  audio: { type: 'string' }, lyrics: { type: 'string' }, artist: { type: 'string' },
  track: { type: 'string' }, output: { type: 'string' }, stem: { type: 'boolean', default: false },
  'spotify-id': { type: 'string' }, 'apple-music-id': { type: 'string' }, isrc: { type: 'string' },
  explicit: { type: 'string' }, album: { type: 'string' },
} });
for (const key of ['audio', 'lyrics', 'artist', 'track', 'output']) {
  if (!values[key]) throw new Error(`Missing --${key}`);
}
globalThis.window = { bar4bar: { alignSong } };
if (values.explicit != null && !['true', 'false'].includes(values.explicit)) throw new Error('--explicit must be true or false.');
const recording = values['spotify-id'] || values['apple-music-id'] || values.isrc ? {
  spotifyID: values['spotify-id'], appleMusicID: values['apple-music-id'], isrc: values.isrc?.toUpperCase(),
  explicit: values.explicit == null ? undefined : values.explicit === 'true',
} : undefined;
const { refineTimelineWithAudio } = await import('../app/align.js');
try {
  const bytes = await readFile(values.audio);
  const wav = decodeWAV(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const duration = wav.channels[0].length / wav.sampleRate;
  const timeline = parseLRC(await readFile(values.lyrics, 'utf8'));
  if (!timeline.lines.length) throw new Error('Supply matching line-synced lyrics.');
  console.log(values.stem ? 'Using supplied vocal stem.' : 'Separating vocals locally…');
  const vocal = values.stem ? { left: wav.channels[0], right: wav.channels[1], sampleRate: wav.sampleRate }
    : await separateVocals({ left: wav.channels[0], right: wav.channels[1] ?? wav.channels[0], sampleRate: wav.sampleRate }, { throwOnError: true });
  if (!vocal?.left) throw new Error('Vocal separation failed; no timing artifact created.');
  const ratio = vocal.sampleRate / 16000;
  const pcm = new Float32Array(Math.floor(vocal.left.length / ratio));
  for (let i = 0; i < pcm.length; i++) {
    const at = Math.floor(i * ratio);
    pcm[i] = (vocal.left[at] + (vocal.right?.[at] ?? vocal.left[at])) / 2;
  }
  const result = await refineTimelineWithAudio(timeline, pcm, {
    stem: true, onProgress: (done, total) => console.log(`Aligned ${done}/${total} lines`),
  });
  if (!result || result.error || !result.aligned) throw new Error(result?.error || 'No lines could be aligned.');
  let anchored = 0, count = 0, uncertainLines = 0;
  const lines = timeline.lines.map(line => {
    const uncertain = !line._vocalAligned || !!line.uncertain;
    if (uncertain) uncertainLines++;
    const words = line.words.map(word => {
      const score = Number.isFinite(word.score) ? word.score : 0;
      count++;
      if (score >= 0.3) anchored++;
      return { text: word.text, start: word.start, end: word.end, score };
    });
    return { start: line.start, end: Math.max(line.end, ...words.map(word => word.end)), words, uncertain };
  });
  const artifact = validateTimings({ version: 1,
    meta: { artist: values.artist, track: values.track, duration, album: values.album, recording },
    timeline: { lines, duration, source: 'aligned', estimated: uncertainLines > 0 || anchored < count },
    quality: { anchoredFraction: anchored / count, uncertainLines, model: alignModelStatus().model },
  });
  await writeFile(values.output, JSON.stringify(artifact));
  console.log(JSON.stringify({ output: values.output, duration, lines: lines.length,
    anchoredFraction: anchored / count, uncertainLines, note: 'Model confidence is not a timing accuracy measurement; audition before publishing.' }));
} finally { separateShutdown(); }
