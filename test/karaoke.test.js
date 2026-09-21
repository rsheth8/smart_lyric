import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readPercent,
  vocalGains,
  clampKey,
  semitoneRatio,
  keyLabel,
  decayEnvelope,
  looksMono,
  FeedbackGuard,
  workletSource,
  KaraokeAudio,
  KEY_MIN,
  KEY_MAX,
  FEEDBACK_HOLD_MS,
} from '../app/karaoke.js';
import { detectPitch } from '../app/pitch.js';

test('vocalGains crossfades the middle and holds the bands at unity', () => {
  const full = vocalGains(1);
  assert.deepEqual(full, { mix: 1, side: 0, bass: 0, air: 0 });
  const none = vocalGains(0);
  assert.deepEqual(none, { mix: 0, side: 1, bass: 1, air: 1 });
  for (const level of [0, 0.25, 0.5, 0.75, 1]) {
    const g = vocalGains(level);
    // Bass and air must never dip or double: mix carries part, the band the rest.
    assert.equal(g.mix + g.bass, 1, `bass not unity at ${level}`);
    assert.equal(g.mix + g.air, 1, `air not unity at ${level}`);
  }
});

test('vocalGains clamps junk input instead of producing negative gain', () => {
  assert.deepEqual(vocalGains(5), { mix: 1, side: 0, bass: 0, air: 0 });
  assert.deepEqual(vocalGains(-5), { mix: 0, side: 1, bass: 1, air: 1 });
  assert.deepEqual(vocalGains(NaN), { mix: 0, side: 1, bass: 1, air: 1 });
});

test('readPercent falls back when nothing is stored', () => {
  // Number(null) is 0, which would pin every slider to zero on a fresh install.
  assert.equal(readPercent(null, 70), 70);
  assert.equal(readPercent(undefined, 70), 70);
  assert.equal(readPercent('', 70), 70);
  assert.equal(readPercent('not a number', 70), 70);
  assert.equal(readPercent('-5', 70), 70);
  assert.equal(readPercent('101', 70), 70);
  // A real stored value wins, including a deliberate zero.
  assert.equal(readPercent('0', 70), 0);
  assert.equal(readPercent('45', 70), 45);
  assert.equal(readPercent('100', 70), 100);
});

test('clampKey stays inside the singable range', () => {
  assert.equal(clampKey(0), 0);
  assert.equal(clampKey(2.4), 2);
  assert.equal(clampKey(99), KEY_MAX);
  assert.equal(clampKey(-99), KEY_MIN);
  assert.equal(clampKey('bad'), 0);
});

test('semitoneRatio is the equal-tempered ratio, clamped to the key range', () => {
  assert.equal(semitoneRatio(0), 1);
  assert.ok(Math.abs(semitoneRatio(1) - 2 ** (1 / 12)) < 1e-12);
  assert.ok(Math.abs(semitoneRatio(-1) - 2 ** (-1 / 12)) < 1e-12);
  // An out-of-range request lands at the limit rather than throwing.
  assert.equal(semitoneRatio(24), semitoneRatio(KEY_MAX));
  assert.equal(semitoneRatio(-24), semitoneRatio(KEY_MIN));
  assert.ok(semitoneRatio(KEY_MAX) < 2, 'the key range stays under an octave');
});

test('keyLabel reads like a key change', () => {
  assert.equal(keyLabel(0), 'Original');
  assert.equal(keyLabel(2), '+2');
  assert.equal(keyLabel(-3), '−3');
});

test('decayEnvelope falls from 1 to 0', () => {
  assert.equal(decayEnvelope(0, 100), 1);
  assert.equal(decayEnvelope(100, 100), 0);
  assert.ok(decayEnvelope(50, 100) < decayEnvelope(10, 100));
  assert.equal(decayEnvelope(0, 0), 0);
});

test('looksMono only fires when the mix is loud and the side is not', () => {
  assert.equal(looksMono(0.5, 0.001), true);
  assert.equal(looksMono(0.5, 0.3), false);
  // Too quiet to judge — a silent intro is not a mono verdict.
  assert.equal(looksMono(0.001, 0), false);
});

test('FeedbackGuard needs a sustained howl, not one loud note', () => {
  const g = new FeedbackGuard();
  assert.equal(g.update(0.9, 0), false, 'must not fire on the first loud frame');
  assert.equal(g.update(0.9, 500), false);
  assert.equal(g.update(0.2, 600), false, 'dropping back resets the timer');
  assert.equal(g.update(0.9, 700), false);
  assert.equal(g.update(0.9, 700 + FEEDBACK_HOLD_MS), true);
});

test('FeedbackGuard rearms after it fires', () => {
  const g = new FeedbackGuard({ holdMs: 100 });
  g.update(0.9, 0);
  assert.equal(g.update(0.9, 200), true);
  assert.equal(g.update(0.9, 250), false, 'timer restarts, no repeat storm');
  assert.equal(g.update(0.9, 400), true);
});

test('levelOf is RMS and safe on nothing', () => {
  assert.equal(KaraokeAudio.levelOf(null), 0);
  assert.equal(KaraokeAudio.levelOf(new Float32Array(0)), 0);
  assert.equal(KaraokeAudio.levelOf(Float32Array.from([1, -1, 1, -1])), 1);
  assert.equal(KaraokeAudio.levelOf(new Float32Array(16)), 0);
});

test('the worklet source survives the stringify round-trip and still shifts pitch', () => {
  // The shifter reaches the audio thread as TEXT. If pitch-shift.js ever closes
  // over a module-scope value, this is the only place that shows up.
  const src = workletSource();
  let registered = null;
  const scope = {
    AudioWorkletProcessor: class {},
    registerProcessor: (name, cls) => {
      registered = { name, cls };
    },
    sampleRate: 48000,
  };
  const run = new Function(
    'AudioWorkletProcessor',
    'registerProcessor',
    'sampleRate',
    `${src}\nreturn true;`
  );
  assert.doesNotThrow(() => run(scope.AudioWorkletProcessor, scope.registerProcessor, scope.sampleRate));
  assert.equal(registered.name, 'pitch-shift');

  const proc = new registered.cls();
  const SR = 48000;
  const Q = 128;
  const params = { ratio: [semitoneRatio(4)] };
  const want = 220 * semitoneRatio(4);
  const out = new Float32Array(SR * 2);
  let n = 0;
  while (n + Q <= out.length) {
    const input = [new Float32Array(Q)];
    for (let i = 0; i < Q; i++) {
      const t = (n + i) / SR;
      input[0][i] =
        0.5 * Math.sin(2 * Math.PI * 220 * t) +
        0.3 * Math.sin(4 * Math.PI * 220 * t) +
        0.2 * Math.sin(6 * Math.PI * 220 * t);
    }
    const output = [new Float32Array(Q)];
    assert.equal(proc.process([input], [output], params), true);
    out.set(output[0], n);
    n += Q;
  }
  const steady = out.subarray(SR);
  const hz = detectPitch(steady.subarray(0, 8192), SR);
  assert.ok(hz, 'worklet produced no pitched audio');
  assert.ok(
    Math.abs(1200 * Math.log2(hz / want)) < 25,
    `worklet landed at ${hz.toFixed(1)} Hz, wanted ${want.toFixed(1)} Hz`
  );
});

test('the worklet keeps running when an input channel is missing', () => {
  const src = workletSource();
  let registered = null;
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', src)(
    class {},
    (name, cls) => {
      registered = cls;
    },
    48000
  );
  const proc = new registered();
  const output = [new Float32Array(128)];
  assert.equal(proc.process([[]], [output], { ratio: [1.2] }), true);
  assert.ok(output[0].every((v) => v === 0));
});
