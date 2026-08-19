import { scaleColor, speedToHz } from './colorUtils.js';

const MIN_LEVEL = 0.08;

/** Whole strip breathes between a dim floor and full colour. */
export default {
  id: 'pulse',
  name: 'Pulse',
  params: ['color', 'speed'],
  render({ pixelCount, color, speed, timeSeconds }) {
    const phase = timeSeconds * speedToHz(speed, 1.0) * Math.PI * 2;
    const level = MIN_LEVEL + (1 - MIN_LEVEL) * ((Math.sin(phase) + 1) / 2);
    const rgb = scaleColor(color, level);
    return Array.from({ length: pixelCount }, () => ({ ...rgb }));
  },
};
