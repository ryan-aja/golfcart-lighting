/**
 * Lighting state model.
 *
 * This module owns the *shape* of the authoritative lighting state and the
 * rules for validating partial updates. It knows nothing about DMX, Art-Net,
 * HTTP or WebSockets — mapping state onto hardware happens in mapping.js.
 *
 * State is built from the zone definitions in config/lighting.json, so adding
 * a zone to config adds it to the state model automatically.
 */

export function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clampBrightness(value) {
  return clampNumber(Math.round(Number(value)), 0, 100);
}

function clampColorComponent(value) {
  return clampNumber(Math.round(Number(value)), 0, 255);
}

function normalizeColor(input, fallback) {
  const base = fallback ?? { r: 255, g: 255, b: 255 };
  if (!input || typeof input !== 'object') return { ...base };
  return {
    r: clampColorComponent(input.r ?? base.r),
    g: clampColorComponent(input.g ?? base.g),
    b: clampColorComponent(input.b ?? base.b),
  };
}

/**
 * Build the initial (all-off) lighting state from configuration.
 *
 * Startup is deliberately "everything off" — decorative lighting is never
 * restored automatically after a power interruption.
 */
export function createInitialState(lightingConfig) {
  const state = {};

  for (const zone of lightingConfig.zones ?? []) {
    state[zone.id] = createZoneState(zone);
  }
  for (const zone of lightingConfig.pixelZones ?? []) {
    state[zone.id] = createZoneState(zone);
  }

  return state;
}

function createZoneState(zone) {
  const d = zone.defaults ?? {};
  switch (zone.type) {
    case 'dimmer':
      return { enabled: false, brightness: clampBrightness(d.brightness ?? 100) };
    case 'mode-dimmer':
      return { mode: 'off', brightness: clampBrightness(d.brightness ?? 100) };
    case 'rgb':
      return {
        enabled: false,
        color: normalizeColor(d.color),
        brightness: clampBrightness(d.brightness ?? 100),
      };
    case 'pixel':
      return {
        enabled: false,
        brightness: clampBrightness(d.brightness ?? 100),
        effect: d.effect ?? 'solid',
        speed: clampNumber(Math.round(Number(d.speed ?? 50)), 1, 100),
        // Tail length in LEDs for trailing effects; bounded by the strip length.
        trail: clampNumber(Math.round(Number(d.trail ?? 8)), 1, zone.pixelCount ?? 255),
        color: normalizeColor(d.color),
        secondaryColor: normalizeColor(d.secondaryColor, { r: 0, g: 0, b: 255 }),
      };
    default:
      throw new Error(`Unknown zone type "${zone.type}" for zone "${zone.id}"`);
  }
}

/**
 * Validate and merge a partial update for one zone.
 *
 * Returns a new zone state object; unknown keys are ignored rather than
 * rejected so a newer UI talking to an older server degrades gracefully.
 * Throws only on values that are structurally wrong (e.g. an invalid mode).
 */
export function applyZonePatch(zone, current, patch, options = {}) {
  const { availableEffects = null } = options;
  const next = { ...current };

  if (zone.type === 'dimmer' || zone.type === 'rgb' || zone.type === 'pixel') {
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  }

  if (zone.type === 'mode-dimmer') {
    if (patch.mode !== undefined) {
      const modes = zone.modes ?? ['off', 'on'];
      const mode = String(patch.mode).toLowerCase();
      if (!modes.includes(mode)) {
        throw new Error(`Invalid mode "${patch.mode}" for zone "${zone.id}" (expected ${modes.join('|')})`);
      }
      next.mode = mode;
    }
  }

  if (patch.brightness !== undefined) {
    next.brightness = clampBrightness(patch.brightness);
  }

  if (zone.type === 'rgb' || zone.type === 'pixel') {
    if (patch.color !== undefined) next.color = normalizeColor(patch.color, current.color);
  }

  if (zone.type === 'pixel') {
    if (patch.secondaryColor !== undefined) {
      next.secondaryColor = normalizeColor(patch.secondaryColor, current.secondaryColor);
    }
    if (patch.speed !== undefined) {
      next.speed = clampNumber(Math.round(Number(patch.speed)), 1, 100);
    }
    if (patch.trail !== undefined) {
      next.trail = clampNumber(Math.round(Number(patch.trail)), 1, zone.pixelCount ?? 255);
    }
    if (patch.effect !== undefined) {
      const effect = String(patch.effect);
      if (availableEffects && !availableEffects.includes(effect)) {
        throw new Error(`Unknown effect "${effect}" (expected ${availableEffects.join('|')})`);
      }
      next.effect = effect;
    }
  }

  return next;
}

/**
 * The "everything dark" state — used by Master Off, the All Off scene and
 * graceful shutdown. Brightness values are intentionally preserved so turning
 * a zone back on restores the level the driver last chose.
 */
export function createAllOffState(lightingConfig, current) {
  const next = structuredClone(current);

  for (const zone of [...(lightingConfig.zones ?? []), ...(lightingConfig.pixelZones ?? [])]) {
    const zoneState = next[zone.id];
    if (!zoneState) continue;
    if (zone.type === 'mode-dimmer') zoneState.mode = 'off';
    else zoneState.enabled = false;
  }

  return next;
}
