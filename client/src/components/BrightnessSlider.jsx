import { useEffect, useRef, useState } from 'react';

const COMMIT_INTERVAL_MS = 60;

/**
 * Touch-friendly slider. Defaults to a 0-100 percentage, but `min`/`max`/`unit`
 * let it serve any scalar control (speed, scanner trail length, ...).
 *
 * While the finger is down the slider owns its value and ignores incoming
 * server state, so an in-flight broadcast can't yank the thumb backwards.
 * Updates are throttled to ~16/sec, which is plenty for a PWM dimmer and keeps
 * the socket quiet.
 */
export default function BrightnessSlider({
  value,
  onChange,
  disabled = false,
  label = 'Brightness',
  min = 0,
  max = 100,
  unit = '%',
}) {
  const [local, setLocal] = useState(value ?? 0);
  const dragging = useRef(false);
  const lastCommit = useRef(0);
  const pending = useRef(null);
  const flushTimer = useRef(null);

  useEffect(() => {
    if (!dragging.current) setLocal(value ?? 0);
  }, [value]);

  useEffect(() => () => clearTimeout(flushTimer.current), []);

  const commit = (next) => {
    const now = performance.now();
    pending.current = next;
    if (now - lastCommit.current >= COMMIT_INTERVAL_MS) {
      lastCommit.current = now;
      onChange(next);
      return;
    }
    // Make sure the final resting value always gets sent.
    clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => {
      lastCommit.current = performance.now();
      onChange(pending.current);
    }, COMMIT_INTERVAL_MS);
  };

  const endDrag = () => {
    dragging.current = false;
    clearTimeout(flushTimer.current);
    onChange(local);
  };

  return (
    <label className={`brightness-slider ${disabled ? 'is-disabled' : ''}`}>
      <span className="slider-head">
        <span className="slider-label">{label}</span>
        <span className="slider-value">
          {local}
          {unit}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step="1"
        value={local}
        disabled={disabled}
        onPointerDown={() => {
          dragging.current = true;
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onChange={(e) => {
          const next = Number(e.target.value);
          setLocal(next);
          commit(next);
        }}
      />
    </label>
  );
}
