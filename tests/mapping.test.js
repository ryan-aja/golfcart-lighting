import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../server/config/index.js';
import { createInitialState } from '../server/lighting/state.js';
import {
  applyColorOrder,
  pixelsPerUniverse,
  renderDmxUniverses,
  renderZoneChannels,
  scaleBrightness,
  scaleColorComponent,
  splitPixelsIntoUniverses,
} from '../server/lighting/mapping.js';

const config = loadConfig();
const lightingConfig = config.lighting;
const DMX_UNIVERSE = lightingConfig.dmxUniverse;

const zoneById = (id) => lightingConfig.zones.find((z) => z.id === id);
/** Read a 1-based DMX channel out of a rendered universe buffer. */
const channel = (buffer, ch) => buffer[ch - 1];

test('scaleBrightness maps 0-100 onto 0-255', () => {
  assert.equal(scaleBrightness(0), 0);
  assert.equal(scaleBrightness(50), 128);
  assert.equal(scaleBrightness(100), 255);
});

test('scaleBrightness respects a zone output ceiling', () => {
  assert.equal(scaleBrightness(100, 200), 200);
  assert.equal(scaleBrightness(50, 200), 100);
});

test('scaleBrightness clamps out-of-range input', () => {
  assert.equal(scaleBrightness(-20), 0);
  assert.equal(scaleBrightness(999), 255);
});

test('50% headlight brightness lands on DMX channel 7 at 128', () => {
  const state = createInitialState(lightingConfig);
  state.headlights = { enabled: true, brightness: 50 };

  const universe = renderDmxUniverses(state, lightingConfig).get(DMX_UNIVERSE);
  assert.equal(channel(universe, 7), 128);
});

test('a disabled headlight outputs zero regardless of brightness', () => {
  const state = createInitialState(lightingConfig);
  state.headlights = { enabled: false, brightness: 100 };

  const universe = renderDmxUniverses(state, lightingConfig).get(DMX_UNIVERSE);
  assert.equal(channel(universe, 7), 0);
});

test('accent RGB maps onto channels 1-3 with brightness scaling', () => {
  const state = createInitialState(lightingConfig);
  state.accent = { enabled: true, color: { r: 255, g: 0, b: 128 }, brightness: 100 };

  const universe = renderDmxUniverses(state, lightingConfig).get(DMX_UNIVERSE);
  assert.equal(channel(universe, 1), 255);
  assert.equal(channel(universe, 2), 0);
  assert.equal(channel(universe, 3), 128);

  state.accent.brightness = 50;
  const dimmed = renderDmxUniverses(state, lightingConfig).get(DMX_UNIVERSE);
  assert.equal(channel(dimmed, 1), 128);
  assert.equal(channel(dimmed, 2), 0);
  assert.equal(channel(dimmed, 3), 64);
});

test('underglow RGB maps onto channels 4-6, independent of accent', () => {
  const state = createInitialState(lightingConfig);
  state.accent = { enabled: true, color: { r: 255, g: 0, b: 0 }, brightness: 100 };
  state.underglow = { enabled: true, color: { r: 0, g: 0, b: 255 }, brightness: 100 };

  const universe = renderDmxUniverses(state, lightingConfig).get(DMX_UNIVERSE);
  assert.deepEqual([1, 2, 3].map((c) => channel(universe, c)), [255, 0, 0]);
  assert.deepEqual([4, 5, 6].map((c) => channel(universe, c)), [0, 0, 255]);
});

test('reverse light only outputs in "on" mode; "auto" stays dark until inputs exist', () => {
  const zone = zoneById('reverse');
  assert.deepEqual(renderZoneChannels(zone, { mode: 'off', brightness: 100 }), { 8: 0 });
  assert.deepEqual(renderZoneChannels(zone, { mode: 'auto', brightness: 100 }), { 8: 0 });
  assert.deepEqual(renderZoneChannels(zone, { mode: 'on', brightness: 100 }), { 8: 255 });
  assert.deepEqual(renderZoneChannels(zone, { mode: 'on', brightness: 50 }), { 8: 128 });
});

test('the initial all-off state produces an entirely zero universe', () => {
  const state = createInitialState(lightingConfig);
  const universe = renderDmxUniverses(state, lightingConfig).get(DMX_UNIVERSE);

  assert.equal(universe.length, 512);
  assert.ok(universe.every((value) => value === 0), 'expected every DMX channel to be 0');
});

test('the unassigned spare channel stays at zero', () => {
  const state = createInitialState(lightingConfig);
  state.headlights = { enabled: true, brightness: 100 };
  state.accent = { enabled: true, color: { r: 255, g: 255, b: 255 }, brightness: 100 };

  const universe = renderDmxUniverses(state, lightingConfig).get(DMX_UNIVERSE);
  assert.equal(channel(universe, 9), 0);
});

test('scaleColorComponent combines component, brightness and output ceiling', () => {
  assert.equal(scaleColorComponent(255, 100, 255), 255);
  assert.equal(scaleColorComponent(255, 50, 255), 128);
  assert.equal(scaleColorComponent(128, 100, 255), 128);
  assert.equal(scaleColorComponent(255, 100, 200), 200);
});

test('a lowered maxOutput caps zone output', () => {
  const limited = { ...zoneById('headlights'), maxOutput: 200 };
  assert.deepEqual(renderZoneChannels(limited, { enabled: true, brightness: 100 }), { 7: 200 });
});

test('applyColorOrder reorders pixel bytes for the configured chipset', () => {
  const pixel = { r: 10, g: 20, b: 30 };
  assert.deepEqual(applyColorOrder(pixel, 'RGB'), [10, 20, 30]);
  assert.deepEqual(applyColorOrder(pixel, 'GRB'), [20, 10, 30]);
  assert.deepEqual(applyColorOrder(pixel, 'BGR'), [30, 20, 10]);
  assert.deepEqual(applyColorOrder({ ...pixel, w: 40 }, 'GRBW'), [20, 10, 30, 40]);
});

test('pixels never straddle a universe boundary', () => {
  assert.equal(pixelsPerUniverse(3), 170);
  assert.equal(pixelsPerUniverse(4), 128);
});

test('pixel universe splitting packs 170 pixels per universe from universeStart', () => {
  const zone = { universeStart: 2, pixelCount: 400, channelsPerPixel: 3, colorOrder: 'RGB' };
  const pixels = Array.from({ length: 400 }, (_, i) => ({ r: i % 256, g: 0, b: 1 }));

  const universes = splitPixelsIntoUniverses(pixels, zone);

  assert.equal(universes.length, 3); // 170 + 170 + 60
  assert.deepEqual(universes.map((u) => u.universe), [2, 3, 4]);

  // First pixel of universe 2 is pixel 0.
  assert.deepEqual([...universes[0].data.subarray(0, 3)], [0, 0, 1]);
  // First pixel of universe 3 is pixel 170.
  assert.deepEqual([...universes[1].data.subarray(0, 3)], [170 % 256, 0, 1]);
  // The final universe holds 60 pixels; everything past 180 bytes is padding.
  assert.deepEqual([...universes[2].data.subarray(0, 3)], [340 % 256, 0, 1]);
  assert.ok(universes[2].data.subarray(180).every((b) => b === 0));
});

test('pixel splitting honours colour order', () => {
  const zone = { universeStart: 5, pixelCount: 2, channelsPerPixel: 3, colorOrder: 'GRB' };
  const [{ universe, data }] = splitPixelsIntoUniverses(
    [
      { r: 1, g: 2, b: 3 },
      { r: 4, g: 5, b: 6 },
    ],
    zone
  );

  assert.equal(universe, 5);
  assert.deepEqual([...data.subarray(0, 6)], [2, 1, 3, 5, 4, 6]);
});
