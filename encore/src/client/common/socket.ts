import { io, type Socket } from 'socket.io-client';
import { useEffect, useState } from 'react';
import type { ClientToServer, Role, ServerToClient } from '../../shared/protocol.ts';

export type AppSocket = Socket<ServerToClient, ClientToServer>;

const PIN_KEY = 'encore.pin';

export function storedPin(): string | undefined {
  const fromUrl = new URLSearchParams(location.search).get('pin');
  if (fromUrl) {
    safeSet(PIN_KEY, fromUrl);
    return fromUrl;
  }
  return safeGet(PIN_KEY) ?? undefined;
}

export function savePin(pin: string): void {
  safeSet(PIN_KEY, pin);
}

export function connect(role: Role, pin?: string): AppSocket {
  return io({
    auth: { role, pin },
    transports: ['websocket', 'polling'],
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000,
  });
}

type Acked<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

/** An error from the server, with its machine-readable code when it has one. */
export type ServerError = Error & { code?: string };

/** Emit an event with an ack and get a promise for the result. */
export function request<T>(socket: AppSocket, event: keyof ClientToServer, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The server didn’t answer. Check the connection.')), 15_000);
    (socket.emit as (...a: unknown[]) => void)(event, ...args, (res: Acked<T>) => {
      clearTimeout(timer);
      if (res?.ok) resolve(res.data);
      else reject(Object.assign(new Error(res?.error ?? 'Something went wrong.'), { code: res?.code }));
    });
  });
}

export type ConnState = 'connecting' | 'online' | 'offline' | 'pin';

export function useConnection(socket: AppSocket | null): ConnState {
  const [state, setState] = useState<ConnState>(socket?.connected ? 'online' : 'connecting');
  useEffect(() => {
    if (!socket) return;
    const on = () => setState('online');
    const off = () => setState('offline');
    const err = (e: Error) => setState(/PIN|Too many/.test(e.message) ? 'pin' : 'offline');
    socket.on('connect', on);
    socket.on('disconnect', off);
    socket.on('connect_error', err);
    if (socket.connected) setState('online');
    return () => {
      socket.off('connect', on);
      socket.off('disconnect', off);
      socket.off('connect_error', err);
    };
  }, [socket]);
  return state;
}

export function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // private mode or storage blocked: the app still works, it just forgets
  }
}
