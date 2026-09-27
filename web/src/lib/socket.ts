/**
 * One shared Socket.IO connection. It re-authenticates whenever the access token changes
 * and re-subscribes to every watched room after a reconnect, so views never go stale.
 */
import { io, type Socket } from 'socket.io-client';
import { API_URL, getAccessToken, onTokenChange } from './api';

// In production REST goes through the Vercel /api proxy (first-party cookies), but Vercel cannot
// proxy WebSockets, so the socket connects straight to the API host. It authenticates with the
// access token in the handshake, so it needs no cookies.
const SOCKET_URL = (import.meta.env.VITE_SOCKET_URL as string | undefined)?.replace(/\/$/, '') || API_URL;

type WatchKind = 'queue:watch' | 'queue:watch-staff' | 'org:watch';

let socket: Socket | null = null;
const watches = new Map<string, { kind: WatchKind; id: string; count: number }>();
const statusListeners = new Set<(connected: boolean) => void>();

export function getSocket(): Socket {
  if (socket) return socket;
  socket = io(SOCKET_URL || undefined, {
    auth: (cb) => cb({ token: getAccessToken() ?? undefined }),
    transports: ['websocket', 'polling'],
    reconnectionDelayMax: 5000,
  });
  socket.on('connect', () => {
    for (const w of watches.values()) socket!.emit(w.kind, w.id);
    statusListeners.forEach((l) => l(true));
  });
  socket.on('disconnect', () => statusListeners.forEach((l) => l(false)));

  let lastToken = getAccessToken();
  onTokenChange((token) => {
    // Only reconnect when the identity changes (login/logout), not on every silent refresh.
    if (!!token === !!lastToken) {
      lastToken = token;
      return;
    }
    lastToken = token;
    socket?.disconnect().connect();
  });
  return socket;
}

/** Reference-counted room subscription. Returns an unsubscribe function. */
export function watch(kind: WatchKind, id: string) {
  const s = getSocket();
  const key = `${kind}:${id}`;
  const existing = watches.get(key);
  if (existing) existing.count++;
  else {
    watches.set(key, { kind, id, count: 1 });
    if (s.connected) s.emit(kind, id);
  }
  return () => {
    const w = watches.get(key);
    if (!w) return;
    if (--w.count > 0) return;
    watches.delete(key);
    const unwatch = kind === 'queue:watch' ? 'queue:unwatch' : kind === 'queue:watch-staff' ? 'queue:unwatch-staff' : null;
    if (unwatch && s.connected) s.emit(unwatch, id);
  };
}

export function onConnectionChange(listener: (connected: boolean) => void) {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}
