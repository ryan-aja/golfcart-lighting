/**
 * WebSocket service (Socket.IO).
 *
 * Real-time synchronisation between the server (source of truth) and every
 * connected UI — the touchscreen and, later, phones on Wi-Fi. A client sends an
 * intent, the lighting service validates and applies it, and the resulting
 * state is broadcast to everyone including the sender. Clients never render
 * optimistically off their own input alone.
 *
 * Socket.IO is used rather than raw `ws` for its automatic reconnection and
 * acknowledgement callbacks — worth the dependency on a vehicle where the
 * touchscreen may briefly lose the server during boot or a service restart.
 */

import { Server } from 'socket.io';
import { createLogger } from '../utils/logger.js';
import { listEffects } from '../effects/index.js';

const log = createLogger('ws');

const STATUS_BROADCAST_MS = 1000;

export class WebSocketService {
  #io;
  #lighting;
  #scenes;
  #getStatus;
  #statusTimer = null;

  constructor({ httpServer, lighting, scenes, getStatus }) {
    this.#lighting = lighting;
    this.#scenes = scenes;
    this.#getStatus = getStatus;
    this.#io = new Server(httpServer, {
      // Same-origin in production; the Vite dev server proxies, so no CORS
      // config is needed. Auth middleware would attach here later.
      serveClient: false,
    });
  }

  start() {
    this.#io.on('connection', (socket) => this.#onConnection(socket));

    // Push state to every client whenever the authoritative state changes.
    this.#lighting.on('change', ({ snapshot, source }) => {
      this.#io.emit('state', snapshot);
      log.debug(`state broadcast (source=${source})`);
    });

    this.#statusTimer = setInterval(() => {
      if (this.#io.engine.clientsCount > 0) this.#io.emit('status', this.#status());
    }, STATUS_BROADCAST_MS);
    this.#statusTimer.unref?.();

    log.info('websocket service started');
  }

  #status() {
    return { ...this.#getStatus(), connectedClients: this.#io.engine.clientsCount };
  }

  #onConnection(socket) {
    log.info(`client connected (${socket.id}) - ${this.#io.engine.clientsCount} total`);

    // Everything a fresh UI needs to render itself, in one message.
    socket.emit('bootstrap', {
      zones: this.#lighting.getZones(),
      scenes: this.#scenes.list(),
      effects: listEffects(),
      snapshot: this.#lighting.getSnapshot(),
      status: this.#status(),
    });

    socket.on('zone:set', ({ zone, patch } = {}, ack) => {
      this.#handle(ack, () => this.#lighting.setZone(zone, patch, { source: 'ws' }));
    });

    socket.on('scene:activate', ({ sceneId } = {}, ack) => {
      this.#handle(ack, () => this.#scenes.activate(sceneId));
    });

    socket.on('all:off', (_payload, ack) => {
      this.#handle(ack, () => this.#lighting.allOff({ source: 'ws' }));
    });

    socket.on('disconnect', (reason) => {
      log.info(`client disconnected (${socket.id}): ${reason}`);
    });
  }

  /** Run an action, acknowledge success, and report validation errors back. */
  #handle(ack, action) {
    try {
      action();
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      log.warn('rejected client command:', err.message);
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  }

  async close() {
    if (this.#statusTimer) clearInterval(this.#statusTimer);
    await this.#io.close();
    log.info('websocket service closed');
  }
}
