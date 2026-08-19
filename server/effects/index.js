/**
 * Effect registry.
 *
 * An effect is a pure function of (pixelCount, colours, speed, elapsed time)
 * that returns an array of full-brightness pixels. Brightness and output
 * ceilings are applied downstream by the lighting engine, and every effect is
 * driven by the single central render loop — effects never own a timer.
 *
 * To add an effect: create a module exporting { id, name, params, render }
 * and register it below.
 */

import solid from './solid.js';
import colorCycle from './colorCycle.js';
import rainbow from './rainbow.js';
import chase from './chase.js';
import pulse from './pulse.js';
import scanner from './scanner.js';

const registry = new Map([solid, colorCycle, rainbow, chase, pulse, scanner].map((e) => [e.id, e]));

export function getEffect(id) {
  return registry.get(id) ?? registry.get('solid');
}

export function listEffects() {
  return [...registry.values()].map(({ id, name, params }) => ({ id, name, params }));
}

export function effectIds() {
  return [...registry.keys()];
}
