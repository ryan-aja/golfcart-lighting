import { Router } from 'express';

export function createScenesRouter({ scenes }) {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ scenes: scenes.list() });
  });

  router.post('/:sceneId', (req, res) => {
    try {
      const scene = scenes.activate(req.params.sceneId);
      res.json({ ok: true, scene: { id: scene.id, name: scene.name } });
    } catch (err) {
      res.status(404).json({ ok: false, error: err.message });
    }
  });

  return router;
}
