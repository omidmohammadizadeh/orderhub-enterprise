"use client";

// Incoming-call popup (Phase BB).
//
// A caller-ID source (the Comet USB hub tablet, the Order Hub Caller ID phone
// app, or a VoIP webhook) POSTs the ringing number to the API, which matches it
// against past orders and broadcasts "callerid:ring" to that location's room.
// This card then shows on EVERY dashboard screen (mounted globally in the
// layout) for ANY of the user's locations — known callers get their name +
// previous addresses to tap straight into a new order.

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Phone, X } from "lucide-react";
import type { CallerIdRingPayload } from "@orderhub/shared";
import {
  getSocket,
  joinLocationRoom,
  leaveLocationRoom,
} from "@/lib/socket/socket.client";
import { useAuthStore } from "@/stores/auth.store";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { apiClient } from "@/lib/api/client";

/** Payload the POS cart panel consumes via the "pos:callerid-fill" event. */
export interface CallerIdFill {
  phone: string;
  name: string | null;
  address: {
    line1: string;
    line2: string | null;
    city: string | null;
    postcode: string | null;
  } | null;
}

// A fill stashed here is picked up by the POS cart panel on mount — used when
// the operator taps "Start order" from a NON-POS screen and we navigate to POS.
export const PENDING_FILL_KEY = "pos:pending-callerid-fill";

export function fillOrderFromCaller(detail: CallerIdFill) {
  window.dispatchEvent(new CustomEvent("pos:callerid-fill", { detail }));
}

export function CallerIdPopup({
  locationIds,
  nativeLocationId,
  locationNames,
}: {
  /** Every location room to listen on (the user's accessible locations). */
  locationIds: string[];
  /** The active location the Comet-USB hub tablet forwards rings for. */
  nativeLocationId?: string | null;
  /** id → shop name, so a multi-location operator sees which shop is ringing. */
  locationNames?: Record<string, string>;
}) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const setSelectedLocationId = useSelectedLocationStore(
    (s) => s.setSelectedLocationId,
  );
  const router = useRouter();
  const pathname = usePathname();
  const [ring, setRing] = useState<CallerIdRingPayload | null>(null);

  const roomKey = locationIds.join(",");
  useEffect(() => {
    if (!accessToken || locationIds.length === 0) return;
    const socket = getSocket(accessToken);
    // Refcounted joins — shared with the orders board / alert player, and
    // released on cleanup so switching the selected location doesn't leave
    // this popup listening to every room it has ever joined.
    for (const id of locationIds) joinLocationRoom(socket, id);
    const onRing = (payload: CallerIdRingPayload) => {
      if (!locationIds.includes(payload.locationId)) return;
      setRing(payload);
    };
    socket.on("callerid:ring", onRing);
    return () => {
      socket.off("callerid:ring", onRing);
      for (const id of locationIds) leaveLocationRoom(socket, id);
    };
    // roomKey captures the location set; re-join if it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomKey, accessToken]);

  // Auto-dismiss after 60s so a missed call doesn't sit on screen all night.
  useEffect(() => {
    if (!ring) return;
    const t = setTimeout(() => setRing(null), 60_000);
    return () => clearTimeout(t);
  }, [ring]);

  // Caller-ID HUB role: when this tablet hosts the Comet USB reader, the native
  // shell dispatches "native:callerid" with the ringing number. Forward it to
  // the API (which matches + broadcasts "callerid:ring" back to every tablet).
  useEffect(() => {
    if (!nativeLocationId) return;
    const recent = new Map<string, number>();
    const onNative = (e: Event) => {
      const d = (e as CustomEvent).detail as { phone?: string };
      const phone = d?.phone?.trim();
      if (!phone) return;
      const now = Date.now();
      if (now - (recent.get(phone) ?? 0) < 10_000) return;
      recent.set(phone, now);
      apiClient
        .post("/v1/customers/caller-id/ring", { locationId: nativeLocationId, phone })
        .catch(() => {
          /* best-effort; the next ring retries */
        });
    };
    window.addEventListener("native:callerid", onNative);
    return () => window.removeEventListener("native:callerid", onNative);
  }, [nativeLocationId]);

  if (!ring) return null;
  const { phone, match, locationId: ringLocationId } = ring;
  const shopName =
    locationNames && locationIds.length > 1
      ? locationNames[ringLocationId]
      : undefined;

  const use = (address: CallerIdFill["address"]) => {
    const detail: CallerIdFill = { phone, name: match?.name ?? null, address };
    if (pathname === "/dashboard/pos") {
      // Already on POS — fill the open cart directly.
      fillOrderFromCaller(detail);
    } else {
      // Elsewhere (e.g. the Orders tab) — carry the caller to POS and switch to
      // the ringing shop, then the POS cart panel applies it on mount.
      try {
        sessionStorage.setItem(PENDING_FILL_KEY, JSON.stringify(detail));
      } catch {
        /* ignore */
      }
      setSelectedLocationId(ringLocationId);
      router.push("/dashboard/pos");
    }
    setRing(null);
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 w-[340px] rounded-xl border border-emerald-200 bg-white shadow-2xl">
      <div className="flex items-center justify-between rounded-t-xl bg-emerald-600 px-4 py-2.5">
        <p className="flex items-center gap-2 text-sm font-bold text-white">
          <Phone className="h-4 w-4 animate-pulse" />
          Incoming call{shopName ? ` · ${shopName}` : ""}
        </p>
        <button
          onClick={() => setRing(null)}
          className="text-emerald-100 hover:text-white"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="space-y-2 p-4">
        <p className="text-lg font-bold tracking-wide text-zinc-900">{phone}</p>
        {match ? (
          <>
            <p className="text-sm text-zinc-700">
              <span className="font-semibold">{match.name}</span>{" "}
              <span className="text-zinc-500">
                · {match.orders} previous order{match.orders === 1 ? "" : "s"}
              </span>
            </p>
            {match.addresses.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                  Deliver to
                </p>
                {match.addresses.map((a, i) => (
                  <button
                    key={i}
                    onClick={() => use(a)}
                    className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-left text-xs text-zinc-700 hover:border-emerald-400 hover:bg-emerald-50"
                  >
                    {[a.line1, a.line2, a.city, a.postcode]
                      .filter(Boolean)
                      .join(", ")}
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={() => use(match.addresses[0] ?? null)}
              className="w-full rounded-lg bg-emerald-600 px-3 py-2.5 text-sm font-bold text-white hover:bg-emerald-700"
            >
              Start order for {match.name.split(" ")[0]}
            </button>
          </>
        ) : (
          <>
            <p className="text-sm text-zinc-500">New caller — no order history.</p>
            <button
              onClick={() => use(null)}
              className="w-full rounded-lg bg-emerald-600 px-3 py-2.5 text-sm font-bold text-white hover:bg-emerald-700"
            >
              Start order with this number
            </button>
          </>
        )}
      </div>
    </div>
  );
}
