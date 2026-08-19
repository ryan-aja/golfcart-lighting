/**
 * Minimal leveled logger.
 *
 * Levels: error < warn < info < debug
 * Set LOG_LEVEL=debug (or DEBUG=1) to enable verbose troubleshooting output.
 * Per-frame Art-Net output is logged at `debug` only, so normal operation stays quiet.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function resolveLevel() {
  const raw = (process.env.LOG_LEVEL || '').toLowerCase();
  if (raw in LEVELS) return raw;
  if (process.env.DEBUG) return 'debug';
  return 'info';
}

const activeLevel = LEVELS[resolveLevel()];

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function emit(level, scope, args) {
  if (LEVELS[level] > activeLevel) return;
  const prefix = `${stamp()} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  // eslint-disable-next-line no-console
  console[level === 'debug' ? 'log' : level](prefix, ...args);
}

export function createLogger(scope) {
  return {
    error: (...args) => emit('error', scope, args),
    warn: (...args) => emit('warn', scope, args),
    info: (...args) => emit('info', scope, args),
    debug: (...args) => emit('debug', scope, args),
    isDebug: () => activeLevel >= LEVELS.debug,
  };
}

export const logger = createLogger('app');
