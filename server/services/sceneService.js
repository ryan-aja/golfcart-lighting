/**
 * Scene service.
 *
 * A scene is just a stored collection of partial zone states, loaded from
 * config/scenes.json. Activating one pushes that partial state through the
 * lighting service, so scenes get the same validation as any other update.
 */

import { createLogger } from '../utils/logger.js';

const log = createLogger('scenes');

export class SceneService {
  #scenes = new Map();
  #lighting;

  constructor({ scenes = [], lighting }) {
    this.#lighting = lighting;
    for (const scene of scenes) {
      if (!scene.id) {
        log.warn('scene without an id skipped');
        continue;
      }
      this.#scenes.set(scene.id, scene);
    }
    log.info(`loaded ${this.#scenes.size} scenes: ${[...this.#scenes.keys()].join(', ')}`);
  }

  list() {
    return [...this.#scenes.values()].map(({ id, name }) => ({ id, name }));
  }

  get(sceneId) {
    return this.#scenes.get(sceneId) ?? null;
  }

  activate(sceneId) {
    const scene = this.#scenes.get(sceneId);
    if (!scene) throw new Error(`Unknown scene "${sceneId}"`);

    log.info(`activating scene "${scene.name ?? scene.id}"`);
    this.#lighting.applyState(scene.state, { sceneId: scene.id, source: `scene:${scene.id}` });
    return scene;
  }
}
