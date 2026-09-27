"use client";

// Keeta channel management modal — same organised surface as the Glovo, Just
// Eat, Uber Eats and Deliveroo ones: identity header, action bar, connection
// card, danger-zone disconnect, and a Menu tab with the shared variant picker.
//
// WHERE KEETA DIFFERS
//
// 1. Closing has no end time. Keeta's API only suspends and reopens — and it
//    closes delivery and pickup together. Keeta can also close a store on
//    their own (weather, or as a penalty for orders left unconfirmed), and
//    only Keeta can reopen it then; the card says so when that happens.
// 2. Publishing a menu from OrderHub LOCKS the menu editor in Keeta's merchant
//    portal for this store. From then on OrderHub is where the Keeta menu
//    lives — said on the Menu tab before anyone is surprised by it.
// 3. The access token belongs to the Keeta BRAND authorization, not to this
//    store, so the connection card shows the authorization's health too.

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Clock,
  Link2,
  Loader2,
  Pause,
  Play,
  Settings2,
  Trash2,
  UtensilsCrossed,
  X,
} from "lucide-react";
import toast from "react-hot-toast";
import { keetaClient } from "@/lib/api/keeta.client";
import { PlatformLogo } from "@/components/ui/platform-logo";
import { ChannelVariantMenuPanel } from "@/components/locations/channel-variant-menu-panel";

const MENU_STATUS_TEXT: Record<string, string> = {
  PROCESSING: "Keeta is processing it",
  SUCCESS: "Live on Keeta",
  PARTIAL: "Live on Keeta, but some products were rejected",
  FAILED: "Rejected by Keeta",
  SEND_FAILED: "Upload failed before Keeta accepted it",
};

export function KeetaManageModal({
  connectionId,
  brandId,
  locationId,
  open,
  onClose,
  onChanged,
}: {
  connectionId: string;
  brandId: string;
  locationId: string;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<"status" | "menu">("status");

  const health = useQuery({
    queryKey: ["keeta-health", connectionId],
    queryFn: () => keetaClient.health(connectionId),
    enabled: open,
    // A menu publish settles on a webhook a minute or two later.
    refetchInterval: (q) => (q.state.data?.menuPublish?.status === "PROCESSING" ? 10_000 : false),
  });

  const err = (e: any) => toast.error(e?.response?.data?.message ?? e?.message ?? "Keeta request failed");

  const pause = useMutation({
    mutationFn: () => keetaClient.pause(connectionId),
    onSuccess: () => {
      toast.success("Keeta store closed — delivery and pickup. It stays closed until you reopen it.", {
        duration: 7000,
      });
      health.refetch();
      onChanged();
    },
    onError: err,
  });
  const resume = useMutation({
    mutationFn: () => keetaClient.resume(connectionId),
    onSuccess: () => {
      toast.success("Keeta store reopened");
      health.refetch();
      onChanged();
    },
    onError: err,
  });
  const hours = useMutation({
    mutationFn: () => keetaClient.publishHours(connectionId),
    onSuccess: (r) =>
      toast.success(
        r.configured
          ? "Opening hours sent to Keeta"
          : "No opening hours are set for this location, so Keeta was told it's open all week. Set real hours before going live.",
        { duration: r.configured ? 4000 : 9000 },
      ),
    onError: err,
  });
  const disconnect = useMutation({
    mutationFn: () => keetaClient.disconnect(connectionId),
    onSuccess: () => {
      toast.success("Keeta disconnected");
      onChanged();
      onClose();
    },
    onError: err,
  });

  if (!open) return null;

  const h = health.data;
  const pub = h?.menuPublish ?? null;
  const closedByKeeta = h?.storeStatus?.status === 4 && h?.status !== "suspended";
  const authBad = h?.authorization && h.authorization.status !== "active";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="keeta-manage-title"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-zinc-50 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-zinc-200 bg-white px-5 py-4">
          <PlatformLogo platform="KEETA" size={40} />
          <div className="min-w-0 flex-1">
            <h2 id="keeta-manage-title" className="text-base font-semibold text-zinc-900">
              Keeta
            </h2>
            <p className="truncate text-xs text-zinc-500">
              {h?.shopName ? `${h.shopName} · ` : ""}Store {h?.shopId ?? "—"}
              {h ? ` · ${h.environment === "production" ? "Production" : "Test app"}` : ""}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-900"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex items-center gap-1 border-b border-zinc-200 bg-white px-5 pt-2" role="tablist">
          {[
            { id: "status" as const, label: "Status", icon: Settings2 },
            { id: "menu" as const, label: "Menu", icon: UtensilsCrossed },
          ].map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium ${active ? "border-zinc-900 text-zinc-900" : "border-transparent text-zinc-500 hover:text-zinc-800"}`}
              >
                <t.icon className="h-3.5 w-3.5" aria-hidden="true" />
                {t.label}
              </button>
            );
          })}
        </div>

        {tab === "status" && (
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 bg-white px-5 py-3">
            <button
              onClick={() => resume.mutate()}
              disabled={resume.isPending}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {resume.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Open store
            </button>
            <button
              onClick={() => pause.mutate()}
              disabled={pause.isPending}
              className="flex items-center gap-1.5 rounded-lg border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-100 disabled:opacity-50"
            >
              {pause.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pause className="h-3.5 w-3.5" />}
              Close store
            </button>
            <button
              onClick={() => hours.mutate()}
              disabled={hours.isPending}
              className="ml-auto flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
            >
              {hours.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />}
              Push opening hours
            </button>
          </div>
        )}

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {tab === "menu" ? (
            <>
              <section className="rounded-xl border border-zinc-200 bg-white p-4">
                <h3 className="mb-1.5 text-xs font-semibold text-zinc-800">Last menu publish</h3>
                {pub ? (
                  <div className="space-y-1 text-[11px] text-zinc-600">
                    <p>
                      <span
                        className={
                          pub.status === "SUCCESS"
                            ? "font-semibold text-emerald-700"
                            : pub.status === "PROCESSING"
                              ? "font-semibold text-amber-700"
                              : "font-semibold text-red-700"
                        }
                      >
                        {MENU_STATUS_TEXT[pub.status ?? ""] ?? pub.status ?? "—"}
                      </span>
                      {pub.sentAt ? ` · sent ${new Date(pub.sentAt).toLocaleString()}` : ""}
                      {pub.stats ? ` · ${pub.stats.spus} products, ${pub.stats.groups} option groups` : ""}
                    </p>
                    {pub.errors.length > 0 && (
                      <ul className="list-disc pl-4 text-red-700/90">
                        {pub.errors.slice(0, 8).map((e, i) => (
                          <li key={i}>
                            {e.name ?? e.code ?? "Menu"}: {e.message}
                          </li>
                        ))}
                      </ul>
                    )}
                    {pub.pictureErrors.length > 0 && (
                      <p className="text-amber-700">
                        {pub.pictureErrors.length} photo(s) rejected — Keeta need at least 600×450 and under 5MB.
                      </p>
                    )}
                    {pub.warnings.length > 0 && (
                      <details className="text-zinc-500">
                        <summary className="cursor-pointer">{pub.warnings.length} warning(s)</summary>
                        <ul className="list-disc pl-4">
                          {pub.warnings.slice(0, 20).map((w, i) => (
                            <li key={i}>{w}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                ) : (
                  <p className="text-[11px] text-zinc-500">No menu sent yet. Publish from Menus → Publish → Keeta.</p>
                )}
                <p className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
                  Publishing replaces the whole Keeta menu for this store, and Keeta then lock menu editing in their
                  merchant portal — manage the Keeta menu here from then on.
                </p>
              </section>
              <ChannelVariantMenuPanel brandId={brandId} locationId={locationId} channel="KEETA" />
            </>
          ) : (
            <>
              {closedByKeeta && (
                <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-800">
                  Keeta show this store as <strong>closed</strong>, and nobody closed it from here. Keeta close stores
                  for weather or when orders go unconfirmed — only Keeta can lift their own suspension.
                </p>
              )}
              <section className="rounded-xl border border-zinc-200 bg-white p-4">
                <h3 className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold text-zinc-800">
                  <Link2 className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />
                  Connection
                </h3>
                <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-[11px]">
                  <dt className="text-zinc-500">Keeta store</dt>
                  <dd className="font-mono text-zinc-800">
                    {h?.shopName ?? "—"} ({h?.shopId ?? "—"})
                  </dd>
                  <dt className="text-zinc-500">Authorization</dt>
                  <dd className={authBad ? "font-medium text-red-700" : "text-zinc-800"}>
                    {h?.authorization
                      ? `${h.authorization.brandName ?? "Keeta brand"} · ${h.authorization.status} · renews before ${new Date(h.authorization.expiresAt).toLocaleDateString()}`
                      : "—"}
                  </dd>
                </dl>
                {authBad && (
                  <p className="mt-2 rounded-md bg-red-50 px-2 py-1.5 text-[11px] text-red-700">
                    {h?.authorization?.lastError ?? "The Keeta authorization is not active."} Re-authorize Keeta for
                    this brand to restore it.
                  </p>
                )}
                {h?.lastError && <p className="mt-2 text-[11px] text-red-700">{h.lastError}</p>}
                {h?.lastOrder && (
                  <p className="mt-2.5 text-[11px] text-zinc-500">
                    Last Keeta order {h.lastOrder.displayId ?? ""} at {new Date(h.lastOrder.createdAt).toLocaleString()}
                  </p>
                )}
              </section>

              <section className="rounded-xl border border-zinc-200 bg-white p-4">
                <h3 className="mb-1.5 text-xs font-semibold text-zinc-800">How syncing works</h3>
                <ul className="list-disc space-y-1 pl-4 text-[11px] text-zinc-500">
                  <li>
                    Keeta orders land on the Orders board. <strong>Accept within 5 minutes</strong> — Keeta cancel
                    unconfirmed orders and can close the store for it.
                  </li>
                  <li>Accepting, marking ready and cancelling on the board updates Keeta. Keeta&apos;s rider is tracked on the order.</li>
                  <li>
                    Refund requests from customers appear in the activity log. Keeta approve them automatically after 15
                    minutes without an answer.
                  </li>
                  <li>
                    Marking an item out of stock takes it off Keeta, and puts it back when it returns. &ldquo;Stop taking
                    orders&rdquo; on the Orders board closes the Keeta store too.
                  </li>
                </ul>
              </section>

              <section className="rounded-xl border border-red-200 bg-red-50/50 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-xs font-semibold text-red-800">Disconnect Keeta</h3>
                    <p className="text-[11px] text-red-600/80">
                      Orders for this store stop reaching the board and stay in the Keeta merchant app. To remove
                      OrderHub&apos;s access completely, the merchant revokes it in Keeta.
                    </p>
                  </div>
                  <button
                    onClick={() => disconnect.mutate()}
                    disabled={disconnect.isPending}
                    className="flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
                  >
                    {disconnect.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                    Disconnect
                  </button>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
