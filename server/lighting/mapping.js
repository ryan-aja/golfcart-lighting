/**
 * Lighting state -> DMX output mapping.
 *
 * This is the only place that knows which DMX channel a zone lives on. It is
 * intentionally a set of pure functions: given a state object and the lighting
 * config it returns channel data, with no I/O and no timing. That makes the
 * hardware mapping easy to test and easy to change as wiring evolves.
 */

const DMX_UNIVERSE_SIZE = 512;

/**
 * Scale a 0-100 UI brightness onto a 0-maxOutput DMX value.
 * 50% of a 255 max output => 128.
 */
export function scaleBrightness(brightness, maxOutput = 255) {
  const pct = Math.min(100, Math.max(0, Number(brightness) || 0));
  return Math.round((pct / 100) * maxOutput);
}

/**
 * Scale one 0-255 colour component by a 0-100 brightness and the zone's
 * configured output ceiling.
 */
export function scaleColorComponent(component, brightness, maxOutput = 255) {
  const c = Math.min(255, Math.max(0, Number(component) || 0));
  const pct = Math.min(100, Math.max(0, Number(brightness) || 0));
  return Math.round((c / 255) * (pct / 100) * maxOutput);
}

/**
 * Resolve a single zone's state into `{ channel: value }` DMX pairs.
 */
export function renderZoneChannels(zone, zoneState) {
  if (!zoneState) return {};
  const maxOutput = zone.maxOutput ?? 255;

  switch (zone.type) {
    case 'dimmer': {
      const value = zoneState.enabled ? scaleBrightness(zoneState.brightness, maxOutput) : 0;
      return { [zone.channel]: value };
    }

    case 'mode-dimmer': {
      // "auto" follows a physical vehicle signal that does not exist yet, so it
      // currently outputs nothing. When an input service is added it will set a
      // resolved flag on the zone state and only this line needs to change.
      const on = zoneState.mode === 'on';
      const value = on ? scaleBrightness(zoneState.brightness, maxOutput) : 0;
      return { [zone.channel]: value };
    }

    case 'rgb': {
      const { r, g, b } = zoneState.color ?? { r: 0, g: 0, b: 0 };
      const on = zoneState.enabled;
      return {
        [zone.channels.r]: on ? scaleColorComponent(r, zoneState.brightness, maxOutput) : 0,
        [zone.channels.g]: on ? scaleColorComponent(g, zoneState.brightness, maxOutput) : 0,
        [zone.channels.b]: on ? scaleColorComponent(b, zoneState.brightness, maxOutput) : 0,
      };
    }

    default:
      return {};
  }
}

/**
 * Render every non-pixel zone into full 512-channel universe buffers.
 * Returns a Map of universe number -> Buffer(512).
 *
 * Channels not claimed by any zone stay at 0, so an unassigned spare channel
 * is never left holding a stale value.
 */
export function renderDmxUniverses(state, lightingConfig) {
  const universes = new Map();
  const defaultUniverse = lightingConfig.dmxUniverse ?? 0;

  const bufferFor = (universe) => {
    if (!universes.has(universe)) universes.set(universe, Buffer.alloc(DMX_UNIVERSE_SIZE));
    return universes.get(universe);
  };

  // Always materialise the primary DMX universe, even if every zone is off,
  // so the decoder keeps receiving a known-zero frame.
  bufferFor(defaultUniverse);

  for (const zone of lightingConfig.zones ?? []) {
    const universe = zone.universe ?? defaultUniverse;
    const buffer = bufferFor(universe);
    for (const [channel, value] of Object.entries(renderZoneChannels(zone, state[zone.id]))) {
      buffer[Number(channel) - 1] = value; // DMX channels are 1-based
    }
  }

  return universes;
}

/**
 * How many whole pixels fit in one universe. Pixels are never split across a
 * universe boundary — that is what BC-204 style controllers expect (170 pixels
 * per universe at 3 channels each).
 */
export function pixelsPerUniverse(channelsPerPixel) {
  return Math.floor(DMX_UNIVERSE_SIZE / channelsPerPixel);
}

/**
 * Reorder an { r, g, b, w } pixel into the wire order the LED chipset expects.
 */
export function applyColorOrder(pixel, colorOrder = 'RGB') {
  const source = { R: pixel.r ?? 0, G: pixel.g ?? 0, B: pixel.b ?? 0, W: pixel.w ?? 0 };
  return colorOrder
    .toUpperCase()
    .split('')
    .map((component) => source[component] ?? 0);
}

/**
 * Pack an array of pixels into consecutive universe buffers.
 * Returns [{ universe, data: Buffer }] starting at zone.universeStart.
 */
export function splitPixelsIntoUniverses(pixels, zone) {
  const channelsPerPixel = zone.channelsPerPixel ?? 3;
  const perUniverse = pixelsPerUniverse(channelsPerPixel);
  const universeCount = Math.max(1, Math.ceil(pixels.length / perUniverse));
  const out = [];

  for (let u = 0; u < universeCount; u += 1) {
    const buffer = Buffer.alloc(DMX_UNIVERSE_SIZE);
    const slice = pixels.slice(u * perUniverse, (u + 1) * perUniverse);

    slice.forEach((pixel, index) => {
      const bytes = applyColorOrder(pixel, zone.colorOrder);
      const offset = index * channelsPerPixel;
      for (let c = 0; c < channelsPerPixel; c += 1) {
        buffer[offset + c] = bytes[c] ?? 0;
      }
    });

    out.push({ universe: (zone.universeStart ?? 0) + u, data: buffer });
  }

  return out;
}

export { DMX_UNIVERSE_SIZE };
