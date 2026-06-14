// LAN transport — raw TCP to port 9100 (or whatever the printer
// expects). Works with Epson TM-m30, Star TSP100/143, generic 80mm
// ESC/POS printers.

import * as net from "net";
import type { ConfiguredPrinter } from "../config/config";
import type { Transport } from "./index";

const SOCKET_TIMEOUT_MS = 8_000;

export class LanTransport implements Transport {
  send(buf: Buffer, printer: ConfiguredPrinter): Promise<void> {
    if (!printer.host) {
      return Promise.reject(new Error("LAN printer missing host"));
    }
    const host = printer.host;
    const port = printer.port ?? 9100;
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      socket.setTimeout(SOCKET_TIMEOUT_MS);
      socket.connect(port, host, () => {
        socket.write(buf, (err) => {
          if (err) {
            socket.destroy();
            reject(err);
            return;
          }
          setTimeout(() => {
            socket.end();
            resolve();
          }, 300);
        });
      });
      socket.on("error", (err) => {
        socket.destroy();
        reject(err);
      });
      socket.on("timeout", () => {
        socket.destroy();
        reject(new Error("printer connect/write timeout"));
      });
    });
  }
}
