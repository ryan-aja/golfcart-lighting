import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../server/config/index.js';
import { applyZonePatch, createAllOffState, createInitialState } from '../server/lighting/state.js';

const { lighting: lightingConfig } = loadConfig();
const zoneById = (id) =>
  [...lightingConfig.zones, ...lightingConfig.pixelZones].find((z) => z.id === id);

test('startup state has every zone off', () => {
  const state = createInitialState(lightingConfig);

  assert.equal(state.headlights.enabled, false);
  assert.equal(state.accent.enabled, false);
  assert.equal(state.underglow.enabled, false);
  assert.equal(state.pixels.enabled, false);
  assert.equal(state.reverse.mode, 'off');
});

test('brightness is clamped to 0-100 and rounded', () => {
  const zone = zoneById('headlights');
  const base = { enabled: true, brightness: 100 };

  assert.equal(applyZonePatch(zone, base, { brightness: 150 }).brightness, 100);
  assert.equal(applyZonePatch(zone, base, { brightness: -10 }).brightness, 0);
  assert.equal(applyZonePatch(zone, base, { brightness: 42.6 }).brightness, 43);
});

test('colour components are clamped to 0-255', () => {
  const zone = zoneById('accent');
  const base = createInitialState(lightingConfig).accent;

  const next = applyZonePatch(zone, base, { color: { r: 999, g: -5, b: 128.4 } });
  assert.deepEqual(next.color, { r: 255, g: 0, b: 128 });
});

test('a partial colour patch keeps the untouched components', () => {
  const zone = zoneById('accent');
  const base = { enabled: true, color: { r: 10, g: 20, b: 30 }, brightness: 100 };

  assert.deepEqual(applyZonePatch(zone, base, { color: { r: 200 } }).color, { r: 200, g: 20, b: 30 });
});

test('an invalid reverse mode is rejected', () => {
  const zone = zoneById('reverse');
  const base = { mode: 'off', brightness: 100 };

  assert.equal(applyZonePatch(zone, base, { mode: 'auto' }).mode, 'auto');
  assert.throws(() => applyZonePatch(zone, base, { mode: 'flashing' }), /Invalid mode/);
});

test('an unknown effect is rejected when the effect list is supplied', () => {
  const zone = zoneById('pixels');
  const base = createInitialState(lightingConfig).pixels;

  assert.equal(
    applyZonePatch(zone, base, { effect: 'rainbow' }, { availableEffects: ['solid', 'rainbow'] }).effect,
    'rainbow'
  );
  assert.throws(
    () => applyZonePatch(zone, base, { effect: 'strobe' }, { availableEffects: ['solid', 'rainbow'] }),
    /Unknown effect/
  );
});

test('unknown patch keys are ignored rather than throwing', () => {
  const zone = zoneById('headlights');
  const base = { enabled: false, brightness: 100 };

  const next = applyZonePatch(zone, base, { enabled: true, somethingNew: 42 });
  assert.deepEqual(next, { enabled: true, brightness: 100 });
});

test('all-off clears every zone but preserves brightness and colour', () => {
  const state = createInitialState(lightingConfig);
  state.headlights = { enabled: true, brightness: 60 };
  state.reverse = { mode: 'on', brightness: 80 };
  state.accent = { enabled: true, color: { r: 255, g: 80, b: 0 }, brightness: 30 };

  const off = createAllOffState(lightingConfig, state);

  assert.equal(off.headlights.enabled, false);
  assert.equal(off.reverse.mode, 'off');
  assert.equal(off.accent.enabled, false);

  // Levels survive so turning a zone back on restores what the driver chose.
  assert.equal(off.headlights.brightness, 60);
  assert.equal(off.reverse.brightness, 80);
  assert.deepEqual(off.accent.color, { r: 255, g: 80, b: 0 });
});
