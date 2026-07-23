"use client";

import { io, Socket } from "socket.io-client";
import type { ServerToClientEvents, ClientToServerEvents } from "@orderhub/shared";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: TypedSocket | null = null;
let socketToken: string | null = null;

// ── Location-room membership, refcounted ─────────────────────────────────────
// Several independent consumers (orders board, alert sounds, caller-id popup,
// the live-orders feed) join the SAME `location:<id>` room. Socket.IO rooms
// have no reference counting — one consumer's `room:leave` on unmount kicked
// every OTHER consumer out of the room too (the orders board leaving on
// navigation silently made the alert player deaf until its next poll happened
// to re-join). These helpers refcount joins so the socket only actually leaves
// a room when the LAST consumer is done with it, and re-join every held room
// after a reconnect (the server forgets memberships on disconnect).
const roomCounts = new Map<string, number>();

export function joinLocationRoom(s: TypedSocket, locationId: string): void {
  const n = (roomCounts.get(locationId) ?? 0) + 1;
  roomCounts.set(locationId, n);
  // Emitting join repeatedly is idempotent server-side.
  s.emit("room:join", locationId);
}

export function leaveLocationRoom(s: TypedSocket, locationId: string): void {
  const n = (roomCounts.get(locationId) ?? 0) - 1;
  if (n <= 0) {
    roomCounts.delete(locationId);
    s.emit("room:leave", locationId);
  } else {
    roomCounts.set(locationId, n);
  }
}

export function getSocket(token = ""): TypedSocket {
  if (socket) {
    // Healthy socket → always reuse. Also reuse while DISCONNECTED if the
    // auth token hasn't changed: socket.io's own reconnection is in flight,
    // and building a second socket here is exactly how we used to end up
    // with duplicate connections + orphaned listeners during reconnect
    // windows. Only a stale token (rotated while offline) forces a rebuild,
    // since reconnecting with the old token would fail auth forever.
    if (socket.connected || socketToken === token || !token) return socket;
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }

  socketToken = token;
  // Use NEXT_PUBLIC_SOCKET_URL (server root) for Socket.IO — NOT NEXT_PUBLIC_API_URL
  // which includes the /api path prefix used only for REST calls.
  socket = io(process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://localhost:4000", {
    auth: { token },
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 1000,
    // Back off to 15s between attempts and retry forever (the library
    // default). The previous cap of 10 attempts meant a till that lost
    // wifi for ~30s gave up on realtime permanently until a page reload;
    // with capped backoff, retrying forever costs one frame every 15s.
    reconnectionDelayMax: 15_000,
  }) as TypedSocket;

  // The server forgets room membership on disconnect — rejoin everything we
  // still hold on every (re)connect so consumers don't go silently deaf.
  socket.on("connect", () => {
    for (const id of roomCounts.keys()) socket?.emit("room:join", id);
  });

  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
  socketToken = null;
  roomCounts.clear();
}

// Namespaced accessor for consumers that prefer object-style imports.
export const socketClient = { getSocket };
