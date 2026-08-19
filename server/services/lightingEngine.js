/**
 * Lighting engine — the single central render loop.
 *
 * One timer drives everything. Effects do not own timers; they are pure
 * functions sampled at whatever rate this loop runs, so animation never
 * depends on UI refresh and adding effects never adds timers.
 *
 * Each frame:
 *   1. read the authoritative state
 *   2. map static zones onto DMX universes
 *   3. render pixel zones through the effect registry
 *   4. hand the universes to the Art-Net service
 *   5. flush (which only transmits what changed, plus keep-alives)
 */

import { createLogger } from '../utils/logger.js';
import { renderDmxUniverses, scaleColorComponent, splitPixelsIntoUniverses } from '../lighting/mapping.js';
import { getEffect } from '../effects/index.js';

const log = createLogger('engine');

export class LightingEngine {
  #lighting;
  #artnet;
  #lightingConfig;
  #frameIntervalMs;
  #timer = null;
  #startedAt = 0;
  #frameCount = 0;
  #now;

  constructor({ lighting, artnet, lightingConfig, frameRate = 30, now = () => Date.now() }) {
    this.#lighting = lighting;
    this.#artnet = artnet;
    this.#lightingConfig = lightingConfig;
    this.#frameIntervalMs = Math.max(1, Math.round(1000 / frameRate));
    this.#now = now;
  }

  start() {
    if (this.#timer) return;
    this.#startedAt = this.#now();
    // Render once immediately so the known startup state reaches the hardware
    // without waiting a frame.
    this.renderFrame();
    this.#timer = setInterval(() => this.renderFrame(), this.#frameIntervalMs);
    this.#timer.unref?.();
    log.info(`render loop started at ${Math.round(1000 / this.#frameIntervalMs)} fps (${this.#frameIntervalMs}ms)`);
  }

  stop() {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
    log.info(`render loop stopped after ${this.#frameCount} frames`);
  }

  renderFrame() {
    try {
      const state = this.#lighting.getState();

      for (const [universe, buffer] of renderDmxUniverses(state, this.#lightingConfig)) {
        this.#artnet.setUniverse(universe, buffer);
      }

      for (const zone of this.#lightingConfig.pixelZones ?? []) {
        this.#renderPixelZone(zone, state[zone.id]);
      }

      this.#artnet.flush();
      this.#frameCount += 1;
    } catch (err) {
      // A render failure must not kill the timer, or the lights freeze.
      log.error('frame render failed:', err.message);
    }
  }

  #renderPixelZone(zone, zoneState) {
    if (!zoneState) return;
    const pixelCount = zone.pixelCount ?? 0;
    if (pixelCount === 0) return;

    const maxOutput = zone.maxOutput ?? 255;
    let pixels;

    if (!zoneState.enabled) {
      pixels = Array.from({ length: pixelCount }, () => ({ r: 0, g: 0, b: 0 }));
    } else {
      const effect = getEffect(zoneState.effect);
      const raw = effect.render({
        pixelCount,
        color: zoneState.color,
        secondaryColor: zoneState.secondaryColor,
        speed: zoneState.speed,
        trail: zoneState.trail,
        timeSeconds: (this.#now() - this.#startedAt) / 1000,
      });
      // Brightness and the output ceiling are applied here, not in the effect,
      // so every effect obeys the same limits.
      pixels = raw.map((p) => ({
        r: scaleColorComponent(p.r, zoneState.brightness, maxOutput),
        g: scaleColorComponent(p.g, zoneState.brightness, maxOutput),
        b: scaleColorComponent(p.b, zoneState.brightness, maxOutput),
      }));
    }

    for (const { universe, data } of splitPixelsIntoUniverses(pixels, zone)) {
      this.#artnet.setUniverse(universe, data);
    }
  }

  getStatus() {
    return {
      running: this.#timer !== null,
      frameRate: Math.round(1000 / this.#frameIntervalMs),
      frameIntervalMs: this.#frameIntervalMs,
      framesRendered: this.#frameCount,
    };
  }
}
