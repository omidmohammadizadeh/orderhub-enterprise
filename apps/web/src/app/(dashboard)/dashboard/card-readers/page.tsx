"use client";

// Card readers settings page. Apple's Tap to Pay App Review checklist (3.6)
// requires the app to let staff enable Tap to Pay outside the usual
// checkout flow — this page is that entry point: register readers and
// connect/link Tap to Pay or WisePad 3 without an active order attached.
// The actual charge flow stays in charge-reader-modal.tsx; this page only
// registers hardware and runs the SDK's connect/account-linking step.

import { CreditCard } from "lucide-react";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { CardReadersTab } from "@/components/pos/card-readers-tab";

export default function CardReadersPage() {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-zinc-900">
          <CreditCard className="h-6 w-6" /> Card readers
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Register and connect card readers — Tap to Pay, WisePad 3, or the
          S700 counter reader — without starting a checkout.
        </p>
      </div>

      {locationId ? (
        <CardReadersTab locationId={locationId} />
      ) : (
        <p className="text-sm text-zinc-500">
          Select a location above to manage its card readers.
        </p>
      )}
    </div>
  );
}
