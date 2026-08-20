"use client";

// Just Eat (JET Connect) channel management modal — the same organised surface
// as the Uber Eats and Deliveroo ones: header with identity, action bar,
// connection card with editable ids, danger-zone disconnect, and a Menu tab
// carrying the same variant picker every other channel uses.
//
// TWO PLACES THIS DELIBERATELY DIFFERS FROM DELIVEROO
//
// 1. The action bar says "Push hours", not "Push hours + prep". JET Connect
//    has no prep-time endpoint — Deliveroo has workload/times and Uber has
//    update-store-prep-time, JET has neither. Labelling the button the same as
//    the others would promise something it cannot do.
// 2. Pausing asks WHEN THE SHOP COMES BACK. JET treats an offline call with no
//    return time as indefinite, so a shop paused at Friday teatime stays off
//    Just Eat until somebody remembers. The other two channels have no such
//    field; here it is worth one input.

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Clock,
  KeyRound,
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
import { justEatClient } from "@/lib/api/justeat.client";
import { PlatformLogo } from "@/components/ui/platform-logo";
import { ChannelVariantMenuPanel } from "@/components/locations/channel-variant-menu-panel";

export function JustEatManageModal({
  connectionId,
  brandId,
  locationId,
  restaurantReference,
  posLocationId,
  open,
  onClose,
  onChanged,
}: {
  connectionId: string;
  brandId: string;
  locationId: string;
  restaurantReference: string | null;
  posLocationId: string | null;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<"status" | "menu">("status");
  const [editRef, setEditRef] = useState(restaurantReference ?? "");
  const [editPos, setEditPos] = useState(posLocationId ?? "");
  const [menuKey, setMenuKey] = useState("");
  const [orderKey, setOrderKey] = useState("");
  const [dirty, setDirty] = useState(false);
  const [onlineAt, setOnlineAt] = useState("");

  useEffect(() => {
    if (!dirty) {
      setEditRef(restaurantReference ?? "");
      setEditPos(posLocationId ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantReference, posLocationId]);

  // Which key tier each call will actually use, and whether the inbound
  // webhooks are authenticated. Answers "is Just Eat live here?" without
  // exposing a single key value.
  const health = useQuery({
    queryKey: ["jet-health", connectionId],
    queryFn: () => justEatClient.health(connectionId),
    enabled: open,
  });

  const err = (e: any) =>
    toast.error(
      e?.response?.data?.message ?? e?.message ?? "Just Eat request failed",
    );

  const pause = useMutation({
    mutationFn: () => justEatClient.pause(connectionId, onlineAt || undefined),
    onSuccess: () => {
      toast.success(
        onlineAt
          ? `Just Eat restaurant offline until ${onlineAt.replace("T", " ")}`
          : "Just Eat restaurant offline — indefinitely, until you reopen it",
      );
      onChanged();
    },
    onError: err,
  });
  const resume = useMutation({
    mutationFn: () => justEatClient.resume(connectionId),
    onSuccess: () => {
      toast.success("Just Eat restaurant online");
      onChanged();
    },
    onError: err,
  });
  const publishHours = useMutation({
    mutationFn: () => justEatClient.publishHours(connectionId),
    onSuccess: (res) => {
      toast.success(
        `Service times pushed to Just Eat (${res.days?.length ?? 0} open days)`,
      );
      // The intersection rule catches everyone out once: widening the hours
      // here does nothing until the menu's availability is widened too.
      if (res.note) toast(res.note, { icon: "ℹ️", duration: 8000 });
    },
    onError: err,
  });
  const save = useMutation({
    mutationFn: () =>
      justEatClient.connect({
        brandId,
        locationId,
        restaurantReference: editRef.trim(),
        posLocationId: editPos.trim() || undefined,
        menuKey: menuKey.trim() || undefined,
        orderKey: orderKey.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success("Just Eat connection updated");
      setDirty(false);
      setMenuKey("");
      setOrderKey("");
      health.refetch();
      onChanged();
    },
    onError: err,
  });
  const disconnect = useMutation({
    mutationFn: () => justEatClient.disconnect(connectionId),
    onSuccess: () => {
      toast.success("Just Eat disconnected");
      onChanged();
      onClose();
    },
    onError: err,
  });

  if (!open) return null;

  const keySource = (k?: { configured: boolean; source: string }) =>
    !k?.configured
      ? "not configured"
      : k.source === "brand"
        ? "this brand's own key"
        : k.source === "country"
          ? "the country key"
          : "the shared key";

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-zinc-50 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-zinc-200 bg-white px-5 py-4">
          <PlatformLogo platform="JUST_EAT" size={40} />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-zinc-900">Just Eat</h2>
            <p className="truncate text-xs text-zinc-500">
              Restaurant {restaurantReference ?? "—"}
              {posLocationId && posLocationId !== restaurantReference
                ? ` · POS location ${posLocationId}`
                : ""}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex items-center gap-1 border-b border-zinc-200 bg-white px-5 pt-2">
          {[
            { id: "status" as const, label: "Status", icon: Settings2 },
            { id: "menu" as const, label: "Menu", icon: UtensilsCrossed },
          ].map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium ${active ? "border-zinc-900 text-zinc-900" : "border-transparent text-zinc-500 hover:text-zinc-800"}`}
              >
                <t.icon className="h-3.5 w-3.5" />
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
              {resume.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              Open restaurant
            </button>
            <button
              onClick={() => pause.mutate()}
              disabled={pause.isPending}
              className="flex items-center gap-1.5 rounded-lg border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-100 disabled:opacity-50"
            >
              {pause.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Pause className="h-3.5 w-3.5" />
              )}
              Take offline
            </button>
            <button
              onClick={() => publishHours.mutate()}
              disabled={publishHours.isPending}
              title="Pushes the location's opening hours to Just Eat as Delivery + Collection service times"
              className="flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
            >
              {publishHours.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Clock className="h-3.5 w-3.5" />
              )}
              Push hours
            </button>
            <label className="ml-auto flex items-center gap-1.5 text-[11px] text-zinc-500">
              Back online at
              <input
                type="datetime-local"
                value={onlineAt}
                onChange={(e) => setOnlineAt(e.target.value)}
                title="Leave empty and the restaurant stays offline until you reopen it"
                className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] focus:border-zinc-900 focus:outline-none"
              />
            </label>
          </div>
        )}

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {tab === "menu" ? (
            <ChannelVariantMenuPanel
              brandId={brandId}
              locationId={locationId}
              channel="JUST_EAT"
            />
          ) : (
            <>
              <section className="rounded-xl border border-zinc-200 bg-white p-4">
                <h3 className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold text-zinc-800">
                  <Link2 className="h-3.5 w-3.5 text-zinc-400" />
                  Connection
                </h3>
                <div className="space-y-2">
                  <div>
                    <label className="text-[11px] text-zinc-500">
                      Restaurant ID
                    </label>
                    <input
                      value={editRef}
                      onChange={(e) => {
                        setEditRef(e.target.value);
                        setDirty(true);
                      }}
                      className="mt-0.5 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-zinc-500">
                      POS location ID (optional — defaults to the Restaurant ID)
                    </label>
                    <input
                      value={editPos}
                      onChange={(e) => {
                        setEditPos(e.target.value);
                        setDirty(true);
                      }}
                      placeholder={editRef || "same as Restaurant ID"}
                      className="mt-0.5 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
                    />
                    <p className="mt-1 text-[10px] text-zinc-400">
                      What Just Eat stamps on every incoming order. Orders are
                      routed by this value — only change it if Just Eat tells
                      you they send something different.
                    </p>
                  </div>
                  {dirty && (
                    <button
                      onClick={() => save.mutate()}
                      disabled={save.isPending || !editRef.trim()}
                      className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                    >
                      {save.isPending && (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      )}
                      Save connection
                    </button>
                  )}
                </div>
              </section>

              <section className="rounded-xl border border-zinc-200 bg-white p-4">
                <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-zinc-800">
                  <KeyRound className="h-3.5 w-3.5 text-zinc-400" />
                  API keys
                </h3>
                <p className="mb-2.5 text-[11px] text-zinc-500">
                  Just Eat issues these. Leave them empty unless this brand was
                  given its own — otherwise the shared country keys are used.
                </p>
                {health.data && (
                  <p className="mb-2.5 text-[11px] text-zinc-600">
                    Currently using {keySource(health.data.menuKey)} for menus
                    and {keySource(health.data.orderKey)} for orders.
                  </p>
                )}
                <div className="space-y-2">
                  <div>
                    <label className="text-[11px] text-zinc-500">
                      Menu API key
                    </label>
                    <input
                      type="password"
                      value={menuKey}
                      onChange={(e) => {
                        setMenuKey(e.target.value);
                        setDirty(true);
                      }}
                      placeholder={
                        health.data?.hasBrandKeys
                          ? "•••••••• (stored — leave blank to keep)"
                          : "leave empty to use the shared key"
                      }
                      className="mt-0.5 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-zinc-500">
                      Order API key
                    </label>
                    <input
                      type="password"
                      value={orderKey}
                      onChange={(e) => {
                        setOrderKey(e.target.value);
                        setDirty(true);
                      }}
                      placeholder={
                        health.data?.hasBrandKeys
                          ? "•••••••• (stored — leave blank to keep)"
                          : "leave empty to use the shared key"
                      }
                      className="mt-0.5 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
                    />
                  </div>
                </div>
              </section>

              <section className="rounded-xl border border-zinc-200 bg-white p-4">
                <h3 className="mb-1.5 text-xs font-semibold text-zinc-800">
                  How syncing works
                </h3>
                <ul className="list-disc space-y-1 pl-4 text-[11px] text-zinc-500">
                  <li>
                    Orders arrive automatically and are acknowledged back to
                    Just Eat; cancellations and driver updates land on the
                    Orders board.
                  </li>
                  <li>
                    "Push hours" sends this location's opening hours as Delivery
                    and Collection service times. Just Eat trades on the overlap
                    of those, the menu's availability and their delivery-pool
                    hours — so widening hours here needs the menu republished
                    too.
                  </li>
                  <li>
                    Taking the restaurant offline here (or "Stop taking orders"
                    on the Orders board) closes it on Just Eat. Set a back-online
                    time and Just Eat reopens it for you; leave it empty and it
                    stays off until you reopen it.
                  </li>
                  <li>
                    Just Eat has no prep-time setting, unlike Deliveroo and Uber
                    Eats — prep time is not pushed from here.
                  </li>
                </ul>
                {health.data && !health.data.webhookSignatureEnforced && (
                  <p className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-700">
                    Inbound order webhooks are not signature-checked yet — set
                    JET_WEBHOOK_SECRET on the server before going live.
                  </p>
                )}
              </section>

              <section className="rounded-xl border border-red-200 bg-red-50/50 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-xs font-semibold text-red-800">
                      Disconnect Just Eat
                    </h3>
                    <p className="text-[11px] text-red-600/80">
                      Removes the restaurant link and any stored keys from
                      OrderHub. The restaurant itself stays live on Just Eat.
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
