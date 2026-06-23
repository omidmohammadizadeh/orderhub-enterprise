"use client";

// Mounted once in the dashboard layout so auto-print runs on EVERY page
// (not just one orders view). Renders nothing — the hook does all the
// work in the background.

import { useBridgeAutoPrint } from "../../hooks/use-bridge-auto-print";
import { useSelectedLocationStore } from "../../stores/selected-location.store";

export function AutoPrintRunner() {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  useBridgeAutoPrint(locationId ?? undefined);
  return null;
}
