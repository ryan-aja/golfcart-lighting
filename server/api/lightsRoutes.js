/**
 * Lighting zone routes.
 *
 * A single generic `:zoneId` route serves every zone, so the documented URLs
 * (/api/lights/headlights, /api/lights/accent, ...) all work without a
 * per-zone handler, and a zone added to config/lighting.json is immediately
 * controllable over REST.
 */

import { Router } from 'express';

export function createLightsRouter({ lighting }) {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ zones: lighting.getZones(), state: lighting.getState() });
  });

  router.post('/all-off', (_req, res) => {
    lighting.allOff({ source: 'rest' });
    res.json({ ok: true, state: lighting.getState() });
  });

  router.post('/:zoneId', (req, res) => {
    const { zoneId } = req.params;
    if (!lighting.hasZone(zoneId)) {
      return res.status(404).json({ ok: false, error: `Unknown lighting zone "${zoneId}"` });
    }
    try {
      const zoneState = lighting.setZone(zoneId, req.body ?? {}, { source: 'rest' });
      res.json({ ok: true, zone: zoneId, state: zoneState });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  return router;
}
