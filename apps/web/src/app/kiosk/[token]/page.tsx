"use client";

// Self-service kiosk — the screen a customer touches in the shop.
//
// Design constraints that are different from every other surface we have:
//   • The user is STANDING, often with a queue behind them. Big targets,
//     few decisions, no scrolling to find the button.
//   • Nobody is signed in and nobody is watching. Every dead end needs a
//     way out, and the screen must return itself to a clean state — an
//     abandoned basket must not become the next customer's order.
//   • The menu comes from the server already resolved (the same call the
//     till uses), so the kiosk cannot drift from the POS.
//
// Payment is deliberately only "pay at counter" or a card link the
// customer pays on their own phone. No reader is wired to an unattended
// screen — see KioskService for the reasoning.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Minus, Plus, ShoppingBag, Trash2 } from "lucide-react";
import {
  buildCartItemName,
  calculateCartItem,
  round2,
  type SelectedModifier,
  type ProductSku,
} from "@orderhub/shared";
import { ModifierSelectionModal } from "@/components/pos/modifier-selection-modal";
import { modifierGroupsClient } from "@/lib/api/catalog.client";
import {
  kioskClient,
  KioskError,
  type KioskOrderItem,
} from "@/lib/api/kiosk.client";

interface Line {
  key: string;
  menuItemId: string;
  displayName: string;
  unitPrice: number;
  quantity: number;
  modifiers: SelectedModifier[];
  notes?: string;
}

const money = (n: number) => `£${Number(n).toFixed(2)}`;

// How long an untouched basket survives. A customer who walks away mid-order
// must not leave their food on the screen for the next person to pay for.
const IDLE_RESET_MS = 90_000;

export default function KioskPage() {
  const { token } = useParams<{ token: string }>();

  const kioskQuery = useQuery({
    queryKey: ["kiosk", token],
    queryFn: () => kioskClient.resolve(token),
    retry: (n, e) => (e as KioskError)?.status === 0 && n < 3,
    // The menu changes when the shop 86s something; a kiosk left running
    // all day must notice without anyone touching it.
    refetchInterval: 60_000,
  });
  const kiosk = kioskQuery.data;

  const groupsQuery = useQuery({
    queryKey: ["kiosk-groups", kiosk?.brandId],
    queryFn: () => modifierGroupsClient.list(kiosk!.brandId!),
    enabled: !!kiosk?.brandId,
  });
  const allGroups = (groupsQuery.data ?? []) as any[];

  const categories: any[] = kiosk?.menu?.categories ?? [];
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const currentCat =
    categories.find((c) => c.id === activeCat) ?? categories[0] ?? null;

  const [cart, setCart] = useState<Line[]>([]);
  const [modalItem, setModalItem] = useState<any | null>(null);
  const [basketOpen, setBasketOpen] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [done, setDone] = useState<{
    displayId: string | null;
    payment: "CARD" | "PAY_AT_COUNTER";
    total: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // One id per basket. Kept until the order lands so a retry after a
  // dropped connection replays rather than ordering twice.
  const requestIdRef = useRef<string | null>(null);
  const placingRef = useRef(false);

  const subtotal = round2(
    cart.reduce((s, l) => s + l.unitPrice * l.quantity, 0),
  );
  const count = cart.reduce((s, l) => s + l.quantity, 0);

  const reset = useCallback(() => {
    setCart([]);
    setBasketOpen(false);
    setDone(null);
    setError(null);
    requestIdRef.current = null;
    setActiveCat(null);
  }, []);

  // Idle timeout — only while there is something to lose.
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

  // Clear the confirmation after a beat so the next customer sees the menu.
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(reset, 12_000);
    return () => clearTimeout(t);
  }, [done, reset]);

  const addLine = (l: {
    menuItemId: string;
    displayName: string;
    unitPrice: number;
    quantity: number;
    modifiers: SelectedModifier[];
    notes?: string;
  }) => {
    setCart((prev) => [
      ...prev,
      { ...l, key: `${l.menuItemId}-${Date.now()}-${prev.length}` },
    ]);
    setModalItem(null);
  };

  const onItemTap = (item: any) => {
    const hasMods = (item.modifierGroupLinks?.length ?? 0) > 0;
    if (hasMods || item.hasMultipleSkus) {
      setModalItem(item);
      return;
    }
    // No options — straight in, one tap.
    const breakdown = calculateCartItem({
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
      unitPrice: breakdown.unitPrice,
      quantity: 1,
      modifiers: [],
    });
  };

  const place = async (payment: "CARD" | "PAY_AT_COUNTER") => {
    if (placingRef.current || !cart.length) return;
    placingRef.current = true;
    setPlacing(true);
    setError(null);
    try {
      if (!requestIdRef.current) {
        requestIdRef.current = `${Date.now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 10)}`;
      }
      const items: KioskOrderItem[] = cart.map((l) => ({
        name: l.displayName,
        quantity: l.quantity,
        // unitPrice already includes the modifiers (calculateCartItem), so
        // the line is unitPrice × quantity and nothing else. Adding the
        // modifiers again here is exactly the bug that overcharged the
        // online storefront.
        unitPrice: l.unitPrice,
        totalPrice: round2(l.unitPrice * l.quantity),
        modifiers: l.modifiers.map((m) => ({
          name: m.name,
          price: m.price,
          quantity: 1,
        })),
        notes: l.notes || null,
        // Load-bearing: the kitchen display routes on menuItemId.
        menuItemId: l.menuItemId,
      }));
      const res = await kioskClient.placeOrder(token, {
        items,
        payment,
        requestId: requestIdRef.current,
      });
      setDone({
        displayId: res.displayId,
        payment: res.payment,
        total: res.total,
      });
      setCart([]);
      setBasketOpen(false);
      requestIdRef.current = null;
    } catch (e: any) {
      setError(e?.message ?? "Something went wrong. Please ask a member of staff.");
    } finally {
      placingRef.current = false;
      setPlacing(false);
    }
  };

  // ── Gates ───────────────────────────────────────────────────────────
  if (kioskQuery.isLoading) {
    return (
      <Full>
        <Loader2 className="h-10 w-10 animate-spin text-zinc-400" />
        <p className="mt-4 text-lg text-zinc-500">Just a moment…</p>
      </Full>
    );
  }
  if (kioskQuery.isError || !kiosk) {
    const status = (kioskQuery.error as KioskError)?.status;
    return (
      <Full>
        <p className="text-2xl font-semibold text-zinc-800">
          {status === 0 ? "No connection" : "This screen isn’t set up yet"}
        </p>
        <p className="mt-3 max-w-md text-center text-zinc-500">
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
          <h1 className="mt-6 text-4xl font-bold text-zinc-900">
            Order placed
          </h1>
          {done.displayId && (
            <p className="mt-2 text-6xl font-black tracking-tight text-emerald-700">
              #{done.displayId}
            </p>
          )}
          <p className="mt-6 max-w-md text-xl text-zinc-600">
            {done.payment === "PAY_AT_COUNTER"
              ? `Please pay ${money(done.total)} at the counter and give them your number.`
              : `Please pay ${money(done.total)} at the counter — a member of staff will take your card.`}
          </p>
          <button
            onClick={reset}
            className="mt-10 rounded-xl bg-zinc-900 px-10 py-5 text-xl font-semibold text-white"
          >
            Done
          </button>
        </div>
      </Full>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-4">
        <div className="flex items-center gap-3">
          {kiosk.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={kiosk.logoUrl} alt="" className="h-12 w-12 rounded-lg object-contain" />
          ) : null}
          <div>
            <h1 className="text-2xl font-bold text-zinc-900">
              {kiosk.brandName ?? kiosk.locationName ?? "Order here"}
            </h1>
            <p className="text-sm text-zinc-500">Tap to order · collect at the counter</p>
          </div>
        </div>
        {cart.length > 0 && (
          <button
            onClick={reset}
            className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-500"
          >
            Start again
          </button>
        )}
      </header>

      {/* Categories */}
      <div className="flex gap-2 overflow-x-auto border-b border-zinc-200 bg-white px-6 py-3">
        {categories.map((c) => (
          <button
            key={c.id}
            onClick={() => setActiveCat(c.id)}
            className={
              "shrink-0 rounded-full px-5 py-3 text-base font-semibold " +
              (currentCat?.id === c.id
                ? "bg-zinc-900 text-white"
                : "bg-zinc-100 text-zinc-700")
            }
          >
            {c.name}
          </button>
        ))}
      </div>

      {/* Items — big tiles, two/three up */}
      <div className="flex-1 overflow-y-auto p-6 pb-32">
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
                  "rounded-2xl border bg-white p-5 text-left shadow-sm transition " +
                  (sold
                    ? "cursor-not-allowed border-zinc-100 opacity-50"
                    : "border-zinc-200 active:scale-[0.98]")
                }
              >
                <div className="text-xl font-semibold leading-tight text-zinc-900">
                  {item.name}
                </div>
                {item.description && (
                  <p className="mt-1 line-clamp-2 text-sm text-zinc-500">
                    {item.description}
                  </p>
                )}
                <div className="mt-3 text-2xl font-bold text-zinc-900">
                  {sold ? "Sold out" : money(Number(item.basePrice ?? 0))}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Basket bar */}
      {count > 0 && !basketOpen && (
        <button
          onClick={() => setBasketOpen(true)}
          className="fixed inset-x-0 bottom-0 flex items-center justify-between bg-zinc-900 px-6 py-5 text-white"
        >
          <span className="flex items-center gap-3 text-lg font-semibold">
            <ShoppingBag className="h-6 w-6" /> {count} item{count === 1 ? "" : "s"}
          </span>
          <span className="text-2xl font-bold">{money(subtotal)}</span>
        </button>
      )}

      {/* Basket sheet */}
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
                  className="grid h-12 w-12 place-items-center rounded-lg bg-zinc-100"
                >
                  <Minus className="h-5 w-5" />
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
                  className="grid h-12 w-12 place-items-center rounded-lg bg-zinc-100"
                >
                  <Plus className="h-5 w-5" />
                </button>
                <button
                  onClick={() =>
                    setCart((p) => p.filter((x) => x.key !== l.key))
                  }
                  className="grid h-12 w-12 place-items-center rounded-lg text-zinc-400"
                >
                  <Trash2 className="h-5 w-5" />
                </button>
              </div>
            ))}
          </div>

          <div className="border-t border-zinc-200 p-6">
            <div className="mb-4 flex items-center justify-between text-2xl font-bold">
              <span>Total</span>
              <span>{money(subtotal)}</span>
            </div>
            {error && (
              <p className="mb-3 rounded-lg bg-red-50 p-3 text-center text-base text-red-700">
                {error}
              </p>
            )}
            <div className="grid gap-3">
              {kiosk.allowPayAtCounter && (
                <button
                  onClick={() => place("PAY_AT_COUNTER")}
                  disabled={placing}
                  className="rounded-xl bg-zinc-900 py-6 text-xl font-bold text-white disabled:opacity-60"
                >
                  {placing ? "Sending…" : "Order & pay at the counter"}
                </button>
              )}
              {kiosk.allowCardPayment && (
                <button
                  onClick={() => place("CARD")}
                  disabled={placing}
                  className="rounded-xl bg-emerald-600 py-6 text-xl font-bold text-white disabled:opacity-60"
                >
                  {placing ? "Sending…" : "Order & pay by card"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {modalItem && (
        <ModifierSelectionModal
          item={modalItem}
          allModifierGroups={allGroups}
          open={!!modalItem}
          onClose={() => setModalItem(null)}
          onAdd={(line) =>
            addLine({
              menuItemId: line.menuItemId,
              displayName: line.displayName,
              unitPrice: line.unitPrice,
              quantity: line.quantity,
              modifiers: line.modifiers,
              notes: line.notes,
            })
          }
        />
      )}
    </div>
  );
}

function Full({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-zinc-50 p-8">
      <div className="flex flex-col items-center">{children}</div>
    </div>
  );
}
