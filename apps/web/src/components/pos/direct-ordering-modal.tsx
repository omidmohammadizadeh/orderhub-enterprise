"use client";

// Phase AP — Direct Online Ordering settings.
//
// Per-location toggles + numbers that the public storefront reads on
// every load:
//
//   • Delivery / collection prep time (advertised to customers)
//   • Payment methods accepted (cash / card)
//   • Order types accepted (delivery / collection)
//   • Schedule limits (days ahead, slot granularity)
//   • Minimum order for delivery
//
// All persisted to the DirectOrderingConfig row created on first save.
//
// Phase AP follow-up (AP-NAV-1): the settings now live on a dedicated
// sidebar page (`/dashboard/direct-ordering`) rather than a POS top-bar
// modal. The DirectOrderingSettings component below is the body that
// page renders; DirectOrderingModal is kept as a thin overlay wrapper
// for any caller that still wants the modal treatment (none today, but
// the symbol is referenced indirectly in tests / docs).

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import {
  directOrderingClient,
  type DirectOrderingConfig,
} from "@/lib/api/pos.client";

export interface DirectOrderingSettingsProps {
  locationId: string;
}

/** Body shared between the standalone page and the legacy modal wrapper.
 *  Every input the original modal exposed is preserved 1:1. */
export function DirectOrderingSettings({ locationId }: DirectOrderingSettingsProps) {
  const qc = useQueryClient();
  const configQuery = useQuery<DirectOrderingConfig>({
    queryKey: ["direct-ordering", locationId],
    queryFn: () => directOrderingClient.get(locationId),
  });

  const [deliveryPrep, setDeliveryPrep] = useState("");
  const [collectionPrep, setCollectionPrep] = useState("");
  const [acceptsCash, setAcceptsCash] = useState(true);
  const [acceptsCard, setAcceptsCard] = useState(true);
  const [acceptsDelivery, setAcceptsDelivery] = useState(true);
  const [acceptsCollection, setAcceptsCollection] = useState(true);
  const [scheduleDays, setScheduleDays] = useState("7");
  const [slotMins, setSlotMins] = useState("15");
  const [minDelivery, setMinDelivery] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);

  // Hydrate from server on first load.
  useEffect(() => {
    const c = configQuery.data;
    if (!c) return;
    setDeliveryPrep(String(c.deliveryPrepMinutes));
    setCollectionPrep(String(c.collectionPrepMinutes));
    setAcceptsCash(c.acceptsCash);
    setAcceptsCard(c.acceptsCard);
    setAcceptsDelivery(c.acceptsDelivery);
    setAcceptsCollection(c.acceptsCollection);
    setScheduleDays(String(c.scheduleMaxDaysAhead));
    setSlotMins(String(c.scheduleSlotMinutes));
    setMinDelivery(c.minOrderForDelivery != null ? String(c.minOrderForDelivery) : "");
  }, [configQuery.data]);

  const save = useMutation({
    mutationFn: () =>
      directOrderingClient.update(locationId, {
        deliveryPrepMinutes: Number(deliveryPrep) || 0,
        collectionPrepMinutes: Number(collectionPrep) || 0,
        acceptsCash,
        acceptsCard,
        acceptsDelivery,
        acceptsCollection,
        scheduleMaxDaysAhead: Number(scheduleDays) || 7,
        scheduleSlotMinutes: Number(slotMins) || 15,
        minOrderForDelivery: minDelivery ? Number(minDelivery) : null,
      }),
    onSuccess: () => {
      setFeedback("Saved");
      qc.invalidateQueries({ queryKey: ["direct-ordering", locationId] });
      window.setTimeout(() => setFeedback(null), 2500);
    },
    onError: (err: any) =>
      setFeedback(err?.response?.data?.message ?? err.message ?? "Failed"),
  });

  return (
    <div className="space-y-5 text-sm">
      {/* Prep times */}
      <div>
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          Prep time advertised to customers
        </p>
        <div className="grid grid-cols-2 gap-3">
          <NumberField label="Delivery (mins)" value={deliveryPrep} onChange={setDeliveryPrep} />
          <NumberField label="Collection (mins)" value={collectionPrep} onChange={setCollectionPrep} />
        </div>
      </div>

      {/* Payment methods */}
      <div>
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          Payment methods accepted online
        </p>
        <ToggleRow label="Accept cash on delivery/collection" value={acceptsCash} onChange={setAcceptsCash} />
        <ToggleRow label="Accept card online (Stripe)" value={acceptsCard} onChange={setAcceptsCard} />
      </div>

      {/* Order types */}
      <div>
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          Order types accepted online
        </p>
        <ToggleRow label="Accept delivery orders" value={acceptsDelivery} onChange={setAcceptsDelivery} />
        <ToggleRow label="Accept collection orders" value={acceptsCollection} onChange={setAcceptsCollection} />
      </div>

      {/* Schedule + min order */}
      <div>
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          Scheduling
        </p>
        <div className="grid grid-cols-3 gap-3">
          <NumberField label="Days ahead" value={scheduleDays} onChange={setScheduleDays} />
          <NumberField label="Slot mins" value={slotMins} onChange={setSlotMins} />
          <NumberField label="Min delivery (£)" value={minDelivery} onChange={setMinDelivery} />
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-zinc-200 pt-3">
        <span className="text-[11px] text-zinc-500">{feedback ?? ""}</span>
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending || configQuery.isLoading}
          className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {save.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
          Save
        </button>
      </div>
    </div>
  );
}

interface ModalProps {
  locationId: string;
  onClose: () => void;
}

/** @deprecated kept for backwards-compat. New code should render
 *  DirectOrderingSettings on its own page. */
export function DirectOrderingModal({ locationId, onClose }: ModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-lg bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900">Direct online ordering</h2>
            <p className="text-xs text-zinc-500">
              How your customer-facing storefront behaves at this location.
            </p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="p-4">
          <DirectOrderingSettings locationId={locationId} />
        </div>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
        {label}
      </span>
      <input
        type="number"
        min="0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
      />
    </label>
  );
}

function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between py-1.5 text-xs">
      <span className="text-zinc-700">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
          value ? "bg-emerald-500" : "bg-zinc-300"
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            value ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
    </label>
  );
}
