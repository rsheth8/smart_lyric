// Desktop-only AI transcript fallback.
// Sources: local audio file, or live capture PCM (Spotify loopback / mic).

import { decodeMono16k, resampleTo16k } from '../../align.js';
import { transcriptToPlainLyrics } from '../../../lib/transcript-text.mjs';
import { chunksToTimeline, applyCleanedLineTexts } from '../formats/asr-timeline.js';
import { estimateTimeline } from '../formats/estimate.js';

const TARGET_RATE = 16000;

export function transcriptionAvailable() {
  return typeof window !== 'undefined' && typeof window.bar4bar?.transcribeAudio === 'function';
}

function lineText(line) {
  return (line.words || []).map((w) => w.text).join(' ');
}

/**
 * Ask the desktop bridge what language this song is sung in (Claude, cached).
 * Whisper-tiny mis-detects non-English vocals (Hindi comes out as English mush),
 * so an explicit hint dramatically improves the transcript. Null = auto-detect.
 */
async function guessLanguage(query) {
  if (typeof window === 'undefined' || typeof window.bar4bar?.guessLanguage !== 'function') {
    return null;
  }
  try {
    const res = await window.bar4bar.guessLanguage({
      artist: query.artist,
      track: query.track,
      album: query.album,
    });
    return res?.language || null;
  } catch {
    return null;
  }
}

/**
 * One Claude pass over the transcript: fix mishearings/casing/punctuation while
 * keeping every line's timing. Soft-fails to the raw ASR text on any problem
 * (no key, rate limit, bad reply) — the show must go on.
 */
async function cleanTimelineWithLlm(timeline, query) {
  if (typeof window === 'undefined' || typeof window.bar4bar?.cleanLyrics !== 'function') return false;
  const lines = timeline?.lines;
  if (!lines?.length) return false;
  try {
    if (!(await window.bar4bar.cleanLyricsAvailable?.())) return false;
    query.onStatus?.('loading', 'Polishing AI lyrics with Claude…');
    const res = await window.bar4bar.cleanLyrics({
      lines: lines.map(lineText),
      artist: query.artist,
      track: query.track,
    });
    if (res?.error || !Array.isArray(res?.lines)) return false;
    return applyCleanedLineTexts(timeline, res.lines);
  } catch {
    return false;
  }
}

function lyricsResultFromAsr(asr, query, { offsetSec = 0 } = {}) {
  if (asr?.error) return { error: asr.error };
  const chunks = asr?.chunks || [];
  if (chunks.length) {
    const timeline = chunksToTimeline(chunks, { offsetSec });
    if (timeline.lines.length) {
      return {
        timeline,
        synced: true,
        meta: {
          trackName: query.track,
          artistName: query.artist,
          albumName: query.album,
          duration: query.duration,
          model: asr?.model,
        },
        source: query.source || 'ai-transcript',
        format: 'asr',
      };
    }
  }
  const plain = transcriptToPlainLyrics(asr?.text || '');
  if (!plain) return { error: 'Speech model heard no words in that audio.' };
  const timeline = estimateTimeline(plain, {
    duration: query.duration,
    leadIn: offsetSec > 0.5 ? offsetSec : 0,
  });
  return {
    plain,
    timeline,
    synced: false,
    meta: {
      trackName: query.track,
      artistName: query.artist,
      albumName: query.album,
      duration: query.duration,
      model: asr?.model,
    },
    source: query.source || 'ai-transcript',
    format: 'plain',
  };
}

/**
 * @param {{ artist?: string, track?: string, album?: string, duration?: number, audioFile?: File, onStatus?: Function }} query
 */
export async function fetchTranscriptFromAudio(query = {}) {
  if (!transcriptionAvailable()) {
    return { skipped: true, reason: 'desktop-only' };
  }
  if (!query.audioFile) {
    return { skipped: true, reason: 'no-audio' };
  }

  try {
    query.onStatus?.(
      'loading',
      `Transcribing “${query.track || query.audioFile.name}”… (first run downloads a speech model)`
    );
    const [pcm, language] = await Promise.all([decodeMono16k(query.audioFile), guessLanguage(query)]);
    const pcmCopy = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
    const asr = await window.bar4bar.transcribeAudio({
      pcm: pcmCopy,
      sampleRate: TARGET_RATE,
      returnTimestamps: true,
      language,
    });
    const result = lyricsResultFromAsr(asr, { ...query, source: 'ai-transcript' });
    if (result?.timeline) await cleanTimelineWithLlm(result.timeline, query);
    return result;
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

/**
 * Transcribe already-captured mono PCM (any sample rate — resampled to 16 kHz).
 * @param {{ pcm: Float32Array, sampleRate: number, offsetSec?: number, artist?: string, track?: string, album?: string, duration?: number, onStatus?: Function, source?: string }} query
 */
export async function fetchTranscriptFromPcm(query = {}) {
  if (!transcriptionAvailable()) {
    return { skipped: true, reason: 'desktop-only' };
  }
  if (!query.pcm?.length) {
    return { error: 'No captured audio to transcribe.' };
  }

  try {
    query.onStatus?.(
      'loading',
      `Transcribing “${query.track || 'track'}”… (first run downloads a speech model)`
    );
    const rate = query.sampleRate || TARGET_RATE;
    const pcm16k = rate === TARGET_RATE ? query.pcm : resampleTo16k(query.pcm, rate);
    const pcmCopy = pcm16k.buffer.slice(pcm16k.byteOffset, pcm16k.byteOffset + pcm16k.byteLength);
    const language = await guessLanguage(query);
    const asr = await window.bar4bar.transcribeAudio({
      pcm: pcmCopy,
      sampleRate: TARGET_RATE,
      returnTimestamps: true,
      language,
    });
    const result = lyricsResultFromAsr(asr, { ...query, source: query.source || 'ai-spotify' }, {
      offsetSec: query.offsetSec || 0,
    });
    if (result?.timeline) await cleanTimelineWithLlm(result.timeline, query);
    return result;
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}
