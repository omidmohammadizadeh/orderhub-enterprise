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
    queryKey: ["locations", "list"], // canonical shared locations cache (was a private duplicate)
    queryFn: () => locationsClient.list(),
    enabled: !!accessToken,
    staleTime: 5 * 60_000,
  });

  const allIds = (locations ?? []).map((l) => l.id);
  // Scope popups to the location the operator has selected in the switcher, so
  // an admin working one shop doesn't get caller-ID popups for every other shop.
  // "All locations" (selectedLocationId === null) listens on every accessible
  // location — useful on the all-locations Orders board.
  const ids = selectedLocationId ? [selectedLocationId] : allIds;
  if (ids.length === 0) return null;

  const names: Record<string, string> = {};
  for (const l of locations ?? []) names[l.id] = l.name;

  // Which location a NATIVE ring (the Comet USB box on this tablet) is posted
  // against. This used to be `selectedLocationId` alone, which meant a hub
  // tablet left on "All locations" read the number off the box and then threw
  // it away — CallerIdPopup bails when nativeLocationId is null, so no tablet
  // ever popped and nothing was logged. Single-site shops (who are most of
  // the Comet users) hit that by simply not touching the location switcher.
  //
  // Fall back to the only location when there is exactly one. With several
  // locations on "All locations" we genuinely cannot tell which shop's
  // landline rang, so the popup warns instead of failing silently.
  const nativeLocationId =
    selectedLocationId ?? (allIds.length === 1 ? allIds[0]! : null);

  return (
    <CallerIdPopup
      locationIds={ids}
      nativeLocationId={nativeLocationId}
      locationNames={names}
    />
  );
}
