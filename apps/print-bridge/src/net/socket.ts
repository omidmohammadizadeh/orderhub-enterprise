// WebSocket subscriber. Listens for printer:job:created so we can
// claim immediately instead of waiting for the 5s polling loop.
// HTTP polling stays on as a fallback if the socket disconnects.

import { io, Socket } from "socket.io-client";
import type { Config } from "../config/config";

export class JobSocket {
  private socket?: Socket;
  private onNewJob: () => void = () => {};

  constructor(private readonly cfg: Config) {}

  connect(onNewJob: () => void) {
    this.onNewJob = onNewJob;
    const url = this.cfg.apiUrl.replace(/\/api\/v1$/, "");
    this.socket = io(url, {
      auth: {
        agentId: this.cfg.agentId,
        agentToken: this.cfg.apiToken,
      },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    this.socket.on("connect", () => {
      console.log("[socket] connected");
      // Best-effort: drain on connect in case we missed events while
      // disconnected.
      this.onNewJob();
    });
    this.socket.on("disconnect", () => console.warn("[socket] disconnected"));
    this.socket.on("printer:job:created", () => this.onNewJob());
  }

  close() {
    this.socket?.close();
  }
}
