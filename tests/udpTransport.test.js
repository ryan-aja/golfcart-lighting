import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';

import { createUdpTransport } from '../server/services/artnet/udpTransport.js';

/**
 * These cover the status fields rather than the wire format (artdmx.test.js has
 * that), because it was the *status* that misled a real bring-up: eth0 came up
 * after the service did, so every send failed for a while, and lastError then
 * sat in /api/status reporting a dead link long after output had recovered.
 *
 * TEST-NET-3 (203.0.113.0/24, RFC 5737) bound to loopback is guaranteed
 * unroutable, which makes the failure path deterministic rather than dependent
 * on whatever network the suite happens to run on.
 *
 * The *errno* is not asserted: the same unroutable send is ENETUNREACH on
 * Windows and EINVAL on the Pi. What the transport promises is that a failure
 * is recorded and not counted as a frame, not which code the kernel chose.
 */

const UNROUTABLE = { host: '203.0.113.1', port: 6454, bindAddress: '127.0.0.1' };

/** A send failure was recorded, whatever the platform called it. */
function assertRecordedFailure(stats) {
  assert.equal(typeof stats.lastError, 'string');
  assert.ok(stats.lastError.length > 0, 'the failure message is kept');
}

/** A throwaway UDP listener, so sends have somewhere real to land. */
function listener() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const received = [];
    sock.on('message', (m) => received.push(m));
    sock.bind(0, '127.0.0.1', () =>
      resolve({ port: sock.address().port, received, close: () => sock.close() })
    );
  });
}

const settle = () => new Promise((r) => setTimeout(r, 120));

test('a successful send records progress and no error', async () => {
  const sink = await listener();
  const tx = createUdpTransport({ host: '127.0.0.1', port: sink.port });
  await tx.init();

  tx.send(0, Buffer.alloc(512, 7));
  await settle();

  const stats = tx.getStats();
  assert.equal(stats.framesSent, 1);
  assert.equal(stats.lastError, null);
  assert.equal(stats.errorCount, 0);
  assert.ok(stats.lastSuccessAt, 'a success should be timestamped');
  assert.equal(stats.lastErrorAt, null);
  assert.equal(sink.received.length, 1, 'the packet actually went somewhere');

  await tx.close();
  sink.close();
});

test('a failed send is counted as an error, never as a frame sent', async () => {
  const tx = createUdpTransport(UNROUTABLE);
  await tx.init();

  tx.send(0, Buffer.alloc(512, 1));
  await settle();

  const stats = tx.getStats();
  assert.equal(stats.errorCount, 1, 'the failure was counted');
  assertRecordedFailure(stats);
  assert.ok(stats.lastErrorAt, 'the failure is timestamped');
  assert.equal(stats.framesSent, 0, 'a failed send must not count as sent');
  assert.equal(stats.lastSuccessAt, null);

  await tx.close();
});

test('repeated identical failures accumulate without re-reporting a new fault', async () => {
  // A dead link fails every frame. The count has to keep climbing while
  // lastError stays the single current fault rather than churning.
  const tx = createUdpTransport(UNROUTABLE);
  await tx.init();

  for (let i = 0; i < 5; i += 1) tx.send(i, Buffer.alloc(512, 1));
  await settle();

  const stats = tx.getStats();
  assert.equal(stats.errorCount, 5, 'every failure counted');
  assert.equal(stats.framesSent, 0);
  assertRecordedFailure(stats);

  await tx.close();
});

test('a healthy transport reports no error even after another one has failed', async () => {
  // The regression: lastError used to be sticky, so /api/status kept reporting
  // a fault that had long since cleared. A transport that is currently sending
  // must report itself healthy.
  const failing = createUdpTransport(UNROUTABLE);
  await failing.init();
  failing.send(0, Buffer.alloc(512, 1));
  await settle();
  assert.ok(failing.getStats().lastError, 'precondition: this one is broken');
  await failing.close();

  const sink = await listener();
  const healthy = createUdpTransport({ host: '127.0.0.1', port: sink.port });
  await healthy.init();
  healthy.send(0, Buffer.alloc(512, 2));
  await settle();

  const stats = healthy.getStats();
  assert.equal(stats.lastError, null, 'a working send must not report an error');
  assert.equal(stats.errorCount, 0);
  assert.equal(stats.framesSent, 1);

  await healthy.close();
  sink.close();
});

test('each universe carries its own sequence counter', async () => {
  const sink = await listener();
  const tx = createUdpTransport({ host: '127.0.0.1', port: sink.port });
  await tx.init();

  tx.send(0, Buffer.alloc(512, 1));
  tx.send(2, Buffer.alloc(512, 2));
  tx.send(0, Buffer.alloc(512, 3));
  await settle();

  assert.equal(tx.getStats().framesSent, 3);
  assert.equal(sink.received.length, 3);
  // Byte 14 is SubUni, byte 12 is the sequence.
  assert.deepEqual(
    sink.received.map((p) => [p.readUInt8(14), p.readUInt8(12)]),
    [
      [0, 1],
      [2, 1],
      [0, 2],
    ],
    'universe 0 advances to 2 while universe 2 is still on its first'
  );

  await tx.close();
  sink.close();
});
