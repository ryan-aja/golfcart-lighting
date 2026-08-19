/** Small colour helpers shared by the pixel effects. */

/**
 * @param {number} h hue 0-1 (wraps)
 * @param {number} s saturation 0-1
 * @param {number} v value 0-1
 */
export function hsvToRgb(h, s = 1, v = 1) {
  const hue = ((h % 1) + 1) % 1;
  const i = Math.floor(hue * 6);
  const f = hue * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);

  const [r, g, b] = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][i % 6];

  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

export function scaleColor(color, factor) {
  return {
    r: Math.round((color.r ?? 0) * factor),
    g: Math.round((color.g ?? 0) * factor),
    b: Math.round((color.b ?? 0) * factor),
  };
}

/**
 * Map a 1-100 UI speed onto cycles per second.
 * Speed 50 lands near 0.75 Hz, which reads as a comfortable mid-tempo.
 */
export function speedToHz(speed, maxHz = 1.5) {
  const pct = Math.min(100, Math.max(1, Number(speed) || 1));
  return (pct / 100) * maxHz;
}
