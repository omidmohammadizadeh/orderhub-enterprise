import { Injectable } from "@nestjs/common";
import type { IPrinterBridge } from "./printer-bridge.interface";
import { LanBridge } from "./lan-bridge";
import { BrowserBridge } from "./browser-bridge";

@Injectable()
export class PrinterBridgeFactory {
  private readonly bridges: Map<string, IPrinterBridge> = new Map([
    ["LAN", new LanBridge()],
    ["EPSON_EPOS", new LanBridge()],   // ePOS uses same TCP path; URL differs
    ["STAR", new LanBridge()],          // StarPRNT TCP mode
    ["BLUETOOTH", new BrowserBridge()], // relay via browser/Flutter agent
    ["USB", new BrowserBridge()],       // relay via browser Web USB
    ["CLOUD", new BrowserBridge()],     // cloud relay
  ]);

  get(connectionType: string): IPrinterBridge {
    return this.bridges.get(connectionType) ?? this.bridges.get("LAN")!;
  }
}
