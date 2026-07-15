import { parseLRC } from './lrc.js';
import { Display } from './display.js';
import { MediaClock, PredictiveClock } from './clock.js';
import { getSynced } from './lyrics.js';
import { fetchArtworkUrl, paletteFromUrl } from './art.js';
import { Mic } from './mic.js';
import { VinylDetector } from './vinyl.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');

const display = new Display({ stage, lyricsEl: $('lyrics'), bgCanvas: $('bg') });
display.start();

const audio = $('audio');
const mediaClock = new MediaClock(audio);
const demoClock = new PredictiveClock(); // previews lyrics when no audio is attached
const vinylClock = new PredictiveClock(); // driven by mic fingerprinting

let haveAudio = false;
let mic = null;
let detector = null;

// -------------------------------- status --------------------------------
function setStatus(type, msg) {
  const el = $('setup-status');
  el.textContent = msg || '';
  el.dataset.type = type || '';
}

// ------------------------------ view modes ------------------------------
function enterSetup() {
  stage.dataset.mode = 'setup';
  clearTimeout(idleTimer);
  $('nowbar').classList.remove('hide');
  if (!audio.paused) audio.pause();
  if (demoClock.isPlaying()) demoClock.pause();
  if (vinylClock.isPlaying()) vinylClock.pause();
}

function enterPlaying() {
  stage.dataset.mode = 'playing';
  poke();
}

// --------------------- shared: fetch + show a song ----------------------
async function prepareSong({ artist, track, album, duration }) {
  setStatus('loading', `Searching for “${track}”…`);
  let result;
  try {
    result = await getSynced({ artist, track, album, duration });
  } catch {
    setStatus('error', 'Couldn’t reach the lyrics service. Check your connection and try again.');
    return false;
  }
  if (!result) {
    setStatus('error', `No synced lyrics found for “${track}”. Try adding the artist, or a different spelling.`);
    return false;
  }
  const timeline = parseLRC(result.lrc);
  if (!timeline.lines.length) {
    setStatus('error', 'Found lyrics, but they had no timing data.');
    return false;
  }
  display.setLyrics(timeline);
  const m = result.meta || {};
  $('np-title').textContent = m.trackName || track;
  $('np-artist').textContent = [m.artistName || artist, m.albumName].filter(Boolean).join(' · ');
  setStatus('', '');
  loadArtwork(m.artistName || artist, m.trackName || track);
  return { lines: timeline.lines.length };
}

async function loadArtwork(artist, track) {
  $('cover').style.backgroundImage = '';
  const url = await fetchArtworkUrl({ artist, track });
  if (!url) return;
  $('cover').style.backgroundImage = `url("${url}")`;
  const palette = await paletteFromUrl(url);
  if (palette && palette.length) display.setPalette(palette);
}

// ---------------------------- manual mode -------------------------------
$('search').addEventListener('submit', (e) => {
  e.preventDefault();
  loadManual();
});

async function loadManual() {
  stopListening();
  const artist = $('in-artist').value.trim();
  const track = $('in-track').value.trim();
  if (!track) {
    setStatus('error', 'Enter a song title.');
    $('in-track').focus();
    return;
  }
  $('btn-load').disabled = true;
  const ok = await prepareSong({ artist, track, duration: haveAudio && audio.duration ? audio.duration : undefined });
  $('btn-load').disabled = false;
  if (!ok) return;

  enterPlaying();
  if (haveAudio) {
    display.setClock(mediaClock);
    audio.play();
  } else {
    display.setClock(demoClock);
    demoClock.start(0);
  }
  updatePlayBtn();
}

// -------------------------- audio file mode -----------------------------
$('btn-audio').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  audio.src = URL.createObjectURL(file);
  haveAudio = true;
  display.setClock(mediaClock);
  setStatus('ok', `Audio ready: ${file.name}. Now load its lyrics to sync.`);
  $('in-track').focus();
});

// ------------------------------ play/pause ------------------------------
$('btn-play').addEventListener('click', togglePlay);
function togglePlay() {
  if (stage.dataset.mode !== 'playing' || detector) return;
  if (haveAudio) {
    audio.paused ? audio.play() : audio.pause();
  } else {
    demoClock.isPlaying() ? demoClock.pause() : demoClock.start(demoClock.now());
    updatePlayBtn();
  }
}
function updatePlayBtn() {
  const playing = detector ? true : haveAudio ? !audio.paused : demoClock.isPlaying();
  $('btn-play').textContent = playing ? 'Pause' : 'Play';
}
audio.addEventListener('play', updatePlayBtn);
audio.addEventListener('pause', updatePlayBtn);

// --------------------------- change song --------------------------------
$('btn-change').addEventListener('click', () => {
  stopListening();
  enterSetup();
  setStatus('', '');
});

// ------------------------ auto-detect (vinyl) ---------------------------
$('btn-listen').addEventListener('click', toggleListen);

async function toggleListen() {
  if (detector) {
    stopListening();
    enterSetup();
    return;
  }
  if (!window.smartLyric || !window.smartLyric.identify) {
    setStatus('error', 'Auto-detect needs the desktop app (run: npm start). It uses the mic + fingerprinting.');
    return;
  }
  try {
    mic = new Mic();
    await mic.start();
  } catch {
    setStatus('error', 'Could not access the microphone. Check permissions and try again.');
    return;
  }
  display.setClock(vinylClock);
  $('np-title').textContent = 'Listening…';
  $('np-artist').textContent = 'Start the record near the mic';
  $('cover').style.backgroundImage = '';
  enterPlaying();
  $('btn-play').textContent = 'Listening';

  detector = new VinylDetector({
    identify: async (wav) => {
      const r = await window.smartLyric.identify(wav);
      if (r && r.error) {
        setStatus('error', `Fingerprint error: ${r.error}`);
        return null;
      }
      return r;
    },
    getChunk: () => mic.captureChunk(),
    clock: vinylClock,
    onSong: (meta) => prepareSong({ artist: meta.artist, track: meta.title, album: meta.album, duration: meta.duration }),
    onState: (s) => {
      if (s === 'locked') $('btn-play').textContent = 'Following';
      else if (s === 'listening') { $('np-title').textContent = 'Listening…'; $('np-artist').textContent = 'Start the record near the mic'; }
    },
  });
  detector.start();
}

function stopListening() {
  if (!detector) return;
  detector.stop();
  mic && mic.stop();
  detector = null;
  mic = null;
}

// -------------------- fullscreen + auto-hiding bar ----------------------
addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'f') {
    if (window.smartLyric && window.smartLyric.toggleFullscreen) window.smartLyric.toggleFullscreen();
    else if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  }
  if (e.code === 'Space' && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    togglePlay();
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

$('in-track').focus();

// Dev-only handle for verifying the lyric view without the network.
window.__sl = { display, demoClock, enterPlaying, stage };
