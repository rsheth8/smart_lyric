import { Display } from './display.js';
import { MediaClock, PredictiveClock } from './clock.js';
import { fetchArtworkUrl, paletteFromUrl } from './art.js';
import { Mic } from './mic.js';
import { SongSession } from './session.js';
import { readAudioTags } from './audio-tags.js';
import { parseLyricsFilename } from './local-lyrics.js';
import { basenamesMatch } from './providers/lyrics/local.js';
import { createSyncPublisher } from './sync-bridge.js';
import { translateLines, romanizeLines, needsRomanization } from './providers/translate.js';
import { getMedium } from './mediums/index.js';
import { initTvNav } from './tv-nav.js';
import { refineTimelineWithAudio, refineTimelineFromMic, alignmentAvailable } from './align.js';
import {
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
let listenRaf = null;
let lastListenResult = null;
let listenEverLocked = false;
let listenSilentSince = null;
let selectedInputDeviceId = null; // chosen mic/line-in (e.g. USB turntable)
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
  const result = await session.load(query);
  // Nudge the user toward the language aids; the display starts with them off.
  const canRomanize =
    result?.hasRoman || needsRomanization((session.timeline?.lines || []).map(lineText));
  if (canRomanize) {
    setTimeout(() => showToast('Press T for pronunciation / English'), 900);
  } else if (result?.estimated) {
    setTimeout(() => showToast('Estimated timing — press P to read'), 900);
  } else if (result?.wordSync) {
    setTimeout(() => showToast('Word sync — press ] [ to nudge if needed'), 900);
  } else if (result?.lines) {
    setTimeout(() => showToast('Line sync — aligning to vocal…'), 900);
  }
  return result;
}

function enterSetup() {
  stage.dataset.mode = 'setup';
  clearTimeout(idleTimer);
  $('nowbar').classList.remove('hide');
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
  poke();
}

function stopActiveMedium() {
  if (activeMedium?.stop) activeMedium.stop();
  activeMedium = null;
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

    if (vinylClock.isPlaying()) {
      panel.hidden = true; // lyrics are following — get out of the way
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
    refineAudioTiming(pendingAudioFile);
  } else {
    session.setClock(demoClock);
    demoClock.start(0);
  }
  updatePlayBtn();
}

// Forced alignment: sharpen within-line word timings using the audio file's
// vocal. Desktop-only + best-effort; failures silently keep the existing timing.
async function refineAudioTiming(file) {
  if (!file || !alignmentAvailable() || !session.timeline) return;
  try {
    const res = await refineTimelineWithAudio(session.timeline, file, {
      onStatus: (msg) => showToast(msg),
    });
    if (res && res.aligned > 0) {
      display.updateTimingBadge({
        source: session.meta?.source,
        format: session.meta?.format,
        wordSync: ['yrc', 'richsync', 'ass'].includes(session.meta?.format),
        aligned: true,
      });
      showToast('Timing aligned to the vocal');
    }
  } catch {
    /* keep existing timing */
  }
}

// Vinyl: vocal alignment needs a ~90 MB model download; only run when already loaded.
let vinylAlignTimer = null;
let vinylAlignBusy = false;

function scheduleVinylAlign() {
  if (!session.timeline || !activeMic || activeMedium?.id !== 'vinyl' || vinylAlignBusy) return;
  if (!alignmentAvailable()) return;
  if (!window.bar4bar?.alignModelLoaded) return;
  clearTimeout(vinylAlignTimer);
  vinylAlignTimer = setTimeout(async () => {
    const loaded = await window.bar4bar.alignModelLoaded().catch(() => false);
    if (!loaded) return;
    vinylAlignBusy = true;
    try {
      const res = await refineTimelineFromMic(session.timeline, activeMic, vinylClock.now());
      if (res?.aligned) {
        display.updateTimingBadge({
          source: session.meta?.source,
          format: session.meta?.format,
          wordSync: ['yrc', 'richsync', 'ass'].includes(session.meta?.format),
          aligned: true,
        });
      }
    } catch {
      /* keep syllable / richsync timing */
    }
    vinylAlignBusy = false;
  }, 600);
}

// Find the selected song on Spotify, start it playing there, load its lyrics,
// and follow playback (also handles skips via the follow-poll).
async function startSpotifySong({ artist, track }) {
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
    const [ok] = await Promise.all([
      prepareSong({
        artist: found.artist,
        track: found.name,
        album: found.album,
        duration: found.duration,
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
    if (!ok) return; // prepareSong set its own "no lyrics" error (song may still be playing)

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
        const loaded = await prepareSong({
          artist: meta.artist,
          track: meta.title || meta.track,
          album: meta.album,
          duration: meta.duration,
        });
        if (loaded) enterPlaying();
        return loaded;
      },
    });
    const clock = getStreamingClock();
    if (clock) session.setClock(clock);

    enterPlaying();
    updateTransport();
    loadArtwork(found.artist, found.name);
    setStatus('ok', 'Playing on Spotify — lyrics are following.');
    updatePlayBtn();
  } catch (err) {
    setStatus('error', err.message || 'Couldn’t start playback on Spotify.');
    console.error('[Bar4Bar] Spotify play failed', err);
  } finally {
    hideBusy();
    $('btn-load').disabled = false;
  }
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

  const tags = await readAudioTags(file);
  session.setAudioFile(file, tags);
  if (tags?.track) $('in-track').value = tags.track;
  if (tags?.artist) $('in-artist').value = tags.artist;

  if (!pendingLyricsFile && $('lyrics-file').files?.length) {
    const paired = [...$('lyrics-file').files].find((f) => basenamesMatch(f.name, file.name));
    if (paired) {
      pendingLyricsFile = paired;
      session.setLyricsFile(paired);
      setStatus('ok', `Audio + lyrics paired: ${file.name}`);
      return;
    }
  }

  setStatus('ok', `Audio ready: ${file.name}. Now load its lyrics to sync.`);
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
        scheduleVinylAlign();
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
      if (r.reason === 'match' && medium.state === 'locked') scheduleVinylAlign();
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
        const loaded = await prepareSong({
          artist: meta.artist,
          track: meta.title || meta.track,
          album: meta.album,
          duration: meta.duration,
        });
        if (loaded) {
          hideBusy();
          enterPlaying();
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
}

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
  // Remote "Menu"/back: leave the lyric view the same way Change song does.
  if (e.key === 'Escape' && stage.dataset.mode === 'playing') {
    $('btn-change').click();
    return;
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
  if (e.key === ']') showSyncToast(display.nudgeSyncOffset(0.05));
  else if (e.key === '[') showSyncToast(display.nudgeSyncOffset(-0.05));
  else if (e.key === '\\') showSyncToast(display.resetSyncOffset());
  else if (e.key.toLowerCase() === 't') {
    cycleAid();
  } else if (e.key.toLowerCase() === 'p') {
    const on = display.toggleReadingMode();
    showToast(on ? 'Reading mode (scroll to read)' : 'Follow mode');
  }
});

let idleTimer;
function poke() {
  if (stage.dataset.mode !== 'playing') return;
  $('nowbar').classList.remove('hide');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => $('nowbar').classList.add('hide'), 3500);
}
addEventListener('mousemove', poke);
// On a remote/keyboard there is no mouse — any key wakes the now-bar too.
addEventListener('keydown', poke);

async function bootSetup() {
  if (window.bar4bar?.getConfig) {
    window.__SL_CONFIG__ = await window.bar4bar.getConfig();
  }
  const apple = !!window.__SL_CONFIG__?.appleMusicDeveloperToken;
  if ($('btn-apple')) $('btn-apple').hidden = !apple;
  await bootAuth();
  await Promise.all([loadChartRecs(), refreshSpotifyPanel()]);
}

bootSetup();
$('in-track').focus();
window.__sl = { display, demoClock, enterPlaying, stage, session };
