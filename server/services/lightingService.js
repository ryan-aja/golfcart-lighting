/**
 * Lighting service — the authoritative lighting state.
 *
 * Everything that wants to change the lights (REST, WebSocket, scenes, and
 * later a hardware input service) goes through here. It emits a "change" event
 * that the WebSocket service broadcasts and the lighting engine reads on its
 * next frame. It never talks to Art-Net directly.
 */

import { EventEmitter } from 'node:events';
import { createLogger } from '../utils/logger.js';
import { applyZonePatch, createAllOffState, createInitialState } from '../lighting/state.js';
import { effectIds } from '../effects/index.js';

const log = createLogger('lighting');

export class LightingService extends EventEmitter {
  #config;
  #state;
  #zones = new Map();
  #activeSceneId = null;
  #updatedAt = Date.now();

  constructor(lightingConfig) {
    super();
    this.#config = lightingConfig;
    for (const zone of [...(lightingConfig.zones ?? []), ...(lightingConfig.pixelZones ?? [])]) {
      this.#zones.set(zone.id, zone);
    }
    this.#state = createInitialState(lightingConfig);
    log.info(`state initialised with ${this.#zones.size} zones (all off)`);
  }

  getState() {
    return this.#state;
  }

  getSnapshot() {
    return {
      state: structuredClone(this.#state),
      activeSceneId: this.#activeSceneId,
      updatedAt: this.#updatedAt,
    };
  }

  getZones() {
    // Shape the config into what the UI needs to render controls generically.
    return [...this.#zones.values()]
      .filter((zone) => !zone.hidden)
      .map((zone) => ({
        id: zone.id,
        name: zone.name,
        type: zone.type,
        modes: zone.modes,
        pixelCount: zone.pixelCount,
      }));
  }

  hasZone(zoneId) {
    return this.#zones.has(zoneId);
  }

  /**
   * Apply a partial update to one zone.
   * @returns the updated zone state
   */
  setZone(zoneId, patch, { source = 'api' } = {}) {
    const zone = this.#zones.get(zoneId);
    if (!zone) throw new Error(`Unknown lighting zone "${zoneId}"`);

    const next = applyZonePatch(zone, this.#state[zoneId], patch ?? {}, {
      availableEffects: zone.type === 'pixel' ? effectIds() : null,
    });

    this.#state[zoneId] = next;
    // A manual change means we are no longer sitting on a stored scene.
    this.#activeSceneId = null;
    this.#commit(`${source}:${zoneId}`);
    return next;
  }

  /** Replace the whole state (used by scene activation). */
  applyState(partialState, { sceneId = null, source = 'scene' } = {}) {
    for (const [zoneId, patch] of Object.entries(partialState ?? {})) {
      const zone = this.#zones.get(zoneId);
      if (!zone) {
        log.warn(`scene references unknown zone "${zoneId}" - ignored`);
        continue;
      }
      this.#state[zoneId] = applyZonePatch(zone, this.#state[zoneId], patch, {
        availableEffects: zone.type === 'pixel' ? effectIds() : null,
      });
    }
    this.#activeSceneId = sceneId;
    this.#commit(source);
    return this.#state;
  }

  allOff({ source = 'master-off' } = {}) {
    this.#state = createAllOffState(this.#config, this.#state);
    this.#activeSceneId = null;
    this.#commit(source);
    log.info(`all lighting off (${source})`);
    return this.#state;
  }

  #commit(source) {
    this.#updatedAt = Date.now();
    this.emit('change', { snapshot: this.getSnapshot(), source });
  }
}
