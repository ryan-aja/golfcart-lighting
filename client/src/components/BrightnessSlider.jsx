import { useEffect, useRef, useState } from 'react';
import useSliderGesture from '../hooks/useSliderGesture.js';

const COMMIT_INTERVAL_MS = 60;

/**
 * Touch-friendly slider. Defaults to a 0-100 percentage, but `min`/`max`/`unit`
 * let it serve any scalar control (speed, scanner trail length, ...).
 *
 * While the finger is down the slider owns its value and ignores incoming
 * server state, so an in-flight broadcast can't yank the thumb backwards.
 * Updates are throttled to ~16/sec, which is plenty for a PWM dimmer and keeps
 * the socket quiet.
 *
 * The thumb tracks the finger from the moment it lands, but nothing is sent
 * until useSliderGesture decides the gesture was aimed at the slider rather
 * than at scrolling the card list — see that hook for why.
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
  // Handlers need the current value synchronously; state would be a frame old.
  const localRef = useRef(value ?? 0);
  const gesture = useSliderGesture();

  useEffect(() => {
    if (!dragging.current) {
      setLocal(value ?? 0);
      localRef.current = value ?? 0;
    }
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
    gesture.end();
    dragging.current = false;
    clearTimeout(flushTimer.current);
    onChange(localRef.current);
  };

  /**
   * The browser took this gesture to scroll the list. The thumb may have
   * jumped to wherever the finger landed, so put it back — nothing was sent,
   * so the server is still the authority.
   */
  const cancelDrag = () => {
    gesture.cancel();
    dragging.current = false;
    clearTimeout(flushTimer.current);
    pending.current = null;
    setLocal(value ?? 0);
    localRef.current = value ?? 0;
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
        onPointerDown={(e) => {
          dragging.current = true;
          gesture.begin(e);
        }}
        onPointerMove={(e) => {
          // Just became a real drag: send the value already scrubbed past.
          if (gesture.track(e)) commit(localRef.current);
        }}
        onPointerUp={endDrag}
        onPointerCancel={cancelDrag}
        onChange={(e) => {
          const next = Number(e.target.value);
          setLocal(next);
          localRef.current = next;
          if (gesture.sending()) commit(next);
        }}
      />
    </label>
  );
}
