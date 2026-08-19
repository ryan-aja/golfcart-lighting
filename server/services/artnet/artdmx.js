/**
 * ArtDMX (OpOutput / OpDmx) packet construction.
 *
 * Art-Net 4 spec, section "ArtDmx". Header layout:
 *
 *   0-7    "Art-Net\0"
 *   8-9    OpCode 0x5000, little-endian
 *   10-11  Protocol version 14, big-endian
 *   12     Sequence (1-255, 0 disables sequencing)
 *   13     Physical (informational only)
 *   14     SubUni  - low byte of the 15-bit port address
 *   15     Net     - high 7 bits of the 15-bit port address
 *   16-17  Length, big-endian, even, 2-512
 *   18+    DMX data
 *
 * We build packets ourselves rather than pulling in an Art-Net npm package.
 * See README "Why no Art-Net library" for the reasoning. Everything below is
 * pure byte assembly, so it is straightforward to unit test.
 */

const ART_NET_ID = Buffer.from('Art-Net\0', 'ascii');
const OP_DMX = 0x5000;
const PROTOCOL_VERSION = 14;
export const ARTDMX_HEADER_SIZE = 18;

/**
 * A flat universe number (0-32767) maps onto the Art-Net 15-bit port address:
 * the low byte is Sub-Net + Universe, the high 7 bits are Net.
 */
export function toPortAddress(universe) {
  const value = Number(universe) & 0x7fff;
  return { subUni: value & 0xff, net: (value >> 8) & 0x7f };
}

/**
 * Build one ArtDMX packet.
 *
 * @param {number} universe  flat universe number
 * @param {Buffer} data      DMX channel data (1-512 bytes)
 * @param {number} sequence  0-255; callers should increment per universe
 * @param {number} physical  informational physical input port
 */
export function buildArtDmxPacket(universe, data, sequence = 0, physical = 0) {
  if (!Buffer.isBuffer(data)) {
    throw new TypeError('ArtDMX data must be a Buffer');
  }
  if (data.length < 1 || data.length > 512) {
    throw new RangeError(`ArtDMX data length must be 1-512 (got ${data.length})`);
  }

  // Length must be even; pad a trailing zero byte if needed.
  const length = data.length % 2 === 0 ? data.length : data.length + 1;
  const packet = Buffer.alloc(ARTDMX_HEADER_SIZE + length);
  const { subUni, net } = toPortAddress(universe);

  ART_NET_ID.copy(packet, 0);
  packet.writeUInt16LE(OP_DMX, 8);
  packet.writeUInt16BE(PROTOCOL_VERSION, 10);
  packet.writeUInt8(sequence & 0xff, 12);
  packet.writeUInt8(physical & 0xff, 13);
  packet.writeUInt8(subUni, 14);
  packet.writeUInt8(net, 15);
  packet.writeUInt16BE(length, 16);
  data.copy(packet, ARTDMX_HEADER_SIZE);

  return packet;
}

/**
 * Sequence numbers wrap 1..255; 0 is reserved to mean "sequencing disabled".
 */
export function nextSequence(current) {
  return current >= 255 ? 1 : current + 1;
}
