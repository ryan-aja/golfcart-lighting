/**
 * Real Art-Net transport: unicast UDP to the BC-204.
 *
 * Unicast (rather than broadcast) is used because the Pi talks to the BC-204
 * over a direct point-to-point Ethernet link with static addresses; there is no
 * reason to put Art-Net traffic on the Wi-Fi side of the machine.
 */

import dgram from 'node:dgram';
import { createLogger } from '../../utils/logger.js';
import { buildArtDmxPacket, nextSequence } from './artdmx.js';

const log = createLogger('artnet:udp');

export function createUdpTransport({ host, port = 6454, bindAddress = null } = {}) {
  if (!host) throw new Error('Art-Net UDP transport requires a destination host');

  let socket = null;
  const sequences = new Map(); // universe -> last sequence number
  let framesSent = 0;

  // `lastError` reports whether output is failing *now*, so a send that
  // succeeds clears it. Keeping it sticky was actively misleading during the
  // first BC-204 bring-up: eth0 came up after the service did, so /api/status
  // showed "send ENETUNREACH" for hours while frames were flowing perfectly,
  // and the obvious reading was that output was broken. The counter and the
  // timestamps keep the history that clearing would otherwise throw away.
  let lastError = null;
  let lastErrorAt = null;
  let lastSuccessAt = null;
  let errorCount = 0;

  return {
    name: 'artnet-udp',
    simulation: false,

    init() {
      return new Promise((resolve, reject) => {
        socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        socket.on('error', (err) => {
          lastError = err.message;
          log.error('socket error:', err.message);
        });

        socket.once('error', reject);

        const onReady = () => {
          socket.off('error', reject);
          // Enable broadcast so the destination can later be changed to a
          // broadcast address (e.g. 192.168.10.255) without touching this code.
          try {
            socket.setBroadcast(true);
          } catch {
            /* not fatal for unicast */
          }
          log.info(`Art-Net output -> ${host}:${port}${bindAddress ? ` (bound to ${bindAddress})` : ''}`);
          resolve();
        };

        if (bindAddress) socket.bind(0, bindAddress, onReady);
        else socket.bind(0, onReady);
      });
    },

    send(universe, data) {
      if (!socket) return;
      const sequence = nextSequence(sequences.get(universe) ?? 0);
      sequences.set(universe, sequence);

      const packet = buildArtDmxPacket(universe, data, sequence);
      socket.send(packet, port, host, (err) => {
        if (err) {
          // Compare before assigning, or "changed" is never true.
          const changed = err.message !== lastError;
          lastError = err.message;
          lastErrorAt = Date.now();
          errorCount += 1;
          // A dead link fails every frame, which at 30fps is a torrent — the
          // first bring-up put 1569 identical lines in the journal. Log the
          // first occurrence and any change, then stay quiet.
          if (changed) log.error(`send failed for universe ${universe}:`, err.message);
          return;
        }
        framesSent += 1;
        lastSuccessAt = Date.now();
        if (lastError) {
          log.info(`output recovered after ${errorCount} failed send(s)`);
          lastError = null;
        }
        log.debug(`U${universe} seq ${sequence} sent (${packet.length} bytes)`);
      });
    },

    getStats() {
      return { framesSent, lastError, lastErrorAt, lastSuccessAt, errorCount };
    },

    close() {
      return new Promise((resolve) => {
        if (!socket) return resolve();
        socket.close(() => {
          log.info(`socket closed after ${framesSent} frames`);
          socket = null;
          resolve();
        });
      });
    },
  };
}
