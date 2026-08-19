import { hsvToRgb, speedToHz } from './colorUtils.js';

/** A full hue wheel spread along the strip, scrolling over time. */
export default {
  id: 'rainbow',
  name: 'Rainbow',
  params: ['speed'],
  render({ pixelCount, speed, timeSeconds }) {
    const offset = timeSeconds * speedToHz(speed, 0.5);
    return Array.from({ length: pixelCount }, (_, i) => hsvToRgb(i / Math.max(1, pixelCount) + offset));
  },
};
