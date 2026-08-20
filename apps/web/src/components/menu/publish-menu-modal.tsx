"use client";

// Phase AW — Publish menu picker.
//
// Two-step flow per the operator's spec:
//
//   Step 1 — pick channel(s)  POS / Online ordering / Just Eat / Uber Eats / Deliveroo
//   Step 2 — pick the brand to publish under
//
// On Publish we PATCH the menu with both selections (publishedTo + brandId)
// and fire a global toast: green "Published" on success, red "Failed" on
// error. The third-party channels stay as audit-only flags until each is
// wired through Integrations; the toast still confirms the selection
// landed against MenuConfig.publishedTo.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { X, Check, ChevronLeft, Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { menusClient } from "@/lib/api/menus.client";
import {
  brandsClient,
  locationsClient,
  type Brand,
} from "@/lib/api/locations.client";
import { PlatformLogo } from "@/components/ui/platform-logo";

interface Props {
  open: boolean;
  menuId: string;
  menuName: string;
  initiallyPublishedTo: string[];
  /** Current brand the menu sits under — drives Step 2's default selection. */
  currentBrandId: string;
  /** Scopes the brand picker. Falls back to all tenant brands if absent. */
  locationId?: string;
  /** Phase BA — locations this menu currently SERVES (from its
   *  assignments); pre-ticked in the multi-select location step. */
  assignedLocationIds?: string[];
  onConfirmed: (publishedTo: string[]) => void;
  onCancel: () => void;
}

interface Target {
  id: string;
  title: string;
  description: string;
  /** False = checkbox only, true = real publish endpoint wired. */
  wired: boolean;
}

const TARGETS: Target[] = [
  {
    id: "ONLINE",
    title: "Direct online ordering",
    description: "Customer storefront — guests place orders directly with you.",
    wired: true,
  },
  {
    id: "POS",
    title: "Order Hub POS",
    description: "Use this menu on in-store tills.",
    wired: true,
  },
  {
    id: "HUBRISE",
    title: "HubRise",
    description:
      "Push to HubRise as a catalog. Fan-out to Just Eat, Uber Eats, Deliveroo follows from HubRise.",
    wired: true,
  },
  {
    id: "WHATSAPP",
    title: "WhatsApp ordering",
    description:
      "Serve this menu in the WhatsApp chat bot. Uses your default prices (same as POS / online ordering) — no brand needed.",
    wired: true,
  },
  {
    id: "JUST_EAT",
    title: "Just Eat",
    description:
      "Direct Just Eat push (JET Connect) — sends this menu to the brand's connected restaurant, bypassing HubRise.",
    wired: true,
  },
  {
    id: "UBER_EATS",
    title: "Uber Eats",
    description:
      "Direct Uber Eats push — uploads this menu to the brand's connected Uber Eats store.",
    wired: true,
  },
  {
    id: "DELIVEROO",
    title: "Deliveroo",
    description:
      "Direct Deliveroo push — uploads this menu to the brand's connected Deliveroo store.",
    wired: true,
  },
];

type Step = "channels" | "location" | "brand";

export function PublishMenuModal({
  open,
  menuId,
  menuName,
  initiallyPublishedTo,
  currentBrandId,
  locationId,
  assignedLocationIds,
  onConfirmed,
  onCancel,
}: Props) {
  const [step, setStep] = useState<Step>("channels");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [brandId, setBrandId] = useState<string>(currentBrandId);
  // Location step (before brand) — Phase BA multi-select. A menu can SERVE
  // many locations at once; publishing rewrites the picked locations'
  // serving assignments and leaves every other location alone. Seeded from
  // where the menu is currently live (assignments) plus the dashboard's
  // selected location.
  const [selLocations, setSelLocations] = useState<Set<string>>(new Set());

  // Re-seed on every open so the modal shows the menu's current state.
  useEffect(() => {
    if (open) {
      setStep("channels");
      setSelected(new Set(initiallyPublishedTo));
      setBrandId(currentBrandId);
      const seed = new Set(assignedLocationIds ?? []);
      if (locationId) seed.add(locationId);
      setSelLocations(seed);
    }
  }, [open, initiallyPublishedTo, currentBrandId, locationId, assignedLocationIds]);

  const locationsQuery = useQuery({
    queryKey: ["locations", "list"],
    queryFn: () => locationsClient.list(),
    enabled: open && step === "location",
  });

  // Brand picker: only the brands that operate AT the picked location(s) —
  // brands homed there via primaryLocationId (the marketplace/virtual brands for
  // that kitchen). Publishing to a marketplace under a brand from a different
  // location makes no sense, and showing every tenant brand here was confusing.
  // The menu's current brand is merged in so it stays selectable even if it
  // isn't homed at the picked location.
  const pickedLocationsForBrands = Array.from(selLocations);
  const brandsQuery = useQuery({
    queryKey: ["brands", "publishable", pickedLocationsForBrands],
    queryFn: async () => {
      if (!pickedLocationsForBrands.length) return brandsClient.list();
      const lists = await Promise.all(
        pickedLocationsForBrands.map((loc) => brandsClient.list(loc)),
      );
      const byId = new Map<string, any>();
      for (const list of lists) for (const b of list) byId.set(b.id, b);
      return Array.from(byId.values());
    },
    enabled: open && step === "brand",
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const next = Array.from(selected);
      const anyWired = next.some((id) =>
        TARGETS.find((t) => t.id === id)?.wired,
      );
      // Phase BA — persist channels + brand + the SERVING LOCATIONS. The
      // API rewrites each picked location's assignments in one
      // transaction (replace per slot); unpicked locations keep whatever
      // menu they had, so publishing here never unpublishes elsewhere.
      // locationIds is only sent when the flow actually showed the
      // location step (HubRise/WhatsApp-only publishes skip it and must
      // not touch assignments).
      const pickedLocations =
        !next.includes("HUBRISE") && !next.includes("WHATSAPP")
          ? Array.from(selLocations)
          : null;
      await menusClient.updateMenu(menuId, {
        publishedTo: next,
        brandId,
        ...(pickedLocations && pickedLocations.length > 0 && {
          locationIds: pickedLocations,
        }),
        ...(anyWired && { status: "PUBLISHED" as const, isActive: true }),
      } as any);
      // Step 2 — fire the real external pushes. POS / Online ordering need
      // no external call — the storefront and POS resolve off the
      // assignment rows written above.
      if (next.includes("HUBRISE")) {
        await menusClient.publishToHubRise(menuId);
      }
      // Marketplace uploads run once per picked location so every
      // connected store gets the menu. Errors aggregate into one toast.
      const marketplaceLocations = pickedLocations?.length
        ? pickedLocations
        : [locationId ?? ""];
      const pushErrors: string[] = [];
      for (const loc of marketplaceLocations) {
        if (next.includes("DELIVEROO")) {
          await menusClient
            .publishToDeliveroo(menuId, { locationId: loc || undefined })
            .catch((e: any) =>
              pushErrors.push(
                `Deliveroo: ${e?.response?.data?.message ?? e?.message ?? "failed"}`,
              ),
            );
        }
        if (next.includes("UBER_EATS")) {
          await menusClient
            .publishToUberEats(menuId, {
              locationId: loc || undefined,
              brandId,
            })
            .catch((e: any) =>
              pushErrors.push(
                `Uber Eats: ${e?.response?.data?.message ?? e?.message ?? "failed"}`,
              ),
            );
        }
        if (next.includes("JUST_EAT")) {
          await menusClient
            .publishToJustEat(menuId, { locationId: loc || undefined })
            .catch((e: any) =>
              pushErrors.push(
                `Just Eat: ${e?.response?.data?.message ?? e?.message ?? "failed"}`,
              ),
            );
        }
      }
      if (pushErrors.length > 0) {
        throw new Error(Array.from(new Set(pushErrors)).join(" · "));
      }
    },
    onSuccess: () => {
      const channelLabel = describeSelection(selected);
      if (!needsBrandStep) {
        toast.success(`Published "${menuName}" to ${channelLabel}.`);
      } else {
        const brandName =
          (brandsQuery.data ?? []).find((b: Brand) => b.id === brandId)?.name ??
          "brand";
        toast.success(`Published "${menuName}" to ${channelLabel} for ${brandName}`);
      }
      onConfirmed(Array.from(selected));
    },
    onError: (err: any) => {
      const reason =
        err?.response?.data?.message ?? err?.message ?? "Unknown error";
      toast.error(`Failed to publish: ${reason}`);
    },
  });

  if (!open) return null;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const canContinue = selected.size > 0;
  const canPublish = !!brandId && selected.size > 0 && !saveMutation.isPending;
  // Channels that DON'T need a brand picked: HubRise self-routes per brand via
  // catalog variants; WhatsApp serves the location's active menu at default
  // prices; POS now shows the location's "POS display name" brand (Location
  // settings), so it no longer asks which brand at publish time. Skip Step 2
  // unless at least one OTHER selected channel (Online / Uber / Deliveroo /
  // Just Eat) genuinely needs a single brand.
  const NO_BRAND_CHANNELS = new Set(["POS", "HUBRISE", "WHATSAPP"]);
  const needsBrandStep = [...selected].some((c) => !NO_BRAND_CHANNELS.has(c));

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[85vh]">
        <header className="flex items-center justify-between p-5 border-b border-zinc-100">
          <div className="flex items-center gap-2">
            {step !== "channels" && (
              <button
                onClick={() =>
                  setStep(step === "brand" ? "location" : "channels")
                }
                className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100"
                title="Back"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            )}
            <div>
              <h2 className="text-base font-semibold text-zinc-900">
                Publish menu
              </h2>
              <p className="text-xs text-zinc-500 mt-0.5">
                {step === "channels"
                  ? `Pick where "${menuName}" should be live.`
                  : step === "location"
                    ? `Pick the location to publish "${menuName}" at.`
                    : `Pick the brand to publish "${menuName}" under.`}
              </p>
            </div>
          </div>
          <button
            onClick={onCancel}
            className="text-zinc-400 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {/* Step indicator — Location/Brand steps are skipped when HubRise is selected. */}
        {needsBrandStep && (
          <div className="flex items-center gap-2 border-b border-zinc-100 px-5 py-2">
            <StepPill index={1} label="Channels" active={step === "channels"} done={step !== "channels"} />
            <span className="h-px flex-1 bg-zinc-200" />
            <StepPill index={2} label="Location" active={step === "location"} done={step === "brand"} />
            <span className="h-px flex-1 bg-zinc-200" />
            <StepPill index={3} label="Brand" active={step === "brand"} done={false} />
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-5 space-y-2.5">
          {step === "channels" ? (
            TARGETS.map((t) => {
              const isOn = selected.has(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => toggle(t.id)}
                  className={`relative w-full flex items-center gap-4 rounded-xl border p-4 text-left transition-colors ${
                    isOn
                      ? "border-orange-300 bg-orange-50"
                      : "border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50"
                  }`}
                >
                  <PlatformLogo platform={t.id} size={44} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-zinc-900">
                      {t.title}
                    </p>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      {t.description}
                    </p>
                    {!t.wired && (
                      <p className="text-[10px] text-amber-700 mt-1.5">
                        Channel integration coming soon — connect in
                        Integrations first.
                      </p>
                    )}
                  </div>
                  <span
                    className={`grid h-5 w-5 place-items-center rounded border-2 flex-shrink-0 ${
                      isOn
                        ? "border-orange-500 bg-orange-500 text-white"
                        : "border-zinc-300 bg-white"
                    }`}
                  >
                    {isOn && <Check className="h-3 w-3" strokeWidth={3} />}
                  </span>
                </button>
              );
            })
          ) : step === "location" ? (
            locationsQuery.isLoading ? (
              <div className="flex items-center justify-center py-12 text-zinc-400">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : (
              <>
                {/* Phase BA — multi-select: this menu will SERVE every ticked
                    location; locations left unticked keep their current menu. */}
                <p className="text-xs text-zinc-500 -mt-1 mb-2">
                  Pick every location this menu should serve. Other locations
                  keep the menu they already have.
                </p>
                {(locationsQuery.data ?? []).map((l: any) => {
                  const isOn = selLocations.has(l.id);
                  return (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() =>
                        setSelLocations((prev) => {
                          const next = new Set(prev);
                          if (next.has(l.id)) next.delete(l.id);
                          else next.add(l.id);
                          return next;
                        })
                      }
                      className={`relative w-full flex items-center gap-4 rounded-xl border p-4 text-left transition-colors ${
                        isOn
                          ? "border-sky-300 bg-sky-50"
                          : "border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50"
                      }`}
                    >
                      <div className="grid h-11 w-11 place-items-center rounded-md bg-zinc-100 text-sm font-bold text-zinc-500">
                        {String(l.name ?? "?").slice(0, 1).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-zinc-900">
                          {l.name}
                        </p>
                        {(l.city || l.postcode) && (
                          <p className="text-xs text-zinc-500 mt-0.5">
                            {[l.city, l.postcode].filter(Boolean).join(", ")}
                          </p>
                        )}
                      </div>
                      <span
                        className={`grid h-5 w-5 place-items-center rounded border-2 flex-shrink-0 ${
                          isOn
                            ? "border-sky-500 bg-sky-500 text-white"
                            : "border-zinc-300 bg-white"
                        }`}
                      >
                        {isOn && <Check className="h-3 w-3" strokeWidth={3} />}
                      </span>
                    </button>
                  );
                })}
              </>
            )
          ) : brandsQuery.isLoading ? (
            <div className="flex items-center justify-center py-12 text-zinc-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (brandsQuery.data ?? []).length === 0 ? (
            <p className="py-12 text-center text-sm text-zinc-500">
              No brands available for your account. Create one under Locations →
              Brands, or ask an admin to assign you a brand.
            </p>
          ) : (
            (brandsQuery.data ?? []).map((b: Brand) => {
              const isOn = brandId === b.id;
              return (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => setBrandId(b.id)}
                  className={`relative w-full flex items-center gap-4 rounded-xl border p-4 text-left transition-colors ${
                    isOn
                      ? "border-violet-300 bg-violet-50"
                      : "border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50"
                  }`}
                >
                  {b.logoUrl ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={b.logoUrl}
                      alt=""
                      className="h-11 w-11 rounded-md object-cover"
                    />
                  ) : (
                    <div className="grid h-11 w-11 place-items-center rounded-md bg-zinc-100 text-sm font-bold text-zinc-500">
                      {b.name.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-zinc-900">
                      {b.name}
                    </p>
                    {b.cuisine && (
                      <p className="text-xs text-zinc-500 mt-0.5">{b.cuisine}</p>
                    )}
                  </div>
                  <span
                    className={`grid h-5 w-5 place-items-center rounded-full border-2 flex-shrink-0 ${
                      isOn
                        ? "border-violet-500 bg-violet-500 text-white"
                        : "border-zinc-300 bg-white"
                    }`}
                  >
                    {isOn && <Check className="h-3 w-3" strokeWidth={3} />}
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between gap-2 p-4 border-t border-zinc-100">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          {step === "channels" ? (
            needsBrandStep ? (
              <Button
                size="sm"
                onClick={() => setStep("location")}
                disabled={!canContinue}
                className="bg-zinc-900 hover:bg-zinc-800 text-white"
              >
                Next: pick location
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => saveMutation.mutate()}
                disabled={!canContinue || saveMutation.isPending}
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                {saveMutation.isPending ? (
                  <span className="inline-flex items-center gap-1">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Publishing…
                  </span>
                ) : (
                  "Publish"
                )}
              </Button>
            )
          ) : step === "location" ? (
            <Button
              size="sm"
              onClick={() => setStep("brand")}
              disabled={selLocations.size === 0}
              className="bg-zinc-900 hover:bg-zinc-800 text-white"
            >
              Next: pick brand
              {selLocations.size > 1 ? ` (${selLocations.size} locations)` : ""}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={!canPublish}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {saveMutation.isPending ? (
                <span className="inline-flex items-center gap-1">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Publishing…
                </span>
              ) : (
                "Publish"
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function StepPill({
  index,
  label,
  active,
  done,
}: {
  index: number;
  label: string;
  active: boolean;
  done: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
        active
          ? "bg-zinc-900 text-white"
          : done
            ? "bg-emerald-100 text-emerald-700"
            : "bg-zinc-100 text-zinc-500"
      }`}
    >
      <span
        className={`grid h-4 w-4 place-items-center rounded-full text-[9px] ${
          active
            ? "bg-white text-zinc-900"
            : done
              ? "bg-emerald-500 text-white"
              : "bg-zinc-300 text-white"
        }`}
      >
        {done ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : index}
      </span>
      {label}
    </span>
  );
}

function describeSelection(s: Set<string>): string {
  const labels: Record<string, string> = {
    ONLINE: "Online ordering",
    POS: "POS",
    HUBRISE: "HubRise",
    WHATSAPP: "WhatsApp",
    JUST_EAT: "Just Eat",
    UBER_EATS: "Uber Eats",
    DELIVEROO: "Deliveroo",
  };
  const names = Array.from(s).map((id) => labels[id] ?? id);
  if (names.length === 0) return "no channels";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}
