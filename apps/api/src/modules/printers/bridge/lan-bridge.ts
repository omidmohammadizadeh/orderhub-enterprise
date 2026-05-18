import * as net from "net";
import { Logger } from "@nestjs/common";
import type { IPrinterBridge, PrinterBridgeConfig, PrintResult } from "./printer-bridge.interface";

const DEFAULT_PORT = 9100;
const TIMEOUT_MS = 5000;

// LAN/TCP bridge — sends raw ESC/POS data to thermal printers via TCP.
// Works with Epson, Star, Bixolon, and most network-connected kitchen printers.
export class LanBridge implements IPrinterBridge {
  readonly connectionType = "LAN";
  private readonly logger = new Logger(LanBridge.name);

  async send(rawData: string, config: PrinterBridgeConfig, jobId: string): Promise<PrintResult> {
    const host = config.ipAddress;
    const port = config.port ?? DEFAULT_PORT;

    if (!host) {
      return { success: false, printerId: "", jobId, error: "No IP address configured" };
    }

    return new Promise((resolve) => {
      const socket = new net.Socket();
      let resolved = false;

      const done = (result: PrintResult) => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
          resolve(result);
        }
      };

      socket.setTimeout(TIMEOUT_MS);

      socket.on("connect", () => {
        socket.write(Buffer.from(rawData, "binary"), (err) => {
          if (err) {
            done({ success: false, printerId: "", jobId, error: err.message });
          } else {
            done({ success: true, printerId: "", jobId, sentAt: new Date() });
          }
        });
      });

      socket.on("error", (err) => {
        this.logger.warn(`LAN printer ${host}:${port} error: ${err.message}`);
        done({ success: false, printerId: "", jobId, error: err.message });
      });

      socket.on("timeout", () => {
        this.logger.warn(`LAN printer ${host}:${port} timeout`);
        done({ success: false, printerId: "", jobId, error: "Connection timeout" });
      });

      socket.connect(port, host);
    });
  }

  async isReachable(config: PrinterBridgeConfig): Promise<boolean> {
    const result = await this.send("", config, "ping");
    return result.success;
  }
}
