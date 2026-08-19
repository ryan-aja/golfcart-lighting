import test from 'node:test';
import assert from 'node:assert/strict';

import { ArtNetService } from '../server/services/artnet/ArtNetService.js';

/** Records what a transport was asked to send, with a controllable clock. */
function createHarness({ keepAliveMs = 1000 } = {}) {
  const sent = [];
  let clock = 1000;

  const transport = {
    name: 'test',
    simulation: true,
    init() {},
    send(universe, data) {
      sent.push({ universe, data: Buffer.from(data) });
    },
    close() {},
  };

  const service = new ArtNetService({ transport, keepAliveMs, now: () => clock });
  return { service, sent, advance: (ms) => (clock += ms), now: () => clock };
}

test('setChannel writes a 1-based DMX channel', async () => {
  const { service, sent } = createHarness();
  await service.init();

  service.setChannel(0, 7, 128);
  service.flush();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].data[6], 128, 'channel 7 lives at buffer index 6');
});

test('setChannels writes a consecutive run', async () => {
  const { service, sent } = createHarness();
  await service.init();

  service.setChannels(0, 4, [10, 20, 30]);
  service.flush();

  assert.deepEqual([...sent[0].data.subarray(3, 6)], [10, 20, 30]);
});

test('channel values are clamped to 0-255', async () => {
  const { service } = createHarness();
  await service.init();

  service.setChannel(0, 1, 999);
  service.setChannel(0, 2, -50);

  const universe = service.getUniverse(0);
  assert.equal(universe[0], 255);
  assert.equal(universe[1], 0);
});

test('an out-of-range channel throws', async () => {
  const { service } = createHarness();
  await service.init();

  assert.throws(() => service.setChannel(0, 0, 1), RangeError);
  assert.throws(() => service.setChannel(0, 513, 1), RangeError);
});

test('an unchanged universe is not retransmitted before the keep-alive is due', async () => {
  const { service, sent, advance } = createHarness({ keepAliveMs: 1000 });
  await service.init();

  service.setChannel(0, 7, 100);
  service.flush();
  assert.equal(sent.length, 1);

  // Several frames later with no change: nothing new on the wire.
  for (let i = 0; i < 20; i += 1) {
    advance(33);
    service.flush();
  }
  assert.equal(sent.length, 1, 'static scene should not flood the network');
});

test('a static universe is refreshed once the keep-alive interval elapses', async () => {
  const { service, sent, advance } = createHarness({ keepAliveMs: 1000 });
  await service.init();

  service.setChannel(0, 7, 100);
  service.flush();

  advance(1001);
  service.flush();

  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].data, sent[0].data);
});

test('a changed universe transmits immediately', async () => {
  const { service, sent, advance } = createHarness();
  await service.init();

  service.setChannel(0, 7, 100);
  service.flush();

  advance(33);
  service.setChannel(0, 7, 255);
  service.flush();

  assert.equal(sent.length, 2);
  assert.equal(sent[1].data[6], 255);
});

test('setUniverse with identical data does not mark the universe dirty', async () => {
  const { service, sent, advance } = createHarness();
  await service.init();

  const frame = Buffer.alloc(512);
  frame[6] = 128;

  service.setUniverse(0, frame);
  service.flush();
  assert.equal(sent.length, 1);

  advance(10);
  service.setUniverse(0, Buffer.from(frame));
  service.flush();
  assert.equal(sent.length, 1);
});

test('multiple universes are tracked independently', async () => {
  const { service, sent, advance } = createHarness();
  await service.init();

  service.setChannel(0, 1, 10);
  service.setChannel(2, 1, 20);
  service.flush();
  assert.equal(sent.length, 2);

  advance(10);
  service.setChannel(2, 1, 30);
  service.flush();

  assert.equal(sent.length, 3);
  assert.equal(sent[2].universe, 2);
});

test('blackout zeroes every universe and forces frames out', async () => {
  const { service, sent } = createHarness();
  await service.init();

  service.setChannel(0, 7, 255);
  service.setChannel(2, 1, 255);
  service.flush();
  const before = sent.length;

  service.blackout(3);

  const blackoutFrames = sent.slice(before);
  assert.equal(blackoutFrames.length, 6, '3 frames x 2 universes');
  assert.ok(blackoutFrames.every((f) => f.data.every((b) => b === 0)));
});

test('status reports transport, universes and frame count', async () => {
  const { service } = createHarness();
  await service.init();

  service.setChannel(0, 1, 1);
  service.setChannel(3, 1, 1);
  service.flush();

  const status = service.getStatus();
  assert.equal(status.configured, true);
  assert.equal(status.simulation, true);
  assert.equal(status.transport, 'test');
  assert.deepEqual(status.universes, [0, 3]);
  assert.equal(status.framesSent, 2);
  assert.ok(status.lastFrameAt > 0);
});
