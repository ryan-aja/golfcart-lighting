/**
 * Express application wiring.
 *
 * In production the same Node process serves the built React app, so the
 * whole controller is a single deployable service. In development the Vite
 * dev server runs separately and proxies /api and /socket.io here.
 */

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createApiRouter } from './api/index.js';
import { CLIENT_DIST_DIR } from './config/index.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('http');

export function createApp({ lighting, scenes, getStatus }) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  // Cheap liveness probe for systemd / kiosk startup scripts.
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.use('/api', createApiRouter({ lighting, scenes, getStatus }));

  const hasClientBuild = fs.existsSync(path.join(CLIENT_DIST_DIR, 'index.html'));
  if (hasClientBuild) {
    app.use(express.static(CLIENT_DIST_DIR));
    // SPA fallback: any non-API path returns the app shell.
    app.get(/.*/, (_req, res) => res.sendFile(path.join(CLIENT_DIST_DIR, 'index.html')));
    log.info(`serving client build from ${CLIENT_DIST_DIR}`);
  } else {
    app.get('/', (_req, res) => {
      res
        .status(200)
        .type('html')
        .send(
          '<h1>Golf Cart Lighting</h1>' +
            '<p>No client build found. Run <code>npm run dev</code> for the Vite dev server, ' +
            'or <code>npm run build</code> to produce a production bundle.</p>'
        );
    });
    log.warn('no client build found - run "npm run build" before production start');
  }

  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
  app.use((err, _req, res, _next) => {
    log.error('unhandled request error:', err.message);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  });

  return app;
}
