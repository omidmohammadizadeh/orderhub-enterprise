import net from "net";
import type { IPrinterBridge, PrinterBridgeConfig, PrintResult } from "./printer-bridge.interface";

// Star Micronics printer bridge.
// Star printers on LAN accept raw ESC/POS over TCP (port 9100) just like generic LAN printers.
// Star CloudPRNT (polling model) requires a separate cloud relay server — use this bridge
// for LAN-connected Star printers.
export class StarBridge implements IPrinterBridge {
  readonly connectionType = "STAR";
  private readonly DEFAULT_PORT = 9100;
  private readonly TIMEOUT_MS = 6_000;

  async send(rawData: string, config: PrinterBridgeConfig, jobId: string): Promise<PrintResult> {
    const ip = config.ipAddress;
    if (!ip) return { success: false, printerId: "", jobId, error: "No IP address configured" };

    const port = config.port ?? this.DEFAULT_PORT;

    return new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;

      const finish = (result: PrintResult) => {
        if (!settled) {
          settled = true;
          socket.destroy();
          resolve(result);
        }
      };

      socket.setTimeout(this.TIMEOUT_MS);

      socket.connect(port, ip, () => {
        // Star printers support both raw ESC/POS and StarPRNT command sets.
        // Raw ESC/POS works for most Star TM/TSP models without additional configuration.
        socket.write(rawData, "binary", (err) => {
          if (err) {
            finish({ success: false, printerId: "", jobId, error: `Write error: ${err.message}` });
          } else {
            // Small drain wait before closing — Star printers can be slow to buffer
            setTimeout(() => finish({ success: true, printerId: "", jobId }), 300);
          }
        });
      });

      socket.on("error", (err) => finish({ success: false, printerId: "", jobId, error: `Socket error: ${err.message}` }));
      socket.on("timeout", () => finish({ success: false, printerId: "", jobId, error: "Connection timed out" }));
    });
  }

  async isReachable(config: PrinterBridgeConfig): Promise<boolean> {
    if (!config.ipAddress) return false;
    const port = config.port ?? this.DEFAULT_PORT;

    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(2_500);
      socket.connect(port, config.ipAddress!, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
      socket.on("timeout", () => { socket.destroy(); resolve(false); });
    });
  }
}
