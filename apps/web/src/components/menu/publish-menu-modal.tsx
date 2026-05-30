"use client";

// Phase AM — Publish menu target picker.
//
// The operator clicks Publish on a menu card → this modal opens with
// five publish targets:
//   - Direct online ordering (customer storefront)
//   - POS (in-store tills)
//   - Just Eat
//   - Uber Eats
//   - Deliveroo
//
// Selections are persisted to MenuConfig.publishedTo[] via
// menusClient.updateMenu. The three external channels are placeholders
// for now — checking them flags intent but the actual outbound import
// stays disabled until each channel is wired through Integrations.

import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { X, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { menusClient } from "@/lib/api/menus.client";
import { PlatformLogo } from "@/components/ui/platform-logo";

interface Props {
  open: boolean;
  menuId: string;
  menuName: string;
  initiallyPublishedTo: string[];
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
    id: "JUST_EAT",
    title: "Just Eat",
    description: "Push to Just Eat marketplace listings.",
    wired: false,
  },
  {
    id: "UBER_EATS",
    title: "Uber Eats",
    description: "Push to Uber Eats marketplace listings.",
    wired: false,
  },
  {
    id: "DELIVEROO",
    title: "Deliveroo",
    description: "Push to Deliveroo marketplace listings.",
    wired: false,
  },
];

export function PublishMenuModal({
  open,
  menuId,
  menuName,
  initiallyPublishedTo,
  onConfirmed,
  onCancel,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Re-seed on every open so the modal shows the menu's current state.
  useEffect(() => {
    if (open) setSelected(new Set(initiallyPublishedTo));
  }, [open, initiallyPublishedTo]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const next = Array.from(selected);
      // status PUBLISHED only when at least one wired target is on; the
      // backend treats publishedTo as an audit field and toggles
      // isActive separately.
      const anyWired = next.some((id) =>
        TARGETS.find((t) => t.id === id)?.wired,
      );
      return menusClient.updateMenu(menuId, {
        // The schema field is named `publishedTo` but the update DTO
        // accepts arbitrary additive fields — sent through any-cast so
        // we don't churn the client typings until publish lands.
        publishedTo: next,
        ...(anyWired && { status: "PUBLISHED" as const, isActive: true }),
      } as any);
    },
    onSuccess: () => onConfirmed(Array.from(selected)),
  });

  if (!open) return null;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between p-5 border-b border-zinc-100">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">
              Publish menu
            </h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              Pick where &quot;{menuName}&quot; should be live.
            </p>
          </div>
          <button
            onClick={onCancel}
            className="text-zinc-400 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-2.5">
          {TARGETS.map((t) => {
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
          })}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-zinc-100">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            {saveMutation.isPending ? "Publishing…" : "Publish"}
          </Button>
        </div>
      </div>
    </div>
  );
}
