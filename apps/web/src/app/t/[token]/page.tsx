"use client";

// QR at table — the guest's phone.
//
// A diner scans the sticker on their table and lands here. The token in the
// URL is the only credential; everything (menu, tab, sending a round) hangs
// off it.
//
// Two flows, chosen per shop in the dashboard (Tables → Payment options) and
// carried on `table.paymentMode`:
//
//   PAY_LATER — the original. The round joins the table's tab and is settled
//               with staff at the end; this page never touches money.
//   PAY_NOW   — the guest pays here first (Apple Pay / Google Pay / card) and
//               NOTHING reaches the kitchen until Stripe says the money
//               arrived. The card sheet is the same component the storefront
//               uses, on the same direct-charge intent; the only thing this
//               page adds is the itemised bill above it, because the service
//               charge is computed server-side and the basket total on the
//               way in is smaller than the amount being charged.
//
// Reuse, not reinvention:
//   • the menu comes from the SAME public storefront endpoint /order/[slug]
//     uses, so prices, 86'd items and modifier groups match the customer site
//   • items with option groups open the shared POS ModifierSelectionModal
//   • money maths matches the POS: unitPrice already includes modifiers and
//     totalPrice = round2(unitPrice × quantity), which is exactly what
//     orders.addRound() expects
//
// Mobile-only by construction: single column, 44px touch targets, primary
// actions pinned to the bottom of the screen.

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  ShoppingBag,
  Plus,
  Minus,
  X,
  Loader2,
  CheckCircle,
  Trash2,
  RefreshCw,
  Utensils,
  AlertCircle,
  CreditCard,
} from "lucide-react";
import {
  formatMoney,
  itemAllowsMode, round2, buildCartItemName, toOrderLineModifier } from "@orderhub/shared";
import type { SelectedModifier } from "@orderhub/shared";
import { cn } from "@/lib/utils";
import { ModifierSelectionModal } from "@/components/pos/modifier-selection-modal";
import type { MenuItem, MenuCategory } from "@/lib/api/menus.client";
import {
  tableQrClient,
  TableQrError,
  type TableQrCheckoutResult,
  type TableQrOrderItem,
} from "@/lib/api/table-qr.client";
import { EmbeddedPaymentSheet } from "@/components/order/embedded-payment-sheet";

// ── Basket ─────────────────────────────────────────────────────────────────

interface BasketLine {
  id: string;
  menuItemId: string;
  displayName: string;
  /** Includes modifier prices (calculateCartItem semantics). */
  unitPrice: number;
  quantity: number;
  modifiers: SelectedModifier[];
  notes?: string;
}

type BasketAction =
  | { type: "ADD"; line: Omit<BasketLine, "id"> }
  | { type: "INCREMENT"; id: string }
  | { type: "DECREMENT"; id: string }
  | { type: "REMOVE"; id: string }
  | { type: "SET"; lines: BasketLine[] }
  | { type: "CLEAR" };

function basketReducer(state: BasketLine[], action: BasketAction): BasketLine[] {
  switch (action.type) {
    case "SET":
      return action.lines;
    case "ADD":
      return [
        ...state,
        { ...action.line, id: Math.random().toString(36).slice(2) },
      ];
    case "INCREMENT":
      return state.map((l) =>
        l.id === action.id ? { ...l, quantity: l.quantity + 1 } : l,
      );
    case "DECREMENT":
      return state
        .map((l) => (l.id === action.id ? { ...l, quantity: l.quantity - 1 } : l))
        .filter((l) => l.quantity > 0);
    case "REMOVE":
      return state.filter((l) => l.id !== action.id);
    case "CLEAR":
      return [];
    default:
      return state;
  }
}

/**
 * Money formatter, bound to a currency.
 *
 * This was a hardcoded pound, which is fine until a Dubai shop opens a table
 * tab and its guests are quoted in sterling. The currency rides on the same
 * storefront payload the menu does, so the page has it — it just has to be
 * threaded to the components that print prices.
 */
type MoneyFn = (n: number) => string;
const moneyFor =
  (currency: string): MoneyFn =>
  (n: number) =>
    formatMoney(n, currency);

// ── Page ───────────────────────────────────────────────────────────────────

export default function TableQrPage() {
  const { token } = useParams<{ token: string }>();

  const [view, setView] = useState<"menu" | "tab">("menu");
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [modalItem, setModalItem] = useState<MenuItem | null>(null);
  const [basketOpen, setBasketOpen] = useState(false);
  const [guestName, setGuestName] = useState("");
  const [kitchenNotes, setKitchenNotes] = useState("");
  // What the "done" overlay is celebrating: a round added to the tab, or a
  // basket that was paid for and is now on its way to the kitchen.
  const [sent, setSent] = useState<
    | { kind: "ROUND"; firstRound: boolean }
    | { kind: "PAID"; orderId: string }
    | null
  >(null);
  // The live card sheet, once /checkout has written the order and minted an
  // intent for it. Null the rest of the time.
  const [pay, setPay] = useState<TableQrCheckoutResult | null>(null);
  const [basket, dispatch] = useReducer(basketReducer, []);

  // ── Data ─────────────────────────────────────────────────────────────────

  const tableQuery = useQuery({
    queryKey: ["table-qr", token],
    queryFn: () => tableQrClient.resolve(token),
    // A dead/disabled token (404) or table service being off (403) is a
    // settled answer — retrying just delays the message. Network blips
    // (status 0) are worth one more go.
    retry: (count, err) =>
      err instanceof TableQrError && err.status === 0 && count < 2,
  });
  const table = tableQuery.data;

  const storeQuery = useQuery({
    queryKey: ["table-qr-store", table?.locationId],
    queryFn: () => tableQrClient.storefront(table!.locationId),
    enabled: !!table?.locationId,
  });
  const store = storeQuery.data;
  // Falls back to GBP only while the payload is still loading — every shop
  // carries a real currency on its location row.
  const currency = ((store as any)?.store?.currency ?? "GBP") as string;
  const money = useMemo(() => moneyFor(currency), [currency]);

  const tabQuery = useQuery({
    queryKey: ["table-qr-tab", token],
    queryFn: () => tableQrClient.tab(token),
    enabled: !!table,
    // Staff and other phones add to the same tab, so a stale total on a
    // backgrounded phone is expected — refresh when the guest looks at it.
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });

  // ── Basket persistence ───────────────────────────────────────────────────
  //
  // Keyed by token so a phone lock, an accidental back, or hopping between
  // Safari tabs doesn't lose a half-built round. Hydrate once, then save on
  // every change (guarded so the empty mount state can't wipe a saved one).
  const basketKey = `orderhub.tablebasket.${token}`;
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(basketKey);
      if (raw) {
        const lines = JSON.parse(raw);
        if (Array.isArray(lines) && lines.length > 0) {
          dispatch({ type: "SET", lines });
        }
      }
    } catch {
      /* corrupt / unavailable storage — start empty */
    }
    setHydrated(true);
  }, [basketKey]);
  useEffect(() => {
    if (typeof window === "undefined" || !hydrated) return;
    try {
      if (basket.length > 0) {
        window.localStorage.setItem(basketKey, JSON.stringify(basket));
      } else {
        window.localStorage.removeItem(basketKey);
      }
    } catch {
      /* quota / private mode — non-fatal */
    }
  }, [basket, basketKey, hydrated]);

  // ── Pay-before-kitchen ───────────────────────────────────────────────────

  // Until the resolve lands we don't know which flow this shop runs, and the
  // basket bar is hidden anyway — so the PAY_LATER default here is never the
  // thing a guest acts on.
  const prepay = table?.paymentMode === "PAY_NOW";

  // 3-D Secure takes the whole page away and drops the guest back on
  // /t/<token>?paid=<orderId>. Pick that up once the basket has hydrated
  // (otherwise the restore below would put the paid round back), show the
  // same confirmation they'd have seen without the redirect, and take the
  // marker off the URL so a refresh doesn't replay it.
  useEffect(() => {
    if (typeof window === "undefined" || !hydrated) return;
    const paidId = new URLSearchParams(window.location.search).get("paid");
    if (!paidId) return;
    dispatch({ type: "CLEAR" });
    setSent({ kind: "PAID", orderId: paidId });
    const url = new URL(window.location.href);
    url.searchParams.delete("paid");
    window.history.replaceState({}, "", url.toString());
  }, [hydrated]);

  // After a card clears, the money landing and the kitchen being told are the
  // same server-side event (the Stripe webhook). Poll until it has, so the
  // overlay only promises "on its way" once it genuinely is — and so a shop
  // whose webhook isn't subscribed to connected-account events still gets
  // there, because this route reconciles against Stripe on the way past.
  const paidOrderId = sent?.kind === "PAID" ? sent.orderId : null;
  const [kitchenConfirmed, setKitchenConfirmed] = useState(false);
  const paidQuery = useQuery({
    queryKey: ["table-qr-order", token, paidOrderId],
    queryFn: () => tableQrClient.orderStatus(token, paidOrderId!),
    enabled: !!paidOrderId && !kitchenConfirmed,
    refetchInterval: 3000,
  });
  useEffect(() => {
    if (paidQuery.data?.paid) setKitchenConfirmed(true);
  }, [paidQuery.data?.paid]);

  // ── Derived ──────────────────────────────────────────────────────────────

  const categories: MenuCategory[] = useMemo(
    () => store?.menu?.categories ?? [],
    [store?.menu?.categories],
  );

  // Availability rules copied from the storefront exactly: 86'd items
  // (isAvailable false) disappear, out-of-stock items stay visible but
  // can't be tapped.
  const sections = useMemo(() => {
    const out: Array<{ cat: MenuCategory; items: MenuItem[] }> = [];
    for (const cat of categories) {
      if (activeCategory !== "all" && cat.id !== activeCategory) continue;
      const items = cat.items
        .filter((link) => link.item.isAvailable)
        .map((link) => link.item)
        // This page is table service only, so anything not sold dine-in —
        // a delivery-only bundle, say — should never reach a guest's phone.
        .filter((it) => itemAllowsMode(it, "DINE_IN"));
      if (items.length > 0 || activeCategory === cat.id) out.push({ cat, items });
    }
    return out;
  }, [categories, activeCategory]);

  const basketTotal = basket.reduce(
    (sum, l) => sum + round2(l.unitPrice * l.quantity),
    0,
  );
  const basketCount = basket.reduce((s, l) => s + l.quantity, 0);

  // ── Sending a round ──────────────────────────────────────────────────────

  // Belt and braces against a double-tap: React state lags a fast second
  // touch by a frame, so a ref latches the very first call.
  const sendingRef = useRef(false);
  // One id per basket, minted on the first send attempt and kept until
  // the round actually lands. A retry after a dropped connection reuses
  // it, so the server replays its answer instead of cooking twice.
  const requestIdRef = useRef<string | null>(null);

  // An edited basket is a genuinely different round, so it must not reuse
  // the previous attempt's id — the server would replay the old answer and
  // the guest would be charged for, or served, the basket they just changed.
  useEffect(() => {
    requestIdRef.current = null;
  }, [basket]);

  const buildPayload = () => {
    const items: TableQrOrderItem[] = basket.map((l) => ({
      name: l.displayName,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      totalPrice: round2(l.unitPrice * l.quantity),
      modifiers: l.modifiers.map((m) => ({
        ...toOrderLineModifier(m),
        quantity: 1,
      })),
      notes: l.notes || null,
      // Load-bearing: KDS station rules match on menuItemId. Dropping it
      // once already cost us kitchen tickets in production.
      menuItemId: l.menuItemId || null,
    }));
    if (!requestIdRef.current) {
      requestIdRef.current = `${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 10)}`;
    }
    return {
      items,
      customerName: guestName.trim() || undefined,
      notes: kitchenNotes.trim() || null,
      requestId: requestIdRef.current,
    };
  };

  const send = useMutation({
    mutationFn: () => tableQrClient.sendRound(token, buildPayload()),
    onSuccess: (res) => {
      // Landed — the next basket is a genuinely new round.
      requestIdRef.current = null;
      dispatch({ type: "CLEAR" });
      setKitchenNotes("");
      setBasketOpen(false);
      setSent({ kind: "ROUND", firstRound: res.mode === "OPEN" });
      // The tab now has the new lines on it, and the table may have just
      // been opened — both queries are stale.
      tabQuery.refetch();
      tableQuery.refetch();
    },
    onSettled: () => {
      sendingRef.current = false;
    },
  });

  // PAY_NOW. This writes the order unpaid and hands back an intent; the
  // basket is deliberately NOT cleared yet, because backing out of the card
  // sheet has to leave the guest their round rather than an empty phone.
  const checkout = useMutation({
    mutationFn: () => tableQrClient.checkout(token, buildPayload()),
    onSuccess: (res) => {
      if (res.alreadyPaid || !res.clientSecret || !res.stripeAccountId) {
        // A repeat of a basket that already went through — don't ask for
        // the money twice, just show them where it got to.
        requestIdRef.current = null;
        dispatch({ type: "CLEAR" });
        setKitchenNotes("");
        setBasketOpen(false);
        setSent({ kind: "PAID", orderId: res.orderId });
        return;
      }
      setPay(res);
    },
    onSettled: () => {
      sendingRef.current = false;
    },
  });

  const busySending = send.isPending || checkout.isPending;

  const handleSend = () => {
    if (sendingRef.current || busySending || basket.length === 0) return;
    sendingRef.current = true;
    if (prepay) checkout.mutate();
    else send.mutate();
  };

  // ── Error / loading gates ────────────────────────────────────────────────

  if (tableQuery.isLoading) {
    return (
      <FullPage>
        <Loader2 className="h-7 w-7 animate-spin text-zinc-400" />
        <p className="mt-4 text-sm text-zinc-500">Finding your table…</p>
      </FullPage>
    );
  }

  if (tableQuery.isError || !table) {
    return <ResolveError error={tableQuery.error} />;
  }

  const heading = table.brandName ?? table.locationName ?? "Order";

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* ── Header ── */}
      <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
        <div className="px-4 pt-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="truncate text-lg font-bold leading-tight text-zinc-900">
                {heading}
              </h1>
              <p className="mt-0.5 text-xs text-zinc-500">
                {table.tabOpen ? "Adding to your table" : "Start your order"}
              </p>
            </div>
            {/* Persistent reassurance that they're ordering to the right
                table — the single most common QR-ordering worry. */}
            <span className="flex flex-shrink-0 items-center gap-1.5 rounded-full bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white">
              <Utensils className="h-3.5 w-3.5" />
              You&rsquo;re at {table.tableName}
            </span>
          </div>

          <div className="mt-3 flex gap-2">
            <SegmentButton
              active={view === "menu"}
              onClick={() => setView("menu")}
            >
              Menu
            </SegmentButton>
            <SegmentButton
              active={view === "tab"}
              onClick={() => {
                setView("tab");
                tabQuery.refetch();
              }}
            >
              {prepay ? "My orders" : "My tab"}
              {(tabQuery.data?.items.length ?? 0) > 0 && (
                <span
                  className={cn(
                    "ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold",
                    view === "tab"
                      ? "bg-white/20 text-white"
                      : "bg-zinc-200 text-zinc-700",
                  )}
                >
                  {tabQuery.data?.items.length}
                </span>
              )}
            </SegmentButton>
          </div>

          {view === "menu" && categories.length > 0 && (
            <div className="mt-3 flex gap-2 overflow-x-auto pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <CategoryChip
                active={activeCategory === "all"}
                onClick={() => setActiveCategory("all")}
              >
                All
              </CategoryChip>
              {categories.map((c) => (
                <CategoryChip
                  key={c.id}
                  active={activeCategory === c.id}
                  onClick={() => setActiveCategory(c.id)}
                >
                  {c.name}
                </CategoryChip>
              ))}
            </div>
          )}
          {(view !== "menu" || categories.length === 0) && <div className="pb-3" />}
        </div>
      </header>

      {/* ── Body ── */}
      {/* Bottom padding clears the sticky basket bar + the iOS home bar. */}
      <main className="px-4 pb-40 pt-4">
        {view === "menu" ? (
          <MenuView
            money={money}
            loading={storeQuery.isLoading}
            failed={storeQuery.isError}
            onRetry={() => storeQuery.refetch()}
            sections={sections}
            showImages={store?.directConfig?.showItemImages ?? true}
            onPick={(item) => {
              const hasMods = (item.modifierGroupLinks?.length ?? 0) > 0;
              if (hasMods || item.hasMultipleSkus) {
                setModalItem(item);
                return;
              }
              // Single tap add. buildCartItemName keeps the line in the exact
              // format the KDS ticket parser expects, same as POS/storefront.
              dispatch({
                type: "ADD",
                line: {
                  menuItemId: item.id,
                  displayName: buildCartItemName({
                    productName: item.name,
                    modifiers: [],
                  }),
                  unitPrice: round2(Number(item.basePrice)),
                  quantity: 1,
                  modifiers: [],
                },
              });
            }}
          />
        ) : (
          <TabView
            money={money}
            prepay={prepay}
            loading={tabQuery.isLoading}
            failed={tabQuery.isError}
            data={tabQuery.data}
            refreshing={tabQuery.isFetching}
            onRefresh={() => tabQuery.refetch()}
          />
        )}
      </main>

      {/* ── Sticky basket bar ── */}
      {basketCount > 0 && !basketOpen && !sent && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-zinc-200 bg-white p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button
            onClick={() => setBasketOpen(true)}
            className="flex min-h-[52px] w-full items-center justify-between rounded-xl bg-zinc-900 px-4 text-white active:bg-zinc-800"
          >
            <span className="flex items-center gap-2 text-sm font-semibold">
              <span className="grid h-6 w-6 place-items-center rounded-full bg-white text-xs font-bold text-zinc-900">
                {basketCount}
              </span>
              View basket
            </span>
            <span className="text-base font-bold">{money(basketTotal)}</span>
          </button>
        </div>
      )}

      {/* ── Modifier modal (shared with POS + storefront) ── */}
      {modalItem && (
        <ModifierSelectionModal
          item={modalItem}
          // This page is public, so the modal must never look the currency up
          // — that endpoint needs a dashboard token. It comes from the same
          // storefront payload the menu does.
          currency={(store as any)?.store?.currency ?? "GBP"}
          allModifierGroups={store?.brandModifierGroups ?? []}
          // One question per screen: staff and customers at a till are
          // completing a task, not browsing. The storefront stays on scroll.
          flow="stepped"
          open={!!modalItem}
          onClose={() => setModalItem(null)}
          onAdd={(line) => {
            dispatch({
              type: "ADD",
              line: {
                menuItemId: line.menuItemId,
                displayName: line.displayName,
                // Already includes modifier prices — do NOT add them again.
                unitPrice: line.unitPrice,
                quantity: line.quantity,
                modifiers: line.modifiers,
                notes: line.notes,
              },
            });
          }}
        />
      )}

      {/* ── Basket sheet ── */}
      {basketOpen && (
        <BasketSheet
          money={money}
          lines={basket}
          total={basketTotal}
          tableName={table.tableName}
          tabOpen={table.tabOpen}
          guestName={guestName}
          setGuestName={setGuestName}
          notes={kitchenNotes}
          setNotes={setKitchenNotes}
          prepay={prepay}
          sending={busySending}
          error={
            (prepay ? checkout.error : send.error) instanceof Error
              ? (prepay ? checkout.error : send.error)!.message
              : (prepay ? checkout.isError : send.isError)
                ? prepay
                  ? "We couldn't start your payment. Please try again."
                  : "We couldn't send that. Please try again."
                : null
          }
          onClose={() => setBasketOpen(false)}
          onIncrement={(id) => dispatch({ type: "INCREMENT", id })}
          onDecrement={(id) => dispatch({ type: "DECREMENT", id })}
          onRemove={(id) => dispatch({ type: "REMOVE", id })}
          onSend={handleSend}
        />
      )}

      {/* ── Card sheet (shared with the storefront) ── */}
      {pay?.clientSecret && pay.stripeAccountId && (
        <EmbeddedPaymentSheet
          money={(n) => money(Number(n ?? 0))}
          clientSecret={pay.clientSecret}
          stripeAccountId={pay.stripeAccountId}
          amountPence={pay.amountPence ?? Math.round(pay.total * 100)}
          orderId={pay.orderId}
          brandId={table.brandId}
          title={`Pay for ${pay.tableName}`}
          subtitle="Your order goes to the kitchen as soon as this clears"
          // 3-D Secure takes the page away; bring them back HERE, not to a
          // storefront tracking screen they never came from.
          returnUrl={
            typeof window === "undefined"
              ? undefined
              : `${window.location.origin}/t/${encodeURIComponent(token)}?paid=${encodeURIComponent(pay.orderId)}`
          }
          summary={<BillSummary money={money} bill={pay} />}
          onPaid={() => {
            requestIdRef.current = null;
            dispatch({ type: "CLEAR" });
            setKitchenNotes("");
            setBasketOpen(false);
            setPay(null);
            setSent({ kind: "PAID", orderId: pay.orderId });
            tabQuery.refetch();
            tableQuery.refetch();
          }}
          // Backing out leaves the basket exactly as it was. The unpaid
          // order stays in the shop's "Waiting for payment" column until
          // staff clear it, the same as an abandoned POS payment link.
          onCancel={() => setPay(null)}
        />
      )}

      {/* ── Sent confirmation ── */}
      {sent && (
        <SentOverlay
          paid={sent.kind === "PAID"}
          kitchenConfirmed={kitchenConfirmed}
          firstRound={sent.kind === "ROUND" && sent.firstRound}
          tableName={table.tableName}
          onSeeTab={() => {
            setSent(null);
            setKitchenConfirmed(false);
            setView("tab");
            tabQuery.refetch();
          }}
          onKeepOrdering={() => {
            setSent(null);
            setKitchenConfirmed(false);
            setView("menu");
          }}
        />
      )}
    </div>
  );
}

// ── Views ──────────────────────────────────────────────────────────────────

function MenuView({
  loading,
  failed,
  onRetry,
  sections,
  showImages,
  onPick,
  money,
}: {
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  sections: Array<{ cat: MenuCategory; items: MenuItem[] }>;
  showImages: boolean;
  onPick: (item: MenuItem) => void;
  money: MoneyFn;
}) {
  if (loading) {
    return (
      <div className="space-y-3 py-6">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-xl bg-zinc-200/70" />
        ))}
      </div>
    );
  }

  if (failed) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-6 text-center">
        <p className="text-sm font-semibold text-zinc-900">
          We couldn&rsquo;t load the menu
        </p>
        <p className="mt-1 text-sm text-zinc-500">
          Check your signal and try again, or ask a member of staff for a menu.
        </p>
        <button
          onClick={onRetry}
          className="mt-4 min-h-[44px] rounded-xl bg-zinc-900 px-5 text-sm font-semibold text-white active:bg-zinc-800"
        >
          Try again
        </button>
      </div>
    );
  }

  if (sections.length === 0) {
    return (
      <p className="py-16 text-center text-sm text-zinc-400">
        Nothing on the menu just yet — please ask a member of staff.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {sections.map(({ cat, items }) => (
        <section key={cat.id}>
          <h2 className="mb-2 text-base font-bold text-zinc-900">{cat.name}</h2>
          {items.length === 0 ? (
            <p className="rounded-xl border border-dashed border-zinc-200 py-6 text-center text-xs text-zinc-400">
              Nothing in {cat.name} right now.
            </p>
          ) : (
            <div className="space-y-2">
              {items.map((item) => (
                <ItemRow
              money={money}
                  key={item.id}
                  item={item}
                  showImage={showImages}
                  onClick={() => onPick(item)}
                />
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function ItemRow({
  item,
  showImage,
  onClick,
  money,
}: {
  item: MenuItem;
  showImage: boolean;
  onClick: () => void;
  money: MoneyFn;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={item.outOfStock}
      className="flex w-full items-center gap-3 rounded-xl border border-zinc-200 bg-white p-3 text-left transition active:border-zinc-400 disabled:opacity-50"
    >
      {showImage && (
        <div className="h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg bg-zinc-100">
          {item.imageUrl ? (
            <img
              src={item.imageUrl}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="grid h-full w-full place-items-center text-zinc-300">
              <ShoppingBag className="h-6 w-6" />
            </div>
          )}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-sm font-semibold text-zinc-900">
            {item.name}
          </h3>
          {item.outOfStock && (
            <span className="flex-shrink-0 rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-600">
              Sold out
            </span>
          )}
        </div>
        {item.description && (
          <p className="mt-0.5 line-clamp-2 text-xs text-zinc-500">
            {item.description}
          </p>
        )}
        <p className="mt-1 text-sm font-bold text-zinc-900">
          {money(Number(item.basePrice))}
        </p>
      </div>
      {!item.outOfStock && (
        <span className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-full bg-zinc-900 text-white">
          <Plus className="h-5 w-5" />
        </span>
      )}
    </button>
  );
}

function TabView({
  loading,
  failed,
  data,
  refreshing,
  onRefresh,
  money,
  prepay,
}: {
  /** This shop takes payment up front, so there is no bill to settle —
   *  the list is a receipt, not a tab. */
  prepay: boolean;
  loading: boolean;
  failed: boolean;
  data?: {
    open: boolean;
    items: Array<{ id: string; name: string; quantity: number; totalPrice: number }>;
    total: number;
    paymentStatus?: string | null;
  };
  money: MoneyFn;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  if (loading) {
    return (
      <div className="space-y-3 py-6">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-14 animate-pulse rounded-xl bg-zinc-200/70" />
        ))}
      </div>
    );
  }

  if (failed) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-6 text-center">
        <p className="text-sm font-semibold text-zinc-900">
          We couldn&rsquo;t load your {prepay ? "orders" : "tab"}
        </p>
        <p className="mt-1 text-sm text-zinc-500">
          Your orders are safe with the kitchen — this is just the list.
        </p>
        <button
          onClick={onRefresh}
          className="mt-4 min-h-[44px] rounded-xl bg-zinc-900 px-5 text-sm font-semibold text-white active:bg-zinc-800"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!data?.open || data.items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-200 bg-white p-8 text-center">
        <p className="text-sm font-semibold text-zinc-900">
          Nothing on your table yet
        </p>
        <p className="mt-1 text-sm text-zinc-500">
          Everything you order will show up here with a running total.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
        {data.items.map((line) => (
          <div
            key={line.id}
            className="flex items-start justify-between gap-3 border-b border-zinc-100 px-4 py-3 last:border-b-0"
          >
            <div className="min-w-0">
              <p className="text-sm text-zinc-900">
                <span className="font-semibold">{line.quantity}×</span>{" "}
                {line.name}
              </p>
            </div>
            <span className="flex-shrink-0 text-sm font-semibold text-zinc-900">
              {money(Number(line.totalPrice))}
            </span>
          </div>
        ))}
        <div className="flex items-center justify-between bg-zinc-50 px-4 py-3">
          <span className="text-sm font-semibold text-zinc-700">Total so far</span>
          <span className="text-lg font-bold text-zinc-900">
            {money(Number(data.total))}
          </span>
        </div>
      </div>

      <p className="text-center text-xs text-zinc-500">
        {prepay
          ? "All paid for — nothing to settle at the end."
          : data.paymentStatus === "PAID"
            ? "This tab has been settled — thank you!"
            : "Nothing to pay here. Ask a member of staff when you're ready to settle up."}
      </p>

      <button
        onClick={onRefresh}
        disabled={refreshing}
        className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white text-sm font-semibold text-zinc-700 active:border-zinc-400 disabled:opacity-60"
      >
        <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
        Refresh
      </button>
    </div>
  );
}

// ── Basket sheet ───────────────────────────────────────────────────────────

function BasketSheet({
  money,
  lines,
  total,
  tableName,
  tabOpen,
  guestName,
  setGuestName,
  notes,
  setNotes,
  prepay,
  sending,
  error,
  onClose,
  onIncrement,
  onDecrement,
  onRemove,
  onSend,
}: {
  money: MoneyFn;
  lines: BasketLine[];
  total: number;
  tableName: string;
  tabOpen: boolean;
  guestName: string;
  setGuestName: (v: string) => void;
  notes: string;
  setNotes: (v: string) => void;
  /** This shop takes payment before the kitchen starts. */
  prepay: boolean;
  sending: boolean;
  error: string | null;
  onClose: () => void;
  onIncrement: (id: string) => void;
  onDecrement: (id: string) => void;
  onRemove: (id: string) => void;
  onSend: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40">
      {/* Tap-outside closes — but never while a round is in flight. */}
      <button
        aria-label="Close basket"
        className="flex-1"
        onClick={() => {
          if (!sending) onClose();
        }}
      />
      <div className="flex max-h-[88vh] flex-col rounded-t-2xl bg-white">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-4">
          <div>
            <h2 className="text-base font-bold text-zinc-900">Your round</h2>
            <p className="text-xs text-zinc-500">
              {prepay
                ? `Pay, and it goes to the kitchen for ${tableName}`
                : `Going to the kitchen for ${tableName}`}
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={sending}
            className="grid h-11 w-11 place-items-center rounded-full text-zinc-500 active:bg-zinc-100 disabled:opacity-40"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {lines.length === 0 ? (
            <p className="py-10 text-center text-sm text-zinc-400">
              Your basket is empty.
            </p>
          ) : (
            <div className="space-y-3">
              {lines.map((line) => (
                <div
                  key={line.id}
                  className="rounded-xl border border-zinc-200 p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 flex-1 text-sm font-semibold text-zinc-900">
                      {line.displayName}
                    </p>
                    <button
                      onClick={() => onRemove(line.id)}
                      disabled={sending}
                      aria-label="Remove"
                      className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-full text-zinc-400 active:bg-zinc-100 disabled:opacity-40"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => onDecrement(line.id)}
                        disabled={sending}
                        aria-label="One fewer"
                        className="grid h-11 w-11 place-items-center rounded-full border border-zinc-200 text-zinc-700 active:bg-zinc-100 disabled:opacity-40"
                      >
                        <Minus className="h-4 w-4" />
                      </button>
                      <span className="min-w-[2ch] text-center text-base font-semibold text-zinc-900">
                        {line.quantity}
                      </span>
                      <button
                        onClick={() => onIncrement(line.id)}
                        disabled={sending}
                        aria-label="One more"
                        className="grid h-11 w-11 place-items-center rounded-full border border-zinc-200 text-zinc-700 active:bg-zinc-100 disabled:opacity-40"
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                    </div>
                    <span className="text-sm font-bold text-zinc-900">
                      {money(round2(line.unitPrice * line.quantity))}
                    </span>
                  </div>
                </div>
              ))}

              <input
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                placeholder="Your name (optional)"
                className="min-h-[48px] w-full rounded-xl border border-zinc-200 px-3 text-sm focus:border-zinc-900 focus:outline-none"
              />
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything the kitchen should know? (optional)"
                rows={2}
                className="w-full resize-none rounded-xl border border-zinc-200 px-3 py-3 text-sm focus:border-zinc-900 focus:outline-none"
              />
            </div>
          )}
        </div>

        <div className="border-t border-zinc-200 px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {error && (
            <p className="mb-3 flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>
                {error} If it keeps failing, check My tab before trying again —
                or just ask a member of staff.
              </span>
            </p>
          )}
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm text-zinc-500">This round</span>
            <span className="text-lg font-bold text-zinc-900">
              {money(total)}
            </span>
          </div>
          <button
            onClick={onSend}
            disabled={sending || lines.length === 0}
            className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 text-base font-semibold text-white active:bg-zinc-800 disabled:opacity-60"
          >
            {sending ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" />
                {prepay ? "One moment…" : "Sending…"}
              </>
            ) : prepay ? (
              <>
                <CreditCard className="h-5 w-5" />
                Continue to payment
              </>
            ) : (
              "Send to kitchen"
            )}
          </button>
          {/* Deliberately "continue to payment", not "pay {total}": the shop's
              service charge is worked out server-side, so the honest total is
              the one itemised on the card sheet, not the basket figure. */}
          <p className="mt-2 text-center text-[11px] text-zinc-400">
            {prepay
              ? "Apple Pay, Google Pay or card. Your order reaches the kitchen once it's paid."
              : tabOpen
                ? "Added to your table — settle up with staff at the end."
                : "No payment now — settle up with staff at the end."}
          </p>
        </div>
      </div>
    </div>
  );
}

function SentOverlay({
  paid,
  kitchenConfirmed,
  firstRound,
  tableName,
  onSeeTab,
  onKeepOrdering,
}: {
  /** The round was paid for on the phone rather than added to a tab. */
  paid: boolean;
  /** The server has confirmed the money landed and the order was released
   *  to the kitchen. Until then the copy stays honest about waiting. */
  kitchenConfirmed: boolean;
  firstRound: boolean;
  tableName: string;
  onSeeTab: () => void;
  onKeepOrdering: () => void;
}) {
  // A paid round isn't "sent" until the restaurant has actually been told —
  // the money arriving and the kitchen ticket appearing are the same event
  // server-side, and claiming the first before the second is how a guest
  // ends up waiting for food nobody is cooking.
  const pending = paid && !kitchenConfirmed;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center">
        {pending ? (
          <Loader2
            className="mx-auto h-12 w-12 animate-spin text-zinc-400"
            aria-hidden
          />
        ) : (
          <CheckCircle className="mx-auto h-12 w-12 text-emerald-500" />
        )}
        <h2 className="mt-4 text-xl font-bold text-zinc-900">
          {pending ? "Confirming your payment…" : paid ? "Paid!" : "Sent!"}
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          {pending
            ? "This takes a few seconds — you can keep this screen open."
            : `Your food is on its way to ${tableName}.`}
        </p>
        <p className="mt-3 text-xs text-zinc-500">
          {paid
            ? pending
              ? "Your card has gone through. We're just waiting for the restaurant to confirm before the kitchen starts."
              : "Paid in full — nothing to settle at the end. Order again whenever you like."
            : firstRound
              ? "We've opened a tab for your table. Order as much as you like and settle up with staff at the end."
              : "It's been added to your table's tab. Settle up with staff at the end."}
        </p>
        <div className="mt-6 space-y-2">
          <button
            onClick={onKeepOrdering}
            className="min-h-[48px] w-full rounded-xl bg-zinc-900 text-sm font-semibold text-white active:bg-zinc-800"
          >
            Order something else
          </button>
          <button
            onClick={onSeeTab}
            className="min-h-[48px] w-full rounded-xl border border-zinc-200 text-sm font-semibold text-zinc-700 active:bg-zinc-100"
          >
            {paid ? "See my orders" : "See my tab"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The itemised bill above the card fields.
 *
 * It exists because the amount Stripe takes is NOT the basket total the
 * guest just looked at: the shop's service charge is computed server-side,
 * and a card surcharge can ride on top of it. Quoting one number without
 * showing where it came from is exactly the moment a diner abandons.
 */
function BillSummary({
  money,
  bill,
}: {
  money: MoneyFn;
  bill: TableQrCheckoutResult;
}) {
  const charged = (bill.amountPence ?? Math.round(bill.total * 100)) / 100;
  // Whatever the payment provider adds on top of the restaurant's own bill.
  const cardFee = round2(charged - bill.total);

  return (
    <dl className="space-y-1.5 rounded-xl bg-zinc-50 px-3 py-3 text-sm">
      <div className="flex justify-between text-zinc-600">
        <dt>Items</dt>
        <dd>{money(bill.subtotal)}</dd>
      </div>
      {bill.serviceCharge > 0 && (
        <div className="flex justify-between text-zinc-600">
          <dt>{bill.serviceChargeLabel}</dt>
          <dd>{money(bill.serviceCharge)}</dd>
        </div>
      )}
      {cardFee > 0 && (
        <div className="flex justify-between text-zinc-600">
          <dt>Card fee</dt>
          <dd>{money(cardFee)}</dd>
        </div>
      )}
      <div className="flex justify-between border-t border-zinc-200 pt-1.5 text-base font-bold text-zinc-900">
        <dt>Total</dt>
        <dd>{money(charged)}</dd>
      </div>
    </dl>
  );
}

// ── Error states ───────────────────────────────────────────────────────────

/**
 * Full-page messages for a guest sitting at a table with a phone in their
 * hand. No jargon, no error codes, and always a way out: ask staff.
 */
function ResolveError({ error }: { error: unknown }) {
  const status = error instanceof TableQrError ? error.status : null;
  const raw = error instanceof Error ? error.message : "";

  let title = "Something went wrong";
  let body =
    "We couldn't open the menu for this table. Please ask a member of staff and they'll take your order.";

  if (status === 0) {
    title = "No connection";
    body =
      "Your phone can't reach us right now. Check your signal or the restaurant's wifi and try again — or just ask a member of staff.";
  } else if (status === 404) {
    title = "This code isn't working";
    body =
      "The QR code on your table is out of date. Please ask a member of staff — they'll sort you out straight away.";
  } else if (status === 403) {
    // The API distinguishes "the venue has table ordering switched off" from
    // "this particular table isn't taking orders". Keep both distinct: one
    // means order-from-your-phone isn't a thing here, the other means move on.
    if (/table isn't taking orders|out of service/i.test(raw)) {
      title = "This table isn't taking orders";
      body =
        "Please ask a member of staff — they'll be happy to take your order at the table.";
    } else {
      title = "Ordering from your phone isn't available here";
      body =
        "No problem — a member of staff will take your order whenever you're ready.";
    }
  }

  return (
    <FullPage>
      <div className="grid h-14 w-14 place-items-center rounded-full bg-zinc-100">
        <Utensils className="h-6 w-6 text-zinc-400" />
      </div>
      <h1 className="mt-5 text-center text-lg font-bold text-zinc-900">
        {title}
      </h1>
      <p className="mt-2 max-w-xs text-center text-sm leading-relaxed text-zinc-500">
        {body}
      </p>
      {status === 0 && (
        <button
          onClick={() => window.location.reload()}
          className="mt-6 min-h-[48px] rounded-xl bg-zinc-900 px-6 text-sm font-semibold text-white active:bg-zinc-800"
        >
          Try again
        </button>
      )}
    </FullPage>
  );
}

function FullPage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-6">
      {children}
    </div>
  );
}

// ── Small pieces ───────────────────────────────────────────────────────────

function SegmentButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex min-h-[44px] flex-1 items-center justify-center rounded-xl border text-sm font-semibold transition",
        active
          ? "border-zinc-900 bg-zinc-900 text-white"
          : "border-zinc-200 bg-white text-zinc-700",
      )}
    >
      {children}
    </button>
  );
}

function CategoryChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "min-h-[36px] flex-shrink-0 rounded-full border px-4 text-xs font-semibold transition",
        active
          ? "border-orange-500 bg-orange-500 text-white"
          : "border-zinc-200 bg-white text-zinc-700",
      )}
    >
      {children}
    </button>
  );
}
