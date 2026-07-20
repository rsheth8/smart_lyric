// BroadcastChannel bridge: main window publishes display state for overlay/OBS.

const CHANNEL = 'bar4bar';

export function createSyncPublisher({ display, getMeta, getClock }) {
  const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;
  let raf = null;

  function snapshot() {
    const clock = getClock?.();
    const meta = getMeta?.() || {};
    return {
      type: 'state',
      meta,
      palette: display.palette,
      position: clock?.now?.() ?? 0,
      isPlaying: clock?.isPlaying?.() ?? false,
      timeline: serializeTimeline(display.lines),
    };
  }

  function tick() {
    if (bc) bc.postMessage(snapshot());
    raf = requestAnimationFrame(tick);
  }

  function start() {
    if (!bc) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    cancelAnimationFrame(raf);
    bc?.close();
  }

  function publishFull() {
    bc?.postMessage(snapshot());
  }

  return { start, stop, publishFull, channel: CHANNEL };
}

export function createSyncSubscriber(onState) {
  const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;
  if (bc) {
    bc.onmessage = (e) => {
      if (e.data?.type === 'state') onState(e.data);
    };
  }
  return () => bc?.close();
}

function serializeTimeline(lines) {
  return (lines || []).map((l) => ({
    start: l.start,
    end: l.end,
    // Carry confidence so the overlay dims low-confidence lines/words like the
    // main window: `uncertain` → line-level render, `score` → softened wipe.
    uncertain: l.uncertain,
    words: l.words.map((w) => ({ text: w.text, start: w.start, end: w.end, score: w.score })),
  }));
}

export { CHANNEL, serializeTimeline };
