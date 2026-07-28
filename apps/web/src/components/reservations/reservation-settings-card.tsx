"use client";

// Booking settings for a location — the guest-facing half of table
// service. Same shape the API reads back out of
// Location.settings.tableService.reservations.
//
// PATCH /v1/locations/:id merges `settings` SHALLOW (top level only), so
// writing `{ tableService: { reservations } }` would drop `enabled` and
// anything else parked under tableService. Always spread the current
// tableService object back in.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { locationsClient } from "@/lib/api/locations.client";
import { queryKeys } from "@/lib/api/query-keys";
import { Button } from "@/components/ui/button";

interface Draft {
  onlineEnabled: boolean;
  maxPartySize: string;
  slotMinutes: string;
  leadTimeMins: string;
  maxDaysAhead: string;
}

// Mirrors the API's readSettings() fallbacks so the form never shows a
// blank where the server would happily apply a default.
const DEFAULTS: Draft = {
  onlineEnabled: false,
  maxPartySize: "12",
  slotMinutes: "90",
  leadTimeMins: "60",
  maxDaysAhead: "60",
};

export function ReservationSettingsCard({ locationId }: { locationId: string }) {
  const qc = useQueryClient();

  const locationQuery = useQuery({
    queryKey: queryKeys.locationDetail(locationId),
    queryFn: () => locationsClient.get(locationId),
    enabled: !!locationId,
  });

  const settings: any = (locationQuery.data as any)?.settings ?? {};
  const tableService: any = settings.tableService ?? {};
  const tableServiceEnabled = !!tableService.enabled;
  const saved: any = tableService.reservations ?? {};

  const [draft, setDraft] = useState<Draft>(DEFAULTS);

  // Re-seed whenever a different location (or a fresh save) lands, so the
  // form never shows the previous location's numbers.
  useEffect(() => {
    setDraft({
      onlineEnabled: !!saved.onlineEnabled,
      maxPartySize: String(saved.maxPartySize ?? DEFAULTS.maxPartySize),
      slotMinutes: String(saved.slotMinutes ?? DEFAULTS.slotMinutes),
      leadTimeMins: String(saved.leadTimeMins ?? DEFAULTS.leadTimeMins),
      maxDaysAhead: String(saved.maxDaysAhead ?? DEFAULTS.maxDaysAhead),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationQuery.data?.id, JSON.stringify(saved)]);

  const save = useMutation({
    mutationFn: () =>
      locationsClient.update(locationId, {
        settings: {
          ...settings,
          tableService: {
            ...tableService,
            reservations: {
              onlineEnabled: draft.onlineEnabled,
              maxPartySize: Number(draft.maxPartySize) || 12,
              slotMinutes: Number(draft.slotMinutes) || 90,
              leadTimeMins: Number(draft.leadTimeMins) || 0,
              maxDaysAhead: Number(draft.maxDaysAhead) || 60,
            },
          },
        },
      } as any),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.locationDetail(locationId) });
      toast.success("Booking settings saved");
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? "Couldn't save"),
  });

  // The sub-settings only make sense once dine-in is on for this location.
  if (!tableServiceEnabled) {
    return (
      <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
        Table service is off for this location — turn it on from the Tables page
        to take bookings.
      </div>
    );
  }

  const numberField = (
    key: keyof Omit<Draft, "onlineEnabled">,
    label: string,
    hint: string,
  ) => (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-zinc-700">
        {label}
      </label>
      <input
        type="number"
        min={0}
        value={draft[key]}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
        className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm min-h-[44px]"
      />
      <p className="mt-1 text-[11px] text-zinc-400">{hint}</p>
    </div>
  );

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5">
      <label className="flex min-h-[44px] items-center gap-2 text-sm text-zinc-700">
        <input
          type="checkbox"
          checked={draft.onlineEnabled}
          onChange={(e) =>
            setDraft((d) => ({ ...d, onlineEnabled: e.target.checked }))
          }
        />
        Take bookings online
      </label>
      <p className="mb-4 text-[11px] text-zinc-500">
        Guests can book a table from your booking page at{" "}
        <code className="rounded bg-zinc-100 px-1">/book/{locationId}</code>.
        Bookings still land in this diary.
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {numberField("maxPartySize", "Max party size", "Bigger parties must call.")}
        {numberField("slotMinutes", "Slot length (mins)", "How long a table is held.")}
        {numberField("leadTimeMins", "Minimum notice (mins)", "No same-minute bookings.")}
        {numberField("maxDaysAhead", "Days ahead", "How far the diary opens.")}
      </div>

      <div className="mt-4 flex justify-end">
        <Button
          onClick={() => save.mutate()}
          loading={save.isPending}
          className="min-h-[44px]"
        >
          Save booking settings
        </Button>
      </div>
    </div>
  );
}
