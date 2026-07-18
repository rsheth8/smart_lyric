import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mixToNet, netToMix, mdxChunkSamples } from '../lib/mdx.mjs';

// dimF = nFft/2 keeps all positive-frequency bins, so an identity "model" (pass
// the packed tensor straight through) must reconstruct the audio.
const params = { nFft: 256, hop: 64, dimF: 128, dimT: 32 };

test('mixToNet produces the [1,4,dimF,dimT] tensor size', () => {
  const n = mdxChunkSamples(params);
  const stereo = [new Float64Array(n), new Float64Array(n)];
  const tensor = mixToNet(stereo, params);
  assert.equal(tensor.length, 4 * params.dimF * params.dimT);
});

test('netToMix(mixToNet(x)) reconstructs both channels (identity model)', () => {
  const n = mdxChunkSamples(params);
  const mk = (seed) => {
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = 0.5 * Math.sin(i / (5 + seed)) + 0.2 * Math.sin(i / 2 + seed);
    return a;
  };
  const stereo = [mk(0), mk(3)];
  const tensor = mixToNet(stereo, params);
  const [l, r] = netToMix(tensor, { ...params, length: n });

  const err = (a, b) => {
    let m = 0;
    // ignore frame-edge transients where COLA isn't fully satisfied
    for (let i = params.nFft; i < n - params.nFft; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
    return m;
  };
  assert.ok(err(l, stereo[0]) < 1e-6, `L reconstruct ${err(l, stereo[0])}`);
  assert.ok(err(r, stereo[1]) < 1e-6, `R reconstruct ${err(r, stereo[1])}`);
});
