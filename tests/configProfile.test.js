import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_DIR, PROFILES_DIR } from '../server/config/index.js';

/**
 * Profiles let one codebase drive more than one rig — the golf cart with its
 * pixel controller, and a set of LT890 fixtures — differing only in config.
 *
 * The loader reads the profile once at import, so these exercise the files and
 * the rules rather than re-importing the module per case: what matters is that
 * every shipped profile is loadable, self-consistent, and cannot be confused
 * with another rig's channel map.
 */

const profiles = fs.existsSync(PROFILES_DIR)
  ? fs.readdirSync(PROFILES_DIR).filter((d) => fs.statSync(path.join(PROFILES_DIR, d)).isDirectory())
  : [];

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('profile.json ships inert, so pulling this code cannot switch a rig', () => {
  const file = path.join(CONFIG_DIR, 'profile.json');
  assert.ok(fs.existsSync(file), 'config/profile.json should exist as documentation');

  const active = (readJson(file).active ?? '').trim();
  assert.equal(
    active,
    '',
    'the committed profile.json must select nothing — a Pi opts in locally, ' +
      'otherwise a git pull would repoint an installed cart at another rig'
  );
});

test('at least one profile ships, and every one is loadable', () => {
  assert.ok(profiles.length > 0, 'expected config/profiles/<name>/');

  for (const name of profiles) {
    const lighting = path.join(PROFILES_DIR, name, 'lighting.json');
    assert.ok(fs.existsSync(lighting), `profile "${name}" needs a lighting.json`);
    assert.doesNotThrow(() => readJson(lighting), `profile "${name}" lighting.json must parse`);
  }
});

test('no profile assigns the same DMX channel twice', () => {
  // The failure this prevents is silent: two zones sharing a channel means one
  // quietly overwrites the other and a fixture never responds.
  for (const name of profiles) {
    const lighting = readJson(path.join(PROFILES_DIR, name, 'lighting.json'));
    const seen = new Map();

    for (const zone of lighting.zones ?? []) {
      const channels = zone.channels
        ? Object.values(zone.channels)
        : Number.isFinite(zone.channel)
          ? [zone.channel]
          : [];

      for (const ch of channels) {
        const key = `${zone.universe ?? lighting.dmxUniverse}:${ch}`;
        assert.equal(
          seen.has(key),
          false,
          `profile "${name}": channel ${ch} claimed by both "${seen.get(key)}" and "${zone.id}"`
        );
        seen.set(key, zone.id);
        assert.ok(ch >= 1 && ch <= 512, `profile "${name}": channel ${ch} is outside DMX range`);
      }
    }
  }
});

test('every scene in a profile refers to zones that profile defines', () => {
  // A scene naming a zone from the other rig would be a silent no-op.
  for (const name of profiles) {
    const dir = path.join(PROFILES_DIR, name);
    const scenesFile = path.join(dir, 'scenes.json');
    if (!fs.existsSync(scenesFile)) continue;

    const lighting = readJson(path.join(dir, 'lighting.json'));
    const ids = new Set([
      ...(lighting.zones ?? []).map((z) => z.id),
      ...(lighting.pixelZones ?? []).map((z) => z.id),
    ]);

    for (const scene of readJson(scenesFile).scenes ?? []) {
      for (const zoneId of Object.keys(scene.zones ?? {})) {
        assert.ok(
          ids.has(zoneId),
          `profile "${name}": scene "${scene.id}" refers to unknown zone "${zoneId}"`
        );
      }
    }
  }
});

test('the lt890 profile lays four fixtures out on a 12-channel stride', () => {
  const lighting = readJson(path.join(PROFILES_DIR, 'lt890', 'lighting.json'));
  const rgb = (lighting.zones ?? []).filter((z) => z.type === 'rgb');

  assert.equal(rgb.length, 4, 'four LT890 fixtures');
  assert.deepEqual(
    rgb.map((z) => z.channels.r),
    [1, 13, 25, 37],
    'each fixture starts 12 channels after the last'
  );

  // 4 x 12 has to fit in the single universe they share.
  const highest = Math.max(
    ...(lighting.zones ?? []).flatMap((z) =>
      z.channels ? Object.values(z.channels) : Number.isFinite(z.channel) ? [z.channel] : []
    )
  );
  assert.ok(highest <= 48, `all four fixtures fit in 48 channels (highest used: ${highest})`);
  assert.equal(lighting.pixelZones?.length ?? 0, 0, 'this rig has no addressable strips');
});
