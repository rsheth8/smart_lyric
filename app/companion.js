// Phone ⇄ TV companion remote.
//
// A phone can't reach the TV directly, so both ends talk to a relay over two
// plain HTTP verbs — SSE to listen, POST to send — addressed by an 8-character
// room code. The LAN relay (server.mjs, which Electron also hosts) and the
// hosted relay (api/companion.js on Vercel) speak the same API, so this client
// never knows which one it is on.
//
// Phone messages are untrusted input: parseCommand() is the single gate every
// one passes before the TV acts on it. Everything except openLink() is pure, so
// it unit-tests without a DOM.

// No I/O/0/1 — a code read off a TV shouldn't be ambiguous. 32 symbols, so a
// random byte masked to 5 bits picks uniformly.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_RE = /^[A-HJ-NP-Z2-9]{8}$/;
export const ROLES = ['tv', 'phone'];
// TV → phone state carries the queue (with artwork URLs), so the cap has room
// for QUEUE_MAX songs at ~300 bytes each.
export const MAX_MESSAGE_BYTES = 16384;
export const QUEUE_MAX = 30;
// Guest rooms: several phones share one room. Each gets its own id so the hosted
// relay can give every phone its own copy of the TV's updates.
export const PEER_RE = /^[a-hj-np-z2-9]{12}$/;
export const NAME_MAX = 24;

const NUDGES_MS = [-100, -25, 25, 100];

export function newRoomCode() {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => ALPHABET[b & 31]).join('');
}

export function newPeerId() {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => ALPHABET[b & 31].toLowerCase()).join('');
}

function text(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** A guest's display name: control characters removed, trimmed, capped. '' if none. */
export function parseName(v) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX) : '';
}

/**
 * Validate a song picked on the phone.
 * @returns {{artist:string, track:string, duration?:number, artwork?:string} | null}
 */
export function parseSong(s) {
  if (!s || typeof s !== 'object') return null;
  const track = text(s.track);
  if (!track) return null;
  const song = { artist: text(s.artist), track };
  if (Number.isFinite(s.duration) && s.duration > 0 && s.duration < 3600) song.duration = s.duration;
  const art = text(s.artwork, 500);
  if (art.startsWith('https://')) song.artwork = art;
  return song;
}

/**
 * Normalise one phone → TV message, or null if it isn't a valid command.
 * Unknown fields are dropped; nothing from the phone reaches the app unshaped.
 */
export function parseCommand(msg) {
  if (!msg || typeof msg !== 'object') return null;
  // Guests sign what they add; the name is display-only (textContent on both ends).
  const by = parseName(msg.by);
  const signed = (cmd) => (by ? { ...cmd, by } : cmd);
  switch (msg.type) {
    case 'hello':
      return signed({ type: 'hello' });
    case 'toggle':
    case 'change':
    case 'next':
      return { type: msg.type };
    case 'play':
    case 'queue': {
      const song = parseSong(msg.song);
      return song ? signed({ type: msg.type, song }) : null;
    }
    case 'unqueue':
      return Number.isInteger(msg.index) && msg.index >= 0 ? { type: 'unqueue', index: msg.index } : null;
    case 'nudge':
      return NUDGES_MS.includes(msg.ms) ? { type: 'nudge', ms: msg.ms } : null;
    case 'feel':
      return msg.sense === 'early' || msg.sense === 'late' ? { type: 'feel', sense: msg.sense } : null;
    default:
      return null;
  }
}

/**
 * Has the song on screen run out? True once the clock passes both the last
 * lyric line and the timeline's duration, plus an outro grace.
 */
export function songFinished({ now, timeline, graceSec = 6 }) {
  const lines = timeline?.lines;
  if (!lines?.length || !Number.isFinite(now)) return false;
  const end = Math.max(lines[lines.length - 1].end || 0, timeline.duration || 0);
  return end > 0 && now > end + graceSec;
}

export function relayUrl(base, room, role, peer = '') {
  return `${base}/api/companion?room=${room}&role=${role}${peer ? `&peer=${peer}` : ''}`;
}

/**
 * Open one end of a room: SSE in, POST out. The POST body is text/plain so it
 * stays a CORS "simple request" — the Electron renderer (file:// origin) needs
 * no preflight. EventSource reconnects on its own after drops.
 */
export function openLink({ base, room, role, peer = '', onMessage, onStatus = () => {} }) {
  const url = relayUrl(base, room, role, peer);
  const es = new EventSource(url);
  es.onopen = () => onStatus('open');
  es.onerror = () => onStatus('retrying');
  es.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    onMessage(msg);
  };
  return {
    send: (msg) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(msg) })
        .catch(() => {}),
    close: () => es.close(),
  };
}
