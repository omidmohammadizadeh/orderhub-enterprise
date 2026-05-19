import { Injectable } from "@nestjs/common";
import type { IPrinterBridge } from "./printer-bridge.interface";
import { LanBridge } from "./lan-bridge";
import { BrowserBridge } from "./browser-bridge";
import { EpsonEposBridge } from "./epson-epos-bridge";
import { StarBridge } from "./star-bridge";

@Injectable()
export class PrinterBridgeFactory {
  private readonly bridges: Map<string, IPrinterBridge> = new Map<string, IPrinterBridge>([
    ["LAN", new LanBridge()],
    ["EPSON_EPOS", new EpsonEposBridge()],  // Epson ePOS SDK over HTTP
    ["STAR", new StarBridge()],              // Star Micronics raw TCP
    ["BLUETOOTH", new BrowserBridge()],      // relay via browser/Flutter agent
    ["USB", new BrowserBridge()],            // relay via browser Web USB
    ["CLOUD", new BrowserBridge()],          // cloud relay
  ]);

  get(connectionType: string): IPrinterBridge {
    return this.bridges.get(connectionType) ?? this.bridges.get("LAN")!;
  }
}
