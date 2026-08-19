/**
 * Socket.IO client.
 *
 * Same-origin in production; the Vite dev server proxies /socket.io to the
 * Node server during development, so no host is ever hardcoded here.
 */

import { io } from 'socket.io-client';

export const socket = io({
  autoConnect: true,
  reconnection: true,
  reconnectionDelay: 500,
  reconnectionDelayMax: 4000,
  // The touchscreen is on localhost and phones are one hop away, so go
  // straight to WebSocket instead of paying for the HTTP long-poll upgrade.
  transports: ['websocket', 'polling'],
});

/** Send a command and resolve with the server's acknowledgement. */
export function emitCommand(event, payload) {
  return new Promise((resolve) => {
    socket.timeout(3000).emit(event, payload, (timeoutErr, response) => {
      if (timeoutErr) return resolve({ ok: false, error: 'Timed out' });
      resolve(response ?? { ok: true });
    });
  });
}
