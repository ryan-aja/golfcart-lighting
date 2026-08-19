/** Large on/off button sized for a fingertip on a moving vehicle. */
export default function ToggleButton({ on, onChange, labelOn = 'ON', labelOff = 'OFF', disabled = false }) {
  return (
    <button
      type="button"
      className={`toggle-button ${on ? 'is-on' : 'is-off'}`}
      aria-pressed={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      {on ? labelOn : labelOff}
    </button>
  );
}
