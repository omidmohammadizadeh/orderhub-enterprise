"use client";

import { io, Socket } from "socket.io-client";
import type { ServerToClientEvents, ClientToServerEvents } from "@orderhub/shared";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: TypedSocket | null = null;

export function getSocket(token = ""): TypedSocket {
  if (socket?.connected) return socket;

  socket = io(process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000", {
    auth: { token },
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 10,
  }) as TypedSocket;

  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}

// Namespaced accessor for consumers that prefer object-style imports.
export const socketClient = { getSocket };
