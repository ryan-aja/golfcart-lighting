import { useLighting } from '../hooks/LightingContext.jsx';
import LightingZoneCard from '../components/LightingZoneCard.jsx';
import SceneButton from '../components/SceneButton.jsx';
import ConnectionIndicator from '../components/ConnectionIndicator.jsx';
import ThemeButton from '../components/ThemeButton.jsx';

/**
 * Main touchscreen dashboard.
 *
 * Single screen, no navigation depth: status bar, scene row, theme audio, then
 * one card per configured zone. Zones come from the server, so the layout
 * follows config.
 */
export default function Dashboard() {
  const {
    connected,
    ready,
    state,
    zones,
    scenes,
    effects,
    status,
    activeSceneId,
    audio,
    error,
    setZone,
    activateScene,
    allOff,
    playTheme,
    stopTheme,
    setThemeLoop,
  } = useLighting();

  return (
    <div className="dashboard">
      <header className="top-bar">
        <h1 className="app-title">LIGHTING</h1>
        <div className="top-actions">
          <ConnectionIndicator connected={connected} status={status} />
          <button type="button" className="master-off" onClick={allOff}>
            ALL OFF
          </button>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}
      {!connected && <div className="warning-banner">Reconnecting to controller…</div>}

      {scenes.length > 0 && (
        <nav className="scene-row" aria-label="Scenes">
          {scenes.map((scene) => (
            <SceneButton
              key={scene.id}
              scene={scene}
              active={activeSceneId === scene.id}
              onSelect={activateScene}
            />
          ))}
        </nav>
      )}

      <ThemeButton
        audio={audio}
        onPlay={playTheme}
        onStop={stopTheme}
        onLoopChange={setThemeLoop}
      />

      <main className="zone-grid">
        {!ready && <p className="loading">Connecting…</p>}
        {zones.map((zone) => (
          <LightingZoneCard
            key={zone.id}
            zone={zone}
            zoneState={state[zone.id]}
            effects={effects}
            onChange={(patch) => setZone(zone.id, patch)}
          />
        ))}
      </main>
    </div>
  );
}
