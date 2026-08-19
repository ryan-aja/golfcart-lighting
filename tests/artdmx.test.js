import test from 'node:test';
import assert from 'node:assert/strict';

import { ARTDMX_HEADER_SIZE, buildArtDmxPacket, nextSequence, toPortAddress } from '../server/services/artnet/artdmx.js';

test('packet carries the Art-Net header fields the spec requires', () => {
  const data = Buffer.alloc(512, 7);
  const packet = buildArtDmxPacket(0, data, 3);

  assert.equal(packet.subarray(0, 8).toString('ascii'), 'Art-Net\0');
  assert.equal(packet.readUInt16LE(8), 0x5000, 'OpDmx opcode is little-endian');
  assert.equal(packet.readUInt16BE(10), 14, 'protocol version is big-endian');
  assert.equal(packet.readUInt8(12), 3, 'sequence');
  assert.equal(packet.readUInt8(13), 0, 'physical');
  assert.equal(packet.readUInt16BE(16), 512, 'length is big-endian');
  assert.equal(packet.length, ARTDMX_HEADER_SIZE + 512);
  assert.equal(packet[ARTDMX_HEADER_SIZE], 7);
});

test('a flat universe number splits into SubUni and Net', () => {
  assert.deepEqual(toPortAddress(0), { subUni: 0, net: 0 });
  assert.deepEqual(toPortAddress(1), { subUni: 1, net: 0 });
  assert.deepEqual(toPortAddress(255), { subUni: 255, net: 0 });
  assert.deepEqual(toPortAddress(256), { subUni: 0, net: 1 });
  assert.deepEqual(toPortAddress(300), { subUni: 44, net: 1 });
});

test('universe number reaches bytes 14 and 15', () => {
  const packet = buildArtDmxPacket(300, Buffer.alloc(2));
  assert.equal(packet.readUInt8(14), 44);
  assert.equal(packet.readUInt8(15), 1);
});

test('odd-length data is padded to an even length', () => {
  const packet = buildArtDmxPacket(0, Buffer.from([1, 2, 3]));
  assert.equal(packet.readUInt16BE(16), 4);
  assert.equal(packet.length, ARTDMX_HEADER_SIZE + 4);
  assert.equal(packet[ARTDMX_HEADER_SIZE + 3], 0);
});

test('out-of-range data lengths are rejected', () => {
  assert.throws(() => buildArtDmxPacket(0, Buffer.alloc(0)), RangeError);
  assert.throws(() => buildArtDmxPacket(0, Buffer.alloc(513)), RangeError);
  assert.throws(() => buildArtDmxPacket(0, [1, 2, 3]), TypeError);
});

test('sequence wraps 1-255, skipping the reserved 0', () => {
  assert.equal(nextSequence(0), 1);
  assert.equal(nextSequence(254), 255);
  assert.equal(nextSequence(255), 1);
});
