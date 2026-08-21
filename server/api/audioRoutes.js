/**
 * Audio routes.
 *
 * Mirrors the WebSocket commands so the theme can be triggered from curl or a
 * hardware button wired to a shell script, not just the touchscreen.
 */

import { Router } from 'express';

export function createAudioRouter({ audio }) {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(audio.getStatus());
  });

  router.post('/play', (req, res) => {
    try {
      res.json({ ok: true, audio: audio.play({ loop: req.body?.loop, source: 'rest' }) });
    } catch (err) {
      res.status(409).json({ ok: false, error: err.message });
    }
  });

  router.post('/stop', (_req, res) => {
    res.json({ ok: true, audio: audio.stop({ source: 'rest' }) });
  });

  router.post('/loop', (req, res) => {
    if (typeof req.body?.loop !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'loop must be true or false' });
    }
    res.json({ ok: true, audio: audio.setLoop(req.body.loop, { source: 'rest' }) });
  });

  return router;
}
