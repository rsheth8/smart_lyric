// The cinematic display: renders a lyric timeline and drives the word-by-word
// highlight from a clock. It's deliberately dumb about WHERE time comes from —
// it just calls clock.now() each frame. Same engine, any clock.

// Vertical translate that brings a line's center to the viewport center.
// `lineTop` must be measured relative to the scrolling #lyrics element.
export function centerTranslate(viewportH, lineTop, lineHeight) {
  return Math.round(viewportH / 2 - (lineTop + lineHeight / 2));
}

const SYNC_KEY = 'sl_sync_offset';
function loadSyncOffset() {
  try {
    const v = parseFloat(localStorage.getItem(SYNC_KEY));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}
function saveSyncOffset(v) {
  try {
    localStorage.setItem(SYNC_KEY, String(v));
  } catch {
    /* ignore */
  }
}

export class Display {
  constructor({ stage, lyricsEl, bgCanvas }) {
    this.stage = stage;
    this.lyricsEl = lyricsEl;
    this.bg = bgCanvas;
    this.bx = bgCanvas.getContext('2d');
    this.clock = null;
    this.lines = [];
    this.lineEls = [];
    this.activeLine = -1;
    this.raf = null;
    // Manual fine-tune (seconds). Positive = lyrics lead (show earlier), which
    // counters output/network lag so highlighting lands on the beat. Persisted
    // because the right value depends on the user's speakers/device/stream path.
    this.syncOffset = loadSyncOffset();
    // Album-art-derived palette (RGB triplets). Sensible default until we have art.
    this.palette = [[82, 229, 255], [255, 113, 91], [18, 59, 83]];
    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
    this._resize();
  }

  setClock(clock) {
    this.clock = clock;
  }

  setPalette(colors) {
    if (colors && colors.length) this.palette = colors;
  }

  // Nudge the manual sync offset (seconds) and persist. Returns the new value.
  nudgeSyncOffset(deltaSec) {
    this.syncOffset = Math.round((this.syncOffset + deltaSec) * 1000) / 1000;
    saveSyncOffset(this.syncOffset);
    return this.syncOffset;
  }

  resetSyncOffset() {
    this.syncOffset = 0;
    saveSyncOffset(0);
    return 0;
  }

  // Build DOM from a parsed timeline ({ lines: [{ start, end, words }] }).
  setLyrics(timeline) {
    this.lines = timeline.lines || [];
    this.lyricsEl.innerHTML = '';
    this.lineEls = this.lines.map((line) => {
      const el = document.createElement('div');
      el.className = 'line';
      for (const word of line.words) {
        const s = document.createElement('span');
        s.className = 'word';
        s.textContent = word.text;
        el.appendChild(s);
        word.el = s;
      }
      this.lyricsEl.appendChild(el);
      line.el = el;
      return el;
    });
    this.activeLine = -1;
    this._resize();
  }

  start() {
    if (this.raf) return;
    const loop = (t) => {
      this._frame(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.bg.width = window.innerWidth * dpr;
    this.bg.height = window.innerHeight * dpr;
    this.bx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.activeLine >= 0) this._centerOn(this.activeLine);
  }

  _centerOn(idx) {
    const el = this.lineEls[idx];
    if (!el) return;
    const H = window.innerHeight;
    if (!H) return; // viewport not laid out yet — try again next frame
    const y = centerTranslate(H, el.offsetTop, el.offsetHeight);
    if (y !== this._lastY) {
      this.lyricsEl.style.transform = `translateY(${y}px)`;
      this._lastY = y;
    }
  }

  _frame(rafTime) {
    if (!this.clock || !this.lines.length) {
      this._drawBg(rafTime / 1000, 0);
      return;
    }
    const t = this.clock.now() + this.syncOffset;

    // Which line are we on? -1 before the first line begins.
    let li = -1;
    for (let i = 0; i < this.lines.length; i++) {
      if (t >= this.lines[i].start) li = i;
      else break;
    }
    const shown = Math.max(0, li);

    if (li !== this.activeLine) {
      this.lineEls.forEach((el, i) => {
        el.classList.toggle('active', i === li);
        el.classList.toggle('past', li >= 0 && i < li);
      });
      this.activeLine = li;
    }
    // Recompute centering every frame so it self-heals after viewport changes
    // (window resize, projector connect, or a briefly zero-height viewport).
    this._centerOn(shown);

    // Word states within the active line.
    if (li >= 0) {
      for (const word of this.lines[li].words) {
        const c = word.el.classList;
        if (t >= word.end) {
          c.add('sung');
          c.remove('current');
        } else if (t >= word.start) {
          c.add('current');
          c.remove('sung');
        } else {
          c.remove('current', 'sung');
        }
      }
    }

    const prog = this.lines.length ? shown / this.lines.length : 0;
    this._drawBg(rafTime / 1000, prog);
  }

  // Ambient album-art glow: slow-drifting radial blobs in the palette colors.
  _drawBg(time, prog) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const st = time * 0.55; // calm drift
    const bx = this.bx;
    bx.clearRect(0, 0, W, H);
    bx.fillStyle = '#070c16';
    bx.fillRect(0, 0, W, H);
    for (let i = 0; i < this.palette.length; i++) {
      const c = this.palette[i];
      const ph = st * (0.12 + i * 0.05) + i * 2.1 + prog * 3;
      const x = W * (0.5 + 0.32 * Math.sin(ph));
      const y = H * (0.5 + 0.3 * Math.cos(ph * 0.8 + i));
      const r = Math.min(W, H) * (0.55 + 0.12 * Math.sin(st * 0.5 + i));
      const g = bx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},0.45)`);
      g.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
      bx.fillStyle = g;
      bx.fillRect(0, 0, W, H);
    }
  }
}
