"use client";

// Mounted once in the dashboard layout so auto-print runs on EVERY page
// (not just one orders view). Renders a tiny status chip, but only when
// running inside the native tablet app — invisible in a normal browser.

import { useBridgeAutoPrint } from "../../hooks/use-bridge-auto-print";
import { useSelectedLocationStore } from "../../stores/selected-location.store";

export function AutoPrintRunner() {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const status = useBridgeAutoPrint(locationId ?? undefined);

  if (!status.inApp) return null;

  const armed = status.armedPrinters > 0;
  return (
    <div
      className={`fixed bottom-2 left-2 z-50 rounded-full border px-2.5 py-1 text-[11px] font-semibold shadow-sm ${
        armed
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "border-amber-200 bg-amber-50 text-amber-700"
      }`}
      title={status.lastMessage ?? ""}
    >
      🖨 {armed ? `Auto-print ON · ${status.armedPrinters}` : "Auto-print OFF"}
      {status.lastMessage ? ` · ${status.lastMessage}` : ""}
    </div>
  );
}
