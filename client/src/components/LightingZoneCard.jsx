import ToggleButton from './ToggleButton.jsx';
import ModeSelector from './ModeSelector.jsx';
import BrightnessSlider from './BrightnessSlider.jsx';
import ColorPicker, { rgbCss } from './ColorPicker.jsx';
import EffectSelector from './EffectSelector.jsx';

/**
 * One lighting zone, rendered generically from its configured type.
 *
 * Adding a zone to config/lighting.json gives it a working card here with no
 * new UI code — which is the point of keeping hardware knowledge on the server.
 */
export default function LightingZoneCard({ zone, zoneState, onChange, effects = [] }) {
  if (!zone || !zoneState) return null;

  const isRgb = zone.type === 'rgb';
  const isPixel = zone.type === 'pixel';
  const isModal = zone.type === 'mode-dimmer';
  const active = isModal ? zoneState.mode !== 'off' : Boolean(zoneState.enabled);

  // Each effect declares which parameters it actually uses, so a zone only
  // shows the controls that will do something. Rainbow hides the colour picker;
  // Scanner reveals the trail-length slider.
  const activeEffect = effects.find((e) => e.id === zoneState.effect);
  const usesParam = (param) => !activeEffect || activeEffect.params.includes(param);
  const showColor = isRgb || (isPixel && usesParam('color'));

  return (
    <section className={`zone-card ${active ? 'is-active' : 'is-inactive'}`}>
      <header className="zone-header">
        <h2 className="zone-title">
          {(isRgb || isPixel) && (
            <span
              className="zone-swatch"
              aria-hidden="true"
              style={{ background: rgbCss(zoneState.color), opacity: active ? 1 : 0.35 }}
            />
          )}
          {zone.name}
        </h2>

        {isModal ? (
          <ModeSelector
            modes={zone.modes ?? ['off', 'on']}
            value={zoneState.mode}
            onChange={(mode) => onChange({ mode })}
          />
        ) : (
          <ToggleButton on={active} onChange={(enabled) => onChange({ enabled })} />
        )}
      </header>

      <div className="zone-body">
        <BrightnessSlider
          value={zoneState.brightness}
          onChange={(brightness) => onChange({ brightness })}
        />

        {showColor && (
          <ColorPicker color={zoneState.color} onChange={(color) => onChange({ color })} />
        )}

        {isPixel && (
          <>
            <EffectSelector
              effects={effects}
              value={zoneState.effect}
              onChange={(effect) => onChange({ effect })}
            />
            {usesParam('speed') && (
              <BrightnessSlider
                label="Speed"
                value={zoneState.speed}
                onChange={(speed) => onChange({ speed })}
                min={1}
              />
            )}
            {usesParam('trail') && (
              <BrightnessSlider
                label="Trail"
                value={zoneState.trail}
                onChange={(trail) => onChange({ trail })}
                min={1}
                max={zone.pixelCount ?? 100}
                unit=" LEDs"
              />
            )}
          </>
        )}
      </div>

      {isModal && zoneState.mode === 'auto' && (
        <p className="zone-note">AUTO follows the reverse signal — vehicle input not wired yet.</p>
      )}
    </section>
  );
}
