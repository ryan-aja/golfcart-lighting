import { hsvToRgb, speedToHz } from './colorUtils.js';

/** Whole strip fades through the hue wheel together. */
export default {
  id: 'colorCycle',
  name: 'Color Cycle',
  params: ['speed'],
  render({ pixelCount, speed, timeSeconds }) {
    const hue = timeSeconds * speedToHz(speed, 0.4);
    const rgb = hsvToRgb(hue);
    return Array.from({ length: pixelCount }, () => ({ ...rgb }));
  },
};
