import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

// USB receipt printers via Android's USB host API (see
// android/.../UsbPrinterModule.kt). Android only — iOS has no public USB
// API, so `native` is null there and every export reports "unavailable".
// Optional so an older APK without the module never crashes the JS bundle
// an OTA update ships to it.

export type UsbPrinterDevice = {
  deviceName: string;
  vendorId: number;
  productId: number;
  manufacturer: string | null;
  product: string | null;
  isPrinterClass: boolean;
  hasPermission: boolean;
};

type UsbPrinterNativeModule = {
  listDevices(): Promise<UsbPrinterDevice[]>;
  print(vendorId: number, productId: number, base64: string): Promise<{ ok: true }>;
};

const native: UsbPrinterNativeModule | null =
  Platform.OS === "android"
    ? requireOptionalNativeModule<UsbPrinterNativeModule>("UsbPrinter")
    : null;

export function isUsbPrintingAvailable(): boolean {
  return native !== null;
}

export async function listUsbPrinters(): Promise<UsbPrinterDevice[]> {
  if (!native) return [];
  return native.listDevices();
}

export async function printUsb(
  vendorId: number,
  productId: number,
  base64: string,
): Promise<void> {
  if (!native) throw new Error("USB printing isn't available in this app build — please update the app.");
  await native.print(vendorId, productId, base64);
}
