/**
 * REST API.
 *
 * The WebSocket channel is the primary path for interactive UI control; this
 * API exists so the system can be driven from curl, Postman or a future
 * integration without opening a socket. Both paths funnel through the same
 * lighting service, so neither can bypass validation.
 */

import { Router } from 'express';
import { createLightsRouter } from './lightsRoutes.js';
import { createScenesRouter } from './scenesRoutes.js';
import { createAudioRouter } from './audioRoutes.js';
import { listEffects } from '../effects/index.js';

export function createApiRouter({ lighting, scenes, audio, getStatus }) {
  const router = Router();

  router.get('/state', (_req, res) => {
    res.json(lighting.getSnapshot());
  });

  router.get('/status', (_req, res) => {
    res.json(getStatus());
  });

  router.get('/config', (_req, res) => {
    res.json({
      zones: lighting.getZones(),
      scenes: scenes.list(),
      effects: listEffects(),
      audio: audio.getStatus(),
    });
  });

  router.get('/effects', (_req, res) => {
    res.json({ effects: listEffects() });
  });

  router.use('/lights', createLightsRouter({ lighting }));
  router.use('/scenes', createScenesRouter({ scenes }));
  router.use('/audio', createAudioRouter({ audio }));

  router.use((_req, res) => {
    res.status(404).json({ ok: false, error: 'Not found' });
  });

  return router;
}
