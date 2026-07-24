import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pushScreen, popScreen, SCREENS } from '../app/ui/router.js';
import { resolveSurface, MODES } from '../app/ui/surface.js';

describe('router — history model', () => {
  test('pushes a new screen onto the stack', () => {
    assert.deepEqual(pushScreen(['home'], 'settings'), ['home', 'settings']);
    assert.deepEqual(pushScreen(['home', 'library'], 'settings'), ['home', 'library', 'settings']);
  });

  test('rewinds instead of growing when revisiting a screen', () => {
    // home → settings → home → settings must not need four backs to escape.
    const stack = ['home', 'library', 'settings'];
    assert.deepEqual(pushScreen(stack, 'home'), ['home']);
    assert.deepEqual(pushScreen(stack, 'library'), ['home', 'library']);
  });

  test('re-pushing the current screen is a no-op', () => {
    const stack = ['home', 'settings'];
    assert.deepEqual(pushScreen(stack, 'settings'), stack);
  });

  test('ignores unknown screen names', () => {
    assert.deepEqual(pushScreen(['home'], 'nope'), ['home']);
  });

  test('pop never empties the stack — home is the floor', () => {
    assert.deepEqual(popScreen(['home', 'settings']), ['home']);
    assert.deepEqual(popScreen(['home']), ['home']);
    assert.deepEqual(popScreen([]), ['home']);
  });

  test('recovers from an empty or malformed stack', () => {
    assert.deepEqual(pushScreen([], 'library'), ['home', 'library']);
    assert.deepEqual(pushScreen(null, 'library'), ['home', 'library']);
  });

  test('push then pop returns to where it started', () => {
    let stack = ['home'];
    for (const name of ['search', 'library', 'settings']) stack = pushScreen(stack, name);
    for (let i = 0; i < 3; i++) stack = popScreen(stack);
    assert.deepEqual(stack, ['home']);
  });

  test('every declared screen is navigable', () => {
    for (const name of SCREENS) {
      const stack = pushScreen(['home'], name);
      assert.equal(stack[stack.length - 1], name);
    }
  });
});

describe('surface — density is declared, never detected', () => {
  // The surface must not be a function of window geometry. A maximized 16" MBP
  // is 1728pt while a 4K TV mirrored from a Mac reports 1920pt, so no width
  // threshold can separate "laptop" from "television" — and on macOS the green
  // button is fullscreen, so a fullscreen rule resizes the whole UI the moment
  // someone makes the window full size. These cases are the regression guard.
  test('window size never changes the surface', () => {
    for (const width of [640, 1280, 1728, 1920, 2560, 3840]) {
      assert.equal(
        resolveSurface({ mode: 'auto', width }),
        'desktop',
        `width ${width} must stay desktop`
      );
    }
  });

  test('fullscreen never changes the surface', () => {
    assert.equal(resolveSurface({ mode: 'auto', fullscreen: true }), 'desktop');
    assert.equal(resolveSurface({ mode: 'auto', width: 1920, fullscreen: true }), 'desktop');
  });

  test('an explicit choice is the only way into tv', () => {
    assert.equal(resolveSurface({ mode: 'tv' }), 'tv');
    assert.equal(resolveSurface({ mode: 'tv', width: 640 }), 'tv');
  });

  test('explicit desktop stays desktop', () => {
    assert.equal(resolveSurface({ mode: 'desktop', width: 3840, fullscreen: true }), 'desktop');
  });

  test('auto and unknown modes mean desktop', () => {
    assert.equal(resolveSurface(), 'desktop');
    assert.equal(resolveSurface({}), 'desktop');
    assert.equal(resolveSurface({ mode: 'auto' }), 'desktop');
    assert.equal(resolveSurface({ mode: 'nonsense' }), 'desktop');
  });

  test('every offered mode resolves to a real surface', () => {
    for (const mode of MODES) {
      assert.ok(['desktop', 'tv'].includes(resolveSurface({ mode })));
    }
  });
});
