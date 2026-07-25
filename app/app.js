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
import {
  SyncEstimator,
  syncLockState,
  driftReadout,
  manualNudgePolicy,
  NUDGE_DEBOUNCE_MS,
} from './sync-learn.js';
import {
  onSyncDiag,
  updateSyncDiag,
  resetSyncDiag,
  syncDiagSummary,
  syncBlocker,
  syncDiag,
  tapHelpCopy,
} from './sync-diag.js';
import { SongSession } from './session.js';
import { readAudioTags } from './audio-tags.js';
import { parseLyricsFilename } from './local-lyrics.js';
import { basenamesMatch } from './providers/lyrics/local.js';
import { createSyncPublisher } from './sync-bridge.js';
import { translateLines, romanizeLines, needsRomanization } from './providers/translate.js';
import { getMedium } from './mediums/index.js';
import { createRouter } from './ui/router.js';
import { initScreenFocus } from './ui/focus.js';
import { initRemote, Intent } from './remote.js';
import { initSurface } from './ui/surface.js';
import { accentFromPalette, applyAccent } from './theme.js';
import { loadLibrary, recordPlay, clearLibrary, relativeWhen, updateArt } from './library.js';
import { cacheKey, getCachedTimeline } from './timeline-cache.js';
import {
  refineTimelineWithAudio,
  refineTimelineFromMic,
  alignmentAvailable,
  warmAlignModel,
  warmSeparationModel,
  setVocalSeparationEnabled,
  needsVocalAlign,
  needsLatencyCalib,
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

// The desktop shell exposes window.bar4bar via preload; the plain dev browser
// doesn't. The class is what turns on the custom titlebar and the traffic-light
// inset, so the same markup stays correct in both.
const isElectron = !!window.bar4bar;
document.body.classList.toggle('is-electron', isElectron);


const display = new Display({ stage, lyricsEl: $('lyrics'), bgCanvas: $('bg') });
display.start();

// --------------------------- screens / density ----------------------------
// Must come after `display` — initSurface applies the density synchronously and
// anything its onChange touches has to already exist.
const router = createRouter({
  stage,
  onEnter: (name) => {
    if (name === 'library') renderLibrary();
    if (name === 'settings') refreshSyncSettings();
    if (name === 'sources') refreshSpotifyPanel();
  },
});

const surface = initSurface({ onChange: () => syncSurfaceUi() });
addEventListener('fullscreenchange', () => {
  document.body.classList.toggle('is-fullscreen', !!document.fullscreenElement);
});

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
let alignCaptureKind = null; // 'loopback' | 'mic' | 'system' — which instrument we're on
let alignTapAvailable = null; // a digital tap exists but isn't carrying audio
let preferDigitalTap = localStorage.getItem('bar4bar.preferTap') !== 'off';
let alignCaptureError = ''; // last failure reason (shown in Sync panel)
let liveAlignTimer = null;
let liveAlignBusy = false;
let liveAlignStopped = true; // true = deliberately halted (not just idle this tick)
let liveAlignReason = 'idle'; // why the last tick did nothing (diagnostics)
// How the vocal aligner listens: 'auto' | 'system' | 'device' | 'off'.
let alignSourceMode = localStorage.getItem('bar4bar.alignSource') || 'auto';
let alignSourceDeviceId = localStorage.getItem('bar4bar.alignDevice') || null;
// Auto-timing: the aligner measures latency from the audio and converges the
// sync offset on its own. Off the moment the user nudges manually (per session).
let autoTiming = localStorage.getItem('bar4bar.autoTiming') !== 'off';
// Manual control is a temporary HOLD that still learns, not a kill switch.
let autoTimingHoldUntil = 0; // don't auto-apply over the user until this ms
let autoTimingFullyManual = false; // persistent disagreement → this song is theirs
let nudgeState = null; // manualNudgePolicy accumulator
let currentPrior = null; // remembered offset trusted enough for a warm-start lock
let nudgeDebounceTimer = null;
const manualHoldActive = () => Date.now() < autoTimingHoldUntil;
/** Auto may still MEASURE and learn while blocked; it just won't move the offset. */
const autoApplyBlocked = () => autoTimingFullyManual || manualHoldActive();
function resetManualTiming() {
  autoTimingHoldUntil = 0;
  autoTimingFullyManual = false;
  nudgeState = null;
  clearTimeout(nudgeDebounceTimer);
  nudgeDebounceTimer = null;
}
let lastAutoApplied = null;
let practiceSlow = false;
const PRACTICE_RATE = 0.8;
const RECAL_NUDGE = 0.08; // feel-late → earlier; feel-early → later
// Isolate the vocal (MDX-Net) before aligning — only takes effect when a model
// is configured (SEPARATE_MODEL_PATH). Default on so it's used once available.
let vocalIsolation = localStorage.getItem('bar4bar.vocalIsolation') !== 'off';
setVocalSeparationEnabled(vocalIsolation);
// Diagnostic HUD — a developer overlay, so it defaults OFF and is opted into
// from Settings ▸ Diagnostics. (It used to default on and shipped on top of the
// lyrics for every user.)
let sepHudEnabled = localStorage.getItem('bar4bar.sepHud') === 'on';
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

let currentArtUrl = null;

async function loadArtwork(artist, track) {
  $('cover').style.backgroundImage = '';
  currentArtUrl = null;
  // Back to brand gold until this song's own palette arrives, so the previous
  // song's accent never bleeds into the next one.
  applyAccent(stage, null);
  const url = await fetchArtworkUrl({ artist, track });
  if (!url) return;
  currentArtUrl = url;
  $('cover').style.backgroundImage = `url("${url}")`;
  if (session.meta?.track) updateArt(session.meta, url);
  const palette = await paletteFromUrl(url);
  if (palette?.length) {
    display.setPalette(palette);
    // Same palette, two jobs: the ambient background glow (which can be any
    // brightness) and the accent (which cannot). accentFromPalette borrows only
    // the hue and rebuilds it at the brand's lightness — see app/theme.js.
    applyAccent(stage, accentFromPalette(palette));
    syncPublisher.publishFull();
  }
}

async function prepareSong(query) {
  resetLiveSeparationStats(); // fresh HUD counts per song
  resetSyncDiag();
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
  resetManualTiming();
  lastAutoApplied = null;

  const { offset, source, strong } = resolveOffset(meta || {});
  display.setSyncOffset(offset, { source, persistLegacy: true });
  // After 1–2 songs on this output path, seed harder so song 2–3 start locked-in.
  syncEstimator.seed(offset, { weight: devicePriorWeight() });
  // A trusted prior lets the lock show green from the first line (the offset is
  // already applied); live measurement then confirms it or knocks it back.
  currentPrior = strong && offset !== 0 ? { value: offset, strong: true, source } : null;
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

/** True while we're measuring through a digital tap rather than a microphone. */
const onDigitalTap = () => alignCaptureKind === 'loopback' || alignCaptureKind === 'system';

function persistCurrentTiming(offset, { fromLock = false, trainsDevice = true } = {}) {
  rememberOffset(session.meta || {}, offset, { fromLock, trainsDevice });
}

/**
 * Fold measured latency samples from the aligner into the estimator and, when
 * confident, converge the live sync offset automatically. This is the "learns as
 * it plays" loop — measured from the actual vocal, not BPM.
 */
function ingestTimingSamples(samples) {
  let accepted = 0;
  let clamped = 0;
  for (const s of samples) {
    const outcome = syncEstimator.addSample(s);
    if (outcome === 'ok') accepted++;
    else if (outcome === 'clamped') clamped++;
  }
  const d = syncDiag();
  updateSyncDiag({
    accepted: d.accepted + accepted,
    clamped: d.clamped + clamped,
    count: syncEstimator.count,
    confidence: syncEstimator.confidence,
  });
  if (!autoTiming || autoApplyBlocked()) {
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
  // Only a microphone hears the speaker delay; a digital tap can't, so it must
  // not train the device default (it would zero out a learned Bluetooth lag).
  persistCurrentTiming(next, { fromLock: true, trainsDevice: !onDigitalTap() });
  lastAutoApplied = next;
  updateTimingReadout();
}

function enterSetup() {
  stage.dataset.mode = 'setup';
  clearTimeout(idleTimer);
  stage.dataset.chrome = 'awake';
  delete stage.dataset.playback; // no ambient paused scene on the hub
  $('nowbar').classList.remove('hide');
  $('hotkeys')?.classList.add('hide');
  $('inspector').hidden = true;
  $('btn-more')?.setAttribute('aria-expanded', 'false');
  // Coming back from a song, the hub should reflect that it was just played.
  renderContinueShelf();
  // The ♪ / count-in / peek overlays hang off `stage`, not `#viewport`, so
  // fading the lyric viewport out doesn't take them with it — without this they
  // sit on top of the menu after a song change. Also drop the old timeline so
  // the RAF loop can't resurrect them while the menu is up.
  display.clearPlayback();
  hideSuggestions();
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
  syncInspectorUi();
  // Every path into the lyric view lands here, so this is the one place a play
  // needs recording. Artwork is still in flight — loadArtwork patches it in.
  if (session.meta?.track) {
    recordPlay(session.meta, { art: currentArtUrl, source: activeMedium?.id || null });
  }
  // First reveal a bit longer so the bar is discoverable.
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
  $('in-track-2').value = track || '';
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
    ensureVocalAlignment({ file: pendingAudioFile, capture: true });
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
    aligned: !!session.timeline?.aligned,
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
  // good; it measures the separate speaker/output delay. Note this is NOT
  // conditioned on `capture` — the local-file path passes capture:false, which
  // used to drop calibration entirely for word-sync and cached timelines.
  const needsTiming = needsLatencyCalib(session.timeline, { autoTiming });
  if (!needs && !needsTiming && !forceCapture) return;
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
    // Word alignment is done, but speaker/output latency is a separate
    // measurement that still needs to listen — fall through rather than return.
    if (!needsTiming) return;
  }

  if (capture || forceCapture || needsTiming) {
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
    alignCaptureKind = 'mic';
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
    preferTap: preferDigitalTap,
  });
  if (!res) {
    alignCaptureError = '';
    return false; // mode === off
  }
  if (res.error || !res.mic) {
    alignCaptureError = res.error || 'Could not start audio capture';
    updateSyncDiag({ capture: 'error', captureError: alignCaptureError });
    return false;
  }
  alignMic = res.mic;
  alignCaptureOwned = true;
  alignCaptureLabel = res.label;
  // Which instrument we ended up on matters: a loopback tap reads the OS mixer
  // BEFORE any output-device delay, so it measures catalog-vs-audio offset, not
  // speaker latency. Only a real mic hears what the room hears.
  alignCaptureKind = res.kind || null;
  alignTapAvailable = res.tapAvailable || null;
  alignCaptureError = '';
  updateSyncDiag({
    capture: 'open',
    captureKind: res.kind || null,
    captureLabel: res.label || '',
    captureError: '',
    fellBackFrom: res.fellBackFrom || null,
    peakLevel: Number(res.peakLevel) || 0,
  });
  if (res.fellBackFrom) {
    showToast(
      `${res.fellBackFrom} is silent — set macOS output to it (or a Multi-Output Device). Listening on ${res.label} instead.`
    );
  }
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
  alignCaptureKind = null;
  alignTapAvailable = null;
  updateSyncSourceUi();
}

function liveAlignMic() {
  return alignMic || activeMic;
}

// null (not 0) when there's no clock: 0 is a real song position, and feeding it
// in makes windowStart negative, which silently excludes every line forever.
function liveAlignNowSec() {
  if (activeMedium?.id === 'vinyl') return vinylClock.now();
  const streaming = getStreamingClock?.();
  if (streaming) return streaming.now();
  if (session.clock?.now) return session.clock.now();
  return null;
}

function stopLiveAlign() {
  clearTimeout(liveAlignTimer);
  liveAlignTimer = null;
  liveAlignBusy = false;
  liveAlignStopped = true;
}

/**
 * Arm the next measurement tick. Idempotent — safe to call from anywhere.
 *
 * Previously this function BOTH decided whether to run and armed the timer, so
 * every "nothing to do right now" check (no mic yet, no line finished yet, all
 * lines measured once) returned without rescheduling and killed the loop for the
 * rest of the song. Deciding now happens in the tick, which always re-arms.
 */
function scheduleLiveAlign(delayMs = 700) {
  liveAlignStopped = false;
  clearTimeout(liveAlignTimer);
  liveAlignTimer = setTimeout(liveAlignTick, delayMs);
}

async function liveAlignTick() {
  liveAlignTimer = null;
  if (liveAlignStopped) return;
  // Hard stops — this song/mode is genuinely done, don't re-arm.
  if (!session.timeline || stage.dataset.mode !== 'playing') {
    liveAlignStopped = true;
    liveAlignReason = 'not-playing';
    return;
  }
  if (liveAlignBusy) return; // a previous tick is still running; it will re-arm

  liveAlignBusy = true;
  const alignGen = session.loadGeneration;
  try {
    const needsWords = needsVocalAlign(session.timeline, session.meta || {});
    // First collect a wide-window latency estimate. Once it locks, line-sync
    // songs continue into word refinement; catalog/cached word-sync stays
    // timing-only (measurement, never touching good catalog word spans).
    const autoNeedsSamples = autoTiming && syncEstimator.suggestion() == null;
    const timingOnly = !needsWords || autoNeedsSamples;

    // Soft skips: record why, then fall through to the re-arm in `finally`.
    if (!autoTiming && timingOnly) return void updateSyncDiag({ loop: (liveAlignReason = 'auto-off') });
    if (!timingOnly && !alignmentAvailable()) return void updateSyncDiag({ loop: (liveAlignReason = 'no-aligner') });
    const mic = liveAlignMic();
    if (!mic) return void updateSyncDiag({ loop: (liveAlignReason = 'no-mic') });
    const nowSec = liveAlignNowSec();
    if (nowSec == null) return void updateSyncDiag({ loop: (liveAlignReason = 'no-clock'), clock: 'none' });

    // Once locked, keep a slow drift-tracking trickle instead of stopping dead.
    const locked = syncEstimator.suggestion() != null;
    const staleAfterSec = timingOnly ? (locked ? 10 : 3) : Infinity;

    if (!timingOnly) await warmAlignModel();
    if (alignGen !== session.loadGeneration) return;
    liveAlignReason = 'measuring';
    updateSyncDiag({
      loop: 'measuring',
      clock: 'ok',
      lastTickMs: Date.now(),
      peakLevel: Math.max(syncDiag().peakLevel, Number(mic.level) || 0),
    });
    const res = await refineTimelineFromMic(session.timeline, mic, nowSec, {
      timingOnly,
      maxLines: timingOnly ? 3 : 2,
      expectedOffset: display.syncOffset || 0,
      staleAfterSec,
    });
    if (alignGen !== session.loadGeneration) return;
    if (res?.aligned) {
      markAlignedBadge();
      persistAlignedTiming();
      updateSyncSourceUi();
    }
    if (res?.timingSamples?.length) ingestTimingSamples(res.timingSamples);
    else if (res === false) updateSyncDiag({ loop: (liveAlignReason = 'no-candidate'), candidates: 0 });
    if (res?.timingSamples?.length) updateSyncDiag({ candidates: res.timingSamples.length });

    // Live rubato retiming is disabled until it uses a stable capture→clock
    // transform and confidence-gated token/onset matching. The current path can
    // shove unreached words mid-line from a false onset match.
  } catch {
    /* keep syllable / richsync timing */
  } finally {
    liveAlignBusy = false;
    // Always keep chasing: drift is continuous, so measurement must be too.
    // Don't re-arm if this tick belonged to a song the user already left.
    if (alignGen !== session.loadGeneration) return;
    if (!liveAlignStopped && session.timeline && stage.dataset.mode === 'playing') {
      scheduleLiveAlign();
    }
  }
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
// ------------------------------ search screen ------------------------------
// Search used to be a dropdown pinned under the field with hand-computed
// viewport coordinates (it had to escape the panel's backdrop-filter). It's now
// a full screen, which deletes all that measurement code and gives each result
// a real row — far easier to hit with a remote than a 40px dropdown line.

function hideSuggestions() {
  const box = $('suggestions');
  if (!box) return;
  box.innerHTML = '';
  suggestionItems = [];
  suggestionIndex = -1;
}

function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function renderSuggestions(items) {
  const box = $('suggestions');
  suggestionItems = items || [];
  suggestionIndex = -1;
  const summary = $('search-summary');

  if (!suggestionItems.length) {
    box.innerHTML = `
      <div class="empty-state">
        <b>No songs found</b>
        <p>Try the artist name as well, or check the spelling. You can also import a lyrics file from Sources.</p>
      </div>`;
    if (summary) summary.textContent = 'No matches';
    return;
  }

  if (summary) {
    summary.textContent = `${suggestionItems.length} result${suggestionItems.length === 1 ? '' : 's'}`;
  }
  box.innerHTML = suggestionItems
    .map(
      (s, i) => `
    <button type="button" class="result-row" role="option" data-i="${i}" aria-selected="false">
      ${s.artwork
        ? `<img src="${s.artwork}" alt="" loading="lazy" />`
        : '<span class="art">♪</span>'}
      <span class="t"><b>${escapeHtml(s.track)}</b><span>${escapeHtml(s.artist)}</span></span>
      <span class="dur">${formatDuration(s.duration)}</span>
    </button>`
    )
    .join('');
  box.querySelectorAll('.result-row').forEach((btn) => {
    btn.addEventListener('click', () => {
      const s = suggestionItems[+btn.dataset.i];
      if (s) loadSong({ artist: s.artist, track: s.track, duration: s.duration });
    });
  });
}

function scheduleSuggest() {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(async () => {
    const q = searchQuery();
    if (q.length < 2) {
      hideSuggestions();
      return;
    }
    const items = await searchSuggestions(q);
    renderSuggestions(items);
  }, 220);
}

/** The hub and the search screen each have a title field; whichever the user
 *  last typed in wins, and the artist field only exists on the search screen. */
function searchQuery() {
  const track = ($('in-track-2').value || $('in-track').value || '').trim();
  const artist = ($('in-artist').value || '').trim();
  return [track, artist].filter(Boolean).join(' ').trim();
}

/** Move to the search screen, carrying whatever was typed on the hub. */
function openSearch(seed) {
  const field = $('in-track-2');
  if (seed != null) field.value = seed;
  else if (!field.value && $('in-track').value) field.value = $('in-track').value;
  router.go('search');
  scheduleSuggest();
}

$('in-track').addEventListener('input', () => {
  // Typing on the hub is the intent to search — jump once there's something
  // to search for, rather than making the user find a second field.
  if ($('in-track').value.trim().length >= 2) openSearch();
});
$('in-track-2').addEventListener('input', scheduleSuggest);
$('in-artist').addEventListener('input', scheduleSuggest);
$('in-track-2').addEventListener('keydown', onSuggestKey);
$('in-artist').addEventListener('keydown', onSuggestKey);

$('search-refine').addEventListener('submit', (e) => {
  e.preventDefault();
  const track = $('in-track-2').value.trim();
  if (track) loadSong({ artist: $('in-artist').value.trim(), track });
});

function onSuggestKey(e) {
  if (!suggestionItems.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    suggestionIndex = Math.min(suggestionItems.length - 1, suggestionIndex + 1);
    highlightSuggestion();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    suggestionIndex = Math.max(0, suggestionIndex - 1);
    highlightSuggestion();
  } else if (e.key === 'Enter' && suggestionIndex >= 0) {
    e.preventDefault();
    const s = suggestionItems[suggestionIndex];
    if (s) loadSong({ artist: s.artist, track: s.track, duration: s.duration });
  }
}

function highlightSuggestion() {
  const rows = $('suggestions').querySelectorAll('.result-row');
  rows.forEach((el, i) => {
    el.setAttribute('aria-selected', i === suggestionIndex ? 'true' : 'false');
    if (i === suggestionIndex) el.scrollIntoView({ block: 'nearest' });
  });
}

// --------------------------- recommendations -----------------------------
function renderRecGrid(el, items, emptyMsg) {
  if (!items?.length) {
    el.innerHTML = `<div class="shelf-empty">${emptyMsg}</div>`;
    return;
  }
  el.innerHTML = items
    .map(
      (s, i) => `
    <button type="button" class="rec" data-i="${i}">
      ${s.artwork ? `<img src="${s.artwork}" alt="" loading="lazy" />` : '<span class="art">♪</span>'}
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

// ------------------------------- library ---------------------------------

function renderLibrary() {
  const host = $('library-list');
  const entries = loadLibrary();
  const count = $('library-count');
  if (count) {
    count.textContent = entries.length
      ? `${entries.length} song${entries.length === 1 ? '' : 's'}`
      : '';
  }

  if (!entries.length) {
    host.innerHTML = `
      <div class="empty-state">
        <b>Nothing here yet</b>
        <p>Songs you follow show up here, with the ones already vocal-aligned marked for instant replay.</p>
      </div>`;
    return;
  }

  host.innerHTML = entries
    .map(
      (e, i) => `
    <button type="button" class="lib-row" data-i="${i}">
      ${e.art ? `<img src="${e.art}" alt="" loading="lazy" />` : '<span class="art"></span>'}
      <span class="t"><b>${escapeHtml(e.track)}</b><span>${escapeHtml(e.artist)}</span></span>
      ${getCachedTimeline(e) ? '<span class="badge-ready">aligned</span>' : ''}
      <span class="when">${relativeWhen(e.lastPlayedAt)}</span>
    </button>`
    )
    .join('');

  host.querySelectorAll('.lib-row').forEach((btn) => {
    btn.addEventListener('click', () => {
      const e = entries[+btn.dataset.i];
      if (e) loadSong({ artist: e.artist, track: e.track, duration: e.duration || undefined });
    });
  });
}

/** The hub's "Continue" shelf — the same store, shown as posters. */
function renderContinueShelf() {
  const row = $('row-continue');
  const shelf = $('continue-shelf');
  const entries = loadLibrary().slice(0, 12);
  row.hidden = entries.length === 0;
  if (!entries.length) return;

  shelf.innerHTML = entries
    .map(
      (e, i) => `
    <button type="button" class="rec" data-i="${i}">
      ${e.art ? `<img src="${e.art}" alt="" loading="lazy" />` : '<span class="art">♪</span>'}
      <span class="meta">
        <b>${escapeHtml(e.track)}</b>
        <span class="${getCachedTimeline(e) ? 'ready' : ''}">${
          getCachedTimeline(e) ? 'Aligned · instant' : escapeHtml(e.artist)
        }</span>
      </span>
    </button>`
    )
    .join('');
  shelf.querySelectorAll('.rec').forEach((btn) => {
    btn.addEventListener('click', () => {
      const e = entries[+btn.dataset.i];
      if (e) loadSong({ artist: e.artist, track: e.track, duration: e.duration || undefined });
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

  // The Spotify entry point exists twice — as a tile on the hub and as the real
  // button on the Sources screen — so both labels move together.
  const setSpotifyCopy = (label, hint) => {
    $('spotify-label').textContent = label;
    $('spotify-hint').textContent = hint;
    $('hub-spotify-label').textContent = label;
    $('hub-spotify-hint').textContent = hint;
    document
      .querySelectorAll('.tile.spotify')
      .forEach((el) => el.classList.toggle('connected', !!token));
  };

  if (token) {
    btn.classList.add('connected');
    setSpotifyCopy('Spotify connected', 'Tap to follow playback');
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
    setSpotifyCopy('Connect Spotify', 'Follow what’s playing');
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
  // Ambient-scene seam: only meaningful while a song is up. 'Play'/'Paused' are
  // the two resting labels; everything else ('Pause'/'Following'/'Listening') is live.
  if (stage.dataset.mode === 'playing') {
    stage.dataset.playback = label === 'Play' || label === 'Paused' ? 'paused' : 'playing';
  } else {
    delete stage.dataset.playback;
  }
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
  return closePanel('inspector') || closePanel('listen-panel');
}

document.addEventListener('click', (e) => {
  const closer = e.target.closest?.('[data-close]');
  if (closer) {
    closePanel(closer.dataset.close);
    if (closer.dataset.close === 'inspector') $('btn-more').setAttribute('aria-expanded', 'false');
    return;
  }
  // Click outside the inspector (and not on its toggle) dismisses it.
  const inspector = $('inspector');
  if (!inspector.hidden && !inspector.contains(e.target) && !$('btn-more').contains(e.target)) {
    inspector.hidden = true;
    $('btn-more').setAttribute('aria-expanded', 'false');
  }
});

// ⋯ — the now-bar's single overflow. Everything per-song that used to live as a
// separate button on the bar is inside: timing, view modes, language — none of
// which have a physical remote button. On a Siri Remote the ⋯ is reached by
// normal focus nav (a swipe wakes the bar, then over to it); opening lands focus
// on the first control inside so the remote can drive the panel immediately.
// (The hardware Menu button is Back, per tvOS — it's Intent.BACK, not this.)
function toggleInspector(force) {
  const panel = $('inspector');
  const open = typeof force === 'boolean' ? force : panel.hidden;
  panel.hidden = !open;
  $('btn-more').setAttribute('aria-expanded', String(open));
  if (open) {
    syncInspectorUi();
    $('nowbar')?.classList.remove('hide');
    poke(9000); // keep the bar awake while the panel is up
    // Land focus inside so a remote can drive it immediately.
    panel.querySelector('button:not([hidden]):not([disabled])')?.focus({ preventScroll: true });
  }
}
$('btn-more').addEventListener('click', () => toggleInspector());

// Global preferences live on the Settings screen, which is reachable with or
// without a song playing — the sync panel used to be the only way in.
$('btn-sync-source').addEventListener('click', () => {
  $('inspector').hidden = true;
  $('btn-more').setAttribute('aria-expanded', 'false');
  enterSetup();
  router.go('settings');
});

/** Populate the Settings screen's audio controls. Called on entering Settings. */
async function refreshSyncSettings() {
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
  syncSurfaceUi();
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
    const needsTiming = needsLatencyCalib(session.timeline, { autoTiming });
    // Retry when word alignment is still needed, latency is still unmeasured, or
    // the last attempt failed.
    if (needs || needsTiming || alignCaptureError) {
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
/**
 * Show the Multi-Output setup guide only when it would actually help: a digital
 * tap is installed but we aren't on it, so audio isn't being routed to it.
 */
function renderTapHelp() {
  const box = $('tap-help');
  if (!box) return;
  const prefBox = $('prefer-tap');
  if (prefBox) prefBox.checked = preferDigitalTap;

  const copy = tapHelpCopy({
    tapAvailable: alignTapAvailable,
    onTap: onDigitalTap(),
    preferTap: preferDigitalTap,
    captureLabel: alignCaptureLabel,
  });
  box.hidden = !copy.show;
  if (!copy.show) return;
  const title = $('tap-help-title');
  const lead = $('tap-help-lead');
  if (title) title.textContent = copy.title;
  if (lead) lead.textContent = copy.lead;
}

function updateSyncSourceUi() {
  const value = $('insp-source-value');
  if (value) {
    const mode = SYNC_MODE_LABELS[alignSourceMode] || 'Auto';
    value.textContent = alignMic || activeMic ? alignCaptureLabel || mode : mode;
  }
  renderTapHelp();
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
    // Name the instrument: a loopback tap reads the mixer before any output
    // delay, so it can't see speaker latency the way a mic can.
    const via =
      alignCaptureKind === 'loopback'
        ? ' · digital tap'
        : alignCaptureKind === 'system'
          ? ' · system tap'
          : '';
    status.textContent = `Capturing: ${alignCaptureLabel || 'input'}${via}${hearing ? ' — hearing audio' : ' — silent so far'}`;
    status.classList.toggle('ok', hearing);
  } else if (alignCaptureError) {
    status.textContent = alignCaptureError;
    status.classList.remove('ok');
  } else if (!playing) {
    status.textContent = 'Not capturing — starts when a song is playing.';
    status.classList.remove('ok');
  } else if (!autoTiming && wordSync && !needsVocalAlign(session.timeline, session.meta || {})) {
    // Only true while auto-timing is OFF — with it on we still listen, to learn
    // the output latency that catalog word timing can't tell us.
    status.textContent = 'Not capturing — this song already has catalog word sync.';
    status.classList.remove('ok');
  } else if (!autoTiming && alreadyAligned && !needsVocalAlign(session.timeline, session.meta || {})) {
    status.textContent = 'Not capturing — timings already vocal-aligned (cached).';
    status.classList.remove('ok');
  } else {
    status.textContent = 'Not capturing — open Sync again or pick a device to retry.';
    status.classList.remove('ok');
  }
}

// Keep the status line honest while it's actually on screen.
setInterval(() => {
  const onSettings = stage.dataset.mode === 'setup' && router.current === 'settings';
  if (onSettings || !$('inspector')?.hidden) updateSyncSourceUi();
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
    // The inspector shows the same number while a song is up.
    const insp = $('insp-timing-readout');
    if (insp) {
      insp.textContent = el.textContent;
      insp.title = el.title;
    }
  }
  const toggle = $('auto-timing');
  if (toggle) toggle.checked = autoTiming;
  const lock = syncLockState(syncEstimator, {
    autoOn: autoTiming,
    suspended: autoTimingFullyManual || manualHoldActive(),
    prior: currentPrior,
  });
  display.setSyncLock(lock);
  // Locked, but live measurement hasn't independently confirmed it yet → it's
  // riding the remembered offset. Green chip, honest detail text.
  const lockedFromMemory = lock === 'locked' && syncEstimator.suggestion() == null;
  updateSyncDiag({ lock, count: syncEstimator.count, confidence: syncEstimator.confidence });
  const hint = $('auto-timing-state');
  if (hint) {
    hint.textContent =
      lock === 'off'
        ? ''
        : lock === 'manual'
          ? 'paused (you tuned it)'
          : lock === 'locked'
            ? lockedFromMemory
              ? 'locked on (from last time)'
              : 'locked on'
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
  // Auto-skipped: say so plainly, otherwise the counters just quietly stop.
  // Retries after a cool-down — not a permanent pause for the song.
  if (s.paused) {
    hud.className = 'hud-idle';
    hud.textContent =
      `◌ stem skipped · too slow${avg != null ? ` (${avg.toFixed(1)}×)` : ''} · raw mix · stem ${s.stemLines}/${total}`;
    return;
  }
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

// ---- sync diagnostics HUD -------------------------------------------------
// Auto-reveals once the lock has been stuck "listening" for a while — which is
// exactly the situation where "Sync listening…" tells the user nothing.
let syncHudEnabled = localStorage.getItem('bar4bar.syncHud') === 'on';
let listeningSince = 0;
const SYNC_HUD_AUTO_AFTER_MS = 10000;

function renderSyncDiag(d) {
  const hud = $('sync-hud');
  if (!hud) return;
  const stuck = d.lock === 'listening' || d.lock === 'converging';
  if (stuck) {
    if (!listeningSince) listeningSince = Date.now();
  } else {
    listeningSince = 0;
  }
  const stuckFor = listeningSince ? Date.now() - listeningSince : 0;
  const show = syncHudEnabled || (stuck && stuckFor > SYNC_HUD_AUTO_AFTER_MS);
  if (!show) {
    hud.hidden = true;
    return;
  }
  hud.hidden = false;
  const blocker = syncBlocker(d);
  hud.className = d.lock === 'locked' ? 'hud-ok' : blocker ? 'hud-warn' : 'hud-idle';
  hud.textContent = syncDiagSummary(d);
}
onSyncDiag(renderSyncDiag);
renderSyncDiag(syncDiag());

$('sync-hud-toggle')?.addEventListener('change', (e) => {
  syncHudEnabled = e.target.checked;
  localStorage.setItem('bar4bar.syncHud', syncHudEnabled ? 'on' : 'off');
  renderSyncDiag(syncDiag());
});

$('prefer-tap')?.addEventListener('change', (e) => {
  preferDigitalTap = e.target.checked;
  localStorage.setItem('bar4bar.preferTap', preferDigitalTap ? 'on' : 'off');
  showToast(
    preferDigitalTap
      ? 'Preferring a digital tap when it carries audio'
      : 'Always listening on the microphone — it hears real speaker delay'
  );
  restartAlignCapture();
});

// Re-run the ladder now that the user has (presumably) fixed routing, so the tap
// is picked up without waiting for the next song.
$('btn-retry-tap')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    if (!preferDigitalTap) {
      preferDigitalTap = true;
      localStorage.setItem('bar4bar.preferTap', 'on');
    }
    stopAlignCapture();
    stopLiveAlign();
    alignCaptureError = '';
    const ok = await startAlignCapture();
    if (ok && onDigitalTap()) {
      showToast(`Now tapping ${alignCaptureLabel} — clean digital signal`);
      scheduleLiveAlign();
    } else if (ok) {
      showToast(`Still silent — listening on ${alignCaptureLabel}. Check the output device.`);
      scheduleLiveAlign();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Use the digital tap now';
    updateSyncSourceUi();
  }
});

function applyTimingNudge(deltaSec) {
  // Manual is instant and authoritative — apply first, always.
  showSyncToast(display.nudgeSyncOffset(deltaSec, persistCurrentTiming));

  nudgeState = manualNudgePolicy(nudgeState, { deltaSec, nowMs: Date.now() });
  autoTimingHoldUntil = nudgeState.holdUntil;
  autoTimingFullyManual = nudgeState.fullyManual;
  if (nudgeState.fullyManual) {
    showToast('Manual timing for this song — auto will stay out of the way');
  }

  // Debounce so a six-tap adjustment teaches ONE value: the one landed on, not
  // the five wrong ones passed through on the way there.
  clearTimeout(nudgeDebounceTimer);
  nudgeDebounceTimer = setTimeout(() => {
    const finalOffset = display.syncOffset || 0;
    if (nudgeState?.anchor) syncEstimator.anchor(finalOffset, { weight: 3 });
    else syncEstimator.addSample({ value: finalOffset, weight: 3, score: 1, source: 'nudge' });
    // Train the device default too, so the NEXT song opens near this value.
    persistCurrentTiming(finalOffset, { fromLock: true });
    updateTimingReadout();
  }, NUDGE_DEBOUNCE_MS);
  updateTimingReadout();
}

/**
 * One-tap recal from singer feel.
 * `late`  → highlight lagging the voice → show lyrics earlier (+)
 * `early` → highlight ahead of the voice → show lyrics later (−)
 */
function applyFeelRecal(sense) {
  const late = sense !== 'early';
  const delta = late ? RECAL_NUDGE : -RECAL_NUDGE;
  resetManualTiming(); // let auto keep refining from here
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
    resetManualTiming(); // re-enable → let it retake control
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
  resetManualTiming(); // fresh start; auto may retake if enabled
  const fallback = getDeviceDefault();
  display.setSyncOffset(fallback, { source: fallback ? 'device' : 'zero' });
  showSyncToast(fallback);
  updateTimingReadout();
});

// ------------------- D-pad / remote navigation (10-foot UI) ----------------
// Arrow keys move focus tvOS-style; Enter activates. Scoped to the ACTIVE screen
// (or the now-playing chrome) so focus can't walk into a screen that's off-stage
// — see app/ui/focus.js. The geometry is still pickNext() in tv-nav.js.
initScreenFocus({
  stage,
  router,
  isTyping: (e) => {
    const t = document.activeElement;
    // ↑/↓ drive the results list while it has entries; ↑ otherwise stays in the
    // field so typing is never hijacked.
    if (t?.tagName === 'INPUT' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      return suggestionItems.length > 0 || e.key === 'ArrowUp';
    }
    return false;
  },
});

// -------------------- remote intents (Siri Remote / TV) --------------------
// The transport + system buttons a focus engine never covers — Play/Pause, the
// track buttons, and Back/Menu — flow through app/remote.js so they work
// whether the runtime delivers them as key events or via the Media Session API.
// Directional focus (MOVE/SELECT) is left to the focus engine above.

/**
 * Peel exactly one layer off the current context, tvOS Menu-button style:
 * popup → focus/reading/practice → leave the lyric view → pop the screen stack.
 * Returns true if it consumed the press.
 */
function handleBack() {
  if (closeAnyOpenPopup()) return true;
  if (stage.dataset.mode === 'playing' && exitTopOverlayMode()) return true;
  if (stage.dataset.mode === 'playing') {
    $('btn-change').click();
    return true;
  }
  return router.back();
}

initRemote({
  guard: (intent) => {
    // Space typed into a text field is a space, not play/pause. A hardware
    // Play button (source 'media'/'mediaSession') always toggles, even in a field.
    if (intent.type === Intent.PLAYPAUSE && intent.source === 'key') {
      return document.activeElement?.tagName !== 'INPUT';
    }
    return true;
  },
  onIntent: (intent, ev) => {
    // Any remote input wakes the chrome. This is the one wake point that also
    // covers Media Session intents (a hardware Play/Pause / track button), which
    // arrive with no keydown and so never reach the keydown-based poke below.
    poke();
    switch (intent.type) {
      case Intent.PLAYPAUSE:
        ev?.preventDefault();
        togglePlay();
        break;
      case Intent.BACK:
        if (handleBack()) ev?.preventDefault();
        break;
      case Intent.NEXT:
        if (!$('btn-next')?.hidden) $('btn-next').click();
        break;
      case Intent.PREV:
        if (!$('btn-prev')?.hidden) $('btn-prev').click();
        break;
      // MOVE / SELECT / MENU / VOICE: navigation stays with the focus engine;
      // MENU + VOICE get homes in later slices.
    }
  },
});

// -------------------- fullscreen + auto-hiding bar -------------------------
addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'f') {
    if (window.bar4bar?.toggleFullscreen) window.bar4bar.toggleFullscreen();
    else if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  }
  // Sync nudge only while lyrics are playing — avoids clashing with search typing.
  if (stage.dataset.mode !== 'playing') return;
  if (e.key === ']') applyTimingNudge(e.shiftKey ? 0.1 : 0.025);
  else if (e.key === '[') applyTimingNudge(e.shiftKey ? -0.1 : -0.025);
  else if (e.key === '\\') {
    clearTrackOffset(session.meta || {});
    syncEstimator.reset();
    resetManualTiming();
    const fallback = getDeviceDefault();
    display.setSyncOffset(fallback, { source: fallback ? 'device' : 'zero' });
    showSyncToast(fallback);
  }
  else if (e.key.toLowerCase() === 't') {
    cycleAid();
  } else if (e.key.toLowerCase() === 'p') {
    toggleReading();
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
    showKeys();
  }
});

let idleTimer;
let lastPokeMove = 0;
/**
 * Wake the now-bar; it fades after idle. `holdMs` overrides the hide delay.
 *
 * The keyboard guide is deliberately NOT woken here. It used to appear on every
 * mouse move, which meant a 12-row reference card sat over the lyrics whenever
 * the pointer twitched. It's now summoned explicitly with `?` (showKeys), which
 * is what the hint on the hub advertises.
 */
// A viewer across the room needs longer to notice the bar than one at a laptop,
// so the lean-back dwell stretches on the TV surface.
function idleHold() {
  return document.body.dataset.surface === 'tv' ? 4800 : 3500;
}
function poke(holdMs) {
  if (stage.dataset.mode !== 'playing') return;
  $('nowbar')?.classList.remove('hide');
  stage.dataset.chrome = 'awake';
  clearTimeout(idleTimer);
  const ms = typeof holdMs === 'number' && holdMs > 0 ? holdMs : idleHold();
  idleTimer = setTimeout(() => {
    // Never fade out from under an open control panel — the user is mid-task.
    // Re-arm instead so it hides once they've dismissed it.
    if (!$('inspector')?.hidden) { poke(); return; }
    $('nowbar')?.classList.add('hide');
    $('hotkeys')?.classList.add('hide');
    stage.dataset.chrome = 'asleep';
  }, ms);
}

/** Summon the keyboard reference (the `?` key / Help menu). */
function showKeys(holdMs = 10000) {
  if (stage.dataset.mode !== 'playing') return;
  $('hotkeys')?.classList.remove('hide');
  poke(holdMs);
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

// ======================== hub navigation + chrome ==========================

// One delegated listener handles every navigation affordance: `data-go="screen"`
// pushes, `data-back` pops. Adding a link to a screen is now markup-only.
document.addEventListener('click', (e) => {
  const go = e.target.closest?.('[data-go]');
  if (go) {
    router.go(go.dataset.go);
    return;
  }
  if (e.target.closest?.('[data-back]')) router.back();
});
$('tb-back')?.addEventListener('click', () => router.back());

// The hub's source tiles are shortcuts to the real controls on the Sources
// screen — click those rather than duplicating each handler.
$('hub-sources').addEventListener('click', (e) => {
  const tile = e.target.closest?.('[data-source]');
  if (!tile) return;
  const target = { spotify: 'btn-spotify', listen: 'btn-listen', audio: 'btn-audio' }[
    tile.dataset.source
  ];
  $(target)?.click();
});

// ---- inspector (the ⋯ panel) ----

function toggleReading(force) {
  const on = display.toggleReadingMode(force);
  updateModeExits();
  syncInspectorUi();
  showToast(on ? 'Reading mode — Esc to leave' : 'Follow mode');
  return on;
}

/** Keep the inspector's toggles honest with the display's actual state. */
function syncInspectorUi() {
  $('btn-reading')?.setAttribute('aria-pressed', display.readingMode ? 'true' : 'false');
  $('btn-focus')?.setAttribute('aria-pressed', display.focusMode ? 'true' : 'false');
  $('btn-practice')?.setAttribute('aria-pressed', practiceSlow ? 'true' : 'false');
  const aid = $('btn-aid');
  if (aid) aid.setAttribute('aria-pressed', (display.aidMode || 'off') !== 'off' ? 'true' : 'false');
  const readout = $('insp-timing-readout');
  if (readout) readout.textContent = $('timing-readout')?.textContent || '0 ms';
}

$('btn-reading')?.addEventListener('click', () => toggleReading());
$('btn-aid')?.addEventListener('click', async () => {
  await cycleAid();
  syncInspectorUi();
});

// ---- settings: layout density ----

function syncSurfaceUi() {
  // 'auto' is the stored default and now behaves exactly as 'desktop', so both
  // light the Desktop button — there's no third state to show.
  const shown = surface.mode === 'tv' ? 'tv' : 'desktop';
  document.querySelectorAll('[data-surface-mode]').forEach((btn) => {
    btn.setAttribute('aria-pressed', btn.dataset.surfaceMode === shown ? 'true' : 'false');
  });
}
$('surface-mode')?.addEventListener('click', (e) => {
  const btn = e.target.closest?.('[data-surface-mode]');
  if (!btn) return;
  surface.setMode(btn.dataset.surfaceMode);
  syncSurfaceUi();
  showToast(
    surface.mode === 'tv'
      ? 'TV layout — sized for a screen across the room'
      : 'Desktop layout'
  );
});

$('btn-clear-library')?.addEventListener('click', () => {
  clearLibrary();
  renderLibrary();
  renderContinueShelf();
  showToast('Library cleared');
});

// ---- native menu bar ----
// Menu items in the Electron shell send an action name here rather than
// duplicating any logic — every one of these is the same path a click takes.
window.bar4bar?.onMenu?.((action) => {
  switch (action) {
    case 'settings':
      if (stage.dataset.mode === 'playing') enterSetup();
      router.go('settings');
      break;
    case 'library':
      if (stage.dataset.mode === 'playing') enterSetup();
      router.go('library');
      break;
    case 'sources':
      if (stage.dataset.mode === 'playing') enterSetup();
      router.go('sources');
      break;
    case 'search':
      if (stage.dataset.mode === 'playing') enterSetup();
      openSearch('');
      break;
    case 'home':
      if (stage.dataset.mode === 'playing') enterSetup();
      router.home();
      break;
    case 'open-audio': $('btn-audio')?.click(); break;
    case 'open-lyrics': $('btn-lyrics')?.click(); break;
    case 'change-song': if (stage.dataset.mode === 'playing') $('btn-change').click(); break;
    case 'play-pause': togglePlay(); break;
    case 'nudge-earlier': applyTimingNudge(0.025); break;
    case 'nudge-later': applyTimingNudge(-0.025); break;
    case 'reset-timing': $('timing-reset')?.click(); break;
    case 'feel-early': applyFeelRecal('early'); break;
    case 'feel-late': applyFeelRecal('late'); break;
    case 'focus-mode':
      display.toggleFocusMode();
      syncFocusUi();
      syncInspectorUi();
      break;
    case 'reading-mode': toggleReading(); break;
    case 'language-aid': cycleAid().then(syncInspectorUi); break;
    case 'projector': $('btn-projector')?.click(); break;
    case 'keys': showKeys(); break;
    default: break;
  }
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
  syncSurfaceUi();
  syncInspectorUi();
  renderContinueShelf();
  setPracticeSlow(false, { quiet: true });
  await Promise.all([loadChartRecs(), refreshSpotifyPanel()]);
}

bootSetup();
// preventScroll: focusing the search field otherwise scrolls it into view,
// which pushes the brand header off the top of the hub on first paint.
if (document.body.dataset.surface === 'tv') {
  // 10-foot: opening on the search field would pop the on-screen keyboard at
  // launch. Land on the first browse action ("Follow what's playing") instead —
  // the whole hub is D-pad navigable, and search stays one click away.
  (document.querySelector('#hub-sources .tile') || document.querySelector('#screens button'))
    ?.focus({ preventScroll: true });
} else {
  $('in-track').focus({ preventScroll: true });
}
window.__sl = { display, demoClock, enterPlaying, stage, session, router, surface };
