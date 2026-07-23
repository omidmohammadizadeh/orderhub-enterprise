"use client";

// ── LocationSelector ────────────────────────────────────────────────────────
// Dropdown that lets staff pick which location's orders to view. Choice is
// persisted via useSelectedLocationStore (localStorage-backed).
//
// PLATFORM_ADMIN sees an "All locations" option that maps to `null` — the
// API treats absent locationId as "no filter" and uses the user's tenant
// scope as the boundary. Other roles see only their assigned locations.

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { locationsClient } from "../../lib/api/locations.client";
import { useSelectedLocationStore } from "../../stores/selected-location.store";
import { useAuthStore } from "../../stores/auth.store";

interface Props {
  /** Show the "All locations" option (PLATFORM_ADMIN only). */
  allowAll?: boolean;
  className?: string;
}

export function LocationSelector({ allowAll, className }: Props) {
  const role = useAuthStore((s) => s.user?.role);
  const { selectedLocationId, setSelectedLocationId } = useSelectedLocationStore();

  const { data: locations, isLoading } = useQuery({
    queryKey: ["locations", "list"],
    queryFn: () => locationsClient.list(),
    staleTime: 60_000,
  });

  // PLATFORM_ADMIN always allowed to view all; for other roles, hide the option.
  const canViewAll = allowAll && role === "PLATFORM_ADMIN";

  // Pick a default if nothing is selected and the user has locations.
  useEffect(() => {
    if (!locations?.length) return;
    if (selectedLocationId) return;
    const first = locations[0];
    if (!first) return;
    // Default: first location for normal users; null (all) for platform admin.
    setSelectedLocationId(canViewAll ? null : first.id);
  }, [locations, selectedLocationId, canViewAll, setSelectedLocationId]);

  if (isLoading) {
    return (
      <div className={`text-xs text-zinc-400 ${className ?? ""}`}>
        Loading locations…
      </div>
    );
  }

  if (!locations?.length) {
    return (
      <div className={`text-xs text-zinc-400 ${className ?? ""}`}>
        No locations
      </div>
    );
  }

  return (
    <div className={`relative ${className ?? ""}`}>
      <select
        value={selectedLocationId ?? ""}
        onChange={(e) => setSelectedLocationId(e.target.value || null)}
        className="appearance-none rounded-lg border border-zinc-200 bg-white pl-3 pr-8 py-1.5 text-sm font-medium text-zinc-700 hover:border-zinc-300 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
        aria-label="Select location"
      >
        {canViewAll && <option value="">All locations</option>}
        {locations.map((loc) => (
          <option key={loc.id} value={loc.id}>
            {loc.name}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400"
        aria-hidden="true"
      />
    </div>
  );
}
