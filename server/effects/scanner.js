import { scaleColor, speedToHz } from './colorUtils.js';

/**
 * Scanner — the Knight Rider / KITT front bar (a "Larson scanner").
 *
 * A bright head sweeps end to end and bounces back, dragging a fading tail
 * behind it. The tail always lags the direction of travel, so it flips sides at
 * each turnaround exactly like the original prop.
 *
 * The original bar was six lamps; this renders against whatever `pixelCount`
 * the zone declares, so a 48-LED high-density strip simply gives a sharper
 * version of the same motion. The head position is fractional, which is what
 * keeps the sweep smooth rather than stepping pixel to pixel.
 *
 * `trail` is the tail length in LEDs and is clamped to the strip length.
 */

// >1 concentrates brightness near the head; 2.2 reads as a crisp comet rather
// than an even gradient.
const FALLOFF_GAMMA = 2.2;

// A touch of glow on the pixel the head is moving into, so sub-pixel motion
// doesn't look like a hard edge.
const LEADING_EDGE_BLEED = 0.35;

// Sweeps (one-way passes) per second at speed 100. At the default speed 50 this
// is 1.5 sweeps/sec — close to the pace of the on-screen bar.
const MAX_SWEEPS_PER_SECOND = 3;

const OFF = { r: 0, g: 0, b: 0 };

export default {
  id: 'scanner',
  name: 'Scanner',
  params: ['color', 'speed', 'trail'],
  render({ pixelCount, color, speed, trail = 8, timeSeconds }) {
    if (pixelCount <= 1) {
      return Array.from({ length: pixelCount }, () => ({ ...color }));
    }

    const last = pixelCount - 1;

    // phase runs 0..2: the first half sweeps up the strip, the second back down.
    const phase = (timeSeconds * speedToHz(speed, MAX_SWEEPS_PER_SECOND)) % 2;
    const forward = phase < 1;
    const head = forward ? phase * last : (2 - phase) * last;

    const tail = Math.max(1, Math.min(Math.round(trail), pixelCount));

    return Array.from({ length: pixelCount }, (_, i) => {
      // How far the head has travelled since it last passed this pixel, measured
      // along the folded path. Pixels the head has not reached yet on this sweep
      // are scored via the previous sweep, so the tail bends around a turnaround
      // instead of collapsing to a single pixel at each end.
      const behind = forward
        ? i <= head
          ? head - i
          : i + head
        : i >= head
          ? i - head
          : 2 * last - i - head;

      if (behind < tail) return scaleColor(color, (1 - behind / tail) ** FALLOFF_GAMMA);

      // Faint glow on the pixel the head is moving into, so sub-pixel motion
      // doesn't read as a hard edge.
      const ahead = forward ? i - head : head - i;
      if (ahead > 0 && ahead < 1) return scaleColor(color, (1 - ahead) * LEADING_EDGE_BLEED);

      return { ...OFF };
    });
  },
};
