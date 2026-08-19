import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, validateConfig } from '../server/config/index.js';

const shipped = loadConfig();

/** A minimal valid config, cloned per test so mutations stay local. */
function baseConfig() {
  return {
    artnet: { frameRate: 30 },
    lighting: {
      dmxUniverse: 0,
      zones: [{ id: 'headlights', type: 'dimmer', universe: 0, channel: 7, maxOutput: 255 }],
      pixelZones: [
        { id: 'pixels', universeStart: 2, pixelCount: 100, channelsPerPixel: 3 },
        { id: 'scanner', universeStart: 6, pixelCount: 48, channelsPerPixel: 3 },
      ],
    },
    scenes: [],
  };
}

test('the shipped configuration is valid', () => {
  assert.doesNotThrow(() => validateConfig(shipped));
});

test('the scanner zone is 48 pixels of RGB starting at universe 6', () => {
  const scanner = shipped.lighting.pixelZones.find((z) => z.id === 'scanner');

  assert.ok(scanner, 'scanner pixel zone exists');
  assert.equal(scanner.universeStart, 6);
  assert.equal(scanner.pixelCount, 48);
  assert.equal(scanner.channelsPerPixel, 3);
  assert.equal(scanner.defaults.effect, 'scanner');
  assert.deepEqual(scanner.defaults.color, { r: 255, g: 0, b: 0 });
});

test('a duplicated DMX channel is rejected at startup', () => {
  const config = baseConfig();
  config.lighting.zones.push({ id: 'aux', type: 'dimmer', universe: 0, channel: 7 });

  assert.throws(() => validateConfig(config), /already used by "headlights"/);
});

test('overlapping pixel universes are rejected at startup', () => {
  const config = baseConfig();
  // 400 pixels spans universes 2, 3 and 4 - which is fine next to a zone at 6.
  config.lighting.pixelZones[0].pixelCount = 400;
  assert.doesNotThrow(() => validateConfig(config));

  // 800 pixels spans 2..6 and collides with the scanner.
  config.lighting.pixelZones[0].pixelCount = 800;
  assert.throws(() => validateConfig(config), /uses universe 6, already used by "pixels"/);
});

test('a pixel zone may not sit on a DMX universe', () => {
  const config = baseConfig();
  config.lighting.pixelZones[1].universeStart = 0;

  assert.throws(() => validateConfig(config), /already a DMX universe/);
});

test('an empty pixel zone reserves no universes', () => {
  const config = baseConfig();
  config.lighting.pixelZones[0].pixelCount = 0;
  config.lighting.pixelZones[1].universeStart = 2;

  assert.doesNotThrow(() => validateConfig(config));
});

test('structurally invalid pixel zones are rejected', () => {
  const badCount = baseConfig();
  badCount.lighting.pixelZones[0].pixelCount = -1;
  assert.throws(() => validateConfig(badCount), /invalid pixelCount/);

  const badChannels = baseConfig();
  badChannels.lighting.pixelZones[0].channelsPerPixel = 5;
  assert.throws(() => validateConfig(badChannels), /channelsPerPixel must be 3 or 4/);

  const badStart = baseConfig();
  badStart.lighting.pixelZones[0].universeStart = -2;
  assert.throws(() => validateConfig(badStart), /invalid universeStart/);
});

test('out-of-range DMX channels and frame rates are rejected', () => {
  const badChannel = baseConfig();
  badChannel.lighting.zones[0].channel = 513;
  assert.throws(() => validateConfig(badChannel), /invalid DMX channel/);

  const badRate = baseConfig();
  badRate.artnet.frameRate = 120;
  assert.throws(() => validateConfig(badRate), /frameRate must be between/);
});
