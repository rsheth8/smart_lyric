import { Display } from './display.js';
import { MediaClock, PredictiveClock } from './clock.js';
import { fetchArtworkUrl, paletteFromUrl } from './art.js';
import { Mic } from './mic.js';
import { SongSession } from './session.js';
import { readAudioTags } from './audio-tags.js';
import { parseLyricsFilename } from './local-lyrics.js';
import { basenamesMatch } from './providers/lyrics/local.js';
import { createSyncPublisher } from './sync-bridge.js';
import { getMedium } from './mediums/index.js';
import {
  beginSpotifyLogin,
  completeSpotifyLoginFromUrl,
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
  return session.load(query);
}

function enterSetup() {
  stage.dataset.mode = 'setup';
  clearTimeout(idleTimer);
  $('nowbar').classList.remove('hide');
  stopActiveMedium();
  if (!audio.paused) audio.pause();
  if (demoClock.isPlaying()) demoClock.pause();
  if (vinylClock.isPlaying()) vinylClock.pause();
}

function enterPlaying() {
  stage.dataset.mode = 'playing';
  poke();
}

function stopActiveMedium() {
  if (activeMedium?.stop) activeMedium.stop();
  activeMedium = null;
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
  } else {
    session.setClock(demoClock);
    demoClock.start(0);
  }
  updatePlayBtn();
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
    panel.hidden = false;
    const [recent, now] = await Promise.all([
      fetchSpotifyRecentlyPlayed(token.access_token),
      fetchSpotifyNowPlaying(token.access_token),
    ]);
    const forGrid = [];
    if (now?.track) forGrid.push(now);
    for (const r of recent) {
      if (!forGrid.some((x) => x.track === r.track && x.artist === r.artist)) forGrid.push(r);
    }
    renderRecGrid($('spotify-recs'), forGrid, 'No recent tracks yet — play something on Spotify.');
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

// ------------------------------ play/pause -------------------------------
$('btn-play').addEventListener('click', togglePlay);
function togglePlay() {
  if (stage.dataset.mode !== 'playing' || activeMedium?.id === 'vinyl') return;
  if (haveAudio) {
    audio.paused ? audio.play() : audio.pause();
  } else {
    demoClock.isPlaying() ? demoClock.pause() : demoClock.start(demoClock.now());
    updatePlayBtn();
  }
}
function updatePlayBtn() {
  const vinylActive = activeMedium?.id === 'vinyl';
  const playing = vinylActive ? true : haveAudio ? !audio.paused : demoClock.isPlaying();
  let label = playing ? 'Pause' : 'Play';
  if (vinylActive && activeMedium?.state === 'locked') label = 'Following';
  else if (vinylActive) label = 'Listening';
  $('btn-play').textContent = label;
}
audio.addEventListener('play', updatePlayBtn);
audio.addEventListener('pause', updatePlayBtn);

$('btn-change').addEventListener('click', () => {
  stopActiveMedium();
  enterSetup();
  setStatus('', '');
});

// ----------------------------- vinyl listen --------------------------------
$('btn-listen').addEventListener('click', toggleListen);

async function toggleListen() {
  if (activeMedium?.id === 'vinyl') {
    stopActiveMedium();
    enterSetup();
    return;
  }
  const medium = getMedium('vinyl');
  if (!medium?.canUse()) {
    setStatus('error', 'Auto-detect needs the desktop app (run: npm start). It uses the mic + fingerprinting.');
    return;
  }

  let mic;
  try {
    mic = new Mic();
    await mic.start();
  } catch {
    setStatus('error', 'Could not access the microphone. Check permissions and try again.');
    return;
  }

  $('np-title').textContent = 'Listening…';
  $('np-artist').textContent = 'Start the record near the mic';
  $('cover').style.backgroundImage = '';
  enterPlaying();
  $('btn-play').textContent = 'Listening';

  activeMedium = medium;
  await medium.start({
    session,
    vinylClock,
    mic,
    onStatus: setStatus,
    prepareSong: async (meta) => {
      const ok = await prepareSong(meta);
      if (ok) enterPlaying();
      return ok;
    },
    onState: (s) => {
      if (s === 'locked') $('btn-play').textContent = 'Following';
      else if (s === 'listening') {
        $('np-title').textContent = 'Listening…';
        $('np-artist').textContent = 'Start the record near the mic';
      }
    },
  });
}

// --------------------------- streaming -----------------------------------
$('btn-spotify')?.addEventListener('click', () => connectStreaming('spotify'));
$('btn-apple')?.addEventListener('click', () => connectStreaming('appleMusic'));
$('btn-spotify-follow')?.addEventListener('click', () => connectStreaming('spotify'));

async function connectStreaming(id) {
  stopActiveMedium();
  const medium = getMedium(id);

  // Always refresh config from Electron / config.js before Spotify (Electron
  // injects env after load; stale empty __SL_CONFIG__ was a silent no-op).
  if (window.smartLyric?.getConfig) {
    try {
      window.__SL_CONFIG__ = await window.smartLyric.getConfig();
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
        showBusy('Connecting to Spotify', 'A login window should appear — sign in and allow access.');
        setStatus('loading', 'Opening Spotify login…');
        const loggedIn = await beginSpotifyLogin();
        if (!loggedIn) {
          // Browser redirect — leave busy up briefly; page will unload.
          showBusy('Redirecting to Spotify', 'Continue in your browser…');
          return;
        }
        setStatus('ok', 'Spotify connected.');
        await refreshSpotifyPanel();
      } else {
        showBusy('Following Spotify', 'Looking up what’s playing…');
        setStatus('loading', 'Following Spotify playback…');
      }
    } catch (err) {
      hideBusy();
      setStatus('error', err.message || 'Spotify login failed.');
      console.error('[smart_lyric] Spotify connect failed', err);
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
  enterPlaying();
  $('np-title').textContent = id === 'spotify' ? 'Following Spotify…' : 'Connecting…';
  $('np-artist').textContent = 'Play a track on Spotify (any device)';
  try {
    const ok = await medium.start({
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
    if (id === 'spotify' && ok === false) {
      hideBusy();
      setStatus('error', 'Could not start Spotify follow. Try Connect Spotify again.');
      enterSetup();
      return;
    }
    setStatus(
      'ok',
      id === 'spotify'
        ? 'Connected. Play a song on Spotify — lyrics will load automatically.'
        : ''
    );
  } catch (err) {
    hideBusy();
    setStatus('error', err.message || 'Failed to start streaming.');
    console.error(err);
    enterSetup();
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
  if (!window.smartLyric?.openProjector) {
    window.open('overlay.html', '_blank', 'noopener');
    setStatus('ok', 'Overlay opened — use OBS Browser Source on overlay.html for streaming.');
    return;
  }
  const displays = await window.smartLyric.getDisplays();
  const external = displays.find((d) => !d.primary) || displays[0];
  await window.smartLyric.openProjector(external?.id);
  setStatus('ok', `Projector opened on ${external?.label || 'display'}.`);
});

// ------------------------------ sync nudge --------------------------------
// Live fine-tune of lyric timing so highlighting lands on the beat. The right
// value depends on the user's speakers / device / stream path, so it's tunable
// on the fly ( [ = later, ] = earlier, \ = reset ) and persisted by Display.
let syncToastTimer;
function showSyncToast(offset) {
  let el = $('sync-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sync-toast';
    document.body.appendChild(el);
  }
  const ms = Math.round(offset * 1000);
  const dir = ms > 0 ? 'earlier' : ms < 0 ? 'later' : 'on time';
  el.textContent = ms === 0 ? 'Sync reset (on time)' : `Sync ${ms > 0 ? '+' : ''}${ms}ms (lyrics ${dir})`;
  el.classList.add('show');
  clearTimeout(syncToastTimer);
  syncToastTimer = setTimeout(() => el.classList.remove('show'), 1400);
}

// -------------------- fullscreen + auto-hiding bar -------------------------
addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'f') {
    if (window.smartLyric?.toggleFullscreen) window.smartLyric.toggleFullscreen();
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
});

let idleTimer;
function poke() {
  if (stage.dataset.mode !== 'playing') return;
  $('nowbar').classList.remove('hide');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => $('nowbar').classList.add('hide'), 3500);
}
addEventListener('mousemove', poke);

async function bootSetup() {
  if (window.smartLyric?.getConfig) {
    window.__SL_CONFIG__ = await window.smartLyric.getConfig();
  }
  const apple = !!window.__SL_CONFIG__?.appleMusicDeveloperToken;
  if ($('btn-apple')) $('btn-apple').hidden = !apple;
  await bootAuth();
  await Promise.all([loadChartRecs(), refreshSpotifyPanel()]);
}

bootSetup();
$('in-track').focus();
window.__sl = { display, demoClock, enterPlaying, stage, session };
