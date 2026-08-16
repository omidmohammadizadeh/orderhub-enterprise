"use client";

// Kiosk — a self-service till.
//
// This is the POS, narrowed to what a customer can safely do on their own:
// always walk-in collection, no customer details, and only two ways to pay.
// It is NOT a separate ordering system — it fetches the same menu
// (getActiveMenuForLocation) and posts to the same POST /v1/orders as the
// till, so a kiosk order is indistinguishable downstream: Orders board,
// KDS, print, walk-in reporting.
//
// The device signs in as a user with the KIOSK role, which can reach this
// page and nothing else. Access is revoked by disabling that account.
//
// Design constraints that differ from the till: the person is standing,
// unaided, possibly with a queue behind them. Large targets, no chrome to
// get lost in, and the screen returns itself to a clean state so an
// abandoned basket never becomes the next customer's order.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Loader2, Minus, Plus, ShoppingBag, Trash2 } from "lucide-react";
import {
  buildCartItemName,
  calculateCartItem,
  round2,
  type SelectedModifier,
  toOrderLineModifier,
} from "@orderhub/shared";
import { ModifierSelectionModal } from "@/components/pos/modifier-selection-modal";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { menusClient, type MenuItem } from "@/lib/api/menus.client";
import { modifierGroupsClient } from "@/lib/api/catalog.client";
import { apiClient } from "@/lib/api/client";
import { ChargeReaderModal } from "@/components/pos/charge-reader-modal";
import { formatDisplayPrice } from "@/lib/menu/display-price";

interface Line {
  key: string;
  menuItemId: string;
  displayName: string;
  unitPrice: number;
  quantity: number;
  modifiers: SelectedModifier[];
  notes?: string;
}

const money = (n: number) => `£${Number(n ?? 0).toFixed(2)}`;

// An untouched basket clears itself. Someone who walks off mid-order must
// not leave their food on screen for the next person to pay for.
const IDLE_RESET_MS = 90_000;

export default function KioskPage() {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);

  const menuQuery = useQuery({
    queryKey: ["kiosk-menu", locationId],
    queryFn: () => menusClient.getActiveMenuForLocation(locationId!),
    enabled: !!locationId,
    // A kiosk runs unattended all day; it has to pick up 86'd items and
    // price changes without anyone touching it.
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const menu = menuQuery.data as any;
  const brandId = menu?.brandId as string | undefined;

  const groupsQuery = useQuery({
    queryKey: ["kiosk-groups", brandId],
    queryFn: () => modifierGroupsClient.list(brandId!),
    enabled: !!brandId,
  });
  // Brand catalogue plus the groups this menu's sizes actually reference —
  // the latter can belong to another brand, which the brand query misses.
  // Same fix as POS; both feed the identical ModifierSelectionModal.
  const allGroups = useMemo(() => {
    const brandGroups = (groupsQuery.data ?? []) as any[];
    const skuGroups = (menu?.skuModifierGroups ?? []) as any[];
    // Phase BN — groups a chosen option opens. Same merge, same reason as the
    // per-size groups: unreachable from the item's own links.
    const nestedGroups = (menu?.nestedModifierGroups ?? []) as any[];
    if (skuGroups.length === 0 && nestedGroups.length === 0) return brandGroups;
    const byId = new Map<string, any>();
    for (const g of brandGroups) byId.set(g.id, g);
    for (const g of [...skuGroups, ...nestedGroups]) {
      if (!byId.has(g.id)) byId.set(g.id, g);
    }
    return Array.from(byId.values());
  }, [groupsQuery.data, menu]);

  const categories: any[] = menu?.categories ?? [];
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const currentCat =
    categories.find((c) => c.id === activeCat) ?? categories[0] ?? null;

  const [cart, setCart] = useState<Line[]>([]);
  const [modalItem, setModalItem] = useState<MenuItem | null>(null);
  const [basketOpen, setBasketOpen] = useState(false);
  const [done, setDone] = useState<{
    displayId: string | null;
    total: number;
    paid: "CARD" | "COUNTER";
  } | null>(null);

  // Latch against a double-tap on a touchscreen: React state lags a fast
  // second touch by a frame.
  const placingRef = useRef(false);
  // A card order sitting unpaid, waiting on the reader.
  const [pendingCard, setPendingCard] = useState<{
    orderId: string;
    displayId: string | null;
    amount: number;
  } | null>(null);

  const subtotal = round2(
    cart.reduce((s, l) => s + l.unitPrice * l.quantity, 0),
  );
  const count = cart.reduce((s, l) => s + l.quantity, 0);

  const reset = useCallback(() => {
    setCart([]);
    setBasketOpen(false);
    setDone(null);
    setActiveCat(null);
  }, []);

  useEffect(() => {
    if (!cart.length || done) return;
    let t = setTimeout(reset, IDLE_RESET_MS);
    const bump = () => {
      clearTimeout(t);
      t = setTimeout(reset, IDLE_RESET_MS);
    };
    window.addEventListener("pointerdown", bump);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", bump);
    };
  }, [cart.length, done, reset]);

  useEffect(() => {
    if (!done) return;
    const t = setTimeout(reset, 12_000);
    return () => clearTimeout(t);
  }, [done, reset]);

  const addLine = (l: Omit<Line, "key">) =>
    setCart((prev) => [
      ...prev,
      { ...l, key: `${l.menuItemId}-${Date.now()}-${prev.length}` },
    ]);

  const onItemTap = (item: any) => {
    const hasMods = (item.modifierGroupLinks?.length ?? 0) > 0;
    if (hasMods || item.hasMultipleSkus) {
      setModalItem(item);
      return;
    }
    const b = calculateCartItem({
      basePrice: Number(item.basePrice ?? 0),
      modifiers: [],
      quantity: 1,
    });
    addLine({
      menuItemId: item.id,
      displayName: buildCartItemName({
        productName: item.name,
        modifiers: [],
        note: null,
      }),
      unitPrice: b.unitPrice,
      quantity: 1,
      modifiers: [],
    });
  };

  const place = useMutation({
    mutationFn: async (payment: "CARD" | "COUNTER") => {
      const body: Record<string, any> = {
        locationId: locationId!,
        ...(brandId ? { brandId } : {}),
        orderSource: "POS" as const,
        fulfillmentType: "PICKUP" as const,
        // Counter trade — this is what the walk-in report counts.
        isWalkIn: true,
        customerInfo: { name: "Kiosk" },
        items: cart.map((l) => ({
          name: l.displayName,
          quantity: l.quantity,
          // unitPrice ALREADY includes modifiers (calculateCartItem), so a
          // line is unitPrice × quantity. Adding them again is exactly what
          // overcharged the online storefront.
          unitPrice: l.unitPrice,
          totalPrice: round2(l.unitPrice * l.quantity),
          modifiers: l.modifiers.map((m) => ({
            ...toOrderLineModifier(m),
            quantity: 1,
          })),
          notes: l.notes,
          // Load-bearing: KDS station routing matches on menuItemId.
          menuItemId: l.menuItemId,
        })),
        subtotal,
        total: subtotal,
        // PAY AT COUNTER  → CASH/PENDING: goes to the kitchen now, staff
        //                    take the money when the customer collects.
        // PAY BY CARD      → CARD/PENDING: the server treats an unpaid card
        //                    order as "waiting for payment" and holds it OFF
        //                    the board, the KDS and the printer until it
        //                    settles (isUnpaidCard in orders.service). The
        //                    reader is opened next; the kitchen only sees it
        //                    once the payment succeeds.
        //                    Sending CASH here — as this first did — put
        //                    unpaid food in front of the kitchen.
        // CARD_TERMINAL, not "CARD": the DTO enum is
        // CASH | CARD_TERMINAL | ONLINE_CARD | PAYMENT_LINK | QR_CODE |
        // EXTERNAL, and sending "CARD" was rejected with a 400 before the
        // order was even created. The service maps CARD_TERMINAL onto the
        // unpaid-card hold that keeps it off the kitchen until it settles.
        paymentMethod:
          payment === "CARD" ? ("CARD_TERMINAL" as const) : ("CASH" as const),
        paymentStatus: "PENDING" as const,
        idempotencyKey: `kiosk-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      };
      const res = await apiClient.post("/v1/orders", body);
      const created = res.data as any;
      const orderId = created?.id ?? created?.order?.id;
      // Read the order back for its number rather than guessing at the
      // create response's shape — that guess is why the confirmation showed
      // no number at all, which is the one thing a customer needs to
      // collect. Best-effort: a missing number must not fail a paid order.
      let displayId: string | null =
        created?.displayId ?? created?.orderNumber ?? null;
      if (!displayId && orderId) {
        try {
          const full = (await apiClient.get(`/v1/orders/${orderId}`)).data as any;
          displayId = full?.displayId ?? full?.orderNumber ?? null;
        } catch {
          /* keep going — the order exists either way */
        }
      }
      return { data: created, orderId, displayId, payment };
    },
    onSuccess: ({ orderId, displayId, payment }) => {
      if (payment === "CARD") {
        // Nothing is confirmed yet — take the money first.
        setPendingCard({ orderId, displayId, amount: subtotal });
        return;
      }
      setDone({ displayId, total: subtotal, paid: payment });
      setCart([]);
      setBasketOpen(false);
    },
    onSettled: () => {
      placingRef.current = false;
    },
  });

  const submit = (payment: "CARD" | "COUNTER") => {
    if (placingRef.current || place.isPending || !cart.length) return;
    placingRef.current = true;
    place.mutate(payment);
  };

  // ── Gates ───────────────────────────────────────────────────────────
  if (!locationId) {
    return (
      <Full>
        <p className="text-2xl font-semibold text-zinc-800">
          No location selected
        </p>
        <p className="mt-2 text-zinc-500">
          Please ask a member of staff to set this screen up.
        </p>
      </Full>
    );
  }
  if (menuQuery.isLoading) {
    return (
      <Full>
        <Loader2 className="h-10 w-10 animate-spin text-zinc-400" />
        <p className="mt-4 text-lg text-zinc-500">Just a moment…</p>
      </Full>
    );
  }
  if (menuQuery.isError || !categories.length) {
    return (
      <Full>
        <p className="text-2xl font-semibold text-zinc-800">
          No menu available
        </p>
        <p className="mt-2 max-w-md text-center text-zinc-500">
          Please order at the counter — a member of staff will be happy to
          help.
        </p>
      </Full>
    );
  }

  if (done) {
    return (
      <Full>
        <div className="text-center">
          <div className="mx-auto grid h-24 w-24 place-items-center rounded-full bg-emerald-100 text-5xl">
            ✓
          </div>
          <h1 className="mt-6 text-4xl font-bold text-zinc-900">Order placed</h1>
          {done.displayId && (
            <p className="mt-2 text-6xl font-black tracking-tight text-emerald-700">
              #{done.displayId}
            </p>
          )}
          <p className="mt-6 max-w-md text-xl text-zinc-600">
            Please pay {money(done.total)} at the counter
            {done.paid === "CARD" ? " by card" : ""} and give them your number.
          </p>
          <button
            onClick={reset}
            className="mt-10 rounded-xl bg-zinc-900 px-12 py-6 text-2xl font-semibold text-white"
          >
            Done
          </button>
        </div>
      </Full>
    );
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col bg-zinc-50">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">Order here</h1>
          <p className="text-sm text-zinc-500">
            Tap to add · collect at the counter
          </p>
        </div>
        {cart.length > 0 && (
          <button
            onClick={reset}
            className="rounded-lg border border-zinc-200 px-5 py-3 text-base font-medium text-zinc-500"
          >
            Start again
          </button>
        )}
      </header>

      <div className="flex gap-2 overflow-x-auto border-b border-zinc-200 bg-white px-6 py-3">
        {categories.map((c) => (
          <button
            key={c.id}
            onClick={() => setActiveCat(c.id)}
            className={
              "shrink-0 rounded-full px-6 py-3 text-base font-semibold " +
              (currentCat?.id === c.id
                ? "bg-zinc-900 text-white"
                : "bg-zinc-100 text-zinc-700")
            }
          >
            {c.name}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-6 pb-28">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          {(currentCat?.items ?? []).map((link: any) => {
            const item = link.item ?? link;
            if (item?.isAvailable === false) return null;
            const sold = item?.outOfStock === true;
            return (
              <button
                key={item.id}
                disabled={sold}
                onClick={() => onItemTap(item)}
                className={
                  "overflow-hidden rounded-2xl border bg-white text-left shadow-sm transition " +
                  (sold
                    ? "cursor-not-allowed border-zinc-100 opacity-50"
                    : "border-zinc-200 active:scale-[0.98]")
                }
              >
                {/* Food sells on the picture. A kiosk is the one surface
                    where the customer has never seen the menu before, so the
                    image carries more than the name does. Fixed aspect so a
                    grid of mixed-ratio photos doesn't go ragged. */}
                {item.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.imageUrl}
                    alt=""
                    className="aspect-[4/3] w-full bg-zinc-100 object-cover"
                  />
                ) : null}
                <div className="p-5">
                <div className="text-xl font-semibold leading-tight text-zinc-900">
                  {item.name}
                </div>
                {item.description && (
                  <p className="mt-1 line-clamp-2 text-sm text-zinc-500">
                    {item.description}
                  </p>
                )}
                <div className="mt-3 text-2xl font-bold text-zinc-900">
                  {sold ? "Sold out" : formatDisplayPrice(item as any)}
                </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {count > 0 && !basketOpen && (
        <button
          onClick={() => setBasketOpen(true)}
          className="fixed inset-x-0 bottom-0 flex items-center justify-between bg-zinc-900 px-6 py-5 text-white"
        >
          <span className="flex items-center gap-3 text-lg font-semibold">
            <ShoppingBag className="h-6 w-6" /> {count} item
            {count === 1 ? "" : "s"}
          </span>
          <span className="text-2xl font-bold">{money(subtotal)}</span>
        </button>
      )}

      {basketOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-white">
          <header className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
            <h2 className="text-2xl font-bold">Your order</h2>
            <button
              onClick={() => setBasketOpen(false)}
              className="rounded-lg border border-zinc-200 px-5 py-3 text-base font-medium"
            >
              Add more
            </button>
          </header>

          <div className="flex-1 overflow-y-auto p-6">
            {cart.map((l) => (
              <div
                key={l.key}
                className="mb-3 flex items-center gap-3 rounded-xl border border-zinc-200 p-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-lg font-semibold text-zinc-900">
                    {l.displayName}
                  </p>
                  <p className="text-base text-zinc-500">
                    {money(l.unitPrice * l.quantity)}
                  </p>
                </div>
                <button
                  onClick={() =>
                    setCart((p) =>
                      p
                        .map((x) =>
                          x.key === l.key
                            ? { ...x, quantity: x.quantity - 1 }
                            : x,
                        )
                        .filter((x) => x.quantity > 0),
                    )
                  }
                  className="grid h-14 w-14 place-items-center rounded-lg bg-zinc-100"
                >
                  <Minus className="h-6 w-6" />
                </button>
                <span className="w-8 text-center text-xl font-bold">
                  {l.quantity}
                </span>
                <button
                  onClick={() =>
                    setCart((p) =>
                      p.map((x) =>
                        x.key === l.key
                          ? { ...x, quantity: x.quantity + 1 }
                          : x,
                      ),
                    )
                  }
                  className="grid h-14 w-14 place-items-center rounded-lg bg-zinc-100"
                >
                  <Plus className="h-6 w-6" />
                </button>
                <button
                  onClick={() =>
                    setCart((p) => p.filter((x) => x.key !== l.key))
                  }
                  className="grid h-14 w-14 place-items-center rounded-lg text-zinc-400"
                >
                  <Trash2 className="h-6 w-6" />
                </button>
              </div>
            ))}
          </div>

          <div className="border-t border-zinc-200 p-6">
            <div className="mb-4 flex items-center justify-between text-2xl font-bold">
              <span>Total</span>
              <span>{money(subtotal)}</span>
            </div>
            {place.isError && (
              <p className="mb-3 rounded-lg bg-red-50 p-3 text-center text-base text-red-700">
                That didn&rsquo;t go through. Try again, or order at the
                counter.
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                onClick={() => submit("CARD")}
                disabled={place.isPending}
                className="rounded-xl bg-emerald-600 py-7 text-xl font-bold text-white disabled:opacity-60"
              >
                {place.isPending ? "Sending…" : "Pay by card"}
              </button>
              <button
                onClick={() => submit("COUNTER")}
                disabled={place.isPending}
                className="rounded-xl bg-zinc-900 py-7 text-xl font-bold text-white disabled:opacity-60"
              >
                {place.isPending ? "Sending…" : "Pay at the counter"}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingCard && locationId && (
        <ChargeReaderModal
          open
          orderId={pendingCard.orderId}
          locationId={locationId}
          amount={pendingCard.amount}
          onPaid={() => {
            // Paid — the server releases it to the kitchen and the printer.
            setDone({
              displayId: pendingCard.displayId,
              total: pendingCard.amount,
              paid: "CARD",
            });
            setCart([]);
            setBasketOpen(false);
            setPendingCard(null);
          }}
          onClose={() => {
            // Closed without paying. The order exists but is unpaid, so the
            // kitchen has NOT seen it — staff can settle or void it at the
            // till. Say so rather than pretending it went through.
            setPendingCard(null);
          }}
        />
      )}

      {modalItem && (
        <ModifierSelectionModal
          item={modalItem}
          allModifierGroups={allGroups}
          // One question per screen: staff and customers at a till are
          // completing a task, not browsing. The storefront stays on scroll.
          flow="stepped"
          open={!!modalItem}
          onClose={() => setModalItem(null)}
          onAdd={(line) => {
            addLine({
              menuItemId: line.menuItemId,
              displayName: line.displayName,
              unitPrice: line.unitPrice,
              quantity: line.quantity,
              modifiers: line.modifiers,
              notes: line.notes,
            });
            setModalItem(null);
          }}
        />
      )}
    </div>
  );
}

function Full({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-[calc(100vh-4rem)] place-items-center bg-zinc-50 p-8">
      <div className="flex flex-col items-center">{children}</div>
    </div>
  );
}
