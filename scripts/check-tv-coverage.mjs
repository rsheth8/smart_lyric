// Provider availability audit; does NOT measure acoustic timing accuracy.
// Input: [{artist, track, duration, group?}]. Use exact recording durations.
import { readFile, writeFile } from 'node:fs/promises';
import { titleScore, cleanTrackTitle, primaryArtist } from '../app/providers/lyrics/lrclib.js';
const [manifest, output] = process.argv.slice(2);
if (!manifest || !output) throw new Error('Usage: node scripts/check-tv-coverage.mjs tracks.json report.json');
const tracks = JSON.parse(await readFile(manifest, 'utf8'));
const base = process.env.LYRICS_API_BASE || 'https://smartlyric.vercel.app';
async function request(url) {
  const start = performance.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
    return { status: response.status, ms: Math.round(performance.now() - start), body: await response.json() };
  } catch (error) { return { status: 0, ms: Math.round(performance.now() - start), error: error.message }; }
}
function matches(track, meta) {
  return titleScore(cleanTrackTitle(track.track), cleanTrackTitle(meta.trackName || meta.track || '')) >= 0.75
    && titleScore(primaryArtist(track.artist), primaryArtist(meta.artistName || meta.artist || '')) >= 0.75
    && (!track.duration || !meta.duration || Math.abs(track.duration - meta.duration) < 22);
}
const rows = [];
for (const track of tracks) {
  const query = new URLSearchParams({ artist: track.artist, track: track.track });
  if (track.duration) query.set('duration', String(track.duration));
  if (track.spotifyId || track.spotifyID) query.set('spotifyID', track.spotifyId || track.spotifyID);
  if (track.isrc) query.set('isrc', track.isrc);
  const lrclibQuery = new URLSearchParams({ artist_name: primaryArtist(track.artist), track_name: cleanTrackTitle(track.track) });
  const responses = await Promise.all([
    request(`${base}/api/lyrics?${query}`), request(`${base}/api/richsync?${query}`),
    request(`https://lrclib.net/api/search?${lrclibQuery}`), request(`${base}/api/word-timings?${query}`),
  ]);
  const providers = responses.map((response, index) => {
    const provider = ['netease', 'richsync', 'lrclib', 'prepared'][index];
    const data = response.body;
    const hits = index === 2 ? (Array.isArray(data) ? data.map(hit => ({ meta: hit, lrc: hit.syncedLyrics })) : []) : [data].filter(Boolean);
    // A metadata-only hit must not hide a later timed result for the same song.
    const matching = hits.filter(hit => hit.meta && matches(track, hit.meta));
    const match = matching.find(hit => hit.yrc || hit.richsync || hit.timeline || hit.lrc) ?? matching[0];
    const word = !!(match?.yrc || match?.richsync || (match?.timeline && !match.timeline.estimated));
    return { provider, status: response.status, ms: response.ms,
      result: word ? 'word_timestamps' : match?.timeline ? 'audio_refined_mixed'
        : match?.lrc ? 'line_timestamps' : !matching.length && hits.some(hit => hit.meta) ? 'rejected_match' : 'unavailable',
      returnedRecording: (() => {
        const meta = match?.meta ?? hits.find(hit => hit.meta)?.meta;
        return meta ? { artist: meta.artistName ?? meta.artist, track: meta.trackName ?? meta.track,
          album: meta.albumName ?? meta.album, duration: meta.duration } : null;
      })(),
      error: response.error ?? data?.error ?? null };
  });
  const result = providers.some(p => p.result === 'word_timestamps') ? 'word_timestamps'
    : providers.some(p => p.result === 'audio_refined_mixed') ? 'audio_refined_mixed'
    : providers.some(p => p.result === 'line_timestamps') ? 'estimated_words_only' : 'missing';
  rows.push({ ...track, recordingDurationKnown: Number.isFinite(track.duration), result, providers });
  console.log(`${track.artist} — ${track.track}: ${result}`);
}
const counts = Object.fromEntries(['word_timestamps', 'audio_refined_mixed', 'estimated_words_only', 'missing']
  .map(state => [state, rows.filter(row => row.result === state).length]));
await writeFile(output, JSON.stringify({ checkedAt: new Date().toISOString(), sampleSize: rows.length,
  counts, warning: 'Availability only. Returned word timestamps have not been auditioned or measured against the recording. This sample is not representative of the whole catalog.', rows }, null, 2));
console.log(JSON.stringify(counts));
