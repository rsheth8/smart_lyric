import { Display } from './display.js';
import { MediaClock, PredictiveClock } from './clock.js';
import { fetchArtworkUrl, paletteFromUrl } from './art.js';
import { Mic } from './mic.js';
import { startBestCapture, listInputDevices, findLoopbackDevice, waitForCaptureWindow } from './capture.js';
import {
  resolveOffset,
  rememberOffset,
  clearTrackOffset,
  migrateLegacyOffset,
  getDeviceDefault,
  devicePriorWeight,
} from './sync-offset.js';
import { SyncEstimator, syncLockState, driftReadout } from './sync-learn.js';
import { SongSession } from './session.js';
import { readAudioTags } from './audio-tags.js';
import { parseLyricsFilename } from './local-lyrics.js';
import { basenamesMatch } from './providers/lyrics/local.js';
import { createSyncPublisher } from './sync-bridge.js';
import { translateLines, romanizeLines, needsRomanization } from './providers/translate.js';
import { getMedium } from './mediums/index.js';
import { initTvNav } from './tv-nav.js';
import {
  refineTimelineWithAudio,
  refineTimelineFromMic,
  alignmentAvailable,
  warmAlignModel,
  warmSeparationModel,
  setVocalSeparationEnabled,
  needsVocalAlign,
  isWordSyncFormat,
  onLiveSepStat,
  liveSeparationStats,
  resetLiveSeparationStats,
} from './align.js';
import {
  transcriptionAvailable,
  fetchTranscriptFromPcm,
} from './providers/lyrics/transcript.js';import {
  beginSpotifyLogin,
  completeSpotifyLoginFromUrl,
  searchSpotifyTrack,
  playSpotifyTrack,
  primeTrack,
  togglePlayback as spotifyTogglePlayback,
  nextTrack as spotifyNextTrack,
  previousTrack as spotifyPreviousTrack,
  isSpotifyPlaying,
  getStreamingClock,
} from './streaming/spotify.js';
import { loadToken as loadAuthToken, isExpired } from './streaming/auth.js';
import {
  fetchChartRecommendations,
  searchSuggestions,
  fetchSpotifyRecentlyPlayed,
  fetchSpotifyNowPlaying,
} from './recommendations.js';

import './mediums/manual.js';
import './mediums/audioFile.js';
import './mediums/vinyl.js';
import './mediums/spotify.js';
import './mediums/appleMusic.js';

// Spotify OAuth (browser) requires the 127.0.0.1 origin — it rejects "localhost",
// and the PKCE verifier lives in this origin's sessionStorage, so the whole app
// must run on 127.0.0.1 for the ?code= redirect to land where the verifier is.
// Forward once on local dev; no-op on 127.0.0.1, Vercel, or Electron (file://).
if (location.hostname === 'localhost') {
  location.replace(location.href.replace('//localhost', '//127.0.0.1'));
}

const $ = (id) => document.getElementById(id);
const stage = $('stage');

const display = new Display({ stage, lyricsEl: $('lyrics'), bgCanvas: $('bg') });
display.start();

const audio = $('audio');
const mediaClock = new MediaClock(audio);
const demoClock = new PredictiveClock();
const vinylClock = new PredictiveClock();

let haveAudio = false;
let activeMedium = null;
let pendingAudioFile = null;
let pendingLyricsFile = null;
let activeMic = null;
let alignMic = null; // silent capture for Spotify/streaming vocal align
let alignCaptureOwned = false;
let alignCaptureLabel = ''; // human name of the active capture source
let alignCaptureError = ''; // last failure reason (shown in Sync panel)
let liveAlignTimer = null;
let liveAlignBusy = false;
// How the vocal aligner listens: 'auto' | 'system' | 'device' | 'off'.
let alignSourceMode = localStorage.getItem('bar4bar.alignSource') || 'auto';
let alignSourceDeviceId = localStorage.getItem('bar4bar.alignDevice') || null;
// Auto-timing: the aligner measures latency from the audio and converges the
// sync offset on its own. Off the moment the user nudges manually (per session).
let autoTiming = localStorage.getItem('bar4bar.autoTiming') !== 'off';
let autoTimingSuspended = false; // user took manual control this song
let lastAutoApplied = null;
let practiceSlow = false;
const PRACTICE_RATE = 0.8;
const RECAL_NUDGE = 0.08; // feel-late → earlier; feel-early → later
// Isolate the vocal (MDX-Net) before aligning — only takes effect when a model
// is configured (SEPARATE_MODEL_PATH). Default on so it's used once available.
let vocalIsolation = localStorage.getItem('bar4bar.vocalIsolation') !== 'off';
setVocalSeparationEnabled(vocalIsolation);
let sepHudEnabled = localStorage.getItem('bar4bar.sepHud') !== 'off'; // default on
const syncEstimator = new SyncEstimator();
let listenRaf = null;
let lastListenResult = null;
let listenEverLocked = false;
let listenSilentSince = null;
let listenPanelDismissed = false; // user closed the vinyl overlay with ×
let selectedInputDeviceId = null; // chosen mic/line-in (e.g. USB turntable / BlackHole)
let suggestionItems = [];
let suggestionIndex = -1;
let suggestTimer = null;

function setStatus(type, msg) {
  const el = $('setup-status');
  el.textContent = msg || '';
  el.dataset.type = type || '';
}

function showBusy(title, detail) {
  const busy = $('busy');
  if (!busy) return;
  busy.hidden = false;
  $('busy-title').textContent = title || 'Working…';
  $('busy-detail').textContent = detail || 'Please wait';
  $('btn-spotify')?.classList.add('busy-pulse');
  if ($('btn-spotify')) $('btn-spotify').disabled = true;
}

function hideBusy() {
  const busy = $('busy');
  if (busy) busy.hidden = true;
  $('btn-spotify')?.classList.remove('busy-pulse');
  if ($('btn-spotify')) $('btn-spotify').disabled = false;
}

const session = new SongSession({
  display,
  clocks: { media: mediaClock, demo: demoClock, vinyl: vinylClock },
  onMeta: (m) => {
    $('np-title').textContent = m.track || '—';
    $('np-artist').textContent = [m.artist, m.album].filter(Boolean).join(' · ');
    loadArtwork(m.artist, m.track);
    syncPublisher.publishFull();
  },
  onError: (msg) => setStatus('error', msg),
  onStatus: setStatus,
});

const syncPublisher = createSyncPublisher({
  display,
  getMeta: () => session.meta,
  getClock: () => session.clock,
});
syncPublisher.start();

async function loadArtwork(artist, track) {
  $('cover').style.backgroundImage = '';
  const url = await fetchArtworkUrl({ artist, track });
  if (!url) return;
  $('cover').style.backgroundImage = `url("${url}")`;
  const palette = await paletteFromUrl(url);
  if (palette?.length) {
    display.setPalette(palette);
    syncPublisher.publishFull();
  }
}

async function prepareSong(query) {
  resetLiveSeparationStats(); // fresh HUD counts per song
  const result = await session.load(query);
  // Apply the best known timing offset for this track (saved per-song, else the
  // learned device default from prior nudges). Not BPM — speaker/Spotify lag.
  applySongTimingOffset(session.meta, { quiet: !result });
  // Nudge the user toward the language aids; the display starts with them off.
  const canRomanize =
    result?.hasRoman || needsRomanization((session.timeline?.lines || []).map(lineText));
  if (canRomanize) {
    setTimeout(() => showToast('Press T for pronunciation / English'), 900);
  } else if (result?.fromCache && result?.aligned) {
    setTimeout(() => showToast('Vocal-aligned (cached)'), 900);
  } else if (result?.source === 'ai-spotify' || result?.source === 'ai-transcript') {
    setTimeout(() => showToast('AI lyrics — nudge with [ ] if needed'), 900);
  } else if (result?.estimated) {
    setTimeout(() => showToast('Estimated timing — aligning when audio is heard…'), 900);
  } else if (result?.wordSync) {
    setTimeout(() => showToast('Word sync — press ] [ to nudge if needed'), 900);
  } else if (result?.needsAlign && alignmentAvailable()) {
    setTimeout(() => showToast('Line sync — aligning to vocal…'), 900);
  } else if (result?.lines) {
    setTimeout(() => showToast('Line sync · words estimated'), 900);
  }
  return result;
}

/** Catalog lyrics first; on miss while Spotify is audible, capture + transcribe. */
async function prepareSongOrAi(meta) {
  const query = {
    artist: meta.artist,
    track: meta.title || meta.track || meta.name,
    album: meta.album,
    duration: meta.duration,
    id: meta.id,
    spotifyId: meta.id || meta.spotifyId,
    quietMiss: true, // AI capture will explain if it also fails
    allowTranscript: false, // catalogs only — AI only after a total miss below
  };
  let loaded = await prepareSong(query);
  if (!loaded && (activeMedium?.id === 'spotify' || meta._spotifyAi)) {
    loaded = await trySpotifyAiLyrics(query);
  } else if (!loaded) {
    setStatus(
      'error',
      `No lyrics found for “${query.track}”. Play on Spotify with Sync capture on, or choose an Audio file.`
    );
  }
  return loaded;
}

/** Load per-track or device-default latency offset when a song starts. */
function applySongTimingOffset(meta, { quiet = false } = {}) {
  // New song → fresh measurements, and let auto retake control.
  syncEstimator.reset();
  autoTimingSuspended = false;
  lastAutoApplied = null;

  const { offset, source } = resolveOffset(meta || {});
  display.setSyncOffset(offset, { source, persistLegacy: true });
  // After 1–2 songs on this output path, seed harder so song 2–3 start locked-in.
  syncEstimator.seed(offset, { weight: devicePriorWeight() });
  updateTimingReadout();
  if (!quiet && source === 'track' && offset !== 0) {
    const ms = Math.round(offset * 1000);
    setTimeout(
      () => showToast(`Timing ${ms > 0 ? '+' : ''}${ms}ms (saved for this song)`),
      1200
    );
  } else if (!quiet && source === 'device' && offset !== 0) {
    const ms = Math.round(offset * 1000);
    setTimeout(
      () => showToast(`Timing ${ms > 0 ? '+' : ''}${ms}ms (your usual delay)`),
      1200
    );
  }
}

function persistCurrentTiming(offset, { fromLock = false } = {}) {
  rememberOffset(session.meta || {}, offset, { fromLock });
}

/**
 * Fold measured latency samples from the aligner into the estimator and, when
 * confident, converge the live sync offset automatically. This is the "learns as
 * it plays" loop — measured from the actual vocal, not BPM.
 */
function ingestTimingSamples(samples) {
  for (const s of samples) syncEstimator.addSample(s);
  if (!autoTiming || autoTimingSuspended) {
    updateTimingReadout();
    return;
  }
  const suggestion = syncEstimator.suggestion();
  if (suggestion == null) {
    updateTimingReadout();
    return;
  }
  // Move gently and only when it actually changes something perceptible (>15ms).
  const current = display.syncOffset || 0;
  if (Math.abs(suggestion - current) < 0.015) {
    lastAutoApplied = suggestion;
    updateTimingReadout();
    return;
  }
  // Adaptive gain: close an obvious gap almost in one move (what a listener does
  // when it's plainly late), but ease in near zero so a noisy room can't set up
  // an oscillation around the target.
  const err = suggestion - current;
  const mag = Math.abs(err);
  const gain = mag > 0.25 ? 0.9 : mag > 0.12 ? 0.7 : 0.45;
  const next = Math.round((current + err * gain) * 1000) / 1000;
  display.setSyncOffset(next, { source: 'auto', persistLegacy: true });
  persistCurrentTiming(next, { fromLock: true }); // mic lock → train device path
  lastAutoApplied = next;
  updateTimingReadout();
}

function enterSetup() {
  stage.dataset.mode = 'setup';
  clearTimeout(idleTimer);
  $('nowbar').classList.remove('hide');
  $('hotkeys')?.classList.add('hide');
  stopActiveMedium();
  updateTransport();
  if (!audio.paused) audio.pause();
  if (demoClock.isPlaying()) demoClock.pause();
  if (vinylClock.isPlaying()) vinylClock.pause();
}

function enterPlaying() {
  stage.dataset.mode = 'playing';
  updateTransport();
  updatePlayBtn();
  // First reveal a bit longer so the key guide is discoverable.
  poke(5200);
}

function stopActiveMedium() {
  if (activeMedium?.stop) activeMedium.stop();
  activeMedium = null;
  stopLiveAlign();
  stopAlignCapture();
  stopListenMeter();
}

// Live feedback for vinyl "listen" mode: a mic-level meter + progressive status
// so the user can see the mic is actually hearing audio and where it is in the
// identify → lock flow. Driven by a RAF loop off activeMic.level + medium.state.
const LISTEN_METER_FULL = 0.15; // RMS mapped to a full bar
const LISTEN_SILENCE_HOLD_MS = 10000; // sustained quiet before we pause the clock
function startListenMeter(mic) {
  activeMic = mic;
  lastListenResult = null;
  listenEverLocked = false;
  listenSilentSince = null;
  listenPanelDismissed = false;
  const panel = $('listen-panel');
  const card = panel.querySelector('.listen-card');
  const fill = panel.querySelector('.listen-meter-fill');
  const threshold = panel.querySelector('.listen-meter-threshold');
  const title = $('listen-title');
  const detail = $('listen-detail');
  panel.hidden = false;
  threshold.style.left = `${Math.min(100, (mic.onsetThreshold / LISTEN_METER_FULL) * 100)}%`;

  const tick = () => {
    if (!activeMic || activeMedium?.id !== 'vinyl') return;
    const level = activeMic.level || 0;
    const hot = level > activeMic.onsetThreshold;
    fill.style.width = `${Math.min(100, (level / LISTEN_METER_FULL) * 100)}%`;
    card.classList.toggle('is-hot', hot);
    if (activeMedium?.state === 'locked') listenEverLocked = true;

    // Track sustained silence so we can pause the moment the record stops,
    // instead of letting the predictive clock scroll lyrics on for ~20s.
    const nowMs = performance.now();
    if (hot) listenSilentSince = null;
    else if (listenSilentSince == null) listenSilentSince = nowMs;
    const silentFor = listenSilentSince == null ? 0 : nowMs - listenSilentSince;

    if (silentFor > LISTEN_SILENCE_HOLD_MS && vinylClock.isPlaying()) {
      vinylClock.pause(); // freeze lyrics; next fingerprint match resumes them
    } else if (hot && listenEverLocked && !vinylClock.isPlaying() && activeMedium?.state === 'locked') {
      // Music came back on the same locked track — resume immediately; the next
      // poll's observe() re-anchors precisely.
      vinylClock.resume();
    }

    if (vinylClock.isPlaying() || listenPanelDismissed) {
      panel.hidden = true; // following, or the user closed the overlay
    } else if (listenEverLocked) {
      panel.hidden = false;
      title.textContent = 'Paused — waiting for the music…';
      detail.textContent = 'Lyrics resume when the record plays again';
    } else if (hot || activeMic.onsetAt != null) {
      panel.hidden = false;
      title.textContent = 'Heard audio — identifying…';
      detail.textContent = describeListenResult(lastListenResult);
    } else {
      panel.hidden = false;
      title.textContent = 'Listening…';
      detail.textContent = 'Start the record near the mic';
    }
    updatePlayBtn();
    listenRaf = requestAnimationFrame(tick);
  };
  cancelAnimationFrame(listenRaf);
  listenRaf = requestAnimationFrame(tick);
}

function describeListenResult(r) {
  if (!r || !r.attempts) return 'Matching against the AcoustID database…';
  const n = r.attempts;
  const tries = `${n} ${n === 1 ? 'try' : 'tries'}`;
  if (r.reason === 'low-score') {
    return `Weak match (${Math.round((r.score || 0) * 100)}%) — ${tries}. Move the mic closer / turn it up.`;
  }
  if (r.reason === 'error') {
    return `Error: ${r.detail || 'lookup failed'} — ${tries}`;
  }
  // no-match / no-audio
  return `No match yet · ${tries}. Vinyl through a mic can be hard to fingerprint.`;
}

function stopListenMeter() {
  cancelAnimationFrame(listenRaf);
  listenRaf = null;
  activeMic = null;
  const panel = $('listen-panel');
  if (panel) panel.hidden = true;
}

// Drop everything tied to the *current* song so the next selection starts clean.
// Without this, an attached audio/lyrics file (or a stale <audio> src) leaks into
// later searches — and even into Spotify/vinyl follow, since session.load still
// forwards the old lyricsFile. Call this whenever the user picks a new source.
function resetSongState() {
  setPracticeSlow(false, { quiet: true });
  haveAudio = false;
  pendingAudioFile = null;
  pendingLyricsFile = null;
  session.setAudioFile(null, null);
  session.setLyricsFile(null);
  if (!audio.paused) audio.pause();
  audio.removeAttribute('src');
  audio.load();
}

function loadToken(service) {
  const token = loadAuthToken(service);
  if (!token || isExpired(token)) return null;
  return token;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ------------------------------ pick a song ------------------------------
async function loadSong({ artist, track, duration }) {
  stopActiveMedium();
  hideSuggestions();
  $('in-track').value = track || '';
  $('in-artist').value = artist || '';
  if (!track) {
    setStatus('error', 'Enter a song title.');
    $('in-track').focus();
    return;
  }
  // Prefer an attached audio file; otherwise, if Spotify is connected, play the
  // song on Spotify and follow it; otherwise fall back to the local demo clock.
  if (!haveAudio && loadToken('spotify')) {
    await startSpotifySong({ artist, track });
    return;
  }

  $('btn-load').disabled = true;
  const ok = await prepareSong({
    artist,
    track,
    duration:
      duration ?? (haveAudio && audio.duration ? audio.duration : session.audioTags?.duration),
  });
  $('btn-load').disabled = false;
  if (!ok) return;

  enterPlaying();
  if (haveAudio) {
    session.setClock(mediaClock);
    audio.play();
    // Refine word timing from the actual vocal in the background — don't hold up
    // playback. The clean audio file is the ideal input for forced alignment.
    ensureVocalAlignment({ file: pendingAudioFile });
  } else {
    session.setClock(demoClock);
    demoClock.start(0);
  }
  updatePlayBtn();
}

function markAlignedBadge() {
  display.updateTimingBadge({
    source: session.meta?.source,
    format: session.meta?.format,
    wordSync: isWordSyncFormat(session.meta?.format),
    aligned: true,
  });
}

function persistAlignedTiming() {
  if (session.saveAlignedCache?.()) {
    /* cached for next play */
  }
}

/**
 * Near word-sync path: catalog word sync wins; otherwise force-align from any
 * audio we can hear (local file, vinyl/line-in, or Spotify loopback/mic).
 * @param {{ file?: File|null, capture?: boolean, forceCapture?: boolean }} [opts]
 *   `forceCapture` starts listening even when the catalog already has word sync
 *   (used when the user opens Sync / changes source mid-song).
 */
async function ensureVocalAlignment({ file = null, capture = false, forceCapture = false } = {}) {
  if (!session.timeline) return;
  const needs = needsVocalAlign(session.timeline, session.meta || {});
  // Auto-timing needs audio even when provider/cached word timing is already
  // good; it measures the separate speaker/output delay.
  if (!needs && !forceCapture && !(capture && autoTiming)) return;
  if (!alignmentAvailable()) {
    alignCaptureError = 'Vocal aligner needs the desktop app (npm start)';
    updateSyncSourceUi();
    return;
  }

  if (needs || autoTiming) warmAlignModel(); // fire-and-forget first-run download

  if (file && needs) {
    try {
      let announced = false;
      const res = await refineTimelineWithAudio(session.timeline, file, {
        onProgress: (done, total) => {
          // Flip the badge as soon as the first lines sharpen; keep it quiet after.
          if (!announced && session.timeline.aligned) {
            announced = true;
            markAlignedBadge();
          }
          if (done < total) setStatus('ok', `Aligning vocals… ${done}/${total}`);
        },
      });
      if (res && res.aligned > 0) {
        markAlignedBadge();
        persistAlignedTiming();
        setStatus('ok', '');
        showToast('Timing aligned to the vocal');
      } else if (res && res.error) {
        showToast('Vocal aligner unavailable — using estimated timing');
      }
    } catch {
      /* keep existing timing */
    }
    return;
  }

  if (capture || forceCapture) {
    if (alignSourceMode === 'off') return;
    const ok = await startAlignCapture();
    if (ok) {
      if (needs) {
        showToast(`Aligning words to the vocal — ${alignCaptureLabel}`);
      } else {
        showToast(
          autoTiming
            ? `Auto-timing is listening — ${alignCaptureLabel}`
            : `Listening on ${alignCaptureLabel}`
        );
      }
      // Auto-timing also runs for catalog/cached word sync. In that case this is
      // measurement-only: preserve good word spans, learn the output latency.
      if (needs || autoTiming) scheduleLiveAlign();
    } else if (alignCaptureError) {
      showToast(alignCaptureError);
    }
    updateSyncSourceUi();
  }
}

/** Silent capture used to align Spotify (and similar) while they play. */
async function startAlignCapture() {
  if (!alignmentAvailable()) {
    alignCaptureError = 'Vocal aligner needs the desktop app (npm start)';
    return false;
  }
  if (activeMic) {
    alignCaptureLabel = 'Vinyl input';
    alignCaptureError = '';
    return true; // vinyl mic already capturing
  }
  if (alignMic) {
    alignCaptureError = '';
    return true;
  }
  const res = await startBestCapture({
    mode: alignSourceMode,
    deviceId: alignSourceDeviceId,
    seconds: 16,
  });
  if (!res) {
    alignCaptureError = '';
    return false; // mode === off
  }
  if (res.error || !res.mic) {
    alignCaptureError = res.error || 'Could not start audio capture';
    return false;
  }
  alignMic = res.mic;
  alignCaptureOwned = true;
  alignCaptureLabel = res.label;
  alignCaptureError = '';
  return true;
}

function stopAlignCapture() {
  if (alignCaptureOwned && alignMic) {
    try {
      alignMic.stop();
    } catch {
      /* ignore */
    }
  }
  alignMic = null;
  alignCaptureOwned = false;
  alignCaptureLabel = '';
  updateSyncSourceUi();
}

function liveAlignMic() {
  return alignMic || activeMic;
}

function liveAlignNowSec() {
  if (activeMedium?.id === 'vinyl') return vinylClock.now();
  const streaming = getStreamingClock?.();
  if (streaming) return streaming.now();
  if (session.clock?.now) return session.clock.now();
  return 0;
}

function stopLiveAlign() {
  clearTimeout(liveAlignTimer);
  liveAlignTimer = null;
  liveAlignBusy = false;
}

function scheduleLiveAlign() {
  if (!session.timeline || liveAlignBusy) return;
  if (!liveAlignMic()) return;
  const needsWords = needsVocalAlign(session.timeline, session.meta || {});
  // First collect a wide-window latency estimate. Once it locks, line-sync songs
  // continue into word refinement; catalog/cached word-sync remains timing-only.
  const autoNeedsSamples =
    autoTiming && !autoTimingSuspended && syncEstimator.suggestion() == null;
  const timingOnly = !needsWords || autoNeedsSamples;
  if (!timingOnly && !alignmentAvailable()) return;
  if (timingOnly && (!autoTiming || autoTimingSuspended)) return;

  // Word refinement and timing calibration have separate completion flags.
  const pending = session.timeline.lines.some(
    (l) =>
      (l.words?.length || 0) > 0 &&
      (timingOnly ? !l._timingMeasured : !l._vocalAligned)
  );
  if (!pending) {
    if (session.timeline.aligned) persistAlignedTiming();
    return;
  }

  clearTimeout(liveAlignTimer);
  liveAlignTimer = setTimeout(async () => {
    liveAlignBusy = true;
    try {
      if (!timingOnly) await warmAlignModel();
      const mic = liveAlignMic();
      if (!mic || !session.timeline) return;
      const res = await refineTimelineFromMic(session.timeline, mic, liveAlignNowSec(), {
        timingOnly,
        maxLines: timingOnly ? 3 : 2,
        expectedOffset: display.syncOffset || 0,
      });
      if (res?.aligned) {
        markAlignedBadge();
        persistAlignedTiming();
        updateSyncSourceUi();
      }
      if (res?.timingSamples?.length) ingestTimingSamples(res.timingSamples);
    } catch {
      /* keep syllable / richsync timing */
    }
    liveAlignBusy = false;
    // Keep chasing upcoming lines while this song is playing.
    if (session.timeline && stage.dataset.mode === 'playing') scheduleLiveAlign();
  }, 700);
}

// Find the selected song on Spotify, start it playing there, load its lyrics,
// and follow playback (also handles skips via the follow-poll).
async function startSpotifySong({ artist, track }) {
  // Drop any leftover local audio/lyrics so catalog miss never transcribes the wrong file.
  resetSongState();
  showBusy('Starting on Spotify', 'Finding the track and loading lyrics…');
  setStatus('loading', `Finding “${track}” on Spotify…`);
  $('btn-load').disabled = true;
  try {
    const found = await searchSpotifyTrack({ artist, track });
    if (!found) {
      setStatus('error', `Couldn’t find “${track}” on Spotify. Try adding the artist.`);
      return;
    }

    setStatus('loading', `Loading lyrics for “${found.name}”…`);
    // Lyrics + playback in parallel — don't serialize NetEase behind Spotify play
    // (that was the "song starts, lyrics never show" feel).
    let playErr = null;
    let [ok] = await Promise.all([
      prepareSong({
        artist: found.artist,
        track: found.name,
        album: found.album,
        duration: found.duration,
        id: found.id,
        spotifyId: found.id,
        quietMiss: true,
        allowTranscript: false, // never AI until every catalog/plain source misses
      }),
      playSpotifyTrack({ uri: found.uri, positionMs: 0 }).catch((err) => {
        playErr = err;
      }),
    ]);

    if (playErr) {
      // No device / not Premium — still show lyrics on the local demo clock if we have them.
      if (ok) await showLyricsWithoutPlayback(found, playErr.message, { alreadyPrepared: true });
      else setStatus('error', playErr.message || 'Couldn’t start Spotify playback.');
      return;
    }
    if (!ok) {
      // Every catalog + plain source missed — only then listen and generate AI lyrics.
      ok = await trySpotifyAiLyrics({
        artist: found.artist,
        track: found.name,
        album: found.album,
        duration: found.duration,
        id: found.id,
        spotifyId: found.id,
      });
      if (!ok) return;
    }

    primeTrack({ artist: found.artist, name: found.name });

    activeMedium = getMedium('spotify');
    await activeMedium.start({
      session,
      firstPollDelayMs: 1000, // let Spotify's currently-playing catch up to our track
      onError: (msg) => setStatus('error', msg),
      onStatus: (a, b) => (b != null ? setStatus(a || 'ok', b) : setStatus('ok', a)),
      onState: () => updatePlayBtn(),
      prepareSong: async (meta) => {
        // Fired when the user skips to another track — reload lyrics for it.
        const loaded = await prepareSongOrAi(meta);
        if (loaded) {
          enterPlaying();
          ensureVocalAlignment({ capture: true });
        }
        return loaded;
      },
    });
    const clock = getStreamingClock();
    if (clock) session.setClock(clock);

    enterPlaying();
    updateTransport();
    loadArtwork(found.artist, found.name);
    setStatus(
      'ok',
      session.meta?.source?.startsWith('ai-')
        ? 'Playing on Spotify — AI lyrics (from your speakers).'
        : 'Playing on Spotify — lyrics are following.'
    );
    updatePlayBtn();
    // Desktop: capture speakers/loopback/mic and force-align line timing → near word sync.
    ensureVocalAlignment({ capture: true });
  } catch (err) {
    setStatus('error', err.message || 'Couldn’t start playback on Spotify.');
    console.error('[Bar4Bar] Spotify play failed', err);
  } finally {
    hideBusy();
    $('btn-load').disabled = false;
  }
}

/**
 * Absolute last resort after every catalog/plain source missed on Spotify:
 * capture speakers/loopback for ~40–90s, run Whisper, install the timeline.
 * Callers must already have run a catalog-only prepareSong that returned false.
 */
async function trySpotifyAiLyrics(meta) {
  if (!transcriptionAvailable()) {
    setStatus(
      'error',
      `No lyrics found for “${meta.track}”. AI lyrics need the desktop app (npm start).`
    );
    return false;
  }
  if (alignSourceMode === 'off') {
    setStatus(
      'error',
      `No lyrics for “${meta.track}”. Turn Sync capture on (not Off) so Bar4Bar can hear Spotify.`
    );
    return false;
  }

  const duration = Number(meta.duration) || 180;
  const targetSec = Math.min(90, Math.max(40, Math.min(duration, 90)));
  const bufSec = Math.ceil(targetSec + 10);

  showBusy('Generating AI lyrics', `Listening to Spotify for ~${Math.round(targetSec)}s…`);
  setStatus(
    'loading',
    `No lyrics from any catalog — listening to generate AI lyrics (~${Math.round(targetSec)}s)…`
  );

  // Need a long contiguous buffer; replace any short align-only capture.
  stopAlignCapture();
  const res = await startBestCapture({
    mode: alignSourceMode,
    deviceId: alignSourceDeviceId,
    seconds: bufSec,
  });
  if (!res || res.error || !res.mic) {
    setStatus(
      'error',
      `No catalog lyrics. ${res?.error || 'Could not capture Spotify audio.'}`
    );
    return false;
  }
  alignMic = res.mic;
  alignCaptureOwned = true;
  alignCaptureLabel = res.label;
  alignCaptureError = '';
  updateSyncSourceUi();

  let songPosAtOnset = null;
  const clock = getStreamingClock?.();
  const wait = await waitForCaptureWindow(res.mic, {
    targetSec,
    timeoutSec: targetSec + 50,
    onProgress: (_heard, msg) => {
      if (res.mic.onsetAt != null && songPosAtOnset == null) {
        songPosAtOnset = typeof clock?.now === 'function' ? clock.now() : 0;
      }
      setStatus('loading', msg);
      showBusy('Generating AI lyrics', msg);
    },
  });

  if (!wait.ok) {
    setStatus('error', wait.reason || 'Couldn’t capture enough Spotify audio to transcribe.');
    return false;
  }
  if (songPosAtOnset == null) {
    songPosAtOnset =
      typeof clock?.now === 'function' ? Math.max(0, clock.now() - wait.heardSec) : 0;
  }

  const pcm = res.mic.getOrderedPcm();
  const result = await fetchTranscriptFromPcm({
    pcm,
    sampleRate: res.mic.sampleRate || 44100,
    offsetSec: songPosAtOnset,
    artist: meta.artist,
    track: meta.track,
    album: meta.album,
    duration: meta.duration,
    onStatus: setStatus,
    source: 'ai-spotify',
  });

  if (result?.error || result?.skipped || !(result?.timeline || result?.plain)) {
    setStatus(
      'error',
      `No catalog lyrics. Transcription failed: ${result?.error || result?.reason || 'no speech detected'}`
    );
    return false;
  }

  const loaded = session.applyResult(result, {
    artist: meta.artist,
    track: meta.track,
    album: meta.album,
    duration: meta.duration,
    id: meta.id || meta.spotifyId,
    spotifyId: meta.id || meta.spotifyId,
  });
  if (loaded) {
    applySongTimingOffset(session.meta, { quiet: true });
    showToast('AI lyrics from Spotify audio — nudge with [ ] if needed');
  }
  return loaded;
}

// Fallback when Spotify can't start playback: display lyrics on the demo clock.
async function showLyricsWithoutPlayback(found, reason, { alreadyPrepared = false } = {}) {
  if (!alreadyPrepared) {
    const ok = await prepareSong({
      artist: found.artist,
      track: found.name,
      album: found.album,
      duration: found.duration,
    });
    if (!ok) return;
  }
  activeMedium = null;
  enterPlaying();
  updateTransport();
  session.setClock(demoClock);
  demoClock.start(0);
  loadArtwork(found.artist, found.name);
  updatePlayBtn();
  setStatus('error', `${reason} Showing lyrics without playback — press Play to preview.`);
}

$('search').addEventListener('submit', (e) => {
  e.preventDefault();
  if (suggestionIndex >= 0 && suggestionItems[suggestionIndex]) {
    const s = suggestionItems[suggestionIndex];
    loadSong({ artist: s.artist, track: s.track, duration: s.duration });
    return;
  }
  loadSong({
    artist: $('in-artist').value.trim(),
    track: $('in-track').value.trim(),
  });
});

// ----------------------- live search suggestions -------------------------
function hideSuggestions() {
  const box = $('suggestions');
  box.hidden = true;
  box.innerHTML = '';
  suggestionItems = [];
  suggestionIndex = -1;
}

function renderSuggestions(items) {
  const box = $('suggestions');
  suggestionItems = items;
  suggestionIndex = -1;
  if (!items.length) {
    hideSuggestions();
    return;
  }
  box.hidden = false;
  box.innerHTML = items
    .map(
      (s, i) => `
    <button type="button" class="suggestion" role="option" data-i="${i}" aria-selected="false">
      ${s.artwork ? `<img src="${s.artwork}" alt="" width="40" height="40" loading="lazy" />` : '<span class="sync-icon">♪</span>'}
      <span class="t"><b>${escapeHtml(s.track)}</b><span>${escapeHtml(s.artist)}</span></span>
    </button>`
    )
    .join('');
  box.querySelectorAll('.suggestion').forEach((btn) => {
    btn.addEventListener('click', () => {
      const s = suggestionItems[+btn.dataset.i];
      if (s) loadSong({ artist: s.artist, track: s.track, duration: s.duration });
    });
  });
}

function scheduleSuggest() {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(async () => {
    const q = [$('in-track').value, $('in-artist').value].filter(Boolean).join(' ').trim();
    if (q.length < 2) {
      hideSuggestions();
      return;
    }
    const items = await searchSuggestions(q);
    if (document.activeElement === $('in-track') || document.activeElement === $('in-artist')) {
      renderSuggestions(items);
    }
  }, 220);
}

$('in-track').addEventListener('input', scheduleSuggest);
$('in-artist').addEventListener('input', scheduleSuggest);
$('in-track').addEventListener('keydown', onSuggestKey);
$('in-artist').addEventListener('keydown', onSuggestKey);
document.addEventListener('click', (e) => {
  if (!$('search').contains(e.target)) hideSuggestions();
});

function onSuggestKey(e) {
  if ($('suggestions').hidden || !suggestionItems.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    suggestionIndex = Math.min(suggestionItems.length - 1, suggestionIndex + 1);
    highlightSuggestion();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    suggestionIndex = Math.max(0, suggestionIndex - 1);
    highlightSuggestion();
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
}

function highlightSuggestion() {
  $('suggestions').querySelectorAll('.suggestion').forEach((el, i) => {
    el.setAttribute('aria-selected', i === suggestionIndex ? 'true' : 'false');
  });
}

// --------------------------- recommendations -----------------------------
function renderRecGrid(el, items, emptyMsg) {
  if (!items?.length) {
    el.innerHTML = `<div class="recs-empty">${emptyMsg}</div>`;
    return;
  }
  el.innerHTML = items
    .map(
      (s, i) => `
    <button type="button" class="rec" data-i="${i}">
      ${s.artwork ? `<img src="${s.artwork}" alt="" width="42" height="42" loading="lazy" />` : '<span class="sync-icon">♪</span>'}
      <span class="meta"><b>${escapeHtml(s.track)}</b><span>${escapeHtml(s.artist)}</span></span>
    </button>`
    )
    .join('');
  el.querySelectorAll('.rec').forEach((btn) => {
    btn.addEventListener('click', () => {
      const s = items[+btn.dataset.i];
      if (s) loadSong({ artist: s.artist, track: s.track, duration: s.duration });
    });
  });
}

async function loadChartRecs() {
  const items = await fetchChartRecommendations();
  renderRecGrid($('chart-recs'), items, 'Couldn’t load recommendations. Search for a song above.');
}

async function refreshSpotifyPanel() {
  const panel = $('spotify-panel');
  const btn = $('btn-spotify');
  const token = loadToken('spotify');

  if (token) {
    btn.classList.add('connected');
    $('spotify-label').textContent = 'Spotify connected';
    $('spotify-hint').textContent = 'Tap to follow playback';
    const [recent, now] = await Promise.all([
      fetchSpotifyRecentlyPlayed(token.access_token),
      fetchSpotifyNowPlaying(token.access_token),
    ]);
    const forGrid = [];
    if (now?.track) forGrid.push(now);
    for (const r of recent) {
      if (!forGrid.some((x) => x.track === r.track && x.artist === r.artist)) forGrid.push(r);
    }
    // Only reveal the panel when there's something to show — an empty header +
    // "Follow now playing" chip with no cards just leaves a void in the menu.
    if (forGrid.length) {
      renderRecGrid($('spotify-recs'), forGrid, '');
      panel.hidden = false;
    } else {
      panel.hidden = true;
    }
  } else {
    btn.classList.remove('connected');
    $('spotify-label').textContent = 'Connect Spotify';
    $('spotify-hint').textContent = 'Follow what’s playing';
    panel.hidden = true;
  }
}

// --------------------------- lyrics file ---------------------------------
$('btn-lyrics').addEventListener('click', () => $('lyrics-file').click());
$('lyrics-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  pendingLyricsFile = file;
  session.setLyricsFile(file);
  const parsed = parseLyricsFilename(file.name);
  if (parsed.track && !$('in-track').value.trim()) $('in-track').value = parsed.track;
  if (parsed.artist && !$('in-artist').value.trim()) $('in-artist').value = parsed.artist;
  if (pendingAudioFile && basenamesMatch(file.name, pendingAudioFile.name)) {
    setStatus('ok', `Lyrics paired with ${pendingAudioFile.name}. Load to sync.`);
    return;
  }
  setStatus('ok', `Lyrics file ready: ${file.name}. Load to preview.`);
});

// --------------------------- audio file ----------------------------------
$('btn-audio').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  pendingAudioFile = file;
  audio.src = URL.createObjectURL(file);
  haveAudio = true;
  session.setAudioFile(file);
  display.setClock(mediaClock);
  updateTransport();
  // Prefetch the ~90 MB aligner model now (desktop) so it's ready by the time the
  // user hits Load — forced alignment then starts immediately instead of stalling.
  // Also warm the vocal-separation model (no-op unless one is configured).
  if (alignmentAvailable()) {
    warmAlignModel();
    warmSeparationModel();
  }

  const tags = await readAudioTags(file);
  session.setAudioFile(file, tags);
  if (tags?.track) $('in-track').value = tags.track;
  if (tags?.artist) $('in-artist').value = tags.artist;

  if (!pendingLyricsFile && $('lyrics-file').files?.length) {
    const paired = [...$('lyrics-file').files].find((f) => basenamesMatch(f.name, file.name));
    if (paired) {
      pendingLyricsFile = paired;
      session.setLyricsFile(paired, { auto: true });
      setStatus('ok', `Audio + lyrics paired: ${file.name}`);
      return;
    }
  }

  setStatus('ok', `Audio ready: ${file.name}. Load to sync — if no lyrics exist, it’ll transcribe.`);
  $('in-track').focus();
});

// ------------------------------ transport --------------------------------
$('btn-play').addEventListener('click', togglePlay);
$('btn-prev')?.addEventListener('click', () => spotifySkip(spotifyPreviousTrack, 'Loading previous track…'));
$('btn-next')?.addEventListener('click', () => spotifySkip(spotifyNextTrack, 'Loading next track…'));

function togglePlay() {
  if (stage.dataset.mode !== 'playing' || activeMedium?.id === 'vinyl') return;
  if (activeMedium?.id === 'spotify') {
    spotifyTogglePlayback()
      .then(updatePlayBtn)
      .catch((e) => setStatus('error', e.message || 'Spotify control failed.'));
    return;
  }
  if (haveAudio) {
    audio.paused ? audio.play() : audio.pause();
  } else {
    demoClock.isPlaying() ? demoClock.pause() : demoClock.start(demoClock.now());
    updatePlayBtn();
  }
}

// Skip to next/previous on Spotify; the follow-poll picks up the new track and
// reloads its lyrics automatically.
async function spotifySkip(fn, msg) {
  if (activeMedium?.id !== 'spotify') return;
  try {
    setStatus('loading', msg);
    await fn();
  } catch (e) {
    setStatus('error', e.message || 'Spotify control failed.');
  }
}

// Show the prev/next buttons only when Spotify is the active, controllable medium.
function updateTransport() {
  const spotify = activeMedium?.id === 'spotify';
  if ($('btn-prev')) $('btn-prev').hidden = !spotify;
  if ($('btn-next')) $('btn-next').hidden = !spotify;
  // Practice 0.8× only makes sense when we own the <audio> element.
  if ($('btn-practice')) $('btn-practice').hidden = !haveAudio;
  if ($('practice-row')) $('practice-row').hidden = !haveAudio;
  if (!haveAudio && practiceSlow) setPracticeSlow(false, { quiet: true });
}

function updatePlayBtn() {
  const vinylActive = activeMedium?.id === 'vinyl';
  const spotifyActive = activeMedium?.id === 'spotify';
  const playing = vinylActive
    ? true
    : spotifyActive
      ? isSpotifyPlaying()
      : haveAudio
        ? !audio.paused
        : demoClock.isPlaying();
  let label = playing ? 'Pause' : 'Play';
  if (vinylActive && activeMedium?.state === 'locked') {
    label = vinylClock.isPlaying() ? 'Following' : 'Paused';
  } else if (vinylActive) {
    label = 'Listening';
  }
  $('btn-play').textContent = label;
}
audio.addEventListener('play', updatePlayBtn);
audio.addEventListener('pause', updatePlayBtn);

$('btn-change').addEventListener('click', () => {
  enterSetup();
  resetSongState();
  setStatus('', '');
});

// --------------------- sync source (how the aligner listens) ---------------
const SYNC_MODE_LABELS = {
  auto: 'Auto',
  system: 'System audio',
  device: 'Input device',
  off: 'Off',
};

// ------------------- dismissible popups (×, outside click, Esc) ------------
// Any element with data-close="<panel id>" hides that panel. The vinyl listen
// overlay is driven by a RAF loop, so closing it also sets a dismissed flag the
// loop respects (it un-dismisses on the next Listen session).
function closePanel(id) {
  const panel = $(id);
  if (!panel || panel.hidden) return false;
  panel.hidden = true;
  if (id === 'listen-panel') listenPanelDismissed = true;
  return true;
}

/** Close whichever dismissible popup is open. Returns true if one closed. */
function closeAnyOpenPopup() {
  if (!$('suggestions').hidden) {
    hideSuggestions();
    return true;
  }
  return closePanel('sync-panel') || closePanel('listen-panel');
}

document.addEventListener('click', (e) => {
  const closer = e.target.closest?.('[data-close]');
  if (closer) {
    closePanel(closer.dataset.close);
    return;
  }
  // Click outside the sync panel (and not on its toggle button) dismisses it.
  const syncPanel = $('sync-panel');
  if (!syncPanel.hidden && !syncPanel.contains(e.target) && e.target !== $('btn-sync-source')) {
    syncPanel.hidden = true;
  }
});

$('btn-sync-source').addEventListener('click', () => {
  const panel = $('sync-panel');
  if (panel.hidden) openSyncPanel();
  else panel.hidden = true;
});

async function openSyncPanel() {
  const panel = $('sync-panel');
  const sourceSel = $('sync-source');
  sourceSel.innerHTML = '';
  for (const [id, label] of Object.entries(SYNC_MODE_LABELS)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent =
      id === 'auto'
        ? 'Auto — loopback → mic → system tap'
        : id === 'system'
          ? 'System audio (internal tap, no noise)'
          : id === 'device'
            ? 'Specific input device'
            : 'Off — keep line sync';
    if (id === alignSourceMode) opt.selected = true;
    sourceSel.appendChild(opt);
  }
  await populateSyncDevices();
  panel.hidden = false;
  // If a song is already playing and we're not capturing, start now (don't wait
  // for the next track) — this is the usual "why isn't it capturing?" fix.
  if (
    alignSourceMode !== 'off' &&
    stage.dataset.mode === 'playing' &&
    !alignMic &&
    !activeMic &&
    activeMedium?.id !== 'vinyl' &&
    session.timeline
  ) {
    const needs = needsVocalAlign(session.timeline, session.meta || {});
    // Only auto-retry when alignment is still needed, or the last attempt failed.
    if (needs || alignCaptureError) {
      await ensureVocalAlignment({ capture: true, forceCapture: true });
    }
  }
  updateTimingReadout();
  updateSyncSourceUi();
  refreshVocalIsolationUi();
}

// Show the vocal-isolation toggle only when a separation model is configured in
// the desktop app; otherwise it's meaningless, so keep it hidden.
async function refreshVocalIsolationUi() {
  const row = $('vocal-isolation-row');
  const box = $('vocal-isolation');
  const state = $('vocal-isolation-state');
  if (!row || !box) return;
  let available = false;
  try {
    available = !!(await window.bar4bar?.separateAvailable?.());
  } catch {
    available = false;
  }
  row.hidden = !available;
  const hudRow = $('sep-hud-row');
  const hudBox = $('sep-hud-toggle');
  if (hudRow) hudRow.hidden = !available;
  if (!available) return;
  box.checked = vocalIsolation;
  if (state) state.textContent = vocalIsolation ? 'on — cleaner alignment' : 'off';
  if (hudBox) hudBox.checked = sepHudEnabled;
}

async function populateSyncDevices() {
  const row = $('sync-device-row');
  const sel = $('sync-device');
  row.hidden = alignSourceMode !== 'device';
  if (row.hidden) return;
  const inputs = await listInputDevices();
  sel.innerHTML = '';
  const loop = findLoopbackDevice(inputs);
  for (const d of inputs) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = (d.label || 'Audio input') + (loop && d.deviceId === loop.deviceId ? ' · loopback' : '');
    if (d.deviceId === alignSourceDeviceId) opt.selected = true;
    sel.appendChild(opt);
  }
}

$('sync-source').addEventListener('change', async (e) => {
  alignSourceMode = e.target.value;
  localStorage.setItem('bar4bar.alignSource', alignSourceMode);
  await populateSyncDevices();
  restartAlignCapture();
});

$('sync-device').addEventListener('change', (e) => {
  alignSourceDeviceId = e.target.value || null;
  if (alignSourceDeviceId) localStorage.setItem('bar4bar.alignDevice', alignSourceDeviceId);
  else localStorage.removeItem('bar4bar.alignDevice');
  restartAlignCapture();
});

/** Apply a source change immediately if a song is playing. */
function restartAlignCapture() {
  stopAlignCapture();
  stopLiveAlign();
  alignCaptureError = '';
  if (alignSourceMode !== 'off' && stage.dataset.mode === 'playing' && activeMedium?.id !== 'vinyl') {
    ensureVocalAlignment({ capture: true, forceCapture: true });
  }
  updateSyncSourceUi();
}

/** Reflect the current source on the now-bar button + panel status line. */
function updateSyncSourceUi() {
  const btn = $('btn-sync-source');
  if (btn) {
    const mode = SYNC_MODE_LABELS[alignSourceMode] || 'Auto';
    btn.textContent = `Sync: ${alignMic || activeMic ? alignCaptureLabel || mode : mode}`;
  }
  const status = $('sync-capture-status');
  if (!status) return;

  const playing = stage.dataset.mode === 'playing';
  const wordSync = isWordSyncFormat(session.meta?.format);
  const alreadyAligned = !!session.timeline?.aligned;

  if (alignSourceMode === 'off') {
    status.textContent = 'Vocal alignment off — using provider timing.';
    status.classList.remove('ok');
  } else if (alignMic || activeMic) {
    const hearing = (alignMic || activeMic).level > 0.01;
    status.textContent = `Capturing: ${alignCaptureLabel || 'input'}${hearing ? ' — hearing audio' : ' — silent so far'}`;
    status.classList.toggle('ok', hearing);
  } else if (alignCaptureError) {
    status.textContent = alignCaptureError;
    status.classList.remove('ok');
  } else if (!playing) {
    status.textContent = 'Not capturing — starts when a song is playing.';
    status.classList.remove('ok');
  } else if (wordSync && !needsVocalAlign(session.timeline, session.meta || {})) {
    status.textContent = 'Not capturing — this song already has catalog word sync.';
    status.classList.remove('ok');
  } else if (alreadyAligned && !needsVocalAlign(session.timeline, session.meta || {})) {
    status.textContent = 'Not capturing — timings already vocal-aligned (cached).';
    status.classList.remove('ok');
  } else {
    status.textContent = 'Not capturing — open Sync again or pick a device to retry.';
    status.classList.remove('ok');
  }
}

// Keep the status line honest while the panel is open.
setInterval(() => {
  if (!$('sync-panel')?.hidden) updateSyncSourceUi();
}, 1200);

// ----------------------------- vinyl listen --------------------------------
$('btn-listen').addEventListener('click', toggleListen);
$('listen-input').addEventListener('change', (e) => {
  selectedInputDeviceId = e.target.value || null;
  // Re-open the mic on the chosen device without leaving the listen screen.
  if (activeMedium?.id === 'vinyl') {
    stopActiveMedium();
    startVinylListen();
  }
});

async function toggleListen() {
  if (activeMedium?.id === 'vinyl') {
    stopActiveMedium();
    enterSetup();
    return;
  }
  startVinylListen();
}

// Populate the input-device dropdown. Labels are only available after mic
// permission has been granted (which mic.start() does), so call it after start.
async function populateInputDevices() {
  const sel = $('listen-input');
  const row = $('listen-input-row');
  if (!sel || !navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    if (!inputs.length) {
      row.hidden = true;
      return;
    }
    sel.innerHTML = '';
    for (const d of inputs) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || 'Audio input';
      if (d.deviceId === selectedInputDeviceId) opt.selected = true;
      sel.appendChild(opt);
    }
    row.hidden = false;
  } catch {
    row.hidden = true;
  }
}

async function startVinylListen() {
  const medium = getMedium('vinyl');
  if (!medium?.canUse()) {
    setStatus('error', 'Auto-detect needs the desktop app (run: npm start). It uses the mic + fingerprinting.');
    return;
  }
  // Vinyl identifies the song from the mic — clear attached files so old lyrics
  // don't override what the fingerprint detects.
  resetSongState();

  // Prefer ACRCloud (ambient recognition) when it's configured in .env.
  let useAmbient = false;
  try {
    const cfg = await window.bar4bar.getConfig?.();
    useAmbient = !!cfg?.acrCloud;
  } catch {
    /* fall back to AcoustID */
  }

  let mic;
  try {
    mic = new Mic({ deviceId: selectedInputDeviceId });
    await mic.start();
  } catch {
    setStatus('error', 'Could not access the audio input. Check permissions and try again.');
    return;
  }

  $('np-title').textContent = 'Listening…';
  $('np-artist').textContent = 'Start the record';
  $('cover').style.backgroundImage = '';
  enterPlaying();
  $('btn-play').textContent = 'Listening';
  startListenMeter(mic);
  populateInputDevices();

  activeMedium = medium;
  await medium.start({
    session,
    vinylClock,
    mic,
    useAmbient,
    onStatus: setStatus,
    prepareSong: async (meta) => {
      const ok = await prepareSong(meta);
      if (ok) {
        enterPlaying();
        warmAlignModel();
        scheduleLiveAlign();
      }
      return ok;
    },
    onState: (s) => {
      if (s === 'locked') $('btn-play').textContent = 'Following';
      else if (s === 'listening') {
        $('btn-play').textContent = 'Listening';
        $('np-title').textContent = 'Listening…';
        $('np-artist').textContent = 'Start the record near the mic';
      }
    },
    onResult: (r) => {
      lastListenResult = r;
      if (r.reason === 'error') setStatus('error', r.detail || 'Fingerprint error');
      if (r.reason === 'match' && medium.state === 'locked') scheduleLiveAlign();
    },
  });
}

// --------------------------- streaming -----------------------------------
$('btn-spotify')?.addEventListener('click', () => connectStreaming('spotify'));
$('btn-apple')?.addEventListener('click', () => connectStreaming('appleMusic'));
$('btn-spotify-follow')?.addEventListener('click', () => connectStreaming('spotify'));

async function connectStreaming(id) {
  stopActiveMedium();
  // Streaming follow drives identity from the service — drop any attached local
  // audio/lyrics files so they don't leak into the followed track's lyrics.
  resetSongState();
  const medium = getMedium(id);

  // Always refresh config from Electron / config.js before Spotify (Electron
  // injects env after load; stale empty __SL_CONFIG__ was a silent no-op).
  if (window.bar4bar?.getConfig) {
    try {
      window.__SL_CONFIG__ = await window.bar4bar.getConfig();
    } catch {
      /* keep existing */
    }
  }
  const cfg = window.__SL_CONFIG__ || {};

  if (id === 'spotify') {
    if (!cfg.spotifyClientId) {
      setStatus(
        'error',
        'Spotify Client ID missing. Set SPOTIFY_CLIENT_ID in .env (desktop) or Vercel env, then fully quit and restart.'
      );
      return;
    }
    try {
      if (!loadToken('spotify')) {
        showBusy('Connecting to Spotify', 'Sign in on the browser tab that just opened, then come back here.');
        setStatus('loading', 'Opening Spotify login in your browser…');
        const loggedIn = await beginSpotifyLogin();
        if (!loggedIn) {
          // Browser redirect — leave busy up briefly; page will unload.
          showBusy('Redirecting to Spotify', 'Continue in your browser…');
          return;
        }
        setStatus('ok', 'Spotify connected.');
        await refreshSpotifyPanel();
      } else {
        // Already connected: follow in the background. No modal — the setup
        // screen stays usable so the user can also just pick a song here.
        setStatus('loading', 'Following Spotify playback…');
      }
    } catch (err) {
      hideBusy();
      setStatus('error', err.message || 'Spotify login failed.');
      console.error('[Bar4Bar] Spotify connect failed', err);
      return;
    }
  } else if (!cfg.appleMusicDeveloperToken && !medium?.canUse()) {
    setStatus('error', 'Add APPLE_MUSIC_DEVELOPER_TOKEN to .env and restart.');
    return;
  }

  if (!medium) {
    hideBusy();
    setStatus('error', `Unknown medium: ${id}`);
    return;
  }

  activeMedium = medium;
  // Stay on the setup screen while waiting for playback. Jumping to the lyric
  // view now would hide search + recommendations and strand the user on an empty
  // "Following…" screen with no way to start a song. The follow-poll runs in the
  // background; the first detected track flips us to the playing view (below).
  hideBusy();
  try {
    const connected = await medium.start({
      session,
      onError: (msg) => {
        hideBusy();
        setStatus('error', msg);
      },
      onStatus: (a, b) => {
        // Mediums pass either (msg) or (type, msg)
        if (b != null) setStatus(a || 'ok', b);
        else setStatus('ok', a);
      },
      onState: () => updatePlayBtn(),
      prepareSong: async (meta) => {
        const loaded = await prepareSongOrAi(meta);
        if (loaded) {
          hideBusy();
          enterPlaying();
          ensureVocalAlignment({ capture: true });
        }
        return loaded;
      },
    });
    if (connected === false) {
      setStatus('error', `Could not start ${medium.label} follow. Try connecting again.`);
      stopActiveMedium();
      return;
    }
    setStatus(
      'ok',
      id === 'spotify'
        ? 'Following Spotify — play a song on any device, or pick one below.'
        : 'Following — start playback, or pick a song below.'
    );
  } catch (err) {
    hideBusy();
    setStatus('error', err.message || 'Failed to start streaming.');
    console.error(err);
    stopActiveMedium();
    return;
  }
  hideBusy();
  await refreshSpotifyPanel();
}

async function bootAuth() {
  try {
    if (await completeSpotifyLoginFromUrl()) {
      setStatus('ok', 'Spotify connected.');
    }
  } catch (err) {
    setStatus('error', err.message || 'Spotify login failed.');
  }
}

// --------------------------- projector -----------------------------------
$('btn-projector')?.addEventListener('click', async () => {
  if (!window.bar4bar?.openProjector) {
    window.open('overlay.html', '_blank', 'noopener');
    setStatus('ok', 'Overlay opened — use OBS Browser Source on overlay.html for streaming.');
    return;
  }
  const displays = await window.bar4bar.getDisplays();
  const external = displays.find((d) => !d.primary) || displays[0];
  await window.bar4bar.openProjector(external?.id);
  setStatus('ok', `Projector opened on ${external?.label || 'display'}.`);
});

// ---------------------- language aid (T cycles) ---------------------------
// Off → Pronunciation (romanized) → English (translated) → Off. Both are filled
// on demand via the free Google endpoint (romanization also comes pre-aligned
// from NetEase for JP/KO/ZH); we only offer modes that apply to the song.
const AID_LABELS = { off: 'Lyrics only', roman: 'Pronunciation', english: 'English translation' };
let translating = false;
let romanizing = false;

const lineText = (l) => l.words.map((w) => w.text).join(' ');

// English meaning for each line (cached on line.english).
async function ensureEnglish() {
  const lines = session.timeline?.lines || [];
  if (!lines.length || lines.some((l) => l.english) || translating) return;
  translating = true;
  showToast('Translating…');
  const out = await translateLines(lines.map(lineText), { to: 'en' });
  translating = false;
  if (out) {
    lines.forEach((l, i) => (l.english = out[i] || ''));
    display.refreshAid();
  } else {
    showToast('Couldn’t translate right now');
  }
}

// Romanized pronunciation for non-Latin lyrics (cached on line.roman). NetEase
// may already have supplied line.roman at load; this fills the rest (e.g. Hindi).
async function ensureRoman() {
  const lines = session.timeline?.lines || [];
  if (!lines.length || lines.some((l) => l.roman) || romanizing) return;
  romanizing = true;
  showToast('Romanizing…');
  const out = await romanizeLines(lines.map(lineText));
  romanizing = false;
  if (out && out.some(Boolean)) {
    lines.forEach((l, i) => (l.roman = out[i] || ''));
    display.refreshAid();
  } else {
    showToast('No pronunciation available');
  }
}

async function cycleAid() {
  if (stage.dataset.mode !== 'playing') return;
  const lines = session.timeline?.lines || [];
  if (!lines.length) return;
  // Pronunciation applies when NetEase gave us a romanization OR the lyrics are a
  // non-Latin script we can romanize on the fly (Hindi, Arabic, Cyrillic, …).
  const romanApplies = display.aidAvailability().roman || needsRomanization(lines.map(lineText));
  const order = ['off'];
  if (romanApplies) order.push('roman');
  order.push('english'); // always available — translated on demand
  const next = order[(order.indexOf(display.aidMode || 'off') + 1) % order.length];
  if (next === 'roman') await ensureRoman();
  if (next === 'english') await ensureEnglish();
  display.setAidMode(next);
  showToast(AID_LABELS[next]);
}

// ------------------------------ sync nudge --------------------------------
// Live fine-tune of lyric timing so highlighting lands on the beat. The right
// value depends on the user's speakers / device / stream path, so it's tunable
// on the fly ( [ = later, ] = earlier, \ = reset ) and persisted by Display.
let syncToastTimer;
function showToast(text) {
  let el = $('sync-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sync-toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(syncToastTimer);
  syncToastTimer = setTimeout(() => el.classList.remove('show'), 1400);
}
function showSyncToast(offset) {
  const ms = Math.round(offset * 1000);
  const dir = ms > 0 ? 'earlier' : ms < 0 ? 'later' : 'on time';
  showToast(ms === 0 ? 'Sync reset (on time)' : `Sync ${ms > 0 ? '+' : ''}${ms}ms (lyrics ${dir})`);
  updateTimingReadout();
}

/** Live ms readout in the Sync panel (+ = lyrics earlier than the clock). */
function updateTimingReadout() {
  const el = $('timing-readout');
  if (el) {
    const ms = Math.round((display.syncOffset || 0) * 1000);
    const src = display.syncOffsetSource;
    const tag =
      src === 'auto'
        ? ' · auto'
        : src === 'track'
          ? ' · this song'
          : src === 'device'
            ? ' · usual'
            : src === 'manual'
              ? ' · tuned'
              : '';
    el.textContent = (ms === 0 ? '0 ms' : `${ms > 0 ? '+' : ''}${ms} ms`) + tag;
    el.title =
      ms === 0
        ? 'On time with the clock'
        : ms > 0
          ? 'Lyrics show earlier (helps when highlight feels late)'
          : 'Lyrics show later (helps when highlight feels early)';
  }
  const toggle = $('auto-timing');
  if (toggle) toggle.checked = autoTiming;
  const lock = syncLockState(syncEstimator, {
    autoOn: autoTiming,
    suspended: autoTimingSuspended,
  });
  display.setSyncLock(lock);
  const hint = $('auto-timing-state');
  if (hint) {
    hint.textContent =
      lock === 'off'
        ? ''
        : lock === 'manual'
          ? 'paused (you tuned it)'
          : lock === 'locked'
            ? 'locked on'
            : lock === 'converging'
              ? 'converging…'
              : 'listening…';
  }
  renderDrift(
    driftReadout({
      measuredSec: syncEstimator.value,
      appliedOffsetSec: display.syncOffset || 0,
      confidence: syncEstimator.confidence,
      count: syncEstimator.count,
    })
  );
}

// Real-time drift meter: how closely the highlight is landing on the vocal now.
// The now-bar chip is silent until the aligner locks, then shows "in sync" or the
// live early/late error; the sync panel shows the full status incl. "listening".
function renderDrift(d) {
  const readout = $('drift-readout');
  if (readout) {
    readout.textContent =
      d.status === 'insync'
        ? '◉ In sync — highlight is landing on the vocal'
        : d.status === 'late'
          ? `▲ Lyrics ${d.magnitudeMs}ms behind the vocal`
          : d.status === 'early'
            ? `▼ Lyrics ${d.magnitudeMs}ms ahead of the vocal`
            : d.status === 'listening'
              ? 'Listening for the vocal…'
              : '';
  }
  const chip = $('drift-chip');
  if (chip) {
    const show = d.status === 'insync' || d.status === 'late' || d.status === 'early';
    chip.hidden = !show;
    chip.classList.toggle('drift-ok', d.status === 'insync');
    chip.classList.toggle('drift-off', d.status === 'late' || d.status === 'early');
    chip.textContent =
      d.status === 'insync'
        ? '◉ In sync'
        : d.status === 'late'
          ? `▲ ${d.magnitudeMs}ms late`
          : d.status === 'early'
            ? `▼ ${d.magnitudeMs}ms early`
            : '';
  }
}

// Live vocal-separation HUD (Phase 3a): shows the realtime factor (is MDX keeping
// up with playback?) and how many lines aligned on a stem vs the raw mix. Stays
// hidden until separation actually runs (Electron + a configured model).
function renderLiveSep(s) {
  const hud = $('live-sep-hud');
  if (!hud) return;
  // Toggled off in the Sync menu → never show.
  if (!sepHudEnabled) {
    hud.hidden = true;
    return;
  }
  hud.hidden = false;
  // Enabled but nothing separated yet → a faint "on" chip so it's confirmable at a glance.
  if (!s || (s.sepCount === 0 && !s.separating)) {
    hud.className = 'hud-idle';
    hud.textContent = '◌ separation HUD on';
    return;
  }
  // Immediate feedback before the first separation finishes.
  if (s.sepCount === 0 && s.separating) {
    hud.className = 'hud-ok';
    hud.textContent = '◐ isolating vocal…';
    return;
  }
  const rt = s.lastRealtime;
  const avg = s.sepTotalSec > 0 ? s.sepTotalWindowSec / s.sepTotalSec : null;
  const total = s.stemLines + s.rawLines;
  const keepUp = rt == null || rt >= 1;
  hud.className = keepUp ? 'hud-ok' : 'hud-warn';
  hud.textContent =
    (s.separating ? '◐ ' : '◉ ') +
    `sep ${rt != null ? rt.toFixed(1) : '—'}×` +
    (avg != null ? ` (avg ${avg.toFixed(1)}×)` : '') +
    ` · stem ${s.stemLines}/${total}`;
}
onLiveSepStat(renderLiveSep);
renderLiveSep(liveSeparationStats()); // reflect the toggle on load

function applyTimingNudge(deltaSec) {
  // Manual control wins for this song; auto stops fighting the user.
  autoTimingSuspended = true;
  showSyncToast(display.nudgeSyncOffset(deltaSec, persistCurrentTiming));
}

/**
 * One-tap recal from singer feel.
 * `late`  → highlight lagging the voice → show lyrics earlier (+)
 * `early` → highlight ahead of the voice → show lyrics later (−)
 */
function applyFeelRecal(sense) {
  const late = sense !== 'early';
  const delta = late ? RECAL_NUDGE : -RECAL_NUDGE;
  autoTimingSuspended = false; // let auto keep refining from here
  const next = display.nudgeSyncOffset(delta, (v) => persistCurrentTiming(v, { fromLock: true }));
  syncEstimator.addSample({
    value: next,
    weight: 1.8,
    score: 0.9,
    source: late ? 'recal-late' : 'recal-early',
  });
  const ms = Math.round(Math.abs(delta) * 1000);
  showToast(
    late
      ? `Caught up (+${ms}ms) — learning this delay`
      : `Pulled back (−${ms}ms) — learning this lead`
  );
  updateTimingReadout();
}

function setPracticeSlow(on, { quiet = false } = {}) {
  practiceSlow = !!on && haveAudio;
  if (haveAudio) audio.playbackRate = practiceSlow ? PRACTICE_RATE : 1;
  else if (audio) audio.playbackRate = 1;
  const btn = $('btn-practice');
  if (btn) {
    btn.hidden = !haveAudio;
    btn.setAttribute('aria-pressed', practiceSlow ? 'true' : 'false');
    btn.textContent = practiceSlow ? '0.8× on' : '0.8×';
  }
  const row = $('practice-row');
  if (row) row.hidden = !haveAudio;
  const box = $('practice-slow');
  if (box) box.checked = practiceSlow;
  if (!quiet && haveAudio) {
    showToast(practiceSlow ? 'Practice mode — Esc or “Exit 0.8×” to leave' : 'Normal speed');
  }
  updateModeExits();
  return practiceSlow;
}

function syncSingerLeadUi() {
  const ms = Math.round((display.singerLead || 0) * 1000);
  const slider = $('singer-lead');
  const readout = $('singer-lead-readout');
  if (slider && Number(slider.value) !== ms) slider.value = String(ms);
  if (readout) readout.textContent = `${ms} ms`;
}

function syncFocusUi() {
  const btn = $('btn-focus');
  if (!btn) return;
  btn.setAttribute('aria-pressed', display.focusMode ? 'true' : 'false');
  btn.textContent = display.focusMode ? 'Focus on' : 'Focus';
  updateModeExits();
}

/** Corner chips so focus/practice/reading are always escapable (nowbar may be hidden). */
function updateModeExits() {
  const host = $('mode-exits');
  if (!host) return;
  const chips = [];
  if (display.focusMode) {
    chips.push({ id: 'exit-focus', label: 'Exit focus · Esc', action: 'focus' });
  }
  if (display.readingMode) {
    chips.push({ id: 'exit-reading', label: 'Exit reading · Esc', action: 'reading' });
  }
  if (practiceSlow) {
    chips.push({ id: 'exit-practice', label: 'Exit 0.8× · Esc', action: 'practice' });
  }
  const sig = chips.map((c) => c.id).join('|');
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  host.innerHTML = '';
  for (const chip of chips) {
    const b = document.createElement('button');
    b.type = 'button';
    b.id = chip.id;
    b.dataset.exit = chip.action;
    b.textContent = chip.label;
    host.appendChild(b);
  }
}

function exitOverlayMode(which) {
  if (which === 'focus' && display.focusMode) {
    display.setFocusMode(false);
    syncFocusUi();
    showToast('Full lyric view');
    return true;
  }
  if (which === 'reading' && display.readingMode) {
    display.toggleReadingMode(false);
    updateModeExits();
    showToast('Follow mode');
    return true;
  }
  if (which === 'practice' && practiceSlow) {
    setPracticeSlow(false);
    updateModeExits();
    return true;
  }
  return false;
}

/** Peel one overlay mode; returns true if something was exited. */
function exitTopOverlayMode() {
  if (display.focusMode) return exitOverlayMode('focus');
  if (display.readingMode) return exitOverlayMode('reading');
  if (practiceSlow) return exitOverlayMode('practice');
  return false;
}

$('btn-timing-early')?.addEventListener('click', () => applyTimingNudge(0.025));
$('btn-timing-late')?.addEventListener('click', () => applyTimingNudge(-0.025));
$('btn-recal')?.addEventListener('click', () => applyFeelRecal('late'));
$('btn-recal-early')?.addEventListener('click', () => applyFeelRecal('early'));
$('btn-focus')?.addEventListener('click', () => {
  const on = display.toggleFocusMode();
  syncFocusUi();
  showToast(on ? 'Focus mode — Esc or “Exit focus” to leave' : 'Full lyric view');
});
$('btn-practice')?.addEventListener('click', () => {
  if (!haveAudio) {
    showToast('Practice slowdown needs a local audio file');
    return;
  }
  setPracticeSlow(!practiceSlow);
  updateModeExits();
});
$('mode-exits')?.addEventListener('click', (e) => {
  const btn = e.target.closest?.('[data-exit]');
  if (!btn) return;
  exitOverlayMode(btn.dataset.exit);
});
$('practice-slow')?.addEventListener('change', (e) => {
  setPracticeSlow(e.target.checked);
});
$('singer-lead')?.addEventListener('input', (e) => {
  display.setSingerLead(Number(e.target.value) / 1000);
  syncSingerLeadUi();
});

$('auto-timing')?.addEventListener('change', (e) => {
  autoTiming = e.target.checked;
  localStorage.setItem('bar4bar.autoTiming', autoTiming ? 'on' : 'off');
  if (autoTiming) {
    autoTimingSuspended = false; // re-enable → let it retake control
    showToast('Auto-timing on — it will match the vocal as it plays');
  } else {
    showToast('Auto-timing off — using manual offset');
  }
  updateTimingReadout();
});

$('vocal-isolation')?.addEventListener('change', (e) => {
  vocalIsolation = e.target.checked;
  localStorage.setItem('bar4bar.vocalIsolation', vocalIsolation ? 'on' : 'off');
  setVocalSeparationEnabled(vocalIsolation);
  const state = $('vocal-isolation-state');
  if (state) state.textContent = vocalIsolation ? 'on — cleaner alignment' : 'off';
  showToast(
    vocalIsolation
      ? 'Vocal isolation on — re-load the song to re-align on the clean vocal'
      : 'Vocal isolation off — aligning on the full mix'
  );
});

$('sep-hud-toggle')?.addEventListener('change', (e) => {
  sepHudEnabled = e.target.checked;
  localStorage.setItem('bar4bar.sepHud', sepHudEnabled ? 'on' : 'off');
  renderLiveSep(liveSeparationStats());
  showToast(sepHudEnabled ? 'Separation HUD on' : 'Separation HUD off');
});

document.querySelector('.timing-dial')?.addEventListener('click', (e) => {
  const btn = e.target.closest?.('[data-timing]');
  if (!btn) return;
  applyTimingNudge(parseFloat(btn.dataset.timing));
});
$('timing-reset')?.addEventListener('click', () => {
  clearTrackOffset(session.meta || {});
  syncEstimator.reset();
  autoTimingSuspended = false; // fresh start; auto may retake if enabled
  const fallback = getDeviceDefault();
  display.setSyncOffset(fallback, { source: fallback ? 'device' : 'zero' });
  showSyncToast(fallback);
  updateTimingReadout();
});

// ------------------- D-pad / remote navigation (10-foot UI) ----------------
// Arrow keys move focus tvOS-style across the setup screen; Enter activates.
// Inputs keep their own keys: ←/→ move the caret, ↑/↓ drive the suggestion
// list while it's open, and ↑ stays in the field so typing is never hijacked.
initTvNav({
  root: $('setup'),
  isActive: (e) => {
    if (stage.dataset.mode !== 'setup') return false;
    const t = document.activeElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT')) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp') return false;
      if (!$('suggestions').hidden) return false; // ↑/↓ belong to the list
    }
    return true;
  },
});

// -------------------- fullscreen + auto-hiding bar -------------------------
addEventListener('keydown', (e) => {
  // Esc peels layers: popup → focus/reading/practice → leave lyric view.
  if (e.key === 'Escape') {
    if (closeAnyOpenPopup()) return;
    if (stage.dataset.mode === 'playing' && exitTopOverlayMode()) return;
    if (stage.dataset.mode === 'playing') {
      $('btn-change').click();
      return;
    }
  }
  if (e.key.toLowerCase() === 'f') {
    if (window.bar4bar?.toggleFullscreen) window.bar4bar.toggleFullscreen();
    else if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  }
  if (e.code === 'Space' && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    togglePlay();
  }
  // Sync nudge only while lyrics are playing — avoids clashing with search typing.
  if (stage.dataset.mode !== 'playing') return;
  if (e.key === ']') applyTimingNudge(e.shiftKey ? 0.1 : 0.025);
  else if (e.key === '[') applyTimingNudge(e.shiftKey ? -0.1 : -0.025);
  else if (e.key === '\\') {
    clearTrackOffset(session.meta || {});
    syncEstimator.reset();
    autoTimingSuspended = false;
    const fallback = getDeviceDefault();
    display.setSyncOffset(fallback, { source: fallback ? 'device' : 'zero' });
    showSyncToast(fallback);
  }
  else if (e.key.toLowerCase() === 't') {
    cycleAid();
  } else if (e.key.toLowerCase() === 'p') {
    const on = display.toggleReadingMode();
    updateModeExits();
    showToast(on ? 'Reading mode — Esc to leave' : 'Follow mode');
  } else if (e.key.toLowerCase() === 'o') {
    const on = display.toggleFocusMode();
    syncFocusUi();
    showToast(on ? 'Focus mode — Esc or “Exit focus” to leave' : 'Full lyric view');
  } else if (e.key.toLowerCase() === 'l') {
    applyFeelRecal('late');
  } else if (e.key.toLowerCase() === 'e') {
    applyFeelRecal('early');
  } else if (e.key.toLowerCase() === 's') {
    if (!haveAudio) showToast('Practice slowdown needs a local audio file');
    else setPracticeSlow(!practiceSlow);
  } else if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
    // Hold the guide a little longer when asked for explicitly.
    poke(10000);
  }
});

let idleTimer;
let lastPokeMove = 0;
/** Wake nowbar + hotkey guide; they fade after idle. `holdMs` overrides the hide delay. */
function poke(holdMs = 3500) {
  if (stage.dataset.mode !== 'playing') return;
  $('nowbar')?.classList.remove('hide');
  $('hotkeys')?.classList.remove('hide');
  clearTimeout(idleTimer);
  const ms = typeof holdMs === 'number' && holdMs > 0 ? holdMs : 3500;
  idleTimer = setTimeout(() => {
    $('nowbar')?.classList.add('hide');
    $('hotkeys')?.classList.add('hide');
  }, ms);
}
// Mouse wake — lightly throttled so tiny jitter doesn't thrash the fade.
addEventListener('mousemove', () => {
  const now = performance.now();
  if (now - lastPokeMove < 120) return;
  lastPokeMove = now;
  poke();
});
// On a remote/keyboard there is no mouse — any key wakes the chrome too.
// Skip ? — that path already calls poke(10000) and shouldn't be shortened.
addEventListener('keydown', (e) => {
  if (e.key === '?' || (e.key === '/' && e.shiftKey)) return;
  poke();
});

async function bootSetup() {
  if (window.bar4bar?.getConfig) {
    window.__SL_CONFIG__ = await window.bar4bar.getConfig();
  }
  const apple = !!window.__SL_CONFIG__?.appleMusicDeveloperToken;
  if ($('btn-apple')) $('btn-apple').hidden = !apple;
  await bootAuth();
  migrateLegacyOffset(display.syncOffset);
  applySongTimingOffset(null, { quiet: true });
  updateSyncSourceUi();
  updateTimingReadout();
  syncSingerLeadUi();
  syncFocusUi();
  setPracticeSlow(false, { quiet: true });
  await Promise.all([loadChartRecs(), refreshSpotifyPanel()]);
}

bootSetup();
$('in-track').focus();
window.__sl = { display, demoClock, enterPlaying, stage, session };
