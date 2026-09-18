import test from 'node:test';
import assert from 'node:assert/strict';
// Isolated process (node:test runs files separately); always use disposable memory.
for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'KV_REST_API_URL', 'KV_REST_API_TOKEN']) delete process.env[key];
const pair = await import('../lib/tv-pair.mjs');
const store = await import('../lib/pair-store.mjs');
const { default: handler } = await import('../api/tv-pair.js');

test('TV pairing requests follow and queue permissions', () => {
  assert.equal(
    pair.SCOPES,
    'user-read-currently-playing user-read-playback-state user-modify-playback-state'
  );
});

test('TV pairing uses PKCE and redeems the result only once', async () => {
  const started = await pair.start();
  assert.match(started.code, /^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/);
  assert.equal((await pair.poll(started.pollToken)).status, 'pending');
  const redirectUri = 'https://example.test/api/tv-pair?action=callback';
  const auth = new URL((await pair.authorizeURL(started.code, { clientId: 'test', redirectUri })).url);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('redirect_uri'), redirectUri);
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.body.get('grant_type'), 'authorization_code');
    assert.ok(options.body.get('code_verifier'));
    return Response.json({ access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600 });
  };
  try {
    assert.deepEqual(await pair.completeCallback({ code: 'test-code', state: started.code, clientId: 'test', redirectUri }), { ok: true });
  } finally { globalThis.fetch = original; }
  const ready = await pair.poll(started.pollToken);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.tokens.refresh_token, 'test-refresh');
  assert.equal((await pair.poll(started.pollToken)).status, 'expired');
});

test('expired pairing records cannot authorize or poll', async () => {
  const started = await pair.start();
  await store.put(`tvpair:code:${started.code}`, {}, -1);
  assert.ok((await pair.authorizeURL(started.code, {clientId: 'test', redirectUri: 'https://example.test'})).error);
  assert.equal((await pair.poll(started.pollToken)).status, 'expired');
});

test('refresh preserves the existing refresh token unless Spotify rotates it', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ access_token: 'new', expires_in: 3600 });
  try {
    assert.equal((await pair.refresh('existing', {clientId: 'test'})).refresh_token, 'existing');
  } finally { globalThis.fetch = original; }
});

test('serverless pairing fails clearly when shared storage is missing', async () => {
  process.env.VERCEL = '1';
  process.env.SPOTIFY_CLIENT_ID = 'test';
  let payload;
  const res = { statusCode: 0, setHeader() {}, end(body) { payload = JSON.parse(body); } };
  try {
    await handler({ url: '/api/tv-pair?action=start', headers: { host: 'example.test' } }, res);
    assert.equal(res.statusCode, 503);
    assert.match(payload.error, /temporarily unavailable/);
    assert.equal(payload.pollToken, undefined);
  } finally { delete process.env.VERCEL; delete process.env.SPOTIFY_CLIENT_ID; }
});

test('revoked Spotify credentials are distinguished from a temporary outage', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({error: 'invalid_grant'}, {status: 400});
    assert.equal((await pair.refresh('revoked', {clientId: 'test'})).status, 401);
    globalThis.fetch = async () => new Response('', {status: 503});
    assert.equal((await pair.refresh('keep-this-token', {clientId: 'test'})).status, 502);
  } finally { globalThis.fetch = original; }
});
