/** Effect chooser for pixel zones. Effects run server-side; this only picks one. */
export default function EffectSelector({ effects = [], value, onChange, disabled = false }) {
  return (
    <div className="effect-selector" role="group" aria-label="Effect">
      {effects.map((effect) => (
        <button
          key={effect.id}
          type="button"
          className={`effect-option ${value === effect.id ? 'is-active' : ''}`}
          aria-pressed={value === effect.id}
          disabled={disabled}
          onClick={() => onChange(effect.id)}
        >
          {effect.name}
        </button>
      ))}
    </div>
  );
}
