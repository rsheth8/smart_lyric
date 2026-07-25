import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classify, Intent } from '../app/remote.js';

describe('classify — directional (focus engine still owns these)', () => {
  it('maps the four arrows to MOVE with a direction', () => {
    assert.deepEqual(classify({ key: 'ArrowUp' }), { type: Intent.MOVE, dir: 'up', source: 'key' });
    assert.deepEqual(classify({ key: 'ArrowDown' }), { type: Intent.MOVE, dir: 'down', source: 'key' });
    assert.deepEqual(classify({ key: 'ArrowLeft' }), { type: Intent.MOVE, dir: 'left', source: 'key' });
    assert.deepEqual(classify({ key: 'ArrowRight' }), { type: Intent.MOVE, dir: 'right', source: 'key' });
  });

  it('maps Enter to SELECT', () => {
    assert.equal(classify({ key: 'Enter' })?.type, Intent.SELECT);
  });
});

describe('classify — transport / system buttons', () => {
  it('maps Space (by code or key) to PLAYPAUSE from a keyboard', () => {
    assert.deepEqual(classify({ code: 'Space' }), { type: Intent.PLAYPAUSE, source: 'key' });
    assert.deepEqual(classify({ key: ' ' }), { type: Intent.PLAYPAUSE, source: 'key' });
    assert.deepEqual(classify({ key: 'Spacebar' }), { type: Intent.PLAYPAUSE, source: 'key' });
  });

  it('maps the hardware media keys with a media source', () => {
    assert.deepEqual(classify({ key: 'MediaPlayPause' }), { type: Intent.PLAYPAUSE, source: 'media' });
    assert.deepEqual(classify({ key: 'MediaPlay' }), { type: Intent.PLAYPAUSE, source: 'media' });
    assert.deepEqual(classify({ key: 'MediaPause' }), { type: Intent.PLAYPAUSE, source: 'media' });
    assert.deepEqual(classify({ key: 'MediaTrackNext' }), { type: Intent.NEXT, source: 'media' });
    assert.deepEqual(classify({ key: 'MediaTrackPrevious' }), { type: Intent.PREV, source: 'media' });
    assert.deepEqual(classify({ key: 'MediaStop' }), { type: Intent.BACK, source: 'media' });
  });

  it('maps Escape and remote back-keys to BACK', () => {
    assert.equal(classify({ key: 'Escape' })?.type, Intent.BACK);
    assert.equal(classify({ key: 'GoBack' })?.type, Intent.BACK);
    assert.equal(classify({ key: 'BrowserBack' })?.type, Intent.BACK);
  });

  it('media keys outrank text meaning (never null)', () => {
    // A media key must classify even though the switch runs before Space.
    assert.ok(classify({ key: 'MediaPlayPause', code: 'Space' }));
  });
});

describe('classify — leaves app/OS accelerators and noise alone', () => {
  it('ignores modifier chords (⌘, / ⌘F / Ctrl+Space etc.)', () => {
    assert.equal(classify({ key: 'ArrowDown', metaKey: true }), null);
    assert.equal(classify({ code: 'Space', ctrlKey: true }), null);
    assert.equal(classify({ key: 'Enter', altKey: true }), null);
  });

  it('returns null for keys with no remote meaning', () => {
    assert.equal(classify({ key: 't' }), null);
    assert.equal(classify({ key: 'a' }), null);
    assert.equal(classify({ key: 'F5' }), null);
    assert.equal(classify(null), null);
    assert.equal(classify(undefined), null);
  });
});
