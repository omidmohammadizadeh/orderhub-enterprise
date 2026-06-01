"use client";

// Phase AP follow-up (AP-NAV-1): Direct online ordering settings used
// to live behind a button on the POS top bar. Operators wanted it on
// the sidebar instead — same fields, dedicated page, scoped to the
// currently selected location.
//
// The form body is the existing DirectOrderingSettings component;
// nothing here changes WHAT can be configured, only WHERE.

import { LocationSelector } from "@/components/dashboard/location-selector";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { DirectOrderingSettings } from "@/components/pos/direct-ordering-modal";

export default function DirectOrderingPage() {
  const selectedLocationId = useSelectedLocationStore(
    (s) => s.selectedLocationId,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">
            Direct online ordering
          </h1>
          <p className="text-sm text-zinc-500">
            How your customer-facing storefront behaves at this location.
          </p>
        </div>
        <LocationSelector />
      </div>

      {!selectedLocationId ? (
        <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-zinc-200 py-24 text-center">
          <p className="font-medium text-zinc-500">Pick a location</p>
          <p className="mt-1 text-sm text-zinc-400">
            Use the selector above to choose which location&apos;s
            storefront to configure.
          </p>
        </div>
      ) : (
        <div className="max-w-2xl rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
          <DirectOrderingSettings locationId={selectedLocationId} />
        </div>
      )}
    </div>
  );
}
