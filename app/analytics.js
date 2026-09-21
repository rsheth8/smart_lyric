// Anonymous product counters: where people drop off between opening the app,
// picking a song, the song being ready, and actually singing it. No ids, no song
// names, no cookies — only bucketed tallies per day. Vercel Web Analytics custom
// events need a Pro plan, so this rides the Upstash store the phone relay
// already uses (api/event.js). Read them with scripts/events.mjs.

const SURFACE = ['tv', 'desktop', 'tvos']; // tvos = the native Apple TV app (tvos/)

// Allowlist: every event name, data key and value is fixed, so a forged beacon
// can't create unbounded counter fields.
export const EVENTS = {
  app_open: { surface: SURFACE },
  song_load: { surface: SURFACE },
  song_ready: { surface: SURFACE, wait: ['<2s', '2-10s', '10-30s', '>30s'] },
  song_exit: { surface: SURFACE, sung: ['<25%', '25-75%', '>75%'] },
  remote_paired: {},
  party_on: {},
  clip_made: { surface: SURFACE },
  mic_on: { surface: SURFACE },
  // The TV worked out what was playing by listening to the room (tvOS auto-sync).
  song_heard: { surface: SURFACE },
  song_scored: { surface: SURFACE, grade: ['Superstar', 'Headliner', 'Encore', 'Warmed up', 'Keep going'] },
  // Hearing yourself through the TV; latency is Monitor.Latency in tvos/, so we
  // learn how many real TVs are too slow for it.
  monitor_on: { surface: SURFACE, latency: ['comfortable', 'noticeable', 'tooSlow'] },
};

export function waitBucket(ms) {
  return ms < 2000 ? '<2s' : ms < 10000 ? '2-10s' : ms < 30000 ? '10-30s' : '>30s';
}

export function sungBucket(frac) {
  return frac < 0.25 ? '<25%' : frac <= 0.75 ? '25-75%' : '>75%';
}

/** Validate an event (JSON string or object); returns its counter field, or null. */
export function eventField(body) {
  let e;
  try {
    e = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return null;
  }
  if (!Object.hasOwn(EVENTS, e?.name)) return null;
  const parts = [e.name];
  for (const [key, allowed] of Object.entries(EVENTS[e.name])) {
    const v = e.data?.[key];
    if (v === undefined) continue;
    if (!allowed.includes(v)) return null;
    parts.push(`${key}=${v}`);
  }
  return parts.join('|');
}

/** Fire-and-forget; never blocks or throws into the UI. */
export function track(name, data = {}) {
  try {
    navigator.sendBeacon?.('/api/event', JSON.stringify({ name, data }));
  } catch {
    /* analytics must never break the app */
  }
}
