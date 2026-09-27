"use client";

// Retail R3 — Picking (shops only).
//
// The shop's equivalent of the kitchen screen: online orders waiting to be
// picked, then being picked, then picked and waiting for the courier. Polled
// rather than socket-driven — a new grocery order is not a two-minute burger,
// and a steady 10s poll can never get stuck the way a missed socket event can.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Clock, Loader2, PackageCheck, ShoppingBasket } from "lucide-react";
import { useCurrency } from "@/hooks/use-currency";
import { locationsClient } from "@/lib/api/locations.client";
import { queryKeys } from "@/lib/api/query-keys";
import { retailClient, type PickOrder } from "@/lib/api/retail.client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { isShopType } from "@/components/locations/business-type-picker";
import { PickOrderView } from "@/components/retail/pick-order-view";

const GROUPS: Array<{ key: string; label: string; statuses: string[] }> = [
  { key: "todo", label: "To pick", statuses: ["ACCEPTED"] },
  { key: "doing", label: "Picking", statuses: ["PREPARING"] },
  { key: "ready", label: "Ready", statuses: ["READY"] },
];

export default function PickingPage() {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const { money } = useCurrency();
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);

  const location = useQuery({
    queryKey: queryKeys.locationDetail(locationId ?? ""),
    queryFn: () => locationsClient.get(locationId!),
    enabled: !!locationId,
    staleTime: 60_000,
  });
  const isShop = isShopType(location.data?.businessType);

  const list = useQuery({
    queryKey: ["retail-picking", locationId],
    queryFn: () => retailClient.pickList(locationId!),
    enabled: !!locationId && isShop,
    refetchInterval: 10_000,
  });
  const index = useQuery({
    queryKey: ["retail-barcodes", locationId],
    queryFn: () => retailClient.barcodes(locationId!),
    enabled: !!locationId && isShop,
    staleTime: 5 * 60_000,
  });

  const orders = list.data?.orders ?? [];
  const open = orders.find((o) => o.id === openId) ?? null;
  // An order that has left the list (collected, dispatched) closes itself.
  useEffect(() => {
    if (openId && list.data && !open) setOpenId(null);
  }, [openId, list.data, open]);

  const start = useMutation({
    mutationFn: (id: string) => retailClient.startPicking(id),
    onSuccess: (_r, id) => {
      setOpenId(id);
      void qc.invalidateQueries({ queryKey: ["retail-picking", locationId] });
    },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? "Couldn't start picking"),
  });

  const grouped = useMemo(
    () => GROUPS.map((g) => ({ ...g, orders: orders.filter((o) => g.statuses.includes(o.status)) })),
    [orders],
  );

  if (!locationId) {
    return <div className="grid h-full place-items-center p-8 text-sm text-zinc-500">Select a location.</div>;
  }
  if (location.data && !isShop) {
    return (
      <div className="mx-auto max-w-md p-8 text-center text-sm text-zinc-600">
        Picking is for shops. Restaurants use the{" "}
        <Link href="/dashboard/orders/kitchen" className="font-medium text-orange-600 hover:underline">
          Kitchen Display
        </Link>
        .
      </div>
    );
  }

  return (
    <div className="grid h-[calc(100vh-4rem)] grid-cols-1 gap-4 p-4 sm:p-6 lg:grid-cols-[20rem_1fr]">
      <aside className={`flex flex-col gap-4 overflow-y-auto ${open ? "hidden lg:flex" : ""}`}>
        <header>
          <h1 className="text-base font-semibold text-zinc-900">Picking</h1>
          <p className="mt-0.5 text-xs text-zinc-500">Online orders for this shop, picked aisle by aisle.</p>
        </header>
        {list.isLoading ? (
          <Loader2 className="mx-auto mt-10 h-5 w-5 animate-spin text-zinc-400" />
        ) : orders.length === 0 ? (
          <div className="mt-6 rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500">
            <ShoppingBasket className="mx-auto mb-2 h-6 w-6 text-zinc-400" />
            No online orders to pick right now.
          </div>
        ) : (
          grouped.map((g) =>
            g.orders.length ? (
              <section key={g.key}>
                <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                  {g.label} · {g.orders.length}
                </h2>
                <ul className="space-y-2">
                  {g.orders.map((o) => (
                    <OrderCard
                      key={o.id}
                      order={o}
                      active={o.id === openId}
                      busy={start.isPending && start.variables === o.id}
                      onOpen={() => (o.status === "ACCEPTED" ? start.mutate(o.id) : setOpenId(o.id))}
                    />
                  ))}
                </ul>
              </section>
            ) : null,
          )
        )}
      </aside>

      <main className={`min-h-0 rounded-xl border border-zinc-200 bg-zinc-50 p-4 ${open ? "" : "hidden lg:block"}`}>
        {open ? (
          <PickOrderView
            key={open.id}
            order={open}
            locationId={locationId}
            index={index.data ?? []}
            money={money}
            onBack={() => setOpenId(null)}
          />
        ) : (
          <div className="grid h-full place-items-center text-sm text-zinc-500">
            <p className="flex items-center gap-2">
              <PackageCheck className="h-4 w-4" /> Choose an order to start picking.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

function OrderCard({
  order,
  active,
  busy,
  onOpen,
}: {
  order: PickOrder;
  active: boolean;
  busy: boolean;
  onOpen: () => void;
}) {
  const units = order.lines.reduce((s, l) => s + l.quantity, 0);
  const found = order.lines.reduce((s, l) => s + (l.pick?.picked ?? 0) + (l.pick?.sub?.qty ?? 0), 0);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        disabled={busy}
        className={`w-full rounded-lg border bg-white p-3 text-left transition ${
          active ? "border-zinc-900 ring-1 ring-zinc-900" : "border-zinc-200 hover:border-zinc-400"
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-zinc-900">
            #{order.orderNumber ?? order.displayId ?? order.id.slice(-6)}
          </p>
          <span className="text-[11px] text-zinc-500">
            {order.fulfillmentType === "PICKUP" ? "Collection" : "Delivery"}
          </span>
        </div>
        <p className="truncate text-xs text-zinc-600">{order.customerName || "Customer"}</p>
        <div className="mt-1 flex items-center justify-between text-[11px] text-zinc-500">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {order.scheduledFor
              ? new Date(order.scheduledFor).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })
              : "ASAP"}
          </span>
          <span className="tabular-nums">
            {order.status === "ACCEPTED" ? `${units} items` : `${found}/${units}`}
          </span>
        </div>
      </button>
    </li>
  );
}
