import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildArtPollPacket,
  isArtPollReply,
  parseArtPollReply,
} from '../server/services/artnet/artpoll.js';

/**
 * Build an ArtPollReply the way a node would, so the parser is exercised
 * against the real layout rather than against itself.
 */
function makeReply({
  ip = [192, 168, 10, 20],
  net = 0,
  subSwitch = 0,
  shortName = 'BC-204',
  longName = 'BC-204 Pixel Controller',
  nodeReport = '#0001 [0000] Power On Tests successful',
  ports = [{ type: 0x80, swOut: 0, good: 0x80 }],
  mac = [0xde, 0xad, 0xbe, 0xef, 0x00, 0x01],
  size = 239,
} = {}) {
  const b = Buffer.alloc(size);
  // `size` is deliberately variable so truncated replies can be built, so every
  // write is bounds-checked rather than assuming the full 239 bytes are there.
  const fits = (offset, length) => offset + length <= b.length;
  const u8 = (value, offset) => { if (fits(offset, 1)) b.writeUInt8(value, offset); };
  const str = (value, offset, length) => { if (fits(offset, length)) b.write(value, offset, length, 'ascii'); };

  Buffer.from('Art-Net\0', 'ascii').copy(b, 0);
  b.writeUInt16LE(0x2100, 8);
  if (fits(10, 4)) Buffer.from(ip).copy(b, 10);
  if (fits(14, 2)) b.writeUInt16LE(6454, 14);
  u8(net, 18);
  u8(subSwitch, 19);
  str(shortName, 26, 18);
  str(longName, 44, 64);
  str(nodeReport, 108, 64);
  if (fits(172, 2)) b.writeUInt16BE(ports.length, 172);
  ports.forEach((p, i) => {
    u8(p.type ?? 0x80, 174 + i);
    u8(p.good ?? 0, 182 + i);
    u8(p.swIn ?? 0, 186 + i);
    u8(p.swOut ?? 0, 190 + i);
  });
  if (fits(201, 6)) Buffer.from(mac).copy(b, 201);
  return b;
}

test('ArtPoll is a well-formed 14-byte packet', () => {
  const p = buildArtPollPacket();

  assert.equal(p.length, 14);
  assert.equal(p.subarray(0, 8).toString('ascii'), 'Art-Net\0');
  assert.equal(p.readUInt16LE(8), 0x2000, 'OpPoll is little-endian');
  assert.equal(p.readUInt16BE(10), 14, 'protocol version is big-endian');
});

test('only actual ArtPollReply packets are recognised', () => {
  assert.ok(isArtPollReply(makeReply()));

  // An ArtDMX packet shares the header but not the opcode.
  const dmx = Buffer.alloc(20);
  Buffer.from('Art-Net\0', 'ascii').copy(dmx, 0);
  dmx.writeUInt16LE(0x5000, 8);
  assert.equal(isArtPollReply(dmx), false);

  assert.equal(isArtPollReply(Buffer.from('not art-net at all')), false);
  assert.equal(isArtPollReply(Buffer.alloc(4)), false, 'too short to inspect');
  assert.equal(isArtPollReply(null), false);
  assert.equal(parseArtPollReply(dmx), null);
});

test('a reply yields the node identity', () => {
  const r = parseArtPollReply(makeReply());

  assert.equal(r.ip, '192.168.10.20');
  assert.equal(r.port, 6454);
  assert.equal(r.shortName, 'BC-204');
  assert.equal(r.longName, 'BC-204 Pixel Controller');
  assert.match(r.nodeReport, /Power On Tests successful/);
  assert.equal(r.mac, 'de:ad:be:ef:00:01');
});

test('port addresses combine net, subnet and SwOut', () => {
  // The whole point of the tool: what universe is each output really on?
  const r = parseArtPollReply(
    makeReply({
      net: 0,
      subSwitch: 0,
      ports: [
        { type: 0x80, swOut: 0 },
        { type: 0x80, swOut: 1 },
        { type: 0x80, swOut: 6 },
      ],
    })
  );

  assert.equal(r.numPorts, 3);
  assert.deepEqual(
    r.ports.map((p) => p.outputUniverse),
    [0, 1, 6]
  );

  // Subnet occupies the next nibble up, so it is worth 16 per step.
  const sub = parseArtPollReply(
    makeReply({ subSwitch: 1, ports: [{ type: 0x80, swOut: 2 }] })
  );
  assert.equal(sub.ports[0].outputUniverse, 18, '(1 << 4) | 2');

  // Net is the high byte of the 15-bit address.
  const netted = parseArtPollReply(
    makeReply({ net: 1, subSwitch: 0, ports: [{ type: 0x80, swOut: 3 }] })
  );
  assert.equal(netted.ports[0].outputUniverse, 259, '(1 << 8) | 3');
});

test('port direction and data-seen flags are decoded', () => {
  const r = parseArtPollReply(
    makeReply({
      ports: [
        { type: 0x80, swOut: 0, good: 0x80 }, // output, receiving
        { type: 0x80, swOut: 1, good: 0x00 }, // output, nothing arriving
        { type: 0x40, swIn: 2, good: 0x00 }, // input only
      ],
    })
  );

  assert.deepEqual(
    r.ports.map((p) => ({ out: p.isOutput, in: p.isInput, data: p.dataReceived })),
    [
      { out: true, in: false, data: true },
      { out: true, in: false, data: false },
      { out: false, in: true, data: false },
    ]
  );
});

test('a truncated reply reports what it can instead of throwing', () => {
  // Some nodes send short replies; a partial answer still beats none.
  const short = makeReply({ size: 100 });
  const r = parseArtPollReply(short);

  assert.equal(r.ip, '192.168.10.20');
  assert.equal(r.shortName, 'BC-204');
  assert.equal(r.numPorts, 0, 'the port block was past the end');
  assert.deepEqual(r.ports, []);
  assert.equal(r.mac, null);
});

test('at most four ports are reported per reply', () => {
  // A node with more ports sends additional replies; one carries only four.
  const r = parseArtPollReply(
    makeReply({ ports: [0, 1, 2, 3, 4, 5].map((swOut) => ({ type: 0x80, swOut })) })
  );

  assert.equal(r.numPorts, 6, 'the node claims six');
  assert.equal(r.ports.length, 4, 'but only four fit in this reply');
});
