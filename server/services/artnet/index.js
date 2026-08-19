/**
 * Art-Net service factory.
 *
 * Chooses the transport based on configuration. Simulation is the default so a
 * fresh checkout on a workstation never emits packets at unknown hardware; set
 * `simulation: false` in config/artnet.json (or LIGHTING_SIMULATION=false) once
 * the BC-204 is wired up.
 */

import { ArtNetService } from './ArtNetService.js';
import { createSimulationTransport } from './simulationTransport.js';
import { createUdpTransport } from './udpTransport.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('artnet');

/**
 * Build a universe -> (channel -> zone label) index so simulation logs can say
 * "headlights ch7=128" instead of just "ch7=128".
 */
function buildChannelLabels(lightingConfig) {
  const labels = new Map();
  const defaultUniverse = lightingConfig.dmxUniverse ?? 0;

  const add = (universe, channel, label) => {
    if (!labels.has(universe)) labels.set(universe, new Map());
    labels.get(universe).set(channel, label);
  };

  for (const zone of lightingConfig.zones ?? []) {
    const universe = zone.universe ?? defaultUniverse;
    if (zone.type === 'rgb') {
      add(universe, zone.channels.r, `${zone.id}.r`);
      add(universe, zone.channels.g, `${zone.id}.g`);
      add(universe, zone.channels.b, `${zone.id}.b`);
    } else {
      add(universe, zone.channel, zone.id);
    }
  }

  return labels;
}

export async function createArtNetService({ artnetConfig, lightingConfig }) {
  const transport = artnetConfig.simulation
    ? createSimulationTransport({ watchedChannels: buildChannelLabels(lightingConfig) })
    : createUdpTransport({
        host: artnetConfig.host,
        port: artnetConfig.port,
        bindAddress: artnetConfig.bindAddress,
      });

  const service = new ArtNetService({
    transport,
    keepAliveMs: artnetConfig.keepAliveMs,
  });

  await service.init();
  log.info(
    `initialised transport=${transport.name} destination=${
      artnetConfig.simulation ? 'none (simulated)' : `${artnetConfig.host}:${artnetConfig.port}`
    } keepAlive=${artnetConfig.keepAliveMs}ms`
  );

  return service;
}

export { ArtNetService };
