// Shared "print this order now" routine — the exact path the order
// detail popup uses, so the order-list printer icon prints identically.
//
// Prints the full receipt straight to every Bluetooth printer at the
// order's location via the native bridge, then clears the order's
// server-side job(s) from the queue. Throws a clear message on failure
// so the caller can surface it.

import { printersClient } from "../api/printers.client";
import {
  hasNativeBridge,
  bridgePrint,
  buildOrderReceipt,
  repeatReceipt,
} from "./bridge";
import { buildPrintPayload } from "./order-receipt";

export async function printOrderViaBridge(order: any): Promise<string> {
  if (!hasNativeBridge()) {
    throw new Error(
      "Native printing only works inside the OrderHub Solutions tablet app.",
    );
  }
  const printers = await printersClient.list(order.locationId);
  const bt = printers.filter(
    (p: any) =>
      p.locationId === order.locationId &&
      p.connectionType === "BLUETOOTH" &&
      p.ipAddress &&
      p.isActive !== false,
  );
  if (bt.length === 0) {
    throw new Error(
      "No Bluetooth printer configured for this location. Add one in Printers.",
    );
  }
  for (const p of bt) {
    const copies = Math.max(
      1,
      Number((p as any).defaults?.copiesReprint ?? 1) || 1,
    );
    const single = buildOrderReceipt(buildPrintPayload(order), p.paperWidth ?? 80);
    await bridgePrint(p.ipAddress!, repeatReceipt(single, copies));
  }
  // Clear this order's job(s) from the queue + bump "last print".
  void printersClient.markOrderPrinted(order.id);
  return bt.length === 1 ? "Printed" : `Printed to ${bt.length} printers`;
}
