"use client";

// Phase AW-14 — Menu Availability ("86 board").
//
// Operator flow:
//   1. Pick a brand at this location.
//   2. See every product in a row, with a toggle under each channel column.
//   3. Toggle a channel OFF → duration sheet opens (1h / 2h / … / custom).
//   4. Save → row turns red for that channel, item is hidden on the
//      storefront / POS / HubRise for the chosen duration.
//   5. Toggle ON → row goes green, item restored on all consumers.
//
// Replaced the old ingredients/suppliers/PO inventory page entirely
// — that's restaurant-level inventory which is a separate concern.
// If we need to bring those back they live in apps/api inventory
// service; just a new tab on this page.

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, X, AlertCircle, Check } from "lucide-react";
import toast from "react-hot-toast";
import { brandsClient, type Brand } from "@/lib/api/locations.client";
import {
  menuAvailabilityClient,
  CHANNELS,
  DURATIONS,
  type Channel,
  type DurationPreset,
  type InventoryItem,
} from "@/lib/api/menu-availability.client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { PlatformLogo } from "@/components/ui/platform-logo";

const CHANNEL_LABELS: Record<Channel, string> = {
  ONLINE: "Online ordering",
  POS: "POS",
  JUST_EAT: "Just Eat",
  UBER_EATS: "Uber Eats",
  DELIVEROO: "Deliveroo",
  WHATSAPP: "WhatsApp",
  HUBRISE: "HubRise",
};

const PLATFORM_LOGO_KEY: Record<Channel, string> = {
  ONLINE: "ONLINE",
  POS: "POS",
  JUST_EAT: "JUST_EAT",
  UBER_EATS: "UBER_EATS",
  DELIVEROO: "DELIVEROO",
  WHATSAPP: "ONLINE",
  HUBRISE: "HUBRISE",
};

const DURATION_LABELS: Record<DurationPreset, string> = {
  "1h": "1 hour",
  "2h": "2 hours",
  "4h": "4 hours",
  "6h": "6 hours",
  "12h": "12 hours",
  until_tomorrow: "Until tomorrow",
  indefinite: "Until I restore",
};

export default function InventoryPage() {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);

  // ── Brand picker ─────────────────────────────────────────────────────
  const brandsQuery = useQuery({
    queryKey: ["brands", locationId, "served"],
    // served: include brands whose menu is served here via an assignment, not
    // just brands homed at this location — so a shared/imported menu published
    // to serve here shows up and its availability can be managed.
    queryFn: () => brandsClient.list(locationId ?? undefined, { served: true }),
    enabled: !!locationId,
  });
  const brands = brandsQuery.data ?? [];
  const [brandId, setBrandId] = useState<string>("");

  useEffect(() => {
    if (!brandId && brands.length > 0) setBrandId(brands[0]!.id);
  }, [brands, brandId]);

  // ── Inventory matrix ────────────────────────────────────────────────
  // Phase BA — the matrix is a LOCATION view: this location's own snoozes
  // overlay the global ("all locations") rows, and toggles below write
  // location-scoped rows so 86ing here never affects another location.
  const matrixQuery = useQuery({
    queryKey: ["menu-availability", brandId, locationId],
    queryFn: () =>
      menuAvailabilityClient.getMatrix(brandId, locationId ?? undefined),
    enabled: !!brandId,
    refetchInterval: 30_000,
  });
  const items = matrixQuery.data?.items ?? [];

  // ── Mutations ───────────────────────────────────────────────────────
  const qc = useQueryClient();
  const refetchKey = ["menu-availability", brandId, locationId];

  const snoozeMutation = useMutation({
    mutationFn: async (args: {
      itemId: string;
      channel: Channel;
      duration?: DurationPreset;
      customExpiresAt?: string;
    }) => {
      // Strip itemId from the body — it's in the URL path. NestJS
      // ValidationPipe (whitelist + forbidNonWhitelisted) rejects
      // unknown properties otherwise.
      const { itemId, ...body } = args;
      return menuAvailabilityClient.snooze(itemId, {
        ...body,
        // Phase BA — 86 at THIS location only.
        ...(locationId ? { locationId } : {}),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: refetchKey }),
    onError: (err: any) =>
      toast.error(
        `Failed to snooze: ${err?.response?.data?.message ?? err?.message ?? "Unknown error"}`,
      ),
  });

  const unsnoozeMutation = useMutation({
    // Phase BA — restores here; the API falls back to clearing a global
    // snooze when this location has no row of its own.
    mutationFn: async (args: { itemId: string; channel: Channel }) =>
      menuAvailabilityClient.unsnooze(
        args.itemId,
        args.channel,
        locationId ?? undefined,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: refetchKey }),
    onError: (err: any) =>
      toast.error(
        `Failed to restore: ${err?.response?.data?.message ?? err?.message ?? "Unknown error"}`,
      ),
  });

  // ── Duration picker sheet ───────────────────────────────────────────
  const [pendingSnooze, setPendingSnooze] = useState<{
    itemId: string;
    itemName: string;
    channel: Channel;
  } | null>(null);

  const handleToggle = (item: InventoryItem, channel: Channel) => {
    const isSnoozedNow = !!item.snoozes[channel];
    if (isSnoozedNow) {
      unsnoozeMutation.mutate({ itemId: item.id, channel });
      toast.success(`${item.name} restored for ${CHANNEL_LABELS[channel]}`);
    } else {
      setPendingSnooze({ itemId: item.id, itemName: item.name, channel });
    }
  };

  const confirmSnooze = (
    duration: DurationPreset | "custom",
    customExpiresAt?: string,
  ) => {
    if (!pendingSnooze) return;
    snoozeMutation.mutate(
      {
        itemId: pendingSnooze.itemId,
        channel: pendingSnooze.channel,
        ...(duration === "custom" ? { customExpiresAt } : { duration }),
      },
      {
        onSuccess: () => {
          toast.success(
            `${pendingSnooze.itemName} hidden on ${CHANNEL_LABELS[pendingSnooze.channel]}`,
          );
          setPendingSnooze(null);
        },
      },
    );
  };

  if (!locationId) {
    return (
      <div className="grid h-full place-items-center p-8 text-center text-sm text-zinc-500">
        Select a location to manage inventory.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-base font-semibold text-zinc-900">Inventory</h1>
        <p className="text-xs text-zinc-500 mt-0.5">
          Take a product off a channel for a set time. Restores automatically
          when the timer runs out.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Brand
        </span>
        {brandsQuery.isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
        ) : brands.length === 0 ? (
          <span className="text-xs text-zinc-500">
            No brands at this location yet.
          </span>
        ) : (
          brands.map((b: Brand) => (
            <button
              key={b.id}
              type="button"
              onClick={() => setBrandId(b.id)}
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                brandId === b.id
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300"
              }`}
            >
              {b.logoUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={b.logoUrl}
                  alt=""
                  className="h-4 w-4 rounded object-cover"
                />
              ) : null}
              {b.name}
            </button>
          ))
        )}
      </div>

      {brandId && matrixQuery.data?.sourceMenu ? (
        <p className="text-xs text-zinc-500">
          Showing the last published menu:{" "}
          <span className="font-semibold text-zinc-700">
            {matrixQuery.data.sourceMenu.name}
          </span>
        </p>
      ) : null}

      {!brandId ? null : matrixQuery.isLoading ? (
        <div className="flex h-40 items-center justify-center text-zinc-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-md border border-dashed border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500">
          {matrixQuery.data?.sourceMenu
            ? "This menu has no products yet."
            : "No published menu for this brand yet — publish a menu to manage its availability here."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-[10px] uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="sticky left-0 z-10 bg-zinc-50 px-3 py-2.5 text-left font-semibold">
                  Product
                </th>
                {CHANNELS.map((c) => (
                  <th
                    key={c}
                    className="whitespace-nowrap px-3 py-2.5 text-center font-semibold"
                  >
                    <div className="flex flex-col items-center gap-1">
                      <PlatformLogo
                        platform={PLATFORM_LOGO_KEY[c]}
                        size={26}
                      />
                      <span>{CHANNEL_LABELS[c]}</span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-t border-zinc-100">
                  <td className="sticky left-0 z-10 bg-white px-3 py-2.5">
                    <div className="flex items-center gap-3">
                      {item.imageUrl ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={item.imageUrl}
                          alt=""
                          className="h-9 w-9 rounded-md object-cover"
                        />
                      ) : (
                        <div className="grid h-9 w-9 place-items-center rounded-md bg-zinc-100 text-[10px] font-bold text-zinc-500">
                          {item.name.slice(0, 1).toUpperCase()}
                        </div>
                      )}
                      <div className="min-w-0">
                        <p className="truncate text-xs font-semibold text-zinc-900">
                          {item.name}
                        </p>
                        <p className="text-[10px] text-zinc-500">
                          £{Number(item.basePrice).toFixed(2)}
                          {item.plu ? ` · ${item.plu}` : ""}
                        </p>
                      </div>
                    </div>
                  </td>
                  {CHANNELS.map((c) => {
                    // Phase BA — an "ALL"-channel row (86'd entirely, from
                    // the products tab) turns every channel off too.
                    const snoozed = item.snoozes[c] ?? (item.snoozes as any).ALL;
                    const isGlobal = snoozed && snoozed.locationId == null;
                    return (
                      <td
                        key={c}
                        className="px-3 py-2.5 text-center align-middle"
                      >
                        <ChannelToggle
                          on={!snoozed}
                          expiresAt={snoozed?.expiresAt ?? null}
                          scope={
                            snoozed ? (isGlobal ? "all" : "here") : null
                          }
                          onClick={() => handleToggle(item, c)}
                          busy={
                            snoozeMutation.isPending ||
                            unsnoozeMutation.isPending
                          }
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pendingSnooze && (
        <DurationSheet
          itemName={pendingSnooze.itemName}
          channel={pendingSnooze.channel}
          onCancel={() => setPendingSnooze(null)}
          onConfirm={confirmSnooze}
          submitting={snoozeMutation.isPending}
        />
      )}
    </div>
  );
}

function ChannelToggle({
  on,
  expiresAt,
  scope,
  onClick,
  busy,
}: {
  on: boolean;
  expiresAt: string | null;
  /** Phase BA — "here" = this location only, "all" = every location. */
  scope?: "here" | "all" | null;
  onClick: () => void;
  busy: boolean;
}) {
  const expiryLabel = useMemo(() => {
    if (!expiresAt) return null;
    const d = new Date(expiresAt);
    const diffMin = Math.round((d.getTime() - Date.now()) / 60_000);
    if (diffMin <= 0) return null;
    if (diffMin < 60) return `${diffMin}m`;
    if (diffMin < 60 * 24) return `${Math.round(diffMin / 60)}h`;
    return d.toLocaleDateString();
  }, [expiresAt]);

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={`inline-flex flex-col items-center gap-0.5 rounded-md px-3 py-1.5 text-[10px] font-semibold transition-colors ${
        on
          ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
          : "bg-red-50 text-red-700 hover:bg-red-100"
      } disabled:opacity-50`}
    >
      <span className="inline-flex items-center gap-1">
        {on ? (
          <Check className="h-3 w-3" strokeWidth={3} />
        ) : (
          <AlertCircle className="h-3 w-3" />
        )}
        {on ? "On" : "Off"}
      </span>
      {!on && (expiryLabel || scope) && (
        <span className="text-[9px] font-normal text-red-600">
          {[expiryLabel, scope === "all" ? "all locations" : scope === "here" ? "here" : null]
            .filter(Boolean)
            .join(" · ")}
        </span>
      )}
    </button>
  );
}

function DurationSheet({
  itemName,
  channel,
  onCancel,
  onConfirm,
  submitting,
}: {
  itemName: string;
  channel: Channel;
  onCancel: () => void;
  onConfirm: (
    duration: DurationPreset | "custom",
    customExpiresAt?: string,
  ) => void;
  submitting: boolean;
}) {
  const [customDate, setCustomDate] = useState<string>("");

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between border-b border-zinc-100 p-5">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900">
              Take &quot;{itemName}&quot; off
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              For <strong>{CHANNEL_LABELS[channel]}</strong> only. Choose how
              long.
            </p>
          </div>
          <button
            onClick={onCancel}
            className="text-zinc-400 hover:text-zinc-700"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="p-5 space-y-2">
          {DURATIONS.map((d) => (
            <button
              key={d}
              onClick={() => onConfirm(d)}
              disabled={submitting}
              className="flex w-full items-center justify-between rounded-md border border-zinc-200 px-3 py-2 text-left text-xs font-medium hover:border-zinc-300 hover:bg-zinc-50 disabled:opacity-50"
            >
              <span>{DURATION_LABELS[d]}</span>
              <span className="text-[10px] text-zinc-400">
                {d === "until_tomorrow"
                  ? "Restores 9am tomorrow"
                  : d === "indefinite"
                    ? "No auto-restore"
                    : ""}
              </span>
            </button>
          ))}

          <div className="rounded-md border border-zinc-200 px-3 py-2">
            <label className="block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Custom date
            </label>
            <div className="mt-1 flex gap-2">
              <input
                type="datetime-local"
                value={customDate}
                onChange={(e) => setCustomDate(e.target.value)}
                className="flex-1 rounded-md border border-zinc-200 px-2 py-1 text-xs focus:border-zinc-900 focus:outline-none"
              />
              <button
                onClick={() =>
                  onConfirm("custom", new Date(customDate).toISOString())
                }
                disabled={!customDate || submitting}
                className="rounded-md bg-zinc-900 px-3 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
              >
                {submitting ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  "Use"
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
