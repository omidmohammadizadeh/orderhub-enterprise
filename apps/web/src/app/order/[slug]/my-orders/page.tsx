"use client";

// Phase AP-5 — customer "My Orders" page.
//
// Renders inside the storefront shell so a signed-in customer can see:
//   * Active orders   → with a "Track" CTA that opens the existing
//                       order-status screen (live timeline + cancel
//                       restaurant view).
//   * Order history   → with "View" (item details), "Order again"
//                       (re-fills the cart on the storefront and
//                       bounces the customer back to /order/[slug]),
//                       and "Leave Google review" (deep-links to the
//                       restaurant's Google Business Profile review URL
//                       — hidden when the location hasn't configured
//                       one).
//
// Auth: the page reads the customer token via useCustomerAuth. If
// nobody's signed in, we open the LoginModal immediately rather than
// bouncing to the home page — keeps the deep-link experience.

import { useEffect, useMemo, useState, Suspense } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import axios from "axios";
import {
  Bike,
  CheckCircle2,
  Clock,
  LogIn,
  RefreshCw,
  Star,
  XCircle,
  ChevronRight,
  ChefHat,
  Truck,
  PackageCheck,
} from "lucide-react";
import { useCustomerAuth } from "@/hooks/use-customer-auth";
import { LoginModal } from "@/components/storefront/login-modal";
import { LeaveReviewModal } from "@/components/storefront/leave-review-modal";
import { reviewsClient } from "@/lib/api/reviews.client";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ??
  "https://orderhub-api-0re6.onrender.com/api";

interface OrderItem {
  id: string;
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  modifiers?: Array<{ name: string; price: number }>;
  notes?: string;
}

interface Order {
  id: string;
  displayId: string | null;
  orderNumber: number | null;
  status: string;
  fulfillmentType: string;
  total: number;
  createdAt: string;
  scheduledFor: string | null;
  estimatedReadyAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  paymentStatus: string;
  paymentMethod: string | null;
  items: OrderItem[];
  location: {
    id: string;
    name: string;
    onlineOrderingSlug: string | null;
    googleReviewUrl: string | null;
    logoUrl: string | null;
  };
  brand?: {
    id: string;
    name: string;
    onlineOrderingSlug: string | null;
    logoUrl: string | null;
  } | null;
}

interface OrdersResponse {
  active: Order[];
  history: Order[];
}

export default function MyOrdersPage() {
  return (
    <Suspense
      fallback={
        <div className="grid min-h-screen place-items-center text-zinc-400" />
      }
    >
      <MyOrdersInner />
    </Suspense>
  );
}

function MyOrdersInner() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { customer, token, isLoading: isAuthLoading } = useCustomerAuth();
  const [orders, setOrders] = useState<OrdersResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [viewingOrder, setViewingOrder] = useState<Order | null>(null);
  // Which past orders the customer has already reviewed, so the card shows
  // "Reviewed" instead of inviting a second one (the API rejects duplicates,
  // but finding that out by tapping is a poor way to learn it).
  const [reviewedIds, setReviewedIds] = useState<Set<string>>(new Set());
  const [reviewingOrder, setReviewingOrder] = useState<Order | null>(null);
  // Phase AW-30 follow-up — useSearchParams is reactive and SSR-safe.
  // The previous `typeof window !== "undefined" && new URLSearchParams(...)`
  // pattern returned null during SSR + hydration, so the Back-to-menu
  // href baked in /order/<slug> with no brand and customers landed on
  // the location storefront after tapping it.
  const brandIdFromUrl = searchParams?.get("brand") ?? null;
  const brandSuffix = brandIdFromUrl
    ? `?brand=${encodeURIComponent(brandIdFromUrl)}`
    : "";

  // Open login modal automatically when auth hydration finishes and
  // there's no signed-in customer.
  useEffect(() => {
    if (!isAuthLoading && !customer) {
      setLoginOpen(true);
    }
  }, [isAuthLoading, customer]);

  // Fetch orders once we have a token. The hook clears `customer`
  // (and indirectly `token`) on /me 401 so this re-runs cleanly after
  // logout.
  useEffect(() => {
    if (!token) {
      setOrders(null);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    // Always scope to the storefront the customer is on: storeSlug
    // resolves to this shop's location server-side, so a customer who
    // has ordered from other shops on the platform never sees those
    // orders here. ?brand=<id> (Phase AW brand overlay) narrows
    // further for multi-brand kitchens.
    axios
      .get<OrdersResponse>(`${API_BASE}/v1/customer-auth/orders`, {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          storeSlug: params.slug,
          ...(brandIdFromUrl ? { brandId: brandIdFromUrl } : {}),
        },
      })
      .then((res) => {
        setOrders(res.data);
        // Ask which of these are already reviewed. Best-effort: if it fails the
        // buttons just stay active and the API still blocks a duplicate.
        const ids = (res.data?.history ?? []).map((o: Order) => o.id);
        if (ids.length) {
          reviewsClient
            .reviewed(ids)
            .then((done) => setReviewedIds(new Set(done)))
            .catch(() => {});
        }
      })
      .catch((err: any) => {
        setError(
          err?.response?.data?.message ??
            err?.message ??
            "Couldn't load your orders.",
        );
      })
      .finally(() => setIsLoading(false));
  }, [token, params.slug, brandIdFromUrl]);

  const handleReorder = (order: Order) => {
    // Hand the cart off via sessionStorage rather than localStorage.
    // sessionStorage is tab-scoped so leaving a stale reorder in the
    // bin can't bleed into a future fresh visit; it also clears the
    // moment the customer closes the tab. The storefront page reads
    // this key on mount when ?reorder=1 is present and dispatches an
    // ADD for each line, then deletes the key so a refresh of the
    // storefront doesn't double-fill the cart.
    const cart = order.items.map((it) => ({
      menuItemId: (it as any).menuItemId ?? it.id,
      displayName: it.name,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      modifiers: it.modifiers ?? [],
      notes: it.notes,
    }));
    const slug = order.location.onlineOrderingSlug ?? params.slug;
    try {
      window.sessionStorage.setItem(
        `orderhub.reorder.${slug}`,
        JSON.stringify({
          items: cart,
          restoredFromOrderId: order.id,
          stashedAt: Date.now(),
        }),
      );
    } catch {
      /* private window / quota — proceed anyway, the storefront
         just won't pre-fill in that case */
    }
    const reorderSuffix = brandIdFromUrl
      ? `?reorder=1&brand=${encodeURIComponent(brandIdFromUrl)}`
      : "?reorder=1";
    router.push(`/order/${slug}${reorderSuffix}`);
  };

  return (
    <div className="min-h-screen bg-zinc-50">
      <PageHeader
        storeSlug={params.slug}
        customer={customer}
        brandSuffix={brandSuffix}
      />

      <main className="mx-auto max-w-3xl px-4 py-8 sm:py-10">
        {isAuthLoading || isLoading ? (
          <LoadingState />
        ) : !customer ? (
          <SignedOutState onSignIn={() => setLoginOpen(true)} />
        ) : error ? (
          <ErrorState message={error} />
        ) : (
          <>
            <Section
              title="Active orders"
              empty={!orders?.active?.length}
              emptyHint="No active orders right now — head back to the menu when you're hungry."
            >
              {orders?.active.map((o) => (
                <ActiveCard
                  key={o.id}
                  order={o}
                  onTrack={() =>
                    router.push(
                      `/order/${o.location.onlineOrderingSlug ?? params.slug}/status/${o.id}`,
                    )
                  }
                />
              ))}
            </Section>

            <div className="mt-8">
              <Section
                title="Order history"
                empty={!orders?.history?.length}
                emptyHint="You haven't completed any orders yet."
              >
                {orders?.history.map((o) => (
                  <HistoryCard
                    key={o.id}
                    order={o}
                    onView={() => setViewingOrder(o)}
                    onReorder={() => handleReorder(o)}
                    reviewed={reviewedIds.has(o.id)}
                    onReview={() => setReviewingOrder(o)}
                  />
                ))}
              </Section>
            </div>
          </>
        )}
      </main>

      {/* Login gate */}
      <LoginModal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        storeSlug={params.slug}
        brandId={brandIdFromUrl}
        onAuthenticated={() => setLoginOpen(false)}
      />
      {reviewingOrder && (
        <LeaveReviewModal
          orderId={reviewingOrder.id}
          merchantName={
            reviewingOrder.brand?.name ?? reviewingOrder.location.name
          }
          onClose={() => setReviewingOrder(null)}
          onSubmitted={() =>
            setReviewedIds((prev) => new Set(prev).add(reviewingOrder.id))
          }
        />
      )}

      {/* View-details drawer */}
      {viewingOrder && (
        <ViewOrderDrawer
          order={viewingOrder}
          onClose={() => setViewingOrder(null)}
        />
      )}
    </div>
  );
}

// ── Page chrome ──────────────────────────────────────────────────────

function PageHeader({
  storeSlug,
  customer,
  brandSuffix,
}: {
  storeSlug: string;
  customer: any;
  brandSuffix: string;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
        <a
          href={`/order/${storeSlug}${brandSuffix}`}
          className="inline-flex items-center gap-2 text-sm font-semibold text-zinc-700 hover:text-zinc-900"
        >
          <ChevronRight className="h-4 w-4 rotate-180 text-zinc-400" />
          Back to menu
        </a>
        {customer && (
          <span className="text-xs text-zinc-500">
            Hi, <span className="font-semibold text-zinc-800">{customer.firstName}</span>
          </span>
        )}
      </div>
      <div className="mx-auto max-w-3xl px-4 pb-4">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900">
          My orders
        </h1>
      </div>
    </header>
  );
}

function Section({
  title,
  empty,
  emptyHint,
  children,
}: {
  title: string;
  empty: boolean;
  emptyHint: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        {title}
      </h2>
      {empty ? (
        <div className="rounded-xl border border-dashed border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500">
          {emptyHint}
        </div>
      ) : (
        <div className="space-y-3">{children}</div>
      )}
    </section>
  );
}

// ── Cards ────────────────────────────────────────────────────────────

const STATUS_META: Record<
  string,
  { label: string; color: string; icon: React.ReactNode }
> = {
  PENDING: { label: "Awaiting confirmation", color: "bg-blue-100 text-blue-700", icon: <Clock className="h-3 w-3" /> },
  ACCEPTED: { label: "Accepted", color: "bg-sky-100 text-sky-700", icon: <CheckCircle2 className="h-3 w-3" /> },
  PREPARING: { label: "Preparing", color: "bg-amber-100 text-amber-700", icon: <ChefHat className="h-3 w-3" /> },
  READY: { label: "Ready", color: "bg-emerald-100 text-emerald-700", icon: <CheckCircle2 className="h-3 w-3" /> },
  PENDING_DISPATCH: { label: "Awaiting driver", color: "bg-orange-100 text-orange-700", icon: <Clock className="h-3 w-3" /> },
  ASSIGNED_DRIVER: { label: "Driver assigned", color: "bg-cyan-100 text-cyan-700", icon: <Bike className="h-3 w-3" /> },
  ACCEPTED_BY_DRIVER: { label: "Driver en route", color: "bg-teal-100 text-teal-700", icon: <Truck className="h-3 w-3" /> },
  RIDER_ARRIVED: { label: "Rider at shop", color: "bg-fuchsia-100 text-fuchsia-700", icon: <Bike className="h-3 w-3" /> },
  OUT_FOR_DELIVERY: { label: "Out for delivery", color: "bg-violet-100 text-violet-700", icon: <Bike className="h-3 w-3" /> },
  COMPLETED: { label: "Delivered", color: "bg-green-100 text-green-700", icon: <PackageCheck className="h-3 w-3" /> },
  CANCELLED: { label: "Cancelled", color: "bg-zinc-100 text-zinc-600", icon: <XCircle className="h-3 w-3" /> },
  REJECTED: { label: "Rejected", color: "bg-rose-100 text-rose-700", icon: <XCircle className="h-3 w-3" /> },
  FAILED: { label: "Failed", color: "bg-rose-100 text-rose-700", icon: <XCircle className="h-3 w-3" /> },
};

function ActiveCard({ order, onTrack }: { order: Order; onTrack: () => void }) {
  const meta = STATUS_META[order.status] ?? STATUS_META.PENDING!;
  const merchantName = order.brand?.name ?? order.location.name;
  const merchantLogo = order.brand?.logoUrl ?? order.location.logoUrl;
  return (
    <article className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <div className="flex items-start gap-3 p-4">
        <LocationAvatar location={{ name: merchantName, logoUrl: merchantLogo }} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-bold text-zinc-900">{merchantName}</h3>
            <OrderNumberPill order={order} />
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            {formatItems(order)} · £{order.total.toFixed(2)}
          </p>
          <span className={`mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${meta.color}`}>
            {meta.icon}
            {meta.label}
          </span>
        </div>
      </div>
      <div className="border-t border-zinc-100 bg-zinc-50/60 px-4 py-3">
        <button
          onClick={onTrack}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-orange-500 px-3 py-2 text-sm font-semibold text-white hover:bg-orange-600"
        >
          Track order
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </article>
  );
}

function HistoryCard({
  order,
  onView,
  onReorder,
  reviewed,
  onReview,
}: {
  order: Order;
  onView: () => void;
  onReorder: () => void;
  reviewed: boolean;
  onReview: () => void;
}) {
  const meta = STATUS_META[order.status] ?? STATUS_META.COMPLETED!;
  const date = useMemo(
    () =>
      new Date(order.createdAt).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
    [order.createdAt],
  );
  const merchantName = order.brand?.name ?? order.location.name;
  const merchantLogo = order.brand?.logoUrl ?? order.location.logoUrl;
  return (
    <article className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <div className="flex items-start gap-3 p-4">
        <LocationAvatar location={{ name: merchantName, logoUrl: merchantLogo }} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-bold text-zinc-900">{merchantName}</h3>
            <OrderNumberPill order={order} />
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            {date} · {formatItems(order)} · £{order.total.toFixed(2)}
          </p>
          <span className={`mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${meta.color}`}>
            {meta.icon}
            {meta.label}
          </span>
        </div>
      </div>
      <div className="grid border-t border-zinc-100 bg-zinc-50/60 sm:grid-cols-3">
        <ActionButton onClick={onView}>View order</ActionButton>
        <ActionButton onClick={onReorder} primary>
          <RefreshCw className="h-3.5 w-3.5" />
          Order again
        </ActionButton>
        {reviewed ? (
          <span className="flex items-center justify-center gap-1.5 border-l border-zinc-100 px-3 py-3 text-sm font-semibold text-green-600">
            <Star className="h-3.5 w-3.5 fill-green-600" />
            Reviewed
          </span>
        ) : (
          <button
            onClick={onReview}
            className="flex items-center justify-center gap-1.5 border-l border-zinc-100 px-3 py-3 text-sm font-semibold text-amber-600 hover:bg-amber-50"
          >
            <Star className="h-3.5 w-3.5" />
            Leave a review
          </button>
        )}
      </div>
    </article>
  );
}

function ActionButton({
  onClick,
  primary,
  children,
}: {
  onClick: () => void;
  primary?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center justify-center gap-1.5 border-l border-zinc-100 px-3 py-3 text-sm font-semibold first:border-l-0 ${
        primary
          ? "text-orange-600 hover:bg-orange-50"
          : "text-zinc-700 hover:bg-zinc-100"
      }`}
    >
      {children}
    </button>
  );
}

function LocationAvatar({
  location,
}: {
  location: { name: string; logoUrl: string | null };
}) {
  if (location.logoUrl) {
    return (
      <img
        src={location.logoUrl}
        alt=""
        className="h-12 w-12 rounded-lg border border-zinc-100 bg-white object-contain p-0.5"
      />
    );
  }
  return (
    <div className="grid h-12 w-12 place-items-center rounded-lg bg-orange-500 text-base font-bold text-white">
      {location.name.slice(0, 1).toUpperCase()}
    </div>
  );
}

function OrderNumberPill({ order }: { order: Order }) {
  // Phase AW-30 — prefer the 5-char displayId (matches the receipt).
  const label = order.displayId
    ? `#${order.displayId}`
    : order.orderNumber
      ? `#${order.orderNumber}`
      : null;
  if (!label) return null;
  return (
    <span className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[10px] font-bold text-zinc-600">
      {label}
    </span>
  );
}

function formatItems(order: Order): string {
  const totalQty = order.items.reduce((s, i) => s + i.quantity, 0);
  return `${totalQty} item${totalQty === 1 ? "" : "s"}`;
}

// ── States ────────────────────────────────────────────────────────────

function LoadingState() {
  return (
    <div className="flex h-64 items-center justify-center text-sm text-zinc-400">
      Loading your orders…
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-red-100 bg-red-50 p-6 text-sm text-red-700">
      {message}
    </div>
  );
}

function SignedOutState({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-10 text-center">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-orange-100 text-orange-600">
        <LogIn className="h-5 w-5" />
      </div>
      <h2 className="mt-4 text-lg font-bold text-zinc-900">
        Sign in to see your orders
      </h2>
      <p className="mt-2 text-sm text-zinc-600">
        Active orders, history, and one-tap reorder all live here.
      </p>
      <button
        onClick={onSignIn}
        className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800"
      >
        <LogIn className="h-4 w-4" />
        Sign in
      </button>
    </div>
  );
}

// ── View drawer ──────────────────────────────────────────────────────

function ViewOrderDrawer({
  order,
  onClose,
}: {
  order: Order;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-zinc-100 bg-white px-5 py-3">
          <h3 className="text-base font-bold text-zinc-900">Order details</h3>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100"
          >
            <XCircle className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-3 p-5">
          <div className="flex items-center justify-between">
            <p className="text-xs uppercase tracking-wider text-zinc-400">
              {order.brand?.name ?? order.location.name}
            </p>
            <OrderNumberPill order={order} />
          </div>
          <ul className="divide-y divide-zinc-100">
            {order.items.map((it) => (
              <li key={it.id} className="py-2">
                <div className="flex justify-between text-sm">
                  <span className="font-medium text-zinc-800">
                    {it.quantity}× {it.name}
                  </span>
                  <span className="text-zinc-700">£{it.totalPrice.toFixed(2)}</span>
                </div>
                {it.modifiers && it.modifiers.length > 0 && (
                  <ul className="ml-4 mt-1 list-disc text-xs text-zinc-500">
                    {it.modifiers.map((m, i) => (
                      <li key={i}>
                        {m.name}
                        {m.price ? ` (+£${m.price.toFixed(2)})` : ""}
                      </li>
                    ))}
                  </ul>
                )}
                {it.notes && (
                  <p className="ml-4 mt-1 text-xs italic text-zinc-500">
                    {it.notes}
                  </p>
                )}
              </li>
            ))}
          </ul>
          <div className="border-t border-zinc-100 pt-3">
            <div className="flex justify-between text-sm font-bold text-zinc-900">
              <span>Total</span>
              <span>£{order.total.toFixed(2)}</span>
            </div>
            {order.paymentMethod && (
              <p className="mt-1 text-xs text-zinc-500">
                Paid via {order.paymentMethod.toLowerCase()} ·{" "}
                {order.paymentStatus.toLowerCase()}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
