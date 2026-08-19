import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../server/config/index.js';
import { LightingService } from '../server/services/lightingService.js';
import { SceneService } from '../server/services/sceneService.js';
import { LightingEngine } from '../server/services/lightingEngine.js';

const config = loadConfig();

function createServices() {
  const lighting = new LightingService(config.lighting);
  const scenes = new SceneService({ scenes: config.scenes, lighting });
  return { lighting, scenes };
}

/** Minimal Art-Net stand-in that just records the last frame per universe. */
function createFakeArtNet() {
  const universes = new Map();
  let flushes = 0;
  return {
    setUniverse: (universe, data) => universes.set(universe, Buffer.from(data)),
    flush: () => (flushes += 1),
    get: (universe) => universes.get(universe),
    universeCount: () => universes.size,
    flushes: () => flushes,
  };
}

test('setZone updates state and emits a change event', () => {
  const { lighting } = createServices();
  const events = [];
  lighting.on('change', (e) => events.push(e));

  lighting.setZone('headlights', { enabled: true, brightness: 75 });

  assert.deepEqual(lighting.getState().headlights, { enabled: true, brightness: 75 });
  assert.equal(events.length, 1);
  assert.equal(events[0].snapshot.state.headlights.brightness, 75);
});

test('setZone rejects an unknown zone', () => {
  const { lighting } = createServices();
  assert.throws(() => lighting.setZone('taillights', { enabled: true }), /Unknown lighting zone/);
});

test('getZones hides zones flagged hidden in config', () => {
  const { lighting } = createServices();
  const ids = lighting.getZones().map((z) => z.id);

  assert.ok(ids.includes('headlights'));
  assert.ok(!ids.includes('spare'), 'the unassigned spare channel is not exposed to the UI');
});

test('activating a scene produces the expected state', () => {
  const { lighting, scenes } = createServices();

  scenes.activate('driving');
  const state = lighting.getState();

  assert.equal(state.headlights.enabled, true);
  assert.equal(state.headlights.brightness, 100);
  assert.equal(state.accent.enabled, true);
  assert.deepEqual(state.accent.color, { r: 255, g: 80, b: 0 });
  assert.equal(state.accent.brightness, 30);
  assert.equal(state.underglow.enabled, false);
  assert.equal(lighting.getSnapshot().activeSceneId, 'driving');
});

test('the all-off scene clears everything', () => {
  const { lighting, scenes } = createServices();

  scenes.activate('party');
  assert.equal(lighting.getState().underglow.enabled, true);

  scenes.activate('all-off');
  const state = lighting.getState();
  assert.equal(state.headlights.enabled, false);
  assert.equal(state.accent.enabled, false);
  assert.equal(state.underglow.enabled, false);
  assert.equal(state.pixels.enabled, false);
  assert.equal(state.reverse.mode, 'off');
});

test('a manual change clears the active scene marker', () => {
  const { lighting, scenes } = createServices();

  scenes.activate('driving');
  assert.equal(lighting.getSnapshot().activeSceneId, 'driving');

  lighting.setZone('headlights', { enabled: false });
  assert.equal(lighting.getSnapshot().activeSceneId, null);
});

test('activating an unknown scene throws', () => {
  const { scenes } = createServices();
  assert.throws(() => scenes.activate('disco'), /Unknown scene/);
});

test('allOff turns every zone off in one update', () => {
  const { lighting } = createServices();
  lighting.setZone('headlights', { enabled: true });
  lighting.setZone('reverse', { mode: 'on' });
  lighting.setZone('underglow', { enabled: true });

  lighting.allOff();
  const state = lighting.getState();

  assert.equal(state.headlights.enabled, false);
  assert.equal(state.reverse.mode, 'off');
  assert.equal(state.underglow.enabled, false);
});

test('the engine renders state through to DMX channel values', () => {
  const { lighting } = createServices();
  const artnet = createFakeArtNet();
  const engine = new LightingEngine({ lighting, artnet, lightingConfig: config.lighting, frameRate: 30 });

  lighting.setZone('headlights', { enabled: true, brightness: 50 });
  lighting.setZone('underglow', { enabled: true, color: { r: 0, g: 0, b: 255 }, brightness: 100 });
  engine.renderFrame();

  const universe = artnet.get(config.lighting.dmxUniverse);
  assert.equal(universe[6], 128, 'headlights on channel 7');
  assert.equal(universe[5], 255, 'underglow blue on channel 6');
  assert.equal(artnet.flushes(), 1);
});

test('the engine emits blank pixel universes while a pixel zone is off', () => {
  const { lighting } = createServices();
  const artnet = createFakeArtNet();
  const engine = new LightingEngine({ lighting, artnet, lightingConfig: config.lighting, frameRate: 30 });

  engine.renderFrame();

  // 100 pixels fit in a single universe starting at universeStart (2).
  const pixelUniverse = artnet.get(2);
  assert.ok(pixelUniverse, 'pixel universe should still be published');
  assert.ok(pixelUniverse.every((b) => b === 0));
});

test('the engine renders a solid pixel zone at the configured brightness', () => {
  const { lighting } = createServices();
  const artnet = createFakeArtNet();
  const engine = new LightingEngine({ lighting, artnet, lightingConfig: config.lighting, frameRate: 30 });

  lighting.setZone('pixels', {
    enabled: true,
    effect: 'solid',
    color: { r: 255, g: 0, b: 0 },
    brightness: 50,
  });
  engine.renderFrame();

  const pixelUniverse = artnet.get(2);
  assert.deepEqual([...pixelUniverse.subarray(0, 6)], [128, 0, 0, 128, 0, 0]);
  // 100 pixels x 3 channels = 300 bytes used; the rest of the universe is idle.
  assert.ok(pixelUniverse.subarray(300).every((b) => b === 0));
});

test('the driving scene arms the scanner bar in red', () => {
  const { lighting, scenes } = createServices();

  scenes.activate('driving');
  const scanner = lighting.getState().scanner;

  assert.equal(scanner.enabled, true);
  assert.equal(scanner.effect, 'scanner');
  assert.deepEqual(scanner.color, { r: 255, g: 0, b: 0 });
  assert.equal(scanner.trail, 8);
});

test('the scanner zone renders onto universe 6 and leaves the other zones alone', () => {
  const { lighting, scenes } = createServices();
  const artnet = createFakeArtNet();
  // Fixed clock: t=0 puts the head on the first pixel.
  const engine = new LightingEngine({
    lighting,
    artnet,
    lightingConfig: config.lighting,
    frameRate: 30,
    now: () => 0,
  });

  scenes.activate('driving');
  engine.renderFrame();

  const bar = artnet.get(6);
  assert.ok(bar, 'scanner publishes universe 6');
  assert.deepEqual([...bar.subarray(0, 3)], [255, 0, 0], 'head pixel is full red');

  // At t=0 the head sits on pixel 0 with its tail bent back up the strip:
  // 8 lit pixels = 24 channels, all pure red, and nothing beyond that.
  assert.ok(bar[3] > 0 && bar[3] < 255, 'tail continues onto the second pixel');
  assert.ok(bar.subarray(24, 144).every((b) => b === 0), 'tail stops after 8 LEDs');
  assert.ok(bar.subarray(144).every((b) => b === 0), '48 px x 3 ch uses only 144 channels');
  for (let px = 0; px < 48; px += 1) {
    assert.equal(bar[px * 3 + 1], 0, `green stays off on pixel ${px}`);
    assert.equal(bar[px * 3 + 2], 0, `blue stays off on pixel ${px}`);
  }

  // The other pixel zone stays dark and the DMX universe is unaffected.
  assert.ok(artnet.get(2).every((b) => b === 0));
  assert.equal(artnet.get(config.lighting.dmxUniverse)[6], 255, 'headlights still on channel 7');
});

test('scanner brightness scales the whole bar', () => {
  const { lighting } = createServices();
  const artnet = createFakeArtNet();
  const engine = new LightingEngine({
    lighting,
    artnet,
    lightingConfig: config.lighting,
    frameRate: 30,
    now: () => 0,
  });

  lighting.setZone('scanner', {
    enabled: true,
    effect: 'scanner',
    color: { r: 255, g: 0, b: 0 },
    brightness: 50,
  });
  engine.renderFrame();

  assert.equal(artnet.get(6)[0], 128);
});

test('trail length is clamped to the zone pixel count', () => {
  const { lighting } = createServices();

  lighting.setZone('scanner', { trail: 999 });
  assert.equal(lighting.getState().scanner.trail, 48);

  lighting.setZone('scanner', { trail: 0 });
  assert.equal(lighting.getState().scanner.trail, 1);
});

test('a render failure does not propagate out of the frame loop', () => {
  const { lighting } = createServices();
  const artnet = createFakeArtNet();
  artnet.setUniverse = () => {
    throw new Error('transport exploded');
  };
  const engine = new LightingEngine({ lighting, artnet, lightingConfig: config.lighting, frameRate: 30 });

  assert.doesNotThrow(() => engine.renderFrame());
});
