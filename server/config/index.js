/**
 * Configuration loader.
 *
 * All hardware-specific values (IPs, DMX channels, universes, pixel counts,
 * frame rate, output limits) live in /config/*.json so they can be changed
 * without touching application or UI code.
 *
 * Environment variables override file values where it is useful to do so
 * during development or in the systemd unit on the Pi.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../utils/logger.js';
import { pixelsPerUniverse } from '../lighting/mapping.js';

const log = createLogger('config');

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '..', '..');
export const CONFIG_DIR = path.join(ROOT_DIR, 'config');
export const CLIENT_DIST_DIR = path.join(ROOT_DIR, 'client', 'dist');

function readJson(name) {
  const file = path.join(CONFIG_DIR, name);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Unable to load config file ${file}: ${err.message}`);
  }
}

/**
 * Like readJson, but a missing file falls back to a default. Used for config
 * added after the first release, so an existing Pi that pulls the new code
 * without the new file still starts.
 */
function readJsonOptional(name, fallback) {
  const file = path.join(CONFIG_DIR, name);
  if (!fs.existsSync(file)) {
    log.debug(`${name} not present - using defaults`);
    return fallback;
  }
  return readJson(name);
}

// Used when config/audio.json is absent. The paths are the same ones the
// installer and scripts/make-theme.js write to.
const DEFAULT_AUDIO = {
  enabled: true,
  files: ['assets/audio/theme.mp3', 'assets/audio/theme.wav'],
  volume: 85,
  defaultLoop: false,
  player: null,
};

function envBool(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function envInt(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

function firstDefined(...values) {
  return values.find((v) => v !== undefined && v !== null);
}

export function loadConfig() {
  const network = readJson('network.json');
  const artnetFile = readJson('artnet.json');
  const lighting = readJson('lighting.json');
  const scenes = readJson('scenes.json');
  const audioFile = readJsonOptional('audio.json', DEFAULT_AUDIO);

  const artnet = {
    ...artnetFile,
    simulation: firstDefined(envBool('LIGHTING_SIMULATION'), artnetFile.simulation, true),
    host: firstDefined(process.env.ARTNET_HOST, artnetFile.host),
    port: firstDefined(envInt('ARTNET_PORT'), artnetFile.port, 6454),
    frameRate: firstDefined(envInt('LIGHTING_FRAME_RATE'), artnetFile.frameRate, 30),
    keepAliveMs: firstDefined(envInt('ARTNET_KEEPALIVE_MS'), artnetFile.keepAliveMs, 1000),
  };

  const config = {
    network: {
      ...network,
      httpPort: firstDefined(envInt('PORT'), network.httpPort, 3100),
      httpHost: firstDefined(process.env.HTTP_HOST, network.httpHost, '0.0.0.0'),
    },
    artnet,
    lighting,
    scenes: scenes.scenes ?? [],
    audio: {
      ...audioFile,
      enabled: firstDefined(envBool('AUDIO_ENABLED'), audioFile.enabled, true),
      files: process.env.AUDIO_FILE ? [process.env.AUDIO_FILE] : audioFile.files ?? [],
      volume: firstDefined(envInt('AUDIO_VOLUME'), audioFile.volume, 85),
      player: firstDefined(process.env.AUDIO_PLAYER, audioFile.player, null),
      defaultLoop: firstDefined(envBool('AUDIO_LOOP'), audioFile.defaultLoop, false),
    },
  };

  validateConfig(config);
  return config;
}

/**
 * Fail fast on configuration that would silently produce wrong DMX output —
 * a duplicated channel is far easier to spot here than on a test bench.
 */
export function validateConfig(config) {
  const claimed = new Map(); // "universe:channel" -> zone id

  const claim = (universe, channel, zoneId) => {
    if (!Number.isInteger(channel) || channel < 1 || channel > 512) {
      throw new Error(`Zone "${zoneId}" has invalid DMX channel ${channel} (expected 1-512)`);
    }
    const key = `${universe}:${channel}`;
    if (claimed.has(key)) {
      throw new Error(
        `Zone "${zoneId}" claims universe ${universe} channel ${channel}, already used by "${claimed.get(key)}"`
      );
    }
    claimed.set(key, zoneId);
  };

  const dmxUniverses = new Set();

  for (const zone of config.lighting.zones ?? []) {
    const universe = zone.universe ?? config.lighting.dmxUniverse ?? 0;
    dmxUniverses.add(universe);
    if (zone.type === 'rgb') {
      claim(universe, zone.channels?.r, zone.id);
      claim(universe, zone.channels?.g, zone.id);
      claim(universe, zone.channels?.b, zone.id);
    } else {
      claim(universe, zone.channel, zone.id);
    }
    if (zone.maxOutput !== undefined && (zone.maxOutput < 0 || zone.maxOutput > 255)) {
      throw new Error(`Zone "${zone.id}" maxOutput must be 0-255`);
    }
  }

  // Pixel zones span a *range* of universes, so overlaps are easy to create by
  // hand and invisible until two strips fight over the same output. Catch it here.
  const pixelUniverses = new Map(); // universe -> zone id

  for (const zone of config.lighting.pixelZones ?? []) {
    if (!Number.isInteger(zone.pixelCount) || zone.pixelCount < 0) {
      throw new Error(`Pixel zone "${zone.id}" has invalid pixelCount`);
    }
    if (![3, 4].includes(zone.channelsPerPixel)) {
      throw new Error(`Pixel zone "${zone.id}" channelsPerPixel must be 3 or 4`);
    }
    if (!Number.isInteger(zone.universeStart) || zone.universeStart < 0) {
      throw new Error(`Pixel zone "${zone.id}" has invalid universeStart`);
    }

    const span = zone.pixelCount > 0
      ? Math.ceil(zone.pixelCount / pixelsPerUniverse(zone.channelsPerPixel))
      : 0;

    for (let i = 0; i < span; i += 1) {
      const universe = zone.universeStart + i;
      if (dmxUniverses.has(universe)) {
        throw new Error(
          `Pixel zone "${zone.id}" uses universe ${universe}, which is already a DMX universe`
        );
      }
      if (pixelUniverses.has(universe)) {
        throw new Error(
          `Pixel zone "${zone.id}" uses universe ${universe}, already used by "${pixelUniverses.get(universe)}"`
        );
      }
      pixelUniverses.set(universe, zone.id);
    }

    log.debug(
      `pixel zone "${zone.id}": ${zone.pixelCount} px -> ${span} universe(s) from ${zone.universeStart}`
    );
  }

  if (config.artnet.frameRate < 1 || config.artnet.frameRate > 60) {
    throw new Error(`artnet.frameRate must be between 1 and 60 (got ${config.artnet.frameRate})`);
  }

  // Audio never affects DMX output, so a bad value here is a warning rather
  // than a startup failure — the cart should still light up without sound.
  const audio = config.audio;
  if (audio) {
    if (!Array.isArray(audio.files)) {
      throw new Error('audio.files must be an array of paths');
    }
    if (!Number.isFinite(audio.volume) || audio.volume < 0 || audio.volume > 100) {
      throw new Error(`audio.volume must be between 0 and 100 (got ${audio.volume})`);
    }
  }

  log.debug('configuration validated', {
    zones: config.lighting.zones?.length ?? 0,
    pixelZones: config.lighting.pixelZones?.length ?? 0,
    scenes: config.scenes.length,
  });
}
