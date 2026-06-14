"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save } from "lucide-react";
import { useState } from "react";
import {
  alertsClient,
  ALERT_TRIGGERS,
  type AlertConfig,
} from "@/lib/api/printers.client";
import { locationsClient } from "@/lib/api/locations.client";

const DEFAULT_SOUND =
  "https://orderhub-static.onrender.com/sounds/notification.mp3";

export function AlertsTab({ locationId }: { locationId?: string }) {
  const qc = useQueryClient();
  const [pickedLocation, setPickedLocation] = useState(locationId ?? "");

  const locationsQuery = useQuery({
    queryKey: ["locations", "list"],
    queryFn: locationsClient.list,
  });
  const effectiveLoc = locationId ?? pickedLocation;
  const alertsQuery = useQuery({
    queryKey: ["alerts", "list", effectiveLoc ?? "all"],
    queryFn: () => alertsClient.list(effectiveLoc),
    enabled: !!effectiveLoc,
  });

  const upsert = useMutation({
    mutationFn: (body: any) => alertsClient.upsert(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts", "list"] }),
  });

  if (!locationId) {
    return (
      <div className="space-y-3">
        <select
          value={pickedLocation}
          onChange={(e) => setPickedLocation(e.target.value)}
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
        >
          <option value="">— pick a location —</option>
          {(locationsQuery.data ?? []).map((l: any) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        {!pickedLocation && (
          <p className="text-sm text-zinc-500">
            Pick a location to configure its alert rules, or use the location
            switcher in the sidebar.
          </p>
        )}
      </div>
    );
  }

  const byTrigger = new Map<string, AlertConfig>(
    (alertsQuery.data ?? []).map((a) => [a.trigger, a]),
  );

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-500">
        Configure how the dashboard reacts to each event. Sounds play in
        every browser tab logged in to this location.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {ALERT_TRIGGERS.map((t) => {
          const cur = byTrigger.get(t.value);
          return (
            <AlertCard
              key={t.value}
              label={t.label}
              trigger={t.value}
              cur={cur}
              onSave={(patch) =>
                upsert.mutate({
                  locationId: effectiveLoc,
                  trigger: t.value,
                  ...patch,
                })
              }
              saving={upsert.isPending}
            />
          );
        })}
      </div>
    </div>
  );
}

function AlertCard({
  label,
  trigger,
  cur,
  onSave,
  saving,
}: {
  label: string;
  trigger: string;
  cur?: AlertConfig;
  onSave: (patch: Partial<AlertConfig>) => void;
  saving: boolean;
}) {
  const [enabled, setEnabled] = useState(cur?.enabled ?? true);
  const [soundUrl, setSoundUrl] = useState(cur?.soundUrl ?? DEFAULT_SOUND);
  const [volume, setVolume] = useState(cur?.volume ?? 1.0);
  const [repeatCount, setRepeatCount] = useState(cur?.repeatCount ?? 1);
  const [repeatIntervalMs, setRepeatInterval] = useState(
    cur?.repeatIntervalMs ?? 5000,
  );
  const [requireAck, setRequireAck] = useState(
    cur?.requireAcknowledgement ?? false,
  );

  const preview = () => {
    const audio = new Audio(soundUrl);
    audio.volume = volume;
    audio.play().catch(() => {});
  };

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-900">{label}</h3>
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          enabled
        </label>
      </div>
      <input
        value={soundUrl}
        onChange={(e) => setSoundUrl(e.target.value)}
        placeholder="https://…/sound.mp3"
        className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-xs"
      />
      <div className="grid grid-cols-3 gap-2">
        <label className="text-[11px] font-semibold text-zinc-600">
          Volume
          <input
            type="range"
            min={0}
            max={1}
            step={0.1}
            value={volume}
            onChange={(e) => setVolume(parseFloat(e.target.value))}
            className="w-full"
          />
        </label>
        <label className="text-[11px] font-semibold text-zinc-600">
          Repeat
          <input
            type="number"
            min={1}
            max={20}
            value={repeatCount}
            onChange={(e) => setRepeatCount(parseInt(e.target.value, 10) || 1)}
            className="w-full rounded border border-zinc-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="text-[11px] font-semibold text-zinc-600">
          Every (ms)
          <input
            type="number"
            min={500}
            max={60000}
            value={repeatIntervalMs}
            onChange={(e) =>
              setRepeatInterval(parseInt(e.target.value, 10) || 5000)
            }
            className="w-full rounded border border-zinc-300 px-2 py-1 text-sm"
          />
        </label>
      </div>
      <label className="flex items-center gap-1 text-xs text-zinc-600">
        <input
          type="checkbox"
          checked={requireAck}
          onChange={(e) => setRequireAck(e.target.checked)}
        />
        Require acknowledgement (keep ringing until someone clicks Stop)
      </label>
      <div className="flex justify-between">
        <button
          onClick={preview}
          className="text-xs font-semibold text-violet-700 hover:text-violet-800"
        >
          ▶ Preview
        </button>
        <button
          onClick={() =>
            onSave({
              enabled,
              soundUrl,
              volume,
              repeatCount,
              repeatIntervalMs,
              requireAcknowledgement: requireAck,
            })
          }
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {saving && <Loader2 className="h-3 w-3 animate-spin" />}
          <Save className="h-3 w-3" /> Save
        </button>
      </div>
    </div>
  );
}
