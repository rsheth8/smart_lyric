// Short-lived storage for the Apple TV pairing handshake.
//
// The TV and the phone are two different clients that have to meet somewhere:
// the TV mints a code, the phone completes the Spotify OAuth against that code,
// and the TV polls until the tokens appear. That needs a store both requests
// can see — which on Vercel means a real one, because each request may be a
// different lambda.
//
// Deliberately pluggable. This needs to hold ~200 bytes for ten minutes, which
// every managed datastore on earth can do, so it should not force a particular
// vendor — free tiers move around (Upstash dropped theirs) and re-plumbing an
// OAuth flow because a pricing page changed is a bad trade. First backend whose
// env vars are present wins:
//
//   1. Supabase          SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
//   2. Upstash-protocol  KV_REST_API_URL + KV_REST_API_TOKEN  (Vercel KV too)
//   3. memory            nothing set — correct for `npm run dev`, NOT for
//                        serverless, where each request may be a cold lambda
//
// Anything reaching this file is a Spotify refresh token, so the Supabase path
// uses the service-role key and a table that is never exposed to the anon role.

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const KV_URL = (process.env.KV_REST_API_URL || '').replace(/\/+$/, '');
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';

const SUPABASE_TABLE = process.env.SUPABASE_PAIR_TABLE || 'tv_pairings';

/** Which backend is in use. Surfaced to the TV so it can warn instead of hanging. */
export const backend = SUPABASE_URL && SUPABASE_KEY
  ? 'supabase'
  : KV_URL && KV_TOKEN
    ? 'kv'
    : 'memory';

/** True when a real shared store is configured. */
export const isDurable = backend !== 'memory';

const memory = new Map();

// MARK: - Supabase (PostgREST)

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function supabasePut(key, value, ttlSec) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`, {
    method: 'POST',
    // Upsert: a retried pairing must overwrite, not collide on the primary key.
    headers: supabaseHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({
      key,
      value,
      expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
    }),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`supabase put ${res.status}: ${await res.text().catch(() => '')}`);
}

async function supabaseGet(key) {
  const url =
    `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}` +
    `?key=eq.${encodeURIComponent(key)}&select=value,expires_at`;
  const res = await fetch(url, { headers: supabaseHeaders(), signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  const rows = await res.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  // Postgres has no native row TTL, so expiry is enforced here rather than
  // trusted to a cleanup job that may not have run yet.
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    supabaseDel(key).catch(() => {});
    return null;
  }
  return row.value ?? null;
}

async function supabaseDel(key) {
  await fetch(
    `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?key=eq.${encodeURIComponent(key)}`,
    {
      method: 'DELETE',
      headers: supabaseHeaders({ Prefer: 'return=minimal' }),
      signal: AbortSignal.timeout(6000),
    }
  );
}

// MARK: - Upstash-protocol REST KV

async function kv(command) {
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`KV ${res.status}`);
  const data = await res.json();
  return data?.result ?? null;
}

// MARK: - Public API

/**
 * @param {string} key
 * @param {any} value
 * @param {number} ttlSec
 */
export async function put(key, value, ttlSec) {
  switch (backend) {
    case 'supabase':
      return supabasePut(key, value, ttlSec);
    case 'kv':
      await kv(['SET', key, JSON.stringify(value), 'EX', String(ttlSec)]);
      return;
    default:
      memory.set(key, { value, expires: Date.now() + ttlSec * 1000 });
      sweep();
  }
}

/** @param {string} key */
export async function get(key) {
  switch (backend) {
    case 'supabase':
      return supabaseGet(key);
    case 'kv': {
      const raw = await kv(['GET', key]);
      if (!raw) return null;
      try {
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        return null;
      }
    }
    default: {
      const hit = memory.get(key);
      if (!hit) return null;
      if (hit.expires < Date.now()) {
        memory.delete(key);
        return null;
      }
      return hit.value;
    }
  }
}

/** @param {string} key */
export async function del(key) {
  switch (backend) {
    case 'supabase':
      return supabaseDel(key);
    case 'kv':
      await kv(['DEL', key]);
      return;
    default:
      memory.delete(key);
  }
}

/** Drop expired entries so a long-running dev server doesn't grow forever. */
function sweep() {
  if (memory.size < 64) return;
  const now = Date.now();
  for (const [k, v] of memory) {
    if (v.expires < now) memory.delete(k);
  }
}
