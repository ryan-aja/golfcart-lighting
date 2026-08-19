/**
 * Simulation transport.
 *
 * Used for development on a workstation with no BC-204 attached. It accepts
 * exactly the same calls as the UDP transport but sends nothing on the wire.
 *
 * To keep the log readable it only reports channels whose value actually
 * changed, and only for channels that a zone is mapped to (passed in as
 * `watchedChannels`). Full frame dumps are available at LOG_LEVEL=debug.
 */

import { createLogger } from '../../utils/logger.js';

const log = createLogger('artnet:sim');

export function createSimulationTransport({ watchedChannels = new Map() } = {}) {
  const previous = new Map(); // universe -> Buffer copy
  let framesSent = 0;

  return {
    name: 'simulation',
    simulation: true,

    async init() {
      log.info('SIMULATION MODE - no Art-Net UDP packets will be transmitted');
    },

    send(universe, data) {
      framesSent += 1;
      const before = previous.get(universe);
      const labels = watchedChannels.get(universe);

      if (before) {
        // Only mapped zone channels are reported at info level. Pixel data
        // changes on every animation frame and would bury the log, so those
        // are summarised at debug instead.
        const named = [];
        let unnamed = 0;
        for (let i = 0; i < data.length; i += 1) {
          if (before[i] === data[i]) continue;
          const channel = i + 1;
          const label = labels?.get(channel);
          if (label) named.push(`${label} ch${channel}=${data[i]}`);
          else unnamed += 1;
        }
        if (named.length) log.info(`U${universe} ${named.join('  ')}`);
        if (unnamed) log.debug(`U${universe} ${unnamed} unmapped channels changed`);
      }

      previous.set(universe, Buffer.from(data));
      log.debug(`U${universe} frame ${framesSent} (${data.length} channels)`);
    },

    async close() {
      log.info(`simulation transport closed after ${framesSent} frames`);
    },
  };
}
