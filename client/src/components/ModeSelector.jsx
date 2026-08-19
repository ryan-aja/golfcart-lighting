/**
 * Segmented control for zones that have modes rather than a simple toggle
 * (currently the reverse light: OFF / AUTO / ON).
 */
export default function ModeSelector({ modes = [], value, onChange, disabled = false }) {
  return (
    <div className="mode-selector" role="group" aria-label="Mode">
      {modes.map((mode) => (
        <button
          key={mode}
          type="button"
          className={`mode-option ${value === mode ? 'is-active' : ''}`}
          aria-pressed={value === mode}
          disabled={disabled}
          onClick={() => onChange(mode)}
        >
          {mode.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
