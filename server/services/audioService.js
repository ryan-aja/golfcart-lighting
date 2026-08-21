/**
 * Audio service — plays a sound file through the Pi's audio output.
 *
 * The controller carries no audio library dependency: it shells out to whichever
 * command-line player the Pi already has (mpg123, ffplay, paplay, aplay). That
 * keeps the install to an apt package instead of a native Node addon that would
 * need rebuilding for arm64 on every Node bump.
 *
 * Looping is handled here by respawning on clean exit rather than by the
 * player's own loop flag, because every player spells that differently and a
 * respawn is what makes "stop" reliably immediate on all of them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createLogger } from '../utils/logger.js';

const log = createLogger('audio');

/**
 * Players in preference order. `extensions: null` means the player handles
 * anything we are likely to hand it.
 *
 * Volume is applied per player because none of them agree on a scale: mpg123
 * wants a 0-32768 scale factor, ffplay 0-100, paplay 0-65536, and aplay has no
 * volume control at all (it plays at whatever the mixer is set to).
 */
const PLAYERS = [
  {
    bin: 'mpg123',
    extensions: ['.mp3'],
    args: (file, volume) => ['-q', '--scale', String(Math.round((volume / 100) * 32768)), file],
  },
  {
    bin: 'ffplay',
    extensions: null,
    args: (file, volume) => [
      '-nodisp',
      '-autoexit',
      '-loglevel', 'quiet',
      '-volume', String(volume),
      file,
    ],
  },
  {
    bin: 'paplay',
    extensions: ['.wav', '.flac', '.ogg'],
    args: (file, volume) => [`--volume=${Math.round((volume / 100) * 65536)}`, file],
  },
  {
    bin: 'aplay',
    extensions: ['.wav'],
    args: (file) => ['-q', file],
  },
];

export const PLAYER_NAMES = PLAYERS.map((p) => p.bin);

// A player that dies faster than this never really started — a missing ALSA
// device, an unreadable file, a codec it claimed to support. Respawning on
// those would spin the CPU, so a run this short counts as a failure.
const MIN_VIABLE_RUN_MS = 400;
const MAX_CONSECUTIVE_FAST_EXITS = 3;

// Grace period between SIGTERM and SIGKILL when stopping playback.
const KILL_GRACE_MS = 500;

// How much of a player's stderr to keep. Enough for the handful of lines that
// actually say what went wrong, without holding a looping player's output.
const STDERR_CAPTURE_LIMIT = 2048;

const DEFAULT_VOLUME = 85;

/** Locate an executable on PATH without spawning it. */
export function findExecutable(bin, env = process.env) {
  const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
  // On Windows a bare name needs an extension; on the Pi this list is just [''].
  const extensions =
    process.platform === 'win32'
      ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
      : [''];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, bin + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Not here — keep looking.
      }
    }
  }
  return null;
}

/**
 * Pick the first configured file that exists on disk. Relative paths resolve
 * against the repo root, so config/audio.json stays portable across installs.
 */
export function resolveAudioFile(files, rootDir) {
  for (const entry of files ?? []) {
    if (!entry) continue;
    const absolute = path.isAbsolute(entry) ? entry : path.join(rootDir, entry);
    if (fs.existsSync(absolute)) return absolute;
  }
  return null;
}

/** Choose a player that is installed and willing to open this file type. */
export function selectPlayer(file, { override = null, env = process.env } = {}) {
  const extension = path.extname(file).toLowerCase();

  // An explicit override wins even if we know nothing about it — the operator
  // may have something we have never heard of on the box.
  const candidates = override
    ? [PLAYERS.find((p) => p.bin === override) ?? { bin: override, extensions: null, args: (f) => [f] }]
    : PLAYERS;

  for (const candidate of candidates) {
    if (candidate.extensions && !candidate.extensions.includes(extension)) continue;
    const resolved = findExecutable(candidate.bin, env);
    if (resolved) return { ...candidate, path: resolved };
  }
  return null;
}

export class AudioService extends EventEmitter {
  #enabled;
  #volume;
  #file = null;
  #player = null;
  #child = null;
  #loop;
  #startedAt = null;
  #error = null;
  #stopping = false;
  #fastExits = 0;
  #killTimer = null;

  constructor({ audioConfig = {}, rootDir }) {
    super();
    this.#enabled = audioConfig.enabled !== false;
    this.#volume = clampVolume(audioConfig.volume);
    this.#loop = Boolean(audioConfig.defaultLoop);

    if (!this.#enabled) {
      log.info('audio disabled by config');
      return;
    }

    this.#file = resolveAudioFile(audioConfig.files, rootDir);
    if (!this.#file) {
      this.#error = 'No audio file installed';
      log.warn(
        `no audio file found (looked for: ${(audioConfig.files ?? []).join(', ') || 'nothing'}) — ` +
          'run "npm run make-theme", or drop your own file in assets/audio/'
      );
      return;
    }

    this.#player = selectPlayer(this.#file, { override: audioConfig.player });
    if (!this.#player) {
      this.#error = 'No audio player installed';
      log.warn(
        `found ${path.basename(this.#file)} but no player that can open it — ` +
          `install one of: ${PLAYER_NAMES.join(', ')}`
      );
      return;
    }

    log.info(
      `ready: ${path.basename(this.#file)} via ${this.#player.bin} at ${this.#volume}% volume`
    );
  }

  get available() {
    return Boolean(this.#file && this.#player);
  }

  get playing() {
    return Boolean(this.#child);
  }

  getStatus() {
    return {
      enabled: this.#enabled,
      available: this.available,
      playing: this.playing,
      loop: this.#loop,
      volume: this.#volume,
      file: this.#file ? path.basename(this.#file) : null,
      player: this.#player?.bin ?? null,
      error: this.#error,
      startedAt: this.#startedAt,
    };
  }

  /**
   * Start playback. Pressing play while already playing restarts from the top,
   * which is what a horn button should do.
   */
  play({ loop, source = 'api' } = {}) {
    if (!this.#enabled) throw new Error('Audio is disabled');
    if (!this.#file) throw new Error('No audio file installed');
    if (!this.#player) throw new Error('No audio player installed on this system');

    if (loop !== undefined) this.#loop = Boolean(loop);

    // Restarting: tear the old process down first, without letting its exit
    // handler fire a loop respawn underneath the new one.
    if (this.#child) this.#terminate();

    this.#fastExits = 0;
    this.#error = null;
    this.#startedAt = Date.now();
    log.info(`play (${source}) loop=${this.#loop}`);
    this.#spawn();
    this.#commit(source);
    return this.getStatus();
  }

  stop({ source = 'api' } = {}) {
    // The loop flag deliberately survives a stop: it is the checkbox's state,
    // not a property of this playback, and unticking it for the user would be
    // surprising. #terminate() is what actually breaks the respawn chain.
    if (!this.#child) {
      this.#startedAt = null;
      return this.getStatus();
    }
    log.info(`stop (${source})`);
    this.#terminate();
    this.#startedAt = null;
    this.#commit(source);
    return this.getStatus();
  }

  /** Change the loop flag, including mid-playback. */
  setLoop(loop, { source = 'api' } = {}) {
    const next = Boolean(loop);
    if (next === this.#loop) return this.getStatus();
    this.#loop = next;
    log.debug(`loop=${next} (${source})`);
    this.#commit(source);
    return this.getStatus();
  }

  #spawn() {
    const args = this.#player.args(this.#file, this.#volume);
    const startedAt = Date.now();

    let child;
    try {
      // stderr is piped rather than ignored: players report a dead audio device
      // there and then exit 0, which is otherwise indistinguishable from a
      // track that simply ended. Piping it is only safe because the handler
      // below drains it — an unread pipe fills and blocks the child.
      child = spawn(this.#player.path, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      this.#error = `Could not start ${this.#player.bin}: ${err.message}`;
      log.error(this.#error);
      this.#child = null;
      this.#startedAt = null;
      this.#commit('spawn-error');
      return;
    }

    this.#child = child;

    // Kept bounded: a looping player left running for hours must not grow this
    // without limit. The first lines are the useful ones anyway.
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < STDERR_CAPTURE_LIMIT) stderr += chunk;
    });

    child.on('error', (err) => {
      if (child !== this.#child) return;
      this.#error = `${this.#player.bin} failed: ${err.message}`;
      log.error(this.#error);
      this.#child = null;
      this.#startedAt = null;
      this.#commit('player-error');
    });

    child.on('exit', (code, signal) => {
      // A process we already replaced or killed — its exit is not our business.
      if (child !== this.#child) return;
      this.#child = null;

      const ranFor = Date.now() - startedAt;
      const failed = code !== 0 && signal === null;
      const complaint = tidyStderr(stderr);

      if (failed || ranFor < MIN_VIABLE_RUN_MS) {
        this.#fastExits += 1;
        if (this.#fastExits >= MAX_CONSECUTIVE_FAST_EXITS) {
          this.#error =
            `${this.#player.bin} exited immediately (code ${code})` +
            (complaint ? `: ${complaint}` : ' — check the audio device');
          log.error(this.#error);
          this.#startedAt = null;
          this.#commit('player-failed');
          return;
        }
      } else {
        this.#fastExits = 0;
      }

      if (this.#loop) {
        if (complaint) log.warn(`${this.#player.bin}: ${complaint}`);
        log.debug('track finished — looping');
        this.#spawn();
        return;
      }

      // A player that complained and then exited 0 has almost certainly played
      // nothing — a dead ALSA device does exactly this. Surface it rather than
      // reporting a silent non-event as a completed track.
      if (complaint) {
        this.#error = `${this.#player.bin}: ${complaint}`;
        log.error(`playback produced no sound — ${this.#error}`);
      } else {
        log.info('playback finished');
      }
      this.#startedAt = null;
      this.#commit('finished');
    });
  }

  /**
   * Kill the current child without triggering a loop respawn.
   *
   * Clearing #child before the signal is what suppresses the respawn: the exit
   * handler checks identity and bails when it no longer owns the slot.
   */
  #terminate() {
    const child = this.#child;
    if (!child) return;

    this.#child = null;

    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }

    // Some players ignore SIGTERM while draining their output buffer.
    clearTimeout(this.#killTimer);
    this.#killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, KILL_GRACE_MS);
    this.#killTimer.unref?.();
  }

  #commit(source) {
    this.emit('change', { status: this.getStatus(), source });
  }

  /** Silence the cart on shutdown. */
  async close() {
    this.#loop = false;
    this.#terminate();
    clearTimeout(this.#killTimer);
  }
}

function clampVolume(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_VOLUME;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

/**
 * Condense a player's stderr into one line fit for a log or the status object.
 *
 * Players are chatty on the way out — ffplay alone prints a banner, a
 * configuration dump and progress lines — so keep only what reads like a
 * complaint, and cap it so a status payload cannot be flooded.
 */
export function tidyStderr(raw, maxLength = 200) {
  const lines = String(raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    // ffplay's banner and build details say nothing about the failure.
    .filter((line) => !/^(ffplay version|built with|configuration:|\s*lib\w+\s+\d)/i.test(line));

  if (lines.length === 0) return null;

  const interesting =
    lines.filter((line) => /error|fail|cannot|could not|unable|no such|denied|busy/i.test(line));
  const chosen = (interesting.length ? interesting : lines).join('; ');

  return chosen.length > maxLength ? `${chosen.slice(0, maxLength - 1)}…` : chosen;
}
