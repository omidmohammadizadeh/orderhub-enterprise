import { Logger } from "@nestjs/common";
import type { IPrinterBridge, PrinterBridgeConfig, PrintResult } from "./printer-bridge.interface";

// Browser fallback bridge — emits the print job via WebSocket to a connected
// browser tab. The browser tab uses window.print() or a Web USB API.
// This is a relay pattern: the API pushes to a Socket.IO room, and the browser
// agent picks it up and forwards to the local printer.
export class BrowserBridge implements IPrinterBridge {
  readonly connectionType = "BROWSER";
  private readonly logger = new Logger(BrowserBridge.name);

  async send(_rawData: string, _config: PrinterBridgeConfig, jobId: string): Promise<PrintResult> {
    // Concrete implementation: emit to socket room `printer:{printerId}`.
    // The browser agent subscribed to that room will receive and print.
    // TODO: inject SocketService and emit here once browser agent is built.
    this.logger.warn(`BrowserBridge.send called — browser agent not yet connected for job ${jobId}`);
    return { success: false, printerId: "", jobId, error: "Browser agent not connected" };
  }

  async isReachable(_config: PrinterBridgeConfig): Promise<boolean> {
    return false;
  }
}
