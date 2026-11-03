"use client";

// Your orders, and one order's progress. The order page polls while the order
// is moving, and is where 3-D Secure and wallet payments land afterwards.

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bike, Check, ChefHat, Clock, Loader2, PackageCheck, Receipt, XCircle } from "lucide-react";
import { eflCustomerApi, EflApiError, type EflOrderDetail } from "@/lib/api/efl-customer";
import { useEflHref } from "../efl-base-context";
import { FOCUS } from "../efl-styles";
import { money } from "../feed/shop-card";
import { Shell } from "./checkout-page";
import { useEflSession, useHydrateEflSession } from "./session";
import { SignInDialog } from "./sign-in-dialog";

const DONE = new Set(["DELIVERED", "COLLECTED", "COMPLETED"]);
const STOPPED = new Set(["CANCELLED", "REJECTED", "FAILED"]);

function statusText(status: string, delivery: boolean): string {
  switch (status) {
    case "PENDING":
      return "Waiting for payment";
    case "RECEIVED":
      return "Sent to the shop";
    case "ACCEPTED":
      return "The shop has your order";
    case "PREPARING":
      return "Being made now";
    case "READY":
      return delivery ? "Ready, waiting for the driver" : "Ready to collect";
    case "OUT_FOR_DELIVERY":
      return "On its way";
    case "RIDER_ARRIVED":
      return "Your driver is outside";
    case "DELIVERED":
      return "Delivered";
    case "COLLECTED":
    case "COMPLETED":
      return "Done. Enjoy!";
    case "CANCELLED":
      return "Cancelled";
    case "REJECTED":
      return "The shop couldn't take this order";
    case "FAILED":
      return "Payment didn't go through";
    default:
      return status.replace(/_/g, " ").toLowerCase();
  }
}

const num = (v: number | string) => Number(v) || 0;

function useSignedIn(): { ready: boolean; signedIn: boolean } {
  useHydrateEflSession();
  const status = useEflSession((s) => s.status);
  return { ready: status !== "unknown", signedIn: status === "signedIn" };
}

function SignInPrompt({ what }: { what: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mx-auto flex max-w-[480px] flex-col items-center gap-3 px-4 py-24 text-center">
      <Receipt aria-hidden="true" className="h-12 w-12 text-[#B5B5B5]" />
      <h1 className="m-0 text-[28px] font-extrabold tracking-[-0.02em]">Sign in to see {what}</h1>
      <p className="m-0 text-[#5E5E5E]">Use the same account as when you ordered.</p>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`efl-press mt-2 min-h-[48px] rounded-full bg-[#0B0B0B] px-6 font-bold text-white ${FOCUS}`}
      >
        Sign in
      </button>
      <SignInDialog open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-24 text-[#5E5E5E]">
      <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" /> {label}
    </div>
  );
}

export function OrdersPage() {
  const href = useEflHref();
  const { ready, signedIn } = useSignedIn();
  const q = useQuery({ queryKey: ["efl-my-orders"], queryFn: eflCustomerApi.myOrders, enabled: signedIn });

  return (
    <Shell>
      {!ready ? (
        <Loading label="Loading…" />
      ) : !signedIn ? (
        <SignInPrompt what="your orders" />
      ) : (
        <div className="mx-auto flex max-w-[720px] flex-col gap-5 px-4 pb-24 pt-6 sm:px-5">
          <h1 className="m-0 text-[32px] font-extrabold tracking-[-0.02em]">Your orders</h1>
          {q.isPending ? (
            <Loading label="Loading your orders…" />
          ) : q.isError ? (
            <p role="alert" className="m-0 rounded-xl bg-[#FDECEC] px-4 py-3 text-sm font-semibold text-[#9B1C1C]">
              We couldn&rsquo;t load your orders. Please try again.
            </p>
          ) : q.data.length === 0 ? (
            <div className="rounded-2xl bg-[#F3F3F3] p-8 text-center">
              <p className="m-0 text-lg font-extrabold">No orders yet</p>
              <Link href={href("/")} className={`mt-2 inline-block rounded font-bold underline underline-offset-4 ${FOCUS}`}>
                Find food near you
              </Link>
            </div>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {q.data.map((o) => (
                <li key={o.id}>
                  <Link
                    href={href(`/orders/${encodeURIComponent(o.id)}`)}
                    className={`efl-press flex min-h-[72px] items-center gap-4 rounded-2xl border border-[#E2E2E2] p-4 hover:border-[#0B0B0B] ${FOCUS}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-bold">{o.brand?.name || o.location?.name || "Your order"}</span>
                      <span className="block text-sm text-[#5E5E5E]">
                        {new Date(o.createdAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                        {" · "}
                        {statusText(o.status, o.fulfillmentType === "DELIVERY")}
                      </span>
                    </span>
                    <span className="text-[15px] font-extrabold tabular-nums">{money(num(o.total))}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Shell>
  );
}

const STEPS_DELIVERY = [
  { status: ["RECEIVED", "ACCEPTED"], label: "Shop has it", icon: Check },
  { status: ["PREPARING", "READY"], label: "Being made", icon: ChefHat },
  { status: ["OUT_FOR_DELIVERY", "RIDER_ARRIVED"], label: "On its way", icon: Bike },
  { status: ["DELIVERED", "COMPLETED", "COLLECTED"], label: "Delivered", icon: PackageCheck },
];
const STEPS_PICKUP = [
  { status: ["RECEIVED", "ACCEPTED"], label: "Shop has it", icon: Check },
  { status: ["PREPARING"], label: "Being made", icon: ChefHat },
  { status: ["READY"], label: "Ready", icon: Clock },
  { status: ["COLLECTED", "COMPLETED", "DELIVERED"], label: "Collected", icon: PackageCheck },
];

function stepIndex(order: EflOrderDetail, steps: typeof STEPS_DELIVERY): number {
  return steps.findIndex((s) => s.status.includes(order.status));
}

export function OrderPage({ orderId }: { orderId: string }) {
  const href = useEflHref();
  const { ready, signedIn } = useSignedIn();
  const q = useQuery({
    queryKey: ["efl-my-order", orderId],
    queryFn: () => eflCustomerApi.myOrder(orderId),
    enabled: signedIn,
    // Every 10s while it's moving; stop once it's finished either way.
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s && (DONE.has(s) || STOPPED.has(s)) ? false : 10_000;
    },
  });

  if (!ready) return <Shell><Loading label="Loading…" /></Shell>;
  if (!signedIn) return <Shell><SignInPrompt what="this order" /></Shell>;
  if (q.isPending) return <Shell><Loading label="Loading your order…" /></Shell>;
  if (q.isError) {
    const missing = q.error instanceof EflApiError && (q.error.status === 404 || q.error.status === 403);
    return (
      <Shell>
        <div className="mx-auto flex max-w-[480px] flex-col items-center gap-3 px-4 py-24 text-center">
          <h1 className="m-0 text-[28px] font-extrabold tracking-[-0.02em]">{missing ? "We can't find that order" : "We couldn't load your order"}</h1>
          <p className="m-0 text-[#5E5E5E]">{missing ? "It may belong to a different account." : "Check your connection and try again."}</p>
          <Link href={href("/orders")} className={`efl-press mt-2 inline-flex min-h-[48px] items-center rounded-full bg-[#0B0B0B] px-6 font-bold text-white ${FOCUS}`}>
            Your orders
          </Link>
        </div>
      </Shell>
    );
  }

  const order = q.data;
  const delivery = order.fulfillmentType === "DELIVERY";
  const steps = delivery ? STEPS_DELIVERY : STEPS_PICKUP;
  const at = stepIndex(order, steps);
  const stopped = STOPPED.has(order.status);
  const eta = order.estimatedReadyAt ? new Date(order.estimatedReadyAt) : null;

  return (
    <Shell>
      <div className="mx-auto flex max-w-[720px] flex-col gap-5 px-4 pb-24 pt-6 sm:px-5">
        <div>
          <p className="m-0 text-sm font-bold text-[#5E5E5E]">
            {order.location?.name ?? "Your order"}
            {order.displayId ? ` · Order ${order.displayId}` : ""}
          </p>
          <h1 aria-live="polite" className="m-0 mt-1 text-[32px] font-extrabold leading-tight tracking-[-0.02em]">
            {statusText(order.status, delivery)}
          </h1>
          {eta && !stopped && !DONE.has(order.status) ? (
            <p className="m-0 mt-1 text-[15px] text-[#5E5E5E]">
              {delivery ? "Expected around " : "Ready around "}
              {eta.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
              {order.driverEtaMinutes != null && order.status === "OUT_FOR_DELIVERY" ? ` · driver ${order.driverEtaMinutes} min away` : ""}
            </p>
          ) : null}
        </div>

        {stopped ? (
          <div className="flex items-start gap-3 rounded-2xl bg-[#FDECEC] p-5 text-[#9B1C1C]">
            <XCircle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
            <p className="m-0 text-[15px] font-semibold">
              {order.cancelReason || "This order won't go ahead."} If you were charged, the money goes back to your card automatically.
            </p>
          </div>
        ) : order.status === "PENDING" ? (
          <p className="m-0 rounded-2xl bg-[#F3F3F3] p-5 text-[15px]">
            We&rsquo;re waiting for your payment to confirm. This page updates by itself.
          </p>
        ) : (
          <ol aria-label="Progress" className="m-0 grid list-none grid-cols-4 gap-2 p-0">
            {steps.map((s, i) => {
              const done = at >= i;
              const Icon = s.icon;
              return (
                <li key={s.label} className="flex flex-col items-center gap-2 text-center">
                  <span
                    className={`flex h-12 w-12 items-center justify-center rounded-full ${done ? "bg-[#D4FF3F]" : "bg-[#F3F3F3] text-[#B5B5B5]"} ${
                      at === i ? "ring-2 ring-[#0B0B0B] ring-offset-2" : ""
                    }`}
                  >
                    <Icon aria-hidden="true" className="h-5 w-5" />
                  </span>
                  <span className={`text-xs font-bold sm:text-sm ${done ? "" : "text-[#8A8A8A]"}`}>
                    {s.label}
                    <span className="sr-only">{done ? " (done)" : ""}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        )}

        {delivery && order.deliveryPin && !order.handedOver && !stopped ? (
          <div className="rounded-2xl bg-[#0B0B0B] p-5 text-white">
            <p className="m-0 text-sm font-bold text-[#D4FF3F]">Your delivery PIN</p>
            <p className="m-0 mt-1 text-[40px] font-extrabold tracking-[0.2em] tabular-nums">{order.deliveryPin}</p>
            <p className="m-0 text-sm text-[#C9C9C9]">Give this to your driver when your food arrives.</p>
          </div>
        ) : null}

        {order.driver?.name && delivery && !stopped ? (
          <p className="m-0 flex items-center gap-2 text-[15px]">
            <Bike aria-hidden="true" className="h-5 w-5" /> {order.driver.name} is delivering your order.
          </p>
        ) : null}

        <section aria-labelledby="items-h" className="rounded-2xl border border-[#E2E2E2] p-5">
          <h2 id="items-h" className="m-0 text-lg font-extrabold">
            What you ordered
          </h2>
          <ul className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
            {order.items.map((it) => (
              <li key={it.id} className="flex justify-between gap-3 text-[15px]">
                <span>
                  {it.quantity} × {it.name}
                </span>
                <span className="tabular-nums">{money(num(it.unitPrice) * it.quantity)}</span>
              </li>
            ))}
          </ul>
          <p className="m-0 mt-3 flex justify-between border-t border-[#E2E2E2] pt-3 text-lg font-extrabold">
            <span>Total</span>
            <span className="tabular-nums">{money(num(order.total))}</span>
          </p>
        </section>

        <p className="m-0 text-sm text-[#5E5E5E]">
          Questions about your order? Use the Eat For Less app to message the shop, or see{" "}
          <Link href={href("/help")} className={`rounded font-bold underline underline-offset-4 ${FOCUS}`}>
            Help
          </Link>
          .
        </p>
      </div>
    </Shell>
  );
}
