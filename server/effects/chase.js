import { speedToHz } from './colorUtils.js';

const TAIL_LENGTH = 6;

/** A short comet of `color` running along a `secondaryColor` background. */
export default {
  id: 'chase',
  name: 'Chase',
  params: ['color', 'secondaryColor', 'speed'],
  render({ pixelCount, color, secondaryColor, speed, timeSeconds }) {
    // One "cycle" walks the head from end to end of the strip.
    const head = (timeSeconds * speedToHz(speed, 1.2) * pixelCount) % pixelCount;

    return Array.from({ length: pixelCount }, (_, i) => {
      const distance = (head - i + pixelCount) % pixelCount;
      if (distance >= TAIL_LENGTH) return { ...secondaryColor };
      const fade = 1 - distance / TAIL_LENGTH;
      return {
        r: Math.round(secondaryColor.r + (color.r - secondaryColor.r) * fade),
        g: Math.round(secondaryColor.g + (color.g - secondaryColor.g) * fade),
        b: Math.round(secondaryColor.b + (color.b - secondaryColor.b) * fade),
      };
    });
  },
};
