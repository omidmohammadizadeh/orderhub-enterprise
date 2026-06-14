// Transport adapter contract. Each runtime (LAN / Bluetooth / USB)
// implements `send(buf, printerCfg)` and the agent loop doesn't care
// which it is.

import type { ConfiguredPrinter } from "../config/config";
import { LanTransport } from "./lan";
import { BluetoothTransport } from "./bluetooth";
import { UsbTransport } from "./usb";

export interface Transport {
  send(buf: Buffer, printer: ConfiguredPrinter): Promise<void>;
}

export function pickTransport(printer: ConfiguredPrinter): Transport {
  switch (printer.transport) {
    case "lan":
      return new LanTransport();
    case "bluetooth":
      return new BluetoothTransport();
    case "usb":
      return new UsbTransport();
    default:
      throw new Error(`unsupported transport: ${printer.transport}`);
  }
}
