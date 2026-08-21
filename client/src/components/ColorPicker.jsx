import { useEffect, useRef, useState } from 'react';
import useSliderGesture from '../hooks/useSliderGesture.js';

/**
 * Touch colour picker: large preset swatches with an optional RGB drawer.
 *
 * A hue wheel is hard to hit accurately on a bumpy cart, so presets do the
 * everyday work and the sliders cover everything else.
 */
const PRESETS = [
  { name: 'White', r: 255, g: 255, b: 255 },
  { name: 'Warm', r: 255, g: 170, b: 90 },
  { name: 'Red', r: 255, g: 0, b: 0 },
  { name: 'Orange', r: 255, g: 80, b: 0 },
  { name: 'Yellow', r: 255, g: 210, b: 0 },
  { name: 'Green', r: 0, g: 255, b: 60 },
  { name: 'Cyan', r: 0, g: 220, b: 255 },
  { name: 'Blue', r: 0, g: 80, b: 255 },
  { name: 'Purple', r: 140, g: 0, b: 255 },
  { name: 'Pink', r: 255, g: 0, b: 180 },
];

const rgbCss = (c) => `rgb(${c?.r ?? 0}, ${c?.g ?? 0}, ${c?.b ?? 0})`;

const isSame = (a, b) => a && b && a.r === b.r && a.g === b.g && a.b === b.b;

/**
 * One channel of the RGB drawer.
 *
 * Its own component so it can hold the gesture hook — these rows live in a
 * scrolling list, and without the guard a swipe to scroll would repaint the
 * zone on the way past. See useSliderGesture.
 */
function RgbSlider({ channel, value, disabled, onChange }) {
  const [local, setLocal] = useState(value);
  const localRef = useRef(value);
  const dragging = useRef(false);
  const gesture = useSliderGesture();

  useEffect(() => {
    if (!dragging.current) {
      setLocal(value);
      localRef.current = value;
    }
  }, [value]);

  const settle = () => {
    gesture.end();
    dragging.current = false;
    onChange(localRef.current);
  };

  const revert = () => {
    gesture.cancel();
    dragging.current = false;
    setLocal(value);
    localRef.current = value;
  };

  return (
    <label className={`rgb-row rgb-${channel}`}>
      <span>{channel.toUpperCase()}</span>
      <input
        type="range"
        min="0"
        max="255"
        step="1"
        value={local}
        disabled={disabled}
        aria-label={`${channel.toUpperCase()} channel`}
        onPointerDown={(e) => {
          dragging.current = true;
          gesture.begin(e);
        }}
        onPointerMove={(e) => {
          if (gesture.track(e)) onChange(localRef.current);
        }}
        onPointerUp={settle}
        onPointerCancel={revert}
        onChange={(e) => {
          const next = Number(e.target.value);
          setLocal(next);
          localRef.current = next;
          if (gesture.sending()) onChange(next);
        }}
      />
      <span className="rgb-value">{local}</span>
    </label>
  );
}

export default function ColorPicker({ color, onChange, disabled = false }) {
  const [showCustom, setShowCustom] = useState(false);
  const current = color ?? { r: 255, g: 255, b: 255 };

  return (
    <div className={`color-picker ${disabled ? 'is-disabled' : ''}`}>
      <div className="swatch-row">
        {PRESETS.map((preset) => (
          <button
            key={preset.name}
            type="button"
            title={preset.name}
            aria-label={preset.name}
            aria-pressed={isSame(current, preset)}
            disabled={disabled}
            className={`swatch ${isSame(current, preset) ? 'is-active' : ''}`}
            style={{ background: rgbCss(preset) }}
            onClick={() => onChange({ r: preset.r, g: preset.g, b: preset.b })}
          />
        ))}
        <button
          type="button"
          className={`swatch swatch-custom ${showCustom ? 'is-active' : ''}`}
          aria-label="Custom colour"
          aria-expanded={showCustom}
          disabled={disabled}
          onClick={() => setShowCustom((v) => !v)}
        >
          RGB
        </button>
      </div>

      {showCustom && (
        <div className="rgb-drawer">
          {['r', 'g', 'b'].map((channel) => (
            <RgbSlider
              key={channel}
              channel={channel}
              value={current[channel] ?? 0}
              disabled={disabled}
              onChange={(next) => onChange({ ...current, [channel]: next })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export { rgbCss };
