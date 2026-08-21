/**
 * Application entry point.
 *
 * Startup order:
 *   1. load configuration
 *   2. initialise Art-Net (simulated or real transport)
 *   3. initialise lighting state (everything off)
 *   4. start the lighting engine / render loop
 *   4b. initialise audio playback
 *   5. start Express
 *   6. start the WebSocket service
 *   7. serve the UI
 *   8. output the known lighting state
 *
 * Decorative lighting is never restored automatically after a power
 * interruption — the cart always comes up dark.
 */

import http from 'node:http';
import { loadConfig, ROOT_DIR } from './config/index.js';
import { createLogger } from './utils/logger.js';
import { createApp } from './app.js';
import { createArtNetService } from './services/artnet/index.js';
import { LightingService } from './services/lightingService.js';
import { SceneService } from './services/sceneService.js';
import { LightingEngine } from './services/lightingEngine.js';
import { WebSocketService } from './services/websocketService.js';
import { AudioService } from './services/audioService.js';

const log = createLogger('startup');

async function main() {
  log.info('golf cart lighting controller starting');

  // 1. Configuration
  const config = loadConfig();
  log.info(
    `config loaded: httpPort=${config.network.httpPort} frameRate=${config.artnet.frameRate} ` +
      `simulation=${config.artnet.simulation} artnetHost=${config.artnet.host}`
  );
  if (config.artnet.simulation) {
    log.warn('LIGHTING SIMULATION MODE - no Art-Net packets will reach the BC-204');
  }

  // 2. Art-Net output
  const artnet = await createArtNetService({
    artnetConfig: config.artnet,
    lightingConfig: config.lighting,
  });

  // 3. Lighting state + scenes
  const lighting = new LightingService(config.lighting);
  const scenes = new SceneService({ scenes: config.scenes, lighting });

  // 4. Render loop
  const engine = new LightingEngine({
    lighting,
    artnet,
    lightingConfig: config.lighting,
    frameRate: config.artnet.frameRate,
  });
  engine.start();

  // 4b. Audio. Never fatal: a cart with no sound card still has to light up,
  // so the service reports its own unavailability rather than throwing.
  const audio = new AudioService({ audioConfig: config.audio, rootDir: ROOT_DIR });

  const getStatus = () => ({
    artnet: {
      ...artnet.getStatus(),
      destination: config.artnet.simulation ? null : `${config.artnet.host}:${config.artnet.port}`,
    },
    engine: engine.getStatus(),
    activeSceneId: lighting.getSnapshot().activeSceneId,
    audio: audio.getStatus(),
    uptimeSeconds: Math.round(process.uptime()),
  });

  // 5-7. HTTP + WebSocket + UI
  const app = createApp({ lighting, scenes, audio, getStatus });
  const server = http.createServer(app);
  const ws = new WebSocketService({ httpServer: server, lighting, scenes, audio, getStatus });
  ws.start();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.network.httpPort, config.network.httpHost, resolve);
  });
  log.info(`http listening on http://${config.network.httpHost}:${config.network.httpPort}`);

  // 8. The engine is already pushing the known (all-off) state.
  log.info('controller ready');

  registerShutdown({ server, ws, engine, artnet, lighting, audio, config });
}

function registerShutdown({ server, ws, engine, artnet, lighting, audio, config }) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received - shutting down`);

    // Stop the render loop first, otherwise the next frame would immediately
    // overwrite the zeros we are about to send.
    engine.stop();
    lighting.allOff({ source: 'shutdown' });

    // Don't leave the theme looping over a stopped controller.
    try {
      await audio.close();
    } catch (err) {
      log.error('audio shutdown error:', err.message);
    }

    try {
      artnet.blackout(config.artnet.shutdownBlackoutFrames ?? 5);
      await artnet.close();
    } catch (err) {
      log.error('art-net shutdown error:', err.message);
    }

    try {
      await ws.close();
    } catch (err) {
      log.error('websocket shutdown error:', err.message);
    }

    server.close(() => {
      log.info('http server closed - goodbye');
      process.exit(0);
    });

    // Don't hang forever on a wedged keep-alive connection.
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception:', err);
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection:', reason);
  });
}

main().catch((err) => {
  log.error('fatal startup error:', err);
  process.exit(1);
});
