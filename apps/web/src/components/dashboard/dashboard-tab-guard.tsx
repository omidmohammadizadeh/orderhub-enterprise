"use client";

// Keeps a disabled tab actually closed.
//
// Hiding a sidebar link is not a control — the URL still works, a bookmark
// still opens, and a tab left open overnight still reloads. When a platform
// admin switches Tables off for a dark kitchen, the requirement is that
// nobody at that shop can *use* it, not just that they can't find it. So
// every navigation is checked against the location's disabled list and sent
// back to Orders, which is why Orders is locked in the registry.
//
// Deliberately quiet about it: a redirect with no explanation reads as a
// broken link, so we hand the reason to the Orders page via ?tabDisabled=.
// Nothing renders that yet; it costs nothing and gives the next person a
// thread to pull.
//
// This is UI enforcement, the same class as KioskRouteGuard — the API still
// answers /v1/tables for an authorised role. Locking the endpoints per
// location is a separate job.

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useDashboardTabAccess } from "@/hooks/use-dashboard-tabs";

const FALLBACK = "/dashboard/orders";

export function DashboardTabGuard() {
  const pathname = usePathname();
  const router = useRouter();
  const { isLoading, hiddenTabForPath } = useDashboardTabAccess();

  useEffect(() => {
    // Never redirect on an unanswered query. The list arrives a tick after
    // mount, and bouncing someone off a page they're allowed to be on is a
    // worse failure than a moment of showing it.
    if (isLoading) return;
    if (!pathname) return;
    const hidden = hiddenTabForPath(pathname);
    if (!hidden) return;
    // replace, not push — back would land on the disabled page again.
    router.replace(`${FALLBACK}?tabDisabled=${encodeURIComponent(hidden)}`);
  }, [isLoading, pathname, hiddenTabForPath, router]);

  return null;
}
