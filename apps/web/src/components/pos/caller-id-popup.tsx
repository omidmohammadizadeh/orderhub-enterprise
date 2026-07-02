"use client";

// Landline caller-ID popup (Phase BB).
//
// The caller-ID hub tablet (CTI Comet USB reader on the shop's analogue
// line) POSTs /v1/customers/caller-id/ring when the phone rings; the API
// matches the number against past orders and broadcasts "callerid:ring" to
// the location's room. Every POS tablet shows this card: known callers get
// their name + previous addresses to tap straight into a new order.

import { useEffect, useState } from "react";
import { Phone, X } from "lucide-react";
import type { CallerIdRingPayload } from "@orderhub/shared";
import { getSocket } from "@/lib/socket/socket.client";
import { useAuthStore } from "@/stores/auth.store";

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

export function fillOrderFromCaller(detail: CallerIdFill) {
  window.dispatchEvent(new CustomEvent("pos:callerid-fill", { detail }));
}

export function CallerIdPopup({ locationId }: { locationId: string | null }) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [ring, setRing] = useState<CallerIdRingPayload | null>(null);

  useEffect(() => {
    if (!locationId || !accessToken) return;
    const socket = getSocket(accessToken);
    socket.emit("room:join", locationId);
    const onRing = (payload: CallerIdRingPayload) => {
      if (payload.locationId !== locationId) return;
      setRing(payload);
    };
    socket.on("callerid:ring", onRing);
    return () => {
      socket.off("callerid:ring", onRing);
    };
  }, [locationId, accessToken]);

  // Auto-dismiss after 60s so a missed call doesn't sit on screen all night.
  useEffect(() => {
    if (!ring) return;
    const t = setTimeout(() => setRing(null), 60_000);
    return () => clearTimeout(t);
  }, [ring]);

  if (!ring) return null;
  const { phone, match } = ring;

  const use = (address: CallerIdFill["address"]) => {
    fillOrderFromCaller({ phone, name: match?.name ?? null, address });
    setRing(null);
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 w-[340px] rounded-xl border border-emerald-200 bg-white shadow-2xl">
      <div className="flex items-center justify-between rounded-t-xl bg-emerald-600 px-4 py-2.5">
        <p className="flex items-center gap-2 text-sm font-bold text-white">
          <Phone className="h-4 w-4 animate-pulse" />
          Incoming call
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
