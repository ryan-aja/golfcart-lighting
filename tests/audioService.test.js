import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AudioService,
  findExecutable,
  resolveAudioFile,
  selectPlayer,
} from '../server/services/audioService.js';

/**
 * These tests use `node` itself as the "player" and a throwaway .js file as the
 * "track": the service only cares that it spawned a process and saw it exit, so
 * a script that sleeps for a known time exercises the real spawn/exit/loop/kill
 * paths without needing a sound card on the machine running the suite.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golfcart-audio-'));

/** A "track" that plays for `ms` and then ends normally. */
function makeTrack(name, ms) {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, `setTimeout(() => {}, ${ms});\n`);
  return file;
}

/** A "track" that fails instantly, like a missing ALSA device would. */
function makeBrokenTrack(name) {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, 'process.exit(1);\n');
  return file;
}

function makeService(file, overrides = {}) {
  return new AudioService({
    audioConfig: { enabled: true, files: [file], volume: 50, player: 'node', ...overrides },
    rootDir: tmpDir,
  });
}

/** Resolve once the service emits a change whose status satisfies `predicate`. */
function waitForStatus(audio, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      audio.off('change', onChange);
      reject(new Error('timed out waiting for audio status'));
    }, timeoutMs);

    const onChange = ({ status }) => {
      if (!predicate(status)) return;
      clearTimeout(timer);
      audio.off('change', onChange);
      resolve(status);
    };

    audio.on('change', onChange);
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- helpers ---

test('findExecutable locates a binary on PATH and reports a miss as null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golfcart-bin-'));
  const name = process.platform === 'win32' ? 'faux.EXE' : 'faux';
  const binary = path.join(dir, name);
  fs.writeFileSync(binary, '');
  fs.chmodSync(binary, 0o755);

  const env = { PATH: dir, PATHEXT: '.EXE' };
  assert.equal(findExecutable('faux', env), binary);
  assert.equal(findExecutable('definitely-not-installed', env), null);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveAudioFile takes the first candidate that exists', () => {
  const present = makeTrack('present.js', 10);

  assert.equal(
    resolveAudioFile(['assets/audio/missing.mp3', path.basename(present)], tmpDir),
    present,
    'a later candidate is used when the preferred one is absent'
  );
  assert.equal(resolveAudioFile(['nope.mp3', 'also-nope.wav'], tmpDir), null);
  assert.equal(resolveAudioFile([], tmpDir), null);
  assert.equal(resolveAudioFile(undefined, tmpDir), null);
});

test('selectPlayer respects the file extension', () => {
  const env = { PATH: '' }; // nothing installed
  assert.equal(selectPlayer('/tmp/theme.mp3', { env }), null);

  // aplay handles .wav but not .mp3, so it must not be offered for an mp3.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golfcart-bin-'));
  const aplay = path.join(dir, process.platform === 'win32' ? 'aplay.EXE' : 'aplay');
  fs.writeFileSync(aplay, '');
  fs.chmodSync(aplay, 0o755);
  const withAplay = { PATH: dir, PATHEXT: '.EXE' };

  assert.equal(selectPlayer('/tmp/theme.wav', { env: withAplay })?.bin, 'aplay');
  assert.equal(selectPlayer('/tmp/theme.mp3', { env: withAplay }), null);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unknown player named in config is still accepted', () => {
  // The operator may have something we have never heard of installed.
  const player = selectPlayer('/tmp/theme.ogg', { override: 'node' });
  assert.equal(player?.bin, 'node');
  assert.deepEqual(player.args('/tmp/theme.ogg', 50), ['/tmp/theme.ogg']);
});

// ------------------------------------------------------- unavailable cases ---

test('a missing audio file is reported, not thrown, at startup', () => {
  const audio = new AudioService({
    audioConfig: { enabled: true, files: ['nothing-here.mp3'], player: 'node' },
    rootDir: tmpDir,
  });

  const status = audio.getStatus();
  assert.equal(status.available, false);
  assert.equal(status.playing, false);
  assert.equal(status.error, 'No audio file installed');
  assert.throws(() => audio.play(), /No audio file installed/);
});

test('audio disabled in config stays disabled', () => {
  const audio = new AudioService({
    audioConfig: { enabled: false, files: [makeTrack('unused.js', 10)], player: 'node' },
    rootDir: tmpDir,
  });

  assert.equal(audio.getStatus().enabled, false);
  assert.equal(audio.getStatus().available, false);
  assert.throws(() => audio.play(), /Audio is disabled/);
});

test('volume is clamped into 0-100 and defaults when unusable', () => {
  const file = makeTrack('vol.js', 10);
  assert.equal(makeService(file, { volume: 250 }).getStatus().volume, 100);
  assert.equal(makeService(file, { volume: -20 }).getStatus().volume, 0);
  assert.equal(makeService(file, { volume: 'loud' }).getStatus().volume, 85);
});

// -------------------------------------------------------------- playback ---

test('play starts a process and the status clears when the track ends', async () => {
  const audio = makeService(makeTrack('short.js', 600));

  assert.equal(audio.getStatus().available, true);
  assert.equal(audio.getStatus().player, 'node');

  audio.play();
  assert.equal(audio.getStatus().playing, true, 'playing immediately after play()');

  const finished = await waitForStatus(audio, (s) => !s.playing);
  assert.equal(finished.playing, false);
  assert.equal(finished.error, null, 'a track that ran to completion is not an error');

  await audio.close();
});

test('stop ends playback immediately', async () => {
  const audio = makeService(makeTrack('long.js', 30000));

  audio.play();
  assert.equal(audio.getStatus().playing, true);

  audio.stop();
  assert.equal(audio.getStatus().playing, false, 'stop is synchronous from the caller view');

  // Nothing may resurrect it afterwards.
  await delay(300);
  assert.equal(audio.getStatus().playing, false);

  await audio.close();
});

test('stopping when nothing is playing is harmless', () => {
  const audio = makeService(makeTrack('idle.js', 10));
  assert.doesNotThrow(() => audio.stop());
  assert.equal(audio.getStatus().playing, false);
});

test('loop restarts the track, and stop breaks out of the loop', async () => {
  const audio = makeService(makeTrack('loopable.js', 500));

  audio.play({ loop: true });
  assert.equal(audio.getStatus().loop, true);

  // Long enough for the first run to end and the next to be spawned.
  await delay(900);
  assert.equal(audio.getStatus().playing, true, 'still playing after the first pass ended');

  audio.stop();
  await delay(400);
  assert.equal(audio.getStatus().playing, false, 'stop breaks the loop');

  await audio.close();
});

test('a track played once does not restart itself', async () => {
  const audio = makeService(makeTrack('once.js', 500));

  audio.play({ loop: false });
  await waitForStatus(audio, (s) => !s.playing);

  await delay(300);
  assert.equal(audio.getStatus().playing, false, 'no respawn without loop');

  await audio.close();
});

test('the loop flag can be changed while a track is playing', async () => {
  const audio = makeService(makeTrack('switch.js', 400));

  audio.play({ loop: true });
  assert.equal(audio.getStatus().loop, true);

  // Turning loop off mid-track must let the current pass be the last one.
  audio.setLoop(false);
  assert.equal(audio.getStatus().loop, false);

  await waitForStatus(audio, (s) => !s.playing);
  await delay(300);
  assert.equal(audio.getStatus().playing, false);

  await audio.close();
});

test('setLoop on an idle service only emits when the value actually changes', () => {
  const audio = makeService(makeTrack('flag.js', 10));
  let changes = 0;
  audio.on('change', () => {
    changes += 1;
  });

  audio.setLoop(true);
  audio.setLoop(true);
  assert.equal(changes, 1, 'a repeated identical value is not a state change');

  audio.setLoop(false);
  assert.equal(changes, 2);
});

test('play while already playing restarts rather than stacking processes', async () => {
  const audio = makeService(makeTrack('restart.js', 5000));

  audio.play();
  const first = audio.getStatus().startedAt;

  await delay(150);
  audio.play();
  assert.equal(audio.getStatus().playing, true);
  assert.ok(audio.getStatus().startedAt >= first, 'the restart re-stamps the start time');

  // The replaced process must not fire a "finished" broadcast that would tell
  // every client playback had stopped while the new one is still running.
  await delay(500);
  assert.equal(audio.getStatus().playing, true, 'the superseded process did not clear the state');

  await audio.close();
});

test('a player that dies instantly gives up instead of respawning forever', async () => {
  const audio = makeService(makeBrokenTrack('broken.js'));

  audio.play({ loop: true });

  const failed = await waitForStatus(audio, (s) => Boolean(s.error));
  assert.match(failed.error, /exited immediately/);
  assert.equal(failed.playing, false);

  await delay(300);
  assert.equal(audio.getStatus().playing, false, 'it stayed stopped');

  await audio.close();
});

test('close silences a looping track', async () => {
  const audio = makeService(makeTrack('shutdown.js', 30000));

  audio.play({ loop: true });
  assert.equal(audio.getStatus().playing, true);

  await audio.close();
  assert.equal(audio.getStatus().playing, false);

  await delay(300);
  assert.equal(audio.getStatus().playing, false, 'no respawn after shutdown');
});
