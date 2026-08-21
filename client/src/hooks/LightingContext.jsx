/**
 * Lighting context.
 *
 * Holds the server's lighting state and exposes intent functions. The server is
 * the source of truth: every command is sent over the socket and the UI redraws
 * from the broadcast that follows. Local changes are applied optimistically so
 * controls feel immediate, then replaced by the authoritative state.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { emitCommand, socket } from '../services/socket.js';

const LightingContext = createContext(null);

function mergePatch(target, patch) {
  const next = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    next[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(target[key] ?? {}), ...value }
      : value;
  }
  return next;
}

export function LightingProvider({ children }) {
  const [connected, setConnected] = useState(socket.connected);
  const [state, setState] = useState({});
  const [zones, setZones] = useState([]);
  const [scenes, setScenes] = useState([]);
  const [effects, setEffects] = useState([]);
  const [status, setStatus] = useState(null);
  const [activeSceneId, setActiveSceneId] = useState(null);
  const [audio, setAudio] = useState(null);
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);

  const errorTimer = useRef(null);

  const flashError = useCallback((message) => {
    setError(message);
    clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(null), 4000);
  }, []);

  useEffect(() => {
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    const onBootstrap = (payload) => {
      setZones(payload.zones ?? []);
      setScenes(payload.scenes ?? []);
      setEffects(payload.effects ?? []);
      setStatus(payload.status ?? null);
      setState(payload.snapshot?.state ?? {});
      setActiveSceneId(payload.snapshot?.activeSceneId ?? null);
      setAudio(payload.audio ?? null);
      setReady(true);
    };

    const onState = (snapshot) => {
      setState(snapshot.state ?? {});
      setActiveSceneId(snapshot.activeSceneId ?? null);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('bootstrap', onBootstrap);
    socket.on('state', onState);
    socket.on('status', setStatus);
    socket.on('audio', setAudio);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('bootstrap', onBootstrap);
      socket.off('state', onState);
      socket.off('status', setStatus);
      socket.off('audio', setAudio);
      clearTimeout(errorTimer.current);
    };
  }, []);

  const setZone = useCallback(
    async (zoneId, patch) => {
      setState((current) => ({ ...current, [zoneId]: mergePatch(current[zoneId] ?? {}, patch) }));
      const result = await emitCommand('zone:set', { zone: zoneId, patch });
      if (!result.ok) flashError(result.error);
    },
    [flashError]
  );

  const activateScene = useCallback(
    async (sceneId) => {
      setActiveSceneId(sceneId);
      const result = await emitCommand('scene:activate', { sceneId });
      if (!result.ok) flashError(result.error);
    },
    [flashError]
  );

  const allOff = useCallback(async () => {
    const result = await emitCommand('all:off', {});
    if (!result.ok) flashError(result.error);
  }, [flashError]);

  /**
   * Audio is the one control that is not idempotent — pressing play while a
   * track runs restarts it. The optimistic flip keeps the button responsive on
   * the touchscreen; the server's broadcast corrects it either way.
   */
  const playTheme = useCallback(
    async (loop) => {
      setAudio((current) => (current ? { ...current, playing: true, loop } : current));
      const result = await emitCommand('audio:play', { loop });
      if (!result.ok) {
        flashError(result.error);
        setAudio((current) => (current ? { ...current, playing: false } : current));
      }
    },
    [flashError]
  );

  const stopTheme = useCallback(async () => {
    setAudio((current) => (current ? { ...current, playing: false } : current));
    const result = await emitCommand('audio:stop', {});
    if (!result.ok) flashError(result.error);
  }, [flashError]);

  const setThemeLoop = useCallback(
    async (loop) => {
      setAudio((current) => (current ? { ...current, loop } : current));
      const result = await emitCommand('audio:loop', { loop });
      if (!result.ok) flashError(result.error);
    },
    [flashError]
  );

  const value = useMemo(
    () => ({
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
    }),
    [
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
    ]
  );

  return <LightingContext.Provider value={value}>{children}</LightingContext.Provider>;
}

export function useLighting() {
  const context = useContext(LightingContext);
  if (!context) throw new Error('useLighting must be used inside a LightingProvider');
  return context;
}

/** Convenience accessor for a single zone's state and updater. */
export function useZone(zoneId) {
  const { state, zones, setZone } = useLighting();
  const zone = zones.find((z) => z.id === zoneId) ?? null;
  const update = useCallback((patch) => setZone(zoneId, patch), [setZone, zoneId]);
  return { zone, zoneState: state[zoneId], update };
}
