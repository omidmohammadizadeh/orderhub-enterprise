"use client";

// ── Which sidebar tabs this user may see right now ──────────────────────────
//
// A platform admin can switch tabs off for a single location (Admin Dashboard
// → Dashboard access). The rule is deliberately blunt: a tab disabled for a
// location is gone for EVERY user of that location, owner included. Roles
// still narrow on top — this only ever subtracts.
//
// Reads the locations list the sidebar and AccessGate already hold, so no
// dashboard page pays an extra request for it.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  disabledTabsFromSettings,
  dashboardTabForPath,
} from "@orderhub/shared";
import { locationsClient } from "@/lib/api/locations.client";
import { queryKeys } from "@/lib/api/query-keys";
import { useAuthStore } from "@/stores/auth.store";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { deviceHomeFor } from "@/components/dashboard/kiosk-route-guard";

export interface DashboardTabAccess {
  /** Tab keys hidden for the current scope. */
  disabled: Set<string>;
  /** True until we know — callers must not redirect before this clears. */
  isLoading: boolean;
  /** True when nothing is being hidden from this user at all. */
  unrestricted: boolean;
  isHidden: (key: string | undefined | null) => boolean;
  /** The tab that owns a path, if that path is hidden. */
  hiddenTabForPath: (pathname: string) => string | undefined;
}

const NOTHING_HIDDEN: Set<string> = new Set();

export function useDashboardTabAccess(): DashboardTabAccess {
  const role = useAuthStore((s) => s.user?.role);
  const selectedLocationId = useSelectedLocationStore(
    (s) => s.selectedLocationId,
  );

  // Two exemptions, both to avoid locking someone out of the very screen that
  // undoes the lock:
  //   • PLATFORM_ADMIN — us. The admin who switches Locations off for a shop
  //     still has to be able to reach Locations, and Dashboard access itself.
  //   • Device accounts (kiosk tablet, kitchen screen) — KioskRouteGuard
  //     already pins them to exactly one page and redirects them back to it.
  //     Hiding that page would put the two guards in a redirect loop, so a
  //     device is confined by its own rule and not this one.
  const exempt = role === "PLATFORM_ADMIN" || !!deviceHomeFor(role);

  const locationsQuery = useQuery({
    queryKey: queryKeys.locations,
    queryFn: () => locationsClient.list(),
    enabled: !exempt && !!role,
    staleTime: 60_000,
  });

  const locations = locationsQuery.data;

  const disabled = useMemo(() => {
    if (exempt || !locations?.length) return NOTHING_HIDDEN;

    if (selectedLocationId) {
      const loc = locations.find((l) => l.id === selectedLocationId);
      // An id we can't resolve (stale localStorage, a location that was
      // removed) hides nothing. Guessing a restriction here would blank the
      // sidebar of someone who simply hasn't re-picked a shop yet.
      if (!loc) return NOTHING_HIDDEN;
      return new Set(disabledTabsFromSettings(loc.settings));
    }

    // "All locations": hide a tab only when it's off at EVERY location the
    // user can reach. Anything else would let one dark kitchen strip Tables
    // out of a combined view that also covers three restaurants.
    const sets = locations.map((l) => disabledTabsFromSettings(l.settings));
    const [first, ...rest] = sets;
    if (!first?.length) return NOTHING_HIDDEN;
    return new Set(first.filter((key) => rest.every((s) => s.includes(key))));
  }, [exempt, locations, selectedLocationId]);

  return useMemo(
    () => ({
      disabled,
      // Exempt users are never "loading" — they're never restricted, so a
      // guard waiting on this would stall the page for nothing.
      isLoading: !exempt && locationsQuery.isPending,
      unrestricted: disabled.size === 0,
      isHidden: (key) => !!key && disabled.has(key),
      hiddenTabForPath: (pathname: string) => {
        if (!disabled.size) return undefined;
        const tab = dashboardTabForPath(pathname);
        return tab && disabled.has(tab.key) ? tab.key : undefined;
      },
    }),
    [disabled, exempt, locationsQuery.isPending],
  );
}
