/**
 * ArtPoll / ArtPollReply — Art-Net's discovery handshake.
 *
 * ArtDMX is fire-and-forget UDP: nothing in the output path can ever tell you
 * whether a node received a frame, or even whether a node exists. Discovery is
 * the only part of the protocol that answers back, which makes it the only way
 * to turn "no lights came on" into a fact.
 *
 * An ArtPollReply carries the thing that matters most when nothing lights up:
 * the port address each output is actually bound to. Comparing that against
 * config/lighting.json settles the usual argument about whether a controller's
 * UI counts universes from 0 or from 1.
 *
 * Art-Net 4 spec, sections "ArtPoll" and "ArtPollReply".
 */

const ART_NET_ID = Buffer.from('Art-Net\0', 'ascii');
const OP_POLL = 0x2000;
const OP_POLL_REPLY = 0x2100;
const PROTOCOL_VERSION = 14;

export const ART_NET_PORT = 6454;

/**
 * ArtPoll is 14 bytes:
 *   0-7    "Art-Net\0"
 *   8-9    OpCode 0x2000, little-endian
 *   10-11  Protocol version, big-endian
 *   12     TalkToMe
 *   13     Priority (lowest DiagPriority the node should report)
 */
export function buildArtPollPacket({ talkToMe = 0x02, priority = 0x10 } = {}) {
  const packet = Buffer.alloc(14);
  ART_NET_ID.copy(packet, 0);
  packet.writeUInt16LE(OP_POLL, 8);
  packet.writeUInt16BE(PROTOCOL_VERSION, 10);
  packet.writeUInt8(talkToMe, 12);
  packet.writeUInt8(priority, 13);
  return packet;
}

/** Read a fixed-width, NUL-padded ASCII field. */
function readString(buffer, offset, length) {
  if (buffer.length < offset + length) return '';
  const raw = buffer.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('ascii').trim();
}

/** True if this datagram is an ArtPollReply. */
export function isArtPollReply(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 14 &&
    buffer.subarray(0, 8).equals(ART_NET_ID) &&
    buffer.readUInt16LE(8) === OP_POLL_REPLY
  );
}

/**
 * Decode an ArtPollReply.
 *
 * Returns null for anything that is not one, so a caller can hand it every
 * datagram that arrives — the wire carries plenty of other Art-Net opcodes.
 *
 * A node reports one reply per bound port group, each carrying up to 4 ports.
 * The 15-bit port address of output `i` is
 *
 *     net << 8 | subSwitch << 4 | swOut[i]
 *
 * which is the number to compare against a universe in config/lighting.json.
 */
export function parseArtPollReply(buffer) {
  if (!isArtPollReply(buffer)) return null;

  // Everything up to SwOut. Shorter replies exist in the wild; report what is
  // there rather than throwing, since a partial answer still beats silence.
  const has = (offset, length = 1) => buffer.length >= offset + length;

  const net = has(18) ? buffer.readUInt8(18) & 0x7f : 0;
  const subSwitch = has(19) ? buffer.readUInt8(19) & 0x0f : 0;
  const numPorts = has(172, 2) ? buffer.readUInt16BE(172) : 0;

  const ports = [];
  for (let i = 0; i < Math.min(numPorts, 4); i += 1) {
    const portType = has(174 + i) ? buffer.readUInt8(174 + i) : 0;
    const swOut = has(190 + i) ? buffer.readUInt8(190 + i) & 0x0f : 0;
    const swIn = has(186 + i) ? buffer.readUInt8(186 + i) & 0x0f : 0;
    const goodOutput = has(182 + i) ? buffer.readUInt8(182 + i) : 0;

    ports.push({
      index: i,
      // Bit 7 = output capable, bit 6 = input capable.
      isOutput: Boolean(portType & 0x80),
      isInput: Boolean(portType & 0x40),
      // The number to match against config/lighting.json.
      outputUniverse: (net << 8) | (subSwitch << 4) | swOut,
      inputUniverse: (net << 8) | (subSwitch << 4) | swIn,
      // Bit 7 of GoodOutput: this port is currently receiving ArtDMX.
      dataReceived: Boolean(goodOutput & 0x80),
    });
  }

  return {
    ip: has(10, 4) ? Array.from(buffer.subarray(10, 14)).join('.') : null,
    port: has(14, 2) ? buffer.readUInt16LE(14) : null,
    shortName: readString(buffer, 26, 18),
    longName: readString(buffer, 44, 64),
    nodeReport: readString(buffer, 108, 64),
    net,
    subSwitch,
    numPorts,
    ports,
    mac: has(201, 6)
      ? Array.from(buffer.subarray(201, 207))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(':')
      : null,
  };
}
