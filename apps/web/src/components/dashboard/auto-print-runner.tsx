"use client";

// Mounted once in the dashboard layout so the background automations run
// on EVERY page (not just one orders view). Renders nothing.
//   • Auto-print — prints new orders over Bluetooth (tablet only)
//   • Auto-accept — accepts new PENDING orders via the same call the
//     manual Accept button uses (any device, any channel)
//   • Booking alerts — chime + toast + paper chit when an online table
//     booking lands, so it doesn't sit unseen in the diary

import { useBridgeAutoPrint } from "../../hooks/use-bridge-auto-print";
import { useAutoAccept } from "../../hooks/use-auto-accept";
import { useBookingAlerts } from "../../hooks/use-booking-alerts";
import { useSelectedLocationStore } from "../../stores/selected-location.store";

export function AutoPrintRunner() {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  useBridgeAutoPrint(locationId ?? undefined);
  useAutoAccept(locationId ?? undefined);
  useBookingAlerts(locationId ?? undefined);
  return null;
}
