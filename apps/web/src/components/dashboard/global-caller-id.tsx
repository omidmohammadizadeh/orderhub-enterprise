"use client";

// Mounts the incoming-call popup ONCE for the whole dashboard (in the layout),
// so it shows on every screen — the Orders tab, POS, anywhere — not just POS.
//
// It listens on the SELECTED location only. A caller-ID box belongs to one
// shop and the person who answers it is stood in that shop, so a ring from
// another site is noise nobody can act on.

import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { locationsClient } from "@/lib/api/locations.client";
import { useAuthStore } from "@/stores/auth.store";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { CallerIdPopup } from "@/components/pos/caller-id-popup";

export function GlobalCallerIdPopup() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const role = useAuthStore((s) => s.user?.role);
  const pathname = usePathname();
  const selectedLocationId = useSelectedLocationStore(
    (s) => s.selectedLocationId,
  );

  // Never on the kiosk. That screen faces the customer queue, unattended —
  // a ringing landline is for staff to answer, and putting a stranger's name
  // and number in front of whoever is stood at the screen is both useless to
  // them and a leak of somebody else's details. Gated on the route as well as
  // the role so it also stays away when staff open the kiosk on a shared
  // tablet. Every other screen is unaffected.
  const isKiosk = role === "KIOSK" || pathname?.startsWith("/dashboard/kiosk");

  const { data: locations } = useQuery({
    queryKey: ["locations", "list"], // canonical shared locations cache (was a private duplicate)
    queryFn: () => locationsClient.list(),
    enabled: !!accessToken,
    staleTime: 5 * 60_000,
  });

  const allIds = (locations ?? []).map((l) => l.id);

  // A ring is only actionable at the shop whose phone rang. The caller-ID box
  // is physically plugged in at ONE location, and whoever answers it is stood
  // in that shop — so the popup follows the location switcher.
  //
  // "All locations" used to subscribe to EVERY accessible room, which meant an
  // admin (who can see every site) got a popup for every landline on the
  // estate, for calls they were never going to answer. At this tenant's size
  // that is constant interruption; at 150 sites it would be unusable.
  //
  // The single-site case is the one to protect: most caller-ID users have one
  // shop and never touch the switcher, so "All locations" is their normal
  // state. With exactly one accessible location that location still rings.
  // With several and no choice made, nothing rings — pick a shop to answer its
  // phone.
  if (isKiosk) return null;

  const ids = selectedLocationId
    ? [selectedLocationId]
    : allIds.length === 1
      ? allIds
      : [];
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
