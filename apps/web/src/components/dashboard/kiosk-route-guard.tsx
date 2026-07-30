"use client";

// Confines a KIOSK device account to the kiosk screen.
//
// The sidebar already hides everything else, but hiding a link is not a
// control — a customer could reach /dashboard/orders by typing it, or by a
// stale tab restoring after the device reboots. This redirects on every
// navigation, so the only page a kiosk account can hold is its own.
//
// This is UI confinement, not authorisation: the API still enforces roles
// per endpoint. It exists so a customer standing at a screen is never one
// URL away from takings.

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/auth.store";

const KIOSK_HOME = "/dashboard/kiosk";

export function KioskRouteGuard() {
  const role = useAuthStore((s) => s.user?.role);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (role !== "KIOSK") return;
    if (pathname === KIOSK_HOME) return;
    // replace, not push — a kiosk must not accumulate history a customer
    // could walk back through.
    router.replace(KIOSK_HOME);
  }, [role, pathname, router]);

  return null;
}
