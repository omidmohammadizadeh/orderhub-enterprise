"use client";

import { X } from "lucide-react";
import { OpeningHoursEditor } from "./opening-hours-editor";
import type { Location } from "@/lib/api/locations.client";

// Phase AN — Standalone Opening Hours drawer, opened from the Locations
// list card's "Opening hours" action chip. Delegates to OpeningHoursEditor
// for the actual table; the drawer wraps it in a right-side slide-over
// shell and supplies the location-picker for the apply-to-others action.

interface Props {
  locationId: string;
  allLocations: Location[];
  onClose: () => void;
}

export function OpeningHoursDrawer({ locationId, allLocations, onClose }: Props) {
  const current = allLocations.find((l) => l.id === locationId);
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full max-w-md flex-col overflow-hidden bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900">Opening hours</h2>
            <p className="text-xs text-zinc-500">{current?.name ?? "Location"}</p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-4">
          <OpeningHoursEditor
            locationId={locationId}
            allLocationsForApply={allLocations.map((l) => ({ id: l.id, name: l.name }))}
          />
        </div>
      </div>
    </div>
  );
}
