"use client";

// The page a share link opens: "Sarah wants you to add your order."
//
// It exists so a guest lands on something that explains itself before it
// starts asking for money's worth of decisions. All it collects is a name —
// there is no account, and the name is what the shop reads off the ticket when
// it bags the order. Once that's in, the guest is handed to the ordinary
// storefront in group mode (?group=<token>), which already knows how to render
// the menu, the modifier sheet and the shared basket.
//
// The brand pin travels with them: a kitchen running several brands serves a
// different menu per brand, and the basket knows which one it was opened for.

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import axios from "axios";
import { Loader2, Lock, Users } from "lucide-react";
import {
  getGuestName,
  getGuestRef,
  groupOrdersClient,
  setGuestName,
} from "@/lib/api/group-orders.client";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export default function GroupOrderJoinPage() {
  const { slug, token } = useParams<{ slug: string; token: string }>();
  const router = useRouter();
  const [myRef, setMyRef] = useState("");
  const [name, setName] = useState("");

  // The ref lives in localStorage, so it can only be read on the client.
  useEffect(() => {
    setMyRef(getGuestRef());
    setName(getGuestName());
  }, []);

  const basketQuery = useQuery({
    queryKey: ["group-order", token, myRef],
    queryFn: () => groupOrdersClient.get(String(token), myRef || undefined),
    enabled: !!token,
    retry: false,
  });
  const basket = basketQuery.data;

  // Whose shop is this? Worth the second request: a link with a name and a
  // logo on it reads as an invitation, and a bare token reads as a phishing
  // attempt. Chained off the basket so the brand pin is right.
  const storeQuery = useQuery({
    queryKey: ["storefront-lite", slug, basket?.brandId],
    queryFn: () =>
      axios
        .get(`${API_BASE}/v1/ordering/store/${slug}`, {
          params: basket?.brandId ? { brand: basket.brandId } : undefined,
        })
        .then((r) => r.data),
    enabled: !!basket,
    retry: false,
  });
  const store = storeQuery.data;
  const storeName =
    store?.location?.name ?? store?.brand?.name ?? "the restaurant";
  const logoUrl = store?.brand?.logoUrl ?? store?.location?.logoUrl ?? null;

  const menuHref = `/order/${slug}?group=${encodeURIComponent(
    String(token),
  )}${basket?.brandId ? `&brand=${encodeURIComponent(basket.brandId)}` : ""}`;

  const join = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setGuestName(trimmed);
    router.push(menuHref);
  };

  if (basketQuery.isLoading || !myRef) {
    return (
      <Shell>
        <Loader2 className="h-7 w-7 animate-spin text-orange-500" />
      </Shell>
    );
  }

  // A dead link is the common case here — baskets expire after a few hours,
  // and the message has to say which kind of dead it is or the guest just
  // messages the host asking why it's broken.
  if (basketQuery.error || !basket) {
    const message =
      ((basketQuery.error as any)?.response?.data?.message as string) ??
      "This group order link isn't valid any more.";
    return (
      <Shell>
        <Card>
          <h1 className="text-lg font-bold text-zinc-900">
            Group order unavailable
          </h1>
          <p className="mt-1 text-sm text-zinc-500">{message}</p>
          <a
            href={`/order/${slug}`}
            className="mt-4 inline-flex w-full items-center justify-center rounded-lg bg-orange-500 px-3 py-2.5 text-sm font-semibold text-white hover:bg-orange-600"
          >
            Order on your own instead
          </a>
        </Card>
      </Shell>
    );
  }

  if (basket.status === "PLACED") {
    return (
      <Shell>
        <Card>
          <h1 className="text-lg font-bold text-zinc-900">
            This group order has been placed
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            {basket.hostName ?? "The host"} already sent it to {storeName}.
            Anything you add now would be a separate order.
          </p>
          <a
            href={`/order/${slug}`}
            className="mt-4 inline-flex w-full items-center justify-center rounded-lg bg-orange-500 px-3 py-2.5 text-sm font-semibold text-white hover:bg-orange-600"
          >
            Start your own order
          </a>
        </Card>
      </Shell>
    );
  }

  if (basket.status === "CANCELLED" || basket.status === "EXPIRED") {
    return (
      <Shell>
        <Card>
          <h1 className="text-lg font-bold text-zinc-900">
            {basket.status === "EXPIRED"
              ? "This group order has expired"
              : "This group order was cancelled"}
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            {basket.status === "EXPIRED"
              ? "Shared baskets stay open for a few hours. Ask whoever sent the link to start a new one."
              : `${basket.hostName ?? "The host"} called it off.`}
          </p>
          <a
            href={`/order/${slug}`}
            className="mt-4 inline-flex w-full items-center justify-center rounded-lg bg-orange-500 px-3 py-2.5 text-sm font-semibold text-white hover:bg-orange-600"
          >
            Order on your own
          </a>
        </Card>
      </Shell>
    );
  }

  const locked = basket.status === "LOCKED";
  // Someone who already has lines in this basket doesn't need to introduce
  // themselves again — they're coming back to add another thing.
  const alreadyIn = basket.items.some((i) => i.addedByRef === myRef);

  return (
    <Shell>
      <Card>
        <div className="flex items-center gap-3">
          {logoUrl ? (
            <img
              src={logoUrl}
              alt=""
              className="h-12 w-12 shrink-0 rounded-lg bg-white object-contain p-1 ring-1 ring-zinc-100"
            />
          ) : (
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-orange-500 text-lg font-bold text-white">
              {storeName.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-orange-600">
              <Users className="h-3.5 w-3.5" /> Group order
            </p>
            <h1 className="truncate text-lg font-bold text-zinc-900">
              {storeName}
            </h1>
          </div>
        </div>

        <p className="mt-4 text-sm text-zinc-700">
          <strong>{basket.hostName ?? "Someone"}</strong> started a shared
          basket
          {basket.fulfillmentType === "DELIVERY"
            ? " for delivery"
            : " for collection"}
          . Add what you want — {basket.hostName ?? "they"} places and pays for
          the whole order.
        </p>

        {basket.people.length > 0 && (
          <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              In the basket so far
            </p>
            <ul className="mt-1.5 space-y-1">
              {basket.people.map((p) => (
                <li
                  key={p.ref}
                  className="flex items-center justify-between text-xs text-zinc-700"
                >
                  <span className="truncate">
                    {p.name}
                    {p.ref === myRef && (
                      <span className="ml-1 text-[10px] font-semibold uppercase text-orange-600">
                        you
                      </span>
                    )}
                    <span className="text-zinc-400">
                      {" "}
                      · {p.count} {p.count === 1 ? "item" : "items"}
                    </span>
                  </span>
                  <span className="shrink-0 font-medium">
                    £{p.total.toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex items-center justify-between border-t border-zinc-200 pt-2 text-xs font-bold text-zinc-900">
              <span>Basket total</span>
              <span>£{basket.subtotal.toFixed(2)}</span>
            </div>
          </div>
        )}

        {locked ? (
          <div className="mt-4">
            <p className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-xs text-zinc-600">
              <Lock className="h-3.5 w-3.5 shrink-0" />
              {basket.hostName ?? "The host"} has closed the basket and is
              checking out — nothing else can be added.
            </p>
            <a
              href={menuHref}
              className="mt-3 inline-flex w-full items-center justify-center rounded-lg border border-zinc-300 px-3 py-2.5 text-sm font-semibold text-zinc-700 hover:bg-zinc-50"
            >
              View the basket
            </a>
          </div>
        ) : (
          <div className="mt-4">
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Your name
            </label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") join();
              }}
              placeholder="e.g. Tom"
              maxLength={40}
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-zinc-400">
              Goes on the items you add so the kitchen can bag them separately.
            </p>
            <button
              type="button"
              onClick={join}
              disabled={!name.trim()}
              className="mt-3 flex w-full items-center justify-center rounded-lg bg-orange-500 px-3 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
            >
              {alreadyIn ? "Back to the menu" : "Join & pick your food"}
            </button>
          </div>
        )}
      </Card>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-zinc-50 px-4 py-10">
      {children}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
      {children}
    </div>
  );
}
