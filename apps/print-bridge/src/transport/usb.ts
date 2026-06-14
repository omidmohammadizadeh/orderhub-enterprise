// USB ESC/POS transport.
//
// Uses the `usb` npm package (optional dep, native build) which wraps
// libusb cross-platform. Set printer.usbVendor + printer.usbProduct
// in config from the vendor/product IDs the printer advertises.
//
// Common IDs:
//   Epson TM-m30:   vendor=0x04b8 product=0x0e15
//   Star TSP143:    vendor=0x0519 product=0x0001
//   XPrinter XP-Q… vendor=0x0fe6 product=0x811e
//
// Find yours with `lsusb` (Linux/mac) or Device Manager (Windows).

import type { ConfiguredPrinter } from "../config/config";
import type { Transport } from "./index";

export class UsbTransport implements Transport {
  async send(buf: Buffer, printer: ConfiguredPrinter): Promise<void> {
    let usb: any;
    try {
      usb = require("usb");
    } catch {
      throw new Error(
        "USB not available on this device — install the `usb` npm package or use LAN/Bluetooth transport.",
      );
    }
    if (!printer.usbVendor || !printer.usbProduct) {
      throw new Error("USB printer missing usbVendor/usbProduct");
    }

    const device = usb.findByIds(printer.usbVendor, printer.usbProduct);
    if (!device) {
      throw new Error(
        `USB printer not found (vendor=${printer.usbVendor.toString(16)} product=${printer.usbProduct.toString(16)})`,
      );
    }
    device.open();
    try {
      const iface = device.interfaces[0];
      if (!iface) throw new Error("USB device has no interfaces");
      if (iface.isKernelDriverActive()) iface.detachKernelDriver();
      iface.claim();
      const out = iface.endpoints.find((e: any) => e.direction === "out");
      if (!out) throw new Error("USB device has no OUT endpoint");
      await new Promise<void>((resolve, reject) => {
        out.transfer(buf, (err: any) => (err ? reject(err) : resolve()));
      });
      iface.release();
    } finally {
      device.close();
    }
  }
}
