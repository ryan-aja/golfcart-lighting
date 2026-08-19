/**
 * Shows the socket link to the controller and whether Art-Net output is real
 * or simulated — the two things worth knowing at a glance while debugging on
 * the cart.
 */
export default function ConnectionIndicator({ connected, status }) {
  const artnet = status?.artnet;
  const simulation = artnet?.simulation;

  const label = !connected ? 'OFFLINE' : simulation ? 'SIM' : 'LIVE';
  const tone = !connected ? 'bad' : simulation ? 'warn' : 'good';

  const detail = !connected
    ? 'No controller connection'
    : simulation
      ? 'Simulation - no Art-Net output'
      : `Art-Net → ${artnet?.destination ?? 'unknown'}`;

  return (
    <div className={`connection-indicator tone-${tone}`} title={detail}>
      <span className="dot" aria-hidden="true" />
      <span className="conn-label">{label}</span>
    </div>
  );
}
