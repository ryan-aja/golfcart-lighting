/**
 * Theme audio control.
 *
 * One big button that plays the theme through the Pi's own speaker (not the
 * browser's — the sound is produced server-side so it plays whether the trigger
 * came from the touchscreen or a phone), plus a loop checkbox.
 *
 * Playback is server state, so a second phone sees the button light up too.
 * While a track is running the button becomes STOP, because on a moving cart
 * the thing you most urgently want is a way to make it stop.
 */

export default function ThemeButton({ audio, onPlay, onStop, onLoopChange }) {
  // Bootstrap has not arrived yet — render nothing rather than a dead control.
  if (!audio) return null;

  const { available, playing, loop, enabled, error, file } = audio;
  const disabled = !enabled || !available;

  const label = playing ? 'STOP' : 'THEME';
  const hint = !enabled
    ? 'Audio disabled in config'
    : error || (file ? `Playing ${file} on the cart` : null);

  return (
    <div className="theme-bar">
      <button
        type="button"
        className={`theme-button${playing ? ' is-playing' : ''}`}
        disabled={disabled}
        aria-label={playing ? 'Stop the theme' : 'Play the theme'}
        onClick={() => (playing ? onStop() : onPlay(loop))}
      >
        <span className="theme-glyph" aria-hidden="true">
          {playing ? '■' : '▶'}
        </span>
        {label}
      </button>

      <label className={`loop-toggle${disabled ? ' is-disabled' : ''}`}>
        <input
          type="checkbox"
          checked={Boolean(loop)}
          disabled={disabled}
          onChange={(event) => onLoopChange(event.target.checked)}
        />
        <span className="loop-box" aria-hidden="true" />
        <span className="loop-label">LOOP</span>
      </label>

      {hint && <span className={`theme-hint${error ? ' is-error' : ''}`}>{hint}</span>}
    </div>
  );
}
