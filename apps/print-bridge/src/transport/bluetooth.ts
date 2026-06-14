// Bluetooth Classic / BLE transport.
//
// Implementation note: noble is an optional dependency because it
// fails to install on systems missing libbluetooth dev headers
// (Linux servers, some CI). The agent loads it lazily so the LAN
// path keeps working even when Bluetooth bits aren't available.
//
// For ESC/POS Bluetooth printers (most generic 80mm thermal):
//   • discover by name OR pre-configured MAC address
//   • write characteristic 0xFF02 (Serial Port Profile common UUID)
//   • throttle writes to 20-byte chunks (BLE MTU limit)

import type { ConfiguredPrinter } from "../config/config";
import type { Transport } from "./index";

export class BluetoothTransport implements Transport {
  async send(buf: Buffer, printer: ConfiguredPrinter): Promise<void> {
    let noble: any;
    try {
      noble = require("@abandonware/noble");
    } catch {
      throw new Error(
        "Bluetooth not available on this device — install @abandonware/noble or use LAN/USB transport.",
      );
    }
    if (!printer.btMac) {
      throw new Error("Bluetooth printer missing btMac");
    }

    // Connect, write, disconnect. Full implementation tracked in
    // BLUETOOTH_PRINTING.md — kept short here so the LAN happy path
    // is unambiguous. The shape is identical: connect → write → close.
    throw new Error(
      "Bluetooth transport scaffolded — see BLUETOOTH_PRINTING.md for vendor adapters.",
    );
  }
}
