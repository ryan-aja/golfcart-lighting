/**
 * REST helpers.
 *
 * The UI drives lighting over WebSocket; these exist for the initial page load
 * fallback and for debugging from the browser console.
 */

async function request(path, options) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

export const api = {
  getState: () => request('/api/state'),
  getConfig: () => request('/api/config'),
  getStatus: () => request('/api/status'),
  setZone: (zoneId, patch) =>
    request(`/api/lights/${zoneId}`, { method: 'POST', body: JSON.stringify(patch) }),
  activateScene: (sceneId) => request(`/api/scenes/${sceneId}`, { method: 'POST' }),
  allOff: () => request('/api/lights/all-off', { method: 'POST' }),
  getAudio: () => request('/api/audio'),
  playTheme: (loop = false) =>
    request('/api/audio/play', { method: 'POST', body: JSON.stringify({ loop }) }),
  stopTheme: () => request('/api/audio/stop', { method: 'POST' }),
  setThemeLoop: (loop) =>
    request('/api/audio/loop', { method: 'POST', body: JSON.stringify({ loop }) }),
};
