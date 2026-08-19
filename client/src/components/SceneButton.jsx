/** One stored scene. */
export default function SceneButton({ scene, active = false, onSelect }) {
  return (
    <button
      type="button"
      className={`scene-button ${active ? 'is-active' : ''}`}
      aria-pressed={active}
      onClick={() => onSelect(scene.id)}
    >
      {scene.name ?? scene.id}
    </button>
  );
}
