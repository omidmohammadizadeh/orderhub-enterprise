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
import { brandsClient, type Brand } from "@/lib/api/locations.client";
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
    id: "JUST_EAT",
    title: "Just Eat",
    description: "Direct Just Eat push (skip via HubRise).",
    wired: false,
  },
  {
    id: "UBER_EATS",
    title: "Uber Eats",
    description: "Direct Uber Eats push (skip via HubRise).",
    wired: false,
  },
  {
    id: "DELIVEROO",
    title: "Deliveroo",
    description: "Direct Deliveroo push (skip via HubRise).",
    wired: false,
  },
];

type Step = "channels" | "brand";

export function PublishMenuModal({
  open,
  menuId,
  menuName,
  initiallyPublishedTo,
  currentBrandId,
  locationId,
  onConfirmed,
  onCancel,
}: Props) {
  const [step, setStep] = useState<Step>("channels");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [brandId, setBrandId] = useState<string>(currentBrandId);

  // Re-seed on every open so the modal shows the menu's current state.
  useEffect(() => {
    if (open) {
      setStep("channels");
      setSelected(new Set(initiallyPublishedTo));
      setBrandId(currentBrandId);
    }
  }, [open, initiallyPublishedTo, currentBrandId]);

  const brandsQuery = useQuery({
    queryKey: ["brands", locationId ?? "tenant"],
    queryFn: () => brandsClient.list(locationId),
    enabled: open && step === "brand",
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const next = Array.from(selected);
      const anyWired = next.some((id) =>
        TARGETS.find((t) => t.id === id)?.wired,
      );
      // Step 1 — persist channel + brand selection on the menu row.
      await menusClient.updateMenu(menuId, {
        publishedTo: next,
        brandId,
        ...(anyWired && { status: "PUBLISHED" as const, isActive: true }),
      } as any);
      // Step 2 — if HubRise is ticked, do the actual catalog push.
      // POS / Online ordering need no external call — they read straight
      // off the publishedTo array on every storefront / POS load.
      if (next.includes("HUBRISE")) {
        await menusClient.publishToHubRise(menuId);
      }
    },
    onSuccess: () => {
      const channelLabel = describeSelection(selected);
      if (!needsBrandStep) {
        toast.success(
          `Published "${menuName}" to ${channelLabel} — each brand priced via its variants.`,
        );
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
  // HubRise self-routes to each brand via catalog variants, so there's no
  // single brand to pick — skip Step 2 when it's selected.
  const needsBrandStep = !selected.has("HUBRISE");

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[85vh]">
        <header className="flex items-center justify-between p-5 border-b border-zinc-100">
          <div className="flex items-center gap-2">
            {step === "brand" && (
              <button
                onClick={() => setStep("channels")}
                className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100"
                title="Back to channels"
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

        {/* Step indicator — Brand step is skipped when HubRise is selected. */}
        {needsBrandStep && (
          <div className="flex items-center gap-2 border-b border-zinc-100 px-5 py-2">
            <StepPill index={1} label="Channels" active={step === "channels"} done={step === "brand"} />
            <span className="h-px flex-1 bg-zinc-200" />
            <StepPill index={2} label="Brand" active={step === "brand"} done={false} />
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
          ) : brandsQuery.isLoading ? (
            <div className="flex items-center justify-center py-12 text-zinc-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (brandsQuery.data ?? []).length === 0 ? (
            <p className="py-12 text-center text-sm text-zinc-500">
              No brands at this location yet. Create one under Locations →
              Brands first.
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
                onClick={() => setStep("brand")}
                disabled={!canContinue}
                className="bg-zinc-900 hover:bg-zinc-800 text-white"
              >
                Next: pick brand
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
                  "Publish to HubRise"
                )}
              </Button>
            )
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
