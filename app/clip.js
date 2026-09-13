// Shareable clips: 15 seconds of the lyric view as a vertical (9:16) video with
// the singer's voice, sized for TikTok / Reels / Shorts.
//
// The lyric view is DOM, and a page can't record itself without a screen-share
// prompt, so a clip redraws the essentials — song card, the line being sung with
// its karaoke wipe, the next line, a link back — onto its own 1080×1920 canvas
// and records that canvas plus the microphone with MediaRecorder.
//
// Audio is the mic only, never the track: a clip is the user's performance, not
// a copy of the recording.

import { wipeProgress } from './display.js';

export const CLIP_W = 1080;
export const CLIP_H = 1920;
export const CLIP_SECONDS = 15;

// MP4 first — it's what phones and the social apps take (Chromium 126+ records
// it); WebM where that's all the browser has.
const TYPES = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
const FONT = '"SF Pro Display", -apple-system, system-ui, sans-serif';

export function pickMimeType(isSupported) {
  return TYPES.find((t) => isSupported(t)) || '';
}

/** Greedy word wrap: rows of words whose measured width fits maxWidth. */
export function wrapWords(words, measure, maxWidth) {
  const rows = [];
  const space = measure(' ');
  let row = [];
  let width = 0;
  for (const word of words) {
    const w = measure(word.text);
    if (row.length && width + space + w > maxWidth) {
      rows.push(row);
      row = [];
      width = 0;
    }
    width += (row.length ? space : 0) + w;
    row.push(word);
  }
  if (row.length) rows.push(row);
  return rows;
}

function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

function loadImage(src) {
  if (!src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    // Without CORS the canvas turns origin-unclean and refuses to be recorded,
    // so art that won't load cross-origin is simply left out.
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function drawLine(ctx, words, t, { y, size, colors, highlight }) {
  ctx.font = `800 ${size}px ${FONT}`;
  const measure = (s) => ctx.measureText(s).width;
  const rows = wrapWords(words, measure, CLIP_W - 160);
  const lh = Math.round(size * 1.22);
  const space = measure(' ');
  rows.forEach((row, r) => {
    const rowW = row.reduce((sum, w, i) => sum + measure(w.text) + (i ? space : 0), 0);
    let x = (CLIP_W - rowW) / 2;
    const ry = y + r * lh;
    for (const word of row) {
      const w = measure(word.text);
      const p = highlight && t != null ? wipeProgress(t, word.start, word.end) : 0;
      ctx.fillStyle = p >= 1 ? colors.sung : colors.upcoming;
      ctx.fillText(word.text, x, ry);
      if (p > 0 && p < 1) {
        // Karaoke wipe: repaint the sung fraction of the word in the accent.
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, ry - size, w * p, size * 1.4);
        ctx.clip();
        ctx.fillStyle = colors.current;
        ctx.fillText(word.text, x, ry);
        ctx.restore();
      }
      x += w + space;
    }
  });
  return y + rows.length * lh;
}

function drawFrame(ctx, { display, art, meta, colors, now }) {
  // Ambient backdrop in the song's palette, drifting like the live view's.
  ctx.fillStyle = '#0b0908';
  ctx.fillRect(0, 0, CLIP_W, CLIP_H);
  display.palette.forEach((c, i) => {
    const ph = now * 0.12 + i * 2.1;
    const x = CLIP_W * (0.5 + 0.35 * Math.sin(ph));
    const y = CLIP_H * (0.5 + 0.3 * Math.cos(ph * 0.8 + i));
    const g = ctx.createRadialGradient(x, y, 0, x, y, CLIP_W * 0.9);
    g.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},0.45)`);
    g.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CLIP_W, CLIP_H);
  });

  // Song card.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const top = 200;
  const textX = art ? 350 : 90;
  if (art) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(90, top, 220, 220, 28);
    ctx.clip();
    ctx.drawImage(art, 90, top, 220, 220);
    ctx.restore();
  }
  ctx.fillStyle = colors.text;
  ctx.font = `750 58px ${FONT}`;
  ctx.fillText(fitText(ctx, meta.track || '', CLIP_W - textX - 90), textX, top + 100);
  ctx.fillStyle = colors.dim;
  ctx.font = `600 42px ${FONT}`;
  ctx.fillText(fitText(ctx, meta.artist || '', CLIP_W - textX - 90), textX, top + 165);

  // The line being sung, and the next one.
  const t = display.cueTime();
  const lines = display.lines || [];
  const li = display.activeLine;
  const cur = li >= 0 ? lines[li] : null;
  const next = lines[li + 1];
  let y = CLIP_H * 0.44;
  if (cur) {
    y = drawLine(ctx, cur.words, t, { y, size: 96, colors, highlight: true });
  } else {
    ctx.textAlign = 'center';
    ctx.fillStyle = colors.current;
    ctx.font = `700 120px ${FONT}`;
    ctx.fillText('♪', CLIP_W / 2, y);
    ctx.textAlign = 'left';
    y += 150;
  }
  if (next) {
    ctx.globalAlpha = 0.55;
    drawLine(ctx, next.words, t, { y: y + 60, size: 66, colors, highlight: false });
    ctx.globalAlpha = 1;
  }

  // The link back is the point: every shared clip says where it was made.
  ctx.textAlign = 'center';
  ctx.fillStyle = colors.dim;
  ctx.font = `650 40px ${FONT}`;
  ctx.fillText('Sung on Bar4Bar · smartlyric.vercel.app', CLIP_W / 2, CLIP_H - 150);
}

/**
 * Record `seconds` of the live lyric view with the mic.
 * @returns {Promise<{ blob: Blob, ext: string, hasVoice: boolean }>}
 */
export async function recordClip({ display, stage, meta = {}, artUrl, seconds = CLIP_SECONDS, onTick = () => {} }) {
  const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
  if (!mimeType) throw new Error('This browser can’t record video clips');

  const canvas = Object.assign(document.createElement('canvas'), { width: CLIP_W, height: CLIP_H });
  const ctx = canvas.getContext('2d');
  const css = getComputedStyle(stage);
  const colors = {
    sung: css.getPropertyValue('--sung').trim() || '#f6f0e4',
    current: css.getPropertyValue('--accent').trim() || '#e3c27a',
    upcoming: 'rgba(246, 240, 228, .4)',
    text: '#f6f0e4',
    dim: 'rgba(246, 240, 228, .6)',
  };
  const art = await loadImage(artUrl);

  let mic = null;
  try {
    // Voice-friendly processing on (unlike the aligner's raw capture).
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    /* no mic or permission denied — record the video on its own */
  }

  const stream = canvas.captureStream(30);
  mic?.getAudioTracks().forEach((track) => stream.addTrack(track));
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const stopped = new Promise((resolve) => {
    rec.onstop = resolve;
  });

  const t0 = performance.now();
  let raf = 0;
  const draw = () => {
    const elapsed = (performance.now() - t0) / 1000;
    drawFrame(ctx, { display, art, meta, colors, now: performance.now() / 1000 });
    onTick(Math.max(0, seconds - elapsed));
    raf = requestAnimationFrame(draw);
  };
  draw();
  rec.start(500);
  // A timer, not the draw loop, ends the clip: rAF stalls in a hidden tab.
  // ponytail: a hidden tab records frozen frames; fine, clips are made on screen.
  const stopTimer = setTimeout(() => rec.state !== 'inactive' && rec.stop(), seconds * 1000);
  try {
    await stopped;
  } finally {
    clearTimeout(stopTimer);
    cancelAnimationFrame(raf);
    stream.getTracks().forEach((track) => track.stop());
  }
  return {
    blob: new Blob(chunks, { type: mimeType }),
    ext: mimeType.startsWith('video/mp4') ? 'mp4' : 'webm',
    hasVoice: !!mic,
  };
}
