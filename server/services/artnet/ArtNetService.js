/**
 * Art-Net service — the ONLY Art-Net interface application code should use.
 *
 *   artnet.setChannel(universe, channel, value)
 *   artnet.setChannels(universe, startChannel, values)
 *   artnet.setUniverse(universe, buffer)
 *   artnet.flush()
 *
 * It holds the current value of every universe and hands frames to a pluggable
 * transport (simulation or real UDP). Nothing above this layer knows how an
 * ArtDMX packet is shaped, which means the transport can be swapped — or
 * replaced with an npm library — without touching lighting or UI code.
 *
 * Flow control: `flush()` only transmits a universe whose contents changed,
 * plus a periodic keep-alive re-send so the BC-204 never times out on a static
 * scene. That keeps a parked cart at ~1 packet/sec instead of 30.
 */

import { createLogger } from '../../utils/logger.js';
import { DMX_UNIVERSE_SIZE } from '../../lighting/mapping.js';

const log = createLogger('artnet');

export class ArtNetService {
  #transport;
  #keepAliveMs;
  #universes = new Map(); // universe -> Buffer(512)
  #dirty = new Set();
  #lastSentAt = new Map(); // universe -> epoch ms
  #framesSent = 0;
  #lastFrameAt = null;
  #started = false;
  #now;

  constructor({ transport, keepAliveMs = 1000, now = () => Date.now() }) {
    this.#transport = transport;
    this.#keepAliveMs = keepAliveMs;
    this.#now = now;
  }

  async init() {
    await this.#transport.init?.();
    this.#started = true;
  }

  get simulation() {
    return Boolean(this.#transport.simulation);
  }

  #bufferFor(universe) {
    if (!this.#universes.has(universe)) {
      this.#universes.set(universe, Buffer.alloc(DMX_UNIVERSE_SIZE));
      this.#dirty.add(universe);
    }
    return this.#universes.get(universe);
  }

  /** @param {number} channel 1-based DMX channel */
  setChannel(universe, channel, value) {
    if (channel < 1 || channel > DMX_UNIVERSE_SIZE) {
      throw new RangeError(`DMX channel must be 1-${DMX_UNIVERSE_SIZE} (got ${channel})`);
    }
    const buffer = this.#bufferFor(universe);
    const byte = Math.min(255, Math.max(0, Math.round(value) || 0));
    if (buffer[channel - 1] !== byte) {
      buffer[channel - 1] = byte;
      this.#dirty.add(universe);
    }
  }

  /** @param {number} startChannel 1-based DMX channel of the first value */
  setChannels(universe, startChannel, values) {
    values.forEach((value, index) => this.setChannel(universe, startChannel + index, value));
  }

  /** Replace an entire universe. Data shorter than 512 leaves the tail untouched. */
  setUniverse(universe, data) {
    const buffer = this.#bufferFor(universe);
    if (buffer.equals(data) && data.length === buffer.length) return;
    data.copy(buffer, 0, 0, Math.min(data.length, buffer.length));
    this.#dirty.add(universe);
  }

  getUniverse(universe) {
    return Buffer.from(this.#bufferFor(universe));
  }

  /** Send every universe that changed, plus any due for a keep-alive re-send. */
  flush() {
    if (!this.#started) return 0;
    const now = this.#now();
    let sent = 0;

    for (const universe of this.#universes.keys()) {
      const staleSince = now - (this.#lastSentAt.get(universe) ?? 0);
      const needsSend = this.#dirty.has(universe) || staleSince >= this.#keepAliveMs;
      if (!needsSend) continue;

      this.#transport.send(universe, this.#universes.get(universe));
      this.#lastSentAt.set(universe, now);
      this.#dirty.delete(universe);
      sent += 1;
    }

    if (sent > 0) {
      this.#framesSent += sent;
      this.#lastFrameAt = now;
    }
    return sent;
  }

  /** Zero every known universe and force it onto the wire immediately. */
  blackout(frames = 1) {
    for (const buffer of this.#universes.values()) buffer.fill(0);
    for (let i = 0; i < frames; i += 1) {
      for (const universe of this.#universes.keys()) this.#dirty.add(universe);
      this.#lastSentAt.clear();
      this.flush();
    }
    log.info(`blackout sent (${frames} frame${frames === 1 ? '' : 's'})`);
  }

  getStatus() {
    return {
      configured: this.#started,
      simulation: this.simulation,
      transport: this.#transport.name,
      universes: [...this.#universes.keys()].sort((a, b) => a - b),
      framesSent: this.#framesSent,
      lastFrameAt: this.#lastFrameAt,
      ...(this.#transport.getStats?.() ?? {}),
    };
  }

  async close() {
    this.#started = false;
    await this.#transport.close?.();
  }
}
