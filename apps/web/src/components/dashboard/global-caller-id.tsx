"use client";

// Mounts the incoming-call popup ONCE for the whole dashboard (in the layout),
// so it shows on every screen — the Orders tab, POS, anywhere — not just POS.
// It listens on ALL of the user's accessible locations, so any shop's call
// pops even on the all-locations Orders board.

import { useQuery } from "@tanstack/react-query";
import { locationsClient } from "@/lib/api/locations.client";
import { useAuthStore } from "@/stores/auth.store";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { CallerIdPopup } from "@/components/pos/caller-id-popup";

export function GlobalCallerIdPopup() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const selectedLocationId = useSelectedLocationStore(
    (s) => s.selectedLocationId,
  );

  const { data: locations } = useQuery({
    queryKey: ["locations", "caller-id-rooms"],
    queryFn: () => locationsClient.list(),
    enabled: !!accessToken,
    staleTime: 5 * 60_000,
  });

  const ids = (locations ?? []).map((l) => l.id);
  if (ids.length === 0) return null;

  const names: Record<string, string> = {};
  for (const l of locations ?? []) names[l.id] = l.name;

  return (
    <CallerIdPopup
      locationIds={ids}
      nativeLocationId={selectedLocationId}
      locationNames={names}
    />
  );
}
