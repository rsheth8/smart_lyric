import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { signedFields, normalizeMatch, acrConfigured, identify } from '../lib/acrcloud.mjs';

const ENV = {
  ACRCLOUD_HOST: 'identify-eu-west-1.acrcloud.com',
  ACRCLOUD_ACCESS_KEY: 'key123',
  ACRCLOUD_ACCESS_SECRET: 'secret456',
};

describe('acrcloud — the signature', () => {
  it('signs exactly the six newline-joined fields ACRCloud expects', () => {
    const fields = signedFields({ accessKey: 'key123', accessSecret: 'secret456', timestamp: '1700000000' });
    // Recomputed independently: a wrong field order or separator still produces a
    // plausible-looking base64 string, and ACRCloud's error doesn't say which.
    const expected = crypto
      .createHmac('sha1', 'secret456')
      .update('POST\n/v1/identify\nkey123\naudio\n1\n1700000000')
      .digest('base64');
    assert.equal(fields.signature, expected);
    assert.equal(fields.access_key, 'key123');
    assert.equal(fields.data_type, 'audio');
    assert.equal(fields.signature_version, '1');
    assert.equal(fields.timestamp, '1700000000');
  });

  it('changes the signature when the timestamp changes', () => {
    const a = signedFields({ accessKey: 'k', accessSecret: 's', timestamp: '1' });
    const b = signedFields({ accessKey: 'k', accessSecret: 's', timestamp: '2' });
    assert.notEqual(a.signature, b.signature);
  });
});

describe('acrcloud — configuration', () => {
  it('needs all three variables', () => {
    assert.equal(acrConfigured(ENV), true);
    assert.equal(acrConfigured({ ...ENV, ACRCLOUD_ACCESS_SECRET: '' }), false);
    assert.equal(acrConfigured({}), false);
  });

  it('refuses to call out when unconfigured', async () => {
    await assert.rejects(() => identify(Buffer.from('wav'), {}), /not configured/);
  });
});

describe('acrcloud — reading a result', () => {
  const hit = (music) => ({ status: { code: 0, msg: 'Success' }, metadata: { music: [music] } });

  it('pulls out the play offset, which is the whole point', () => {
    const m = normalizeMatch(
      hit({ acrid: 'abc', title: 'Yellow', artists: [{ name: 'Coldplay' }], play_offset_ms: 41500, duration_ms: 266000, score: 92 })
    );
    assert.equal(m.offsetSec, 41.5);
    assert.equal(m.durationSec, 266);
    assert.equal(m.recordingId, 'abc');
    assert.equal(m.title, 'Yellow');
  });

  it('normalises confidence from 0..100 to the 0..1 the detector gates on', () => {
    assert.equal(normalizeMatch(hit({ title: 't', score: 92 })).score, 0.92);
    assert.equal(normalizeMatch(hit({ title: 't', score: 0 })).score, 0);
    // No score reported at all means "we matched it" — don't gate it out as 0.
    assert.equal(normalizeMatch(hit({ title: 't' })).score, 1);
  });

  it('joins multiple credited artists', () => {
    const m = normalizeMatch(hit({ title: 't', artists: [{ name: 'A' }, { name: 'B' }, { name: '' }] }));
    assert.equal(m.artist, 'A, B');
  });

  it('falls back to title|artist when there is no acrid', () => {
    assert.equal(normalizeMatch(hit({ title: 'Yellow', artists: [{ name: 'Coldplay' }] })).recordingId, 'Yellow|Coldplay');
  });

  it('reports a missing offset as null rather than zero', () => {
    // Zero would mean "the song just started" and would yank the lyrics to 0:00.
    assert.equal(normalizeMatch(hit({ title: 't' })).offsetSec, null);
    assert.equal(normalizeMatch(hit({ title: 't' })).durationSec, null);
  });

  it('treats status 1001 as a clean miss, not an error', () => {
    assert.equal(normalizeMatch({ status: { code: 1001, msg: 'No result' } }), null);
  });

  it('treats an empty music list as a miss', () => {
    assert.equal(normalizeMatch({ status: { code: 0 }, metadata: { music: [] } }), null);
    assert.equal(normalizeMatch({ status: { code: 0 } }), null);
  });

  it('throws on a real service error so the route can 502', () => {
    assert.throws(() => normalizeMatch({ status: { code: 3003, msg: 'Limit exceeded' } }), /3003.*Limit exceeded/);
  });
});

describe('acrcloud — the request', () => {
  it('posts the sample and its signed fields to the configured host', async () => {
    let seen = null;
    const fakeFetch = async (url, opts) => {
      seen = { url, form: opts.body };
      return { ok: true, json: async () => ({ status: { code: 1001 } }) };
    };
    const out = await identify(Buffer.from('RIFFfake'), ENV, fakeFetch);

    assert.equal(out, null);
    assert.equal(seen.url, 'https://identify-eu-west-1.acrcloud.com/v1/identify');
    assert.equal(seen.form.get('access_key'), 'key123');
    assert.equal(seen.form.get('sample_bytes'), '8');
    assert.ok(seen.form.get('signature'), 'must send a signature');
    assert.ok(seen.form.get('sample'), 'must send the audio');
  });

  it('turns a non-200 into an error the route can report', async () => {
    const fakeFetch = async () => ({ ok: false, status: 429 });
    await assert.rejects(() => identify(Buffer.from('x'), ENV, fakeFetch), /HTTP 429/);
  });
});

describe('/api/identify — the route the Apple TV calls', () => {
  // Minimal req/res doubles: the handler only needs an async-iterable body and
  // these three bits of the response.
  const request = (body, method = 'POST') => ({
    method,
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body);
    },
  });
  const response = () => ({
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v; },
    end(b = '') { this.body = b; },
  });

  async function call(req, { acr, env = ENV } = {}) {
    const savedEnv = { ...process.env };
    const savedFetch = globalThis.fetch;
    Object.assign(process.env, env);
    if (acr) globalThis.fetch = acr;
    try {
      const { default: handler } = await import(`../api/identify.js?t=${Math.random()}`);
      const res = response();
      await handler(req, res);
      return res;
    } finally {
      globalThis.fetch = savedFetch;
      for (const k of Object.keys(ENV)) delete process.env[k];
      Object.assign(process.env, savedEnv);
    }
  }

  it('returns the normalised match for a hit', async () => {
    const acr = async () => ({
      ok: true,
      json: async () => ({
        status: { code: 0 },
        metadata: { music: [{ acrid: 'abc', title: 'Yellow', artists: [{ name: 'Coldplay' }], play_offset_ms: 41500, score: 92 }] },
      }),
    });
    const res = await call(request('RIFFfake'), { acr });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body).match.offsetSec, 41.5);
    assert.equal(res.headers['Cache-Control'], 'no-store');
  });

  it('returns match:null for a clean miss, not an error', async () => {
    const acr = async () => ({ ok: true, json: async () => ({ status: { code: 1001 } }) });
    const res = await call(request('RIFFfake'), { acr });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).match, null);
  });

  it('502s when the service errors', async () => {
    const acr = async () => ({ ok: false, status: 429 });
    const res = await call(request('RIFFfake'), { acr });
    assert.equal(res.statusCode, 502);
    assert.match(JSON.parse(res.body).error, /429/);
  });

  it('503s when recognition is not configured', async () => {
    const res = await call(request('RIFFfake'), { env: {} });
    assert.equal(res.statusCode, 503);
  });

  it('rejects an empty sample rather than paying for the lookup', async () => {
    let called = false;
    const res = await call(request(''), { acr: async () => { called = true; } });
    assert.equal(res.statusCode, 413);
    assert.equal(called, false);
  });

  it('only answers POST', async () => {
    const res = await call(request('', 'GET'));
    assert.equal(res.statusCode, 405);
  });
});
