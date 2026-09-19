"use client";

// Glovo channel management modal — same organised surface as the Just Eat,
// Uber Eats and Deliveroo ones: identity header, action bar, connection card,
// danger-zone disconnect, and a Menu tab with the shared variant picker.
//
// THREE PLACES THIS DELIBERATELY DIFFERS FROM THE OTHERS
//
// 1. There is no "Push hours" button. Glovo's API cannot set opening hours —
//    the regular schedule lives in the Glovo Partner Webapp. A button that
//    could only ever fail would be worse than none, so the card says where
//    hours are set instead.
// 2. Closing always has an end time. Glovo has no open-ended close; leaving
//    "Closed until" empty closes it for a week (or until you reopen), and the
//    toast says so rather than implying "indefinitely".
// 3. The Store ID is OURS, not Glovo's. Their docs: "This Store ID is the one
//    provided by you." It has to be handed to Glovo's onboarding team, so it is
//    shown with a copy button rather than asked for.

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Copy,
  Link2,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Settings2,
  Trash2,
  UtensilsCrossed,
  X,
} from "lucide-react";
import toast from "react-hot-toast";
import { glovoClient } from "@/lib/api/glovo.client";
import { PlatformLogo } from "@/components/ui/platform-logo";
import { ChannelVariantMenuPanel } from "@/components/locations/channel-variant-menu-panel";

const MENU_STATUS_TEXT: Record<string, string> = {
  SENDING: "Sending to Glovo…",
  PROCESSING: "Glovo is processing it",
  SUCCESS: "Live on Glovo",
  FETCH_MENU_INVALID_PAYLOAD: "Rejected — Glovo says the menu is invalid",
  FETCH_MENU_SERVER_ERROR: "Glovo could not download the menu from us",
  FETCH_MENU_UNAUTHORIZED: "Glovo was refused when downloading the menu",
  NOT_PROCESSED: "Not processed — the Glovo store setup needs checking",
  LIMIT_EXCEEDED: "Daily upload limit reached (5 a day)",
  GLOVO_ERROR: "Glovo had an internal error — try again later",
  SCHEDULE_CATALOG_DISABLED: "Rejected — this store has no schedule catalogue",
  UPLOAD_FAILED: "Upload failed before Glovo accepted it",
  EXPIRED: "Result no longer available (Glovo keeps it 24 hours)",
};

export function GlovoManageModal({
  connectionId,
  brandId,
  locationId,
  storeId,
  open,
  onClose,
  onChanged,
}: {
  connectionId: string;
  brandId: string;
  locationId: string;
  storeId: string | null;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<"status" | "menu">("status");
  const [editStore, setEditStore] = useState(storeId ?? "");
  const [dirty, setDirty] = useState(false);
  const [closedUntil, setClosedUntil] = useState("");

  useEffect(() => {
    if (!dirty) setEditStore(storeId ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  const health = useQuery({
    queryKey: ["glovo-health", connectionId],
    queryFn: () => glovoClient.health(connectionId),
    enabled: open,
  });

  const err = (e: any) =>
    toast.error(e?.response?.data?.message ?? e?.message ?? "Glovo request failed");

  const pause = useMutation({
    // datetime-local is the operator's wall clock; the API wants an instant.
    mutationFn: () =>
      glovoClient.pause(connectionId, closedUntil ? new Date(closedUntil).toISOString() : undefined),
    onSuccess: (res) => {
      toast.success(
        res.openEnded
          ? `Glovo store closed. Glovo needs an end time, so it reopens by itself on ${new Date(res.until!).toLocaleString()} unless you reopen it sooner.`
          : `Glovo store closed until ${new Date(res.until!).toLocaleString()}`,
        { duration: 8000 },
      );
      onChanged();
    },
    onError: err,
  });
  const resume = useMutation({
    mutationFn: () => glovoClient.resume(connectionId),
    onSuccess: () => {
      toast.success("Glovo store reopened — back on its Glovo schedule");
      onChanged();
    },
    onError: err,
  });
  const save = useMutation({
    mutationFn: () => glovoClient.connect({ brandId, locationId, storeId: editStore.trim() || undefined }),
    onSuccess: () => {
      toast.success("Glovo connection updated — tell Glovo if the Store ID changed");
      setDirty(false);
      health.refetch();
      onChanged();
    },
    onError: err,
  });
  const refreshMenu = useMutation({
    mutationFn: () => glovoClient.menuStatus(connectionId),
    onSuccess: () => health.refetch(),
    onError: err,
  });
  const disconnect = useMutation({
    mutationFn: () => glovoClient.disconnect(connectionId),
    onSuccess: () => {
      toast.success("Glovo disconnected");
      onChanged();
      onClose();
    },
    onError: err,
  });

  if (!open) return null;

  const pub = health.data?.menuPublish ?? null;
  const copy = (text: string) =>
    navigator.clipboard
      ?.writeText(text)
      .then(() => toast.success("Copied"))
      .catch(() => toast.error("Copy failed"));

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="glovo-manage-title"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-zinc-50 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-zinc-200 bg-white px-5 py-4">
          <PlatformLogo platform="GLOVO" size={40} />
          <div className="min-w-0 flex-1">
            <h2 id="glovo-manage-title" className="text-base font-semibold text-zinc-900">
              Glovo
            </h2>
            <p className="truncate text-xs text-zinc-500">
              Store ID {storeId ?? "—"}
              {health.data ? ` · ${health.data.environment === "production" ? "Production" : "Stage (testing)"}` : ""}
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
            <label className="ml-auto flex items-center gap-1.5 text-[11px] text-zinc-500">
              Closed until
              <input
                type="datetime-local"
                value={closedUntil}
                onChange={(e) => setClosedUntil(e.target.value)}
                title="Glovo needs an end time. Leave empty and the store closes for 7 days or until you reopen it."
                className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] focus:border-zinc-900 focus:outline-none"
              />
            </label>
          </div>
        )}

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {tab === "menu" ? (
            <>
              <section className="rounded-xl border border-zinc-200 bg-white p-4">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold text-zinc-800">Last menu upload</h3>
                  {pub?.transactionId && (
                    <button
                      onClick={() => refreshMenu.mutate()}
                      disabled={refreshMenu.isPending}
                      className="flex items-center gap-1 rounded-md border border-zinc-300 px-2 py-1 text-[10px] font-medium hover:bg-zinc-50 disabled:opacity-50"
                    >
                      <RefreshCw className={`h-3 w-3 ${refreshMenu.isPending ? "animate-spin" : ""}`} />
                      Check now
                    </button>
                  )}
                </div>
                {pub ? (
                  <div className="space-y-1 text-[11px] text-zinc-600">
                    <p>
                      <span
                        className={
                          pub.status === "SUCCESS"
                            ? "font-semibold text-emerald-700"
                            : pub.status === "PROCESSING" || pub.status === "SENDING"
                              ? "font-semibold text-amber-700"
                              : "font-semibold text-red-700"
                        }
                      >
                        {MENU_STATUS_TEXT[pub.status ?? ""] ?? pub.status ?? "—"}
                      </span>
                      {pub.sentAt ? ` · sent ${new Date(pub.sentAt).toLocaleString()}` : ""}
                    </p>
                    {pub.details.length > 0 && (
                      <ul className="list-disc pl-4 text-zinc-500">
                        {pub.details.slice(0, 5).map((d) => (
                          <li key={d}>{d}</li>
                        ))}
                      </ul>
                    )}
                    <p className="text-zinc-400">
                      {pub.uploadsLast24h} of 5 full uploads used in the last 24 hours. Publish from
                      Menus → Publish → Glovo.
                    </p>
                  </div>
                ) : (
                  <p className="text-[11px] text-zinc-500">
                    No menu sent yet. Publish from Menus → Publish → Glovo.
                  </p>
                )}
              </section>
              <ChannelVariantMenuPanel brandId={brandId} locationId={locationId} channel="GLOVO" />
            </>
          ) : (
            <>
              <section className="rounded-xl border border-zinc-200 bg-white p-4">
                <h3 className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold text-zinc-800">
                  <Link2 className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />
                  Connection
                </h3>
                <label htmlFor="glovo-store-id" className="text-[11px] text-zinc-500">
                  Store ID — give this to Glovo for this store address
                </label>
                <div className="mt-0.5 flex gap-1.5">
                  <input
                    id="glovo-store-id"
                    value={editStore}
                    onChange={(e) => {
                      setEditStore(e.target.value);
                      setDirty(true);
                    }}
                    spellCheck={false}
                    autoComplete="off"
                    className="w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 font-mono text-xs focus:border-zinc-900 focus:outline-none"
                  />
                  <button
                    onClick={() => copy(editStore)}
                    aria-label="Copy Store ID"
                    className="rounded-lg border border-zinc-300 px-2 text-zinc-600 hover:bg-zinc-100"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="mt-1 text-[10px] text-zinc-400">
                  Glovo routes every order by this value. Change it only together with Glovo.
                </p>
                {dirty && (
                  <button
                    onClick={() => save.mutate()}
                    disabled={save.isPending}
                    className="mt-2 flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {save.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                    Save connection
                  </button>
                )}
                {health.data?.lastOrder && (
                  <p className="mt-2.5 text-[11px] text-zinc-500">
                    Last Glovo order {health.data.lastOrder.displayId ?? ""} at{" "}
                    {new Date(health.data.lastOrder.createdAt).toLocaleString()}
                  </p>
                )}
              </section>

              <section className="rounded-xl border border-zinc-200 bg-white p-4">
                <h3 className="mb-1.5 text-xs font-semibold text-zinc-800">How syncing works</h3>
                <ul className="list-disc space-y-1 pl-4 text-[11px] text-zinc-500">
                  <li>
                    Glovo sends an order when the kitchen should start it, based on when the courier
                    will arrive — not the moment the customer pays. The Glovo pick-up code is at the
                    top of the ticket.
                  </li>
                  <li>
                    Accepting, marking ready and handing over on the Orders board updates Glovo.
                  </li>
                  <li>
                    Glovo has no way to cancel an order from here. Phone Glovo support to cancel, or
                    the courier will still come.
                  </li>
                  <li>
                    Opening hours are set in the Glovo Partner Webapp — Glovo&apos;s API cannot change
                    them. Closing here (or &ldquo;Stop taking orders&rdquo; on the Orders board)
                    closes the store on Glovo until the time you set.
                  </li>
                  <li>Marking an item out of stock takes it off Glovo, and puts it back when it returns.</li>
                </ul>
                {health.data && !health.data.webhookAuthEnforced && (
                  <p className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-700">
                    Incoming Glovo orders are not authenticated yet — set GLOVO_API_TOKEN on the server
                    before going live.
                  </p>
                )}
              </section>

              <section className="rounded-xl border border-red-200 bg-red-50/50 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-xs font-semibold text-red-800">Disconnect Glovo</h3>
                    <p className="text-[11px] text-red-600/80">
                      Orders stop reaching the board. The store stays live on Glovo — ask Glovo to
                      detach the Store ID as well.
                    </p>
                  </div>
                  <button
                    onClick={() => disconnect.mutate()}
                    disabled={disconnect.isPending}
                    className="flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
                  >
                    {disconnect.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
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
