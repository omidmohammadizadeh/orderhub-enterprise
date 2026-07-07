"use client";

// ── SidebarLocationSwitcher ───────────────────────────────────────────────
// Replaces the old tenant pill at the top of the sidebar. Drives the global
// useSelectedLocationStore — every tab in the dashboard reads from there
// for scoping (Orders, POS, Menu, Products, Direct ordering, etc.).
//
// "All locations" maps to selectedLocationId === null. Every tab respects
// it EXCEPT POS, which physically needs one location at a time (a single
// register can't serve two stores). On /dashboard/pos:
//   • The "All locations" option is hidden.
//   • If the global state is null when the user opens POS, the first
//     available location is auto-selected so the page doesn't render
//     empty.
//
// Dark theme to match the sidebar; click-outside-to-close handled
// manually instead of pulling in shadcn's Popover.

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Building2, ChevronDown, Check } from "lucide-react";
import { locationsClient, type Location } from "../../lib/api/locations.client";
import { useSelectedLocationStore } from "../../stores/selected-location.store";

export function SidebarLocationSwitcher() {
  const pathname = usePathname();
  const isPosRoute = pathname?.startsWith("/dashboard/pos") ?? false;

  const { selectedLocationId, setSelectedLocationId } =
    useSelectedLocationStore();

  const { data: locations } = useQuery({
    queryKey: ["locations", "list"],
    queryFn: () => locationsClient.list(),
    staleTime: 60_000,
  });

  // "All locations" only makes sense when the user actually has more than
  // one location. A single-location user is always scoped to their one
  // location (no "All locations" option).
  const hasMultiple = (locations?.length ?? 0) > 1;
  const allowAll = !isPosRoute && hasMultiple;

  // Force-pick a single location when "All locations" isn't offered:
  //   • POS always needs one location, and
  //   • a user with exactly one accessible location should land on it
  //     instead of the (now hidden) "All locations" view.
  useEffect(() => {
    if (allowAll) return;
    if (selectedLocationId) return;
    const first = locations?.[0];
    if (first) setSelectedLocationId(first.id);
  }, [allowAll, selectedLocationId, locations, setSelectedLocationId]);

  const selected = locations?.find((l) => l.id === selectedLocationId) ?? null;

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const display =
    selected?.name ?? (allowAll ? "All locations" : "Select location");

  return (
    <div className="relative mx-3 mt-3" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.04] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.07] group"
      >
        <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-violet-500/20">
          <Building2 className="h-3.5 w-3.5 text-violet-400" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-white truncate">{display}</p>
          <p className="text-[10px] text-zinc-500 truncate">
            {isPosRoute
              ? "POS — single location"
              : selected
                ? "Scoped to this location"
                : "Showing every location"}
          </p>
        </div>
        <ChevronDown
          className={`h-3.5 w-3.5 flex-shrink-0 text-zinc-500 group-hover:text-zinc-300 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-40 mt-1 max-h-72 overflow-y-auto rounded-lg border border-white/[0.08] bg-[#161617] py-1 shadow-xl shadow-black/40">
          {allowAll && (
            <SwitcherRow
              label="All locations"
              hint="Combined view across every location"
              active={!selectedLocationId}
              onClick={() => {
                setSelectedLocationId(null);
                setOpen(false);
              }}
            />
          )}
          {locations?.length ? (
            <>
              {allowAll && (
                <div className="my-1 mx-3 h-px bg-white/[0.06]" />
              )}
              {locations.map((loc: Location) => (
                <SwitcherRow
                  key={loc.id}
                  label={loc.name}
                  hint={(loc as any).city ?? undefined}
                  active={selectedLocationId === loc.id}
                  onClick={() => {
                    setSelectedLocationId(loc.id);
                    setOpen(false);
                  }}
                />
              ))}
            </>
          ) : (
            <p className="px-3 py-2 text-[11px] text-zinc-500">
              No locations yet.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function SwitcherRow({
  label,
  hint,
  active,
  onClick,
}: {
  label: string;
  hint?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
        active ? "bg-white/[0.05]" : "hover:bg-white/[0.04]"
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-white truncate">{label}</p>
        {hint && (
          <p className="text-[10px] text-zinc-500 truncate">{hint}</p>
        )}
      </div>
      {active && <Check className="h-3.5 w-3.5 text-violet-400" />}
    </button>
  );
}
