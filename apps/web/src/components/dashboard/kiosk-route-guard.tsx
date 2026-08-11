"use client";

// Confines a DEVICE account to its one screen.
//
// Some accounts aren't people — a kiosk tablet in the doorway, a display
// bolted to the wall in the kitchen. Each signs in as its own user and should
// reach exactly one page.
//
// The sidebar already hides everything else, but hiding a link is not a
// control — someone could reach /dashboard/orders by typing it, or a stale
// tab could restore after the device reboots. This redirects on every
// navigation, so the only page these accounts can hold is their own.
//
// This is UI confinement, not authorisation: the API still enforces roles per
// endpoint. It exists so a customer standing at a kiosk, or anyone passing
// the kitchen, is never one URL away from takings.

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/auth.store";

/**
 * Device role → the single page it may hold. Shared with the sidebar so the
 * nav and the guard can never disagree about where a device belongs.
 */
export const DEVICE_HOME: Record<string, string> = {
  KIOSK: "/dashboard/kiosk",
  KITCHEN_DISPLAY: "/dashboard/orders/kitchen",
};

/** The one page this account may hold, or undefined for a real person. */
export function deviceHomeFor(role: string | undefined | null) {
  return role ? DEVICE_HOME[role] : undefined;
}

export function KioskRouteGuard() {
  const role = useAuthStore((s) => s.user?.role);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const home = deviceHomeFor(role);
    if (!home) return;
    if (pathname === home) return;
    // replace, not push — a device must not accumulate history someone could
    // walk back through.
    router.replace(home);
  }, [role, pathname, router]);

  return null;
}
