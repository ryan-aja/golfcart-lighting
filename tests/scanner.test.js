import test from 'node:test';
import assert from 'node:assert/strict';

import scanner from '../server/effects/scanner.js';
import { getEffect, listEffects } from '../server/effects/index.js';

const RED = { r: 255, g: 0, b: 0 };

/**
 * At speed 100 the head makes 3 sweeps/second, so phase = t * 3 (mod 2):
 *   t = 0     -> head at pixel 0, travelling forward
 *   t = 1/6   -> head at midpoint, forward
 *   t = 1/3   -> head at the last pixel, turning back
 *   t = 1/2   -> head at midpoint, travelling backward
 *   t = 2/3   -> head back at pixel 0
 */
const SPEED = 100;
const render = (opts) => scanner.render({ color: RED, speed: SPEED, trail: 8, ...opts });
const litIndexes = (pixels) => pixels.map((p, i) => [p, i]).filter(([p]) => p.r > 0).map(([, i]) => i);

test('scanner is registered and declares a configurable trail', () => {
  assert.equal(getEffect('scanner').id, 'scanner');
  assert.deepEqual(scanner.params, ['color', 'speed', 'trail']);
  assert.ok(listEffects().some((e) => e.id === 'scanner' && e.name === 'Scanner'));
});

test('at the bottom turnaround the head sits on pixel 0 and the tail bends back up', () => {
  const pixels = render({ pixelCount: 48, timeSeconds: 0 });

  assert.deepEqual(pixels[0], RED, 'head is at full colour on the first pixel');
  // The tail lies where the head just came from - up the strip, not off the end.
  assert.deepEqual(litIndexes(pixels), [0, 1, 2, 3, 4, 5, 6, 7]);
  for (let i = 1; i < 7; i += 1) {
    assert.ok(pixels[i].r > pixels[i + 1].r, 'tail fades away from the head');
  }
});

test('at the top turnaround the head reaches the last pixel and the tail bends back down', () => {
  const pixels = render({ pixelCount: 48, timeSeconds: 1 / 3 });

  assert.deepEqual(pixels[47], RED);
  assert.deepEqual(litIndexes(pixels), [40, 41, 42, 43, 44, 45, 46, 47]);
});

test('the tail never collapses to the bare head, at any point in the cycle', () => {
  // Regression guard: scoring the tail only against the current sweep made it
  // vanish at each end, leaving a single lit pixel — a visible blink twice a
  // second. The floor here is 3 rather than the full trail length because the
  // faintest pixels of the gamma falloff legitimately round to 0 at 8 bits.
  for (let step = 0; step <= 400; step += 1) {
    const t = (step / 400) * (2 / 3);
    const lit = litIndexes(render({ pixelCount: 48, trail: 8, timeSeconds: t }));
    assert.ok(lit.length >= 3, `only ${lit.length} pixels lit at t=${t.toFixed(4)}`);
  }
});

test('the trail falls behind the head while travelling forward', () => {
  const pixels = render({ pixelCount: 48, timeSeconds: 1 / 6 }); // head at 23.5

  const lit = litIndexes(pixels);
  assert.ok(Math.min(...lit) >= 16, 'trail does not extend past its length');
  assert.ok(Math.max(...lit) <= 24, 'nothing beyond the faint leading edge');

  // Brightest pixel is the one the head sits on, and the tail fades away behind it.
  assert.equal(pixels.indexOf(pixels.reduce((a, b) => (b.r > a.r ? b : a))), 23);
  for (let i = 23; i > 16; i -= 1) {
    assert.ok(pixels[i].r > pixels[i - 1].r, `pixel ${i} should be brighter than ${i - 1}`);
  }
});

test('the trail flips to the other side on the return sweep', () => {
  const pixels = render({ pixelCount: 48, timeSeconds: 1 / 2 }); // head at 23.5, backward
  const lit = litIndexes(pixels);

  assert.ok(Math.max(...lit) >= 31, 'tail now extends up-strip');
  assert.ok(Math.min(...lit) >= 23, 'nothing below the head but the leading edge');
  assert.equal(pixels.indexOf(pixels.reduce((a, b) => (b.r > a.r ? b : a))), 24);
});

test('the sweep bounces rather than wrapping', () => {
  const count = 48;
  const heads = [];
  for (let step = 0; step <= 24; step += 1) {
    const pixels = render({ pixelCount: count, timeSeconds: (step / 24) * (2 / 3) });
    heads.push(pixels.indexOf(pixels.reduce((a, b) => (b.r > a.r ? b : a))));
  }

  // Out to the far end and back again, never jumping across the boundary.
  assert.equal(heads[0], 0);
  assert.equal(Math.max(...heads), count - 1);
  assert.equal(heads[heads.length - 1], 0);

  const peak = heads.indexOf(count - 1);
  for (let i = 1; i <= peak; i += 1) assert.ok(heads[i] >= heads[i - 1], 'rises to the far end');
  for (let i = peak + 1; i < heads.length; i += 1) assert.ok(heads[i] <= heads[i - 1], 'returns');
});

test('the effect traverses whatever pixel count the zone declares', () => {
  for (const pixelCount of [6, 12, 48, 144]) {
    const pixels = render({ pixelCount, timeSeconds: 1 / 3 });
    assert.equal(pixels.length, pixelCount);
    assert.deepEqual(pixels[pixelCount - 1], RED, `head reaches the end of a ${pixelCount}px strip`);
  }
});

test('trail length is configurable', () => {
  const short = render({ pixelCount: 48, trail: 3, timeSeconds: 1 / 6 });
  const long = render({ pixelCount: 48, trail: 20, timeSeconds: 1 / 6 });

  assert.ok(litIndexes(long).length > litIndexes(short).length);
  assert.ok(Math.min(...litIndexes(short)) >= 21, 'a 3-LED trail stays near the head');
  assert.ok(Math.min(...litIndexes(long)) <= 6, 'a 20-LED trail reaches much further back');
});

test('a trail longer than the strip is clamped rather than wrapping', () => {
  const pixels = render({ pixelCount: 6, trail: 500, timeSeconds: 1 / 3 });

  assert.equal(pixels.length, 6);
  assert.deepEqual(pixels[5], RED);
  assert.ok(pixels.every((p) => p.g === 0 && p.b === 0));
});

test('the effect renders in the selected colour', () => {
  const blue = scanner.render({
    pixelCount: 48,
    color: { r: 0, g: 0, b: 255 },
    speed: SPEED,
    trail: 8,
    timeSeconds: 0,
  });

  assert.deepEqual(blue[0], { r: 0, g: 0, b: 255 });
  assert.ok(blue.every((p) => p.r === 0 && p.g === 0));
});

test('a single-pixel zone degrades gracefully', () => {
  assert.deepEqual(render({ pixelCount: 1, timeSeconds: 0.4 }), [RED]);
  assert.deepEqual(render({ pixelCount: 0, timeSeconds: 0.4 }), []);
});
