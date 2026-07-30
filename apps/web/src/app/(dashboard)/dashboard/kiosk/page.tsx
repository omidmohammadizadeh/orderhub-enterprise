"use client";

// Self-service kiosk screens — register a device, get the URL it opens.
//
// Mirrors the signage page: the screen itself carries no login, just an
// unguessable token, so the whole job here is minting that token and
// getting it onto the device.

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { QRCodeSVG } from "qrcode.react";
import { Copy, MonitorSmartphone, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { kioskClient, type KioskDevice } from "@/lib/api/kiosk.client";

export default function KioskPage() {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [origin, setOrigin] = useState("");

  // window is client-only, and the URL must be whatever host the operator
  // is actually on (custom domains included).
  useEffect(() => setOrigin(window.location.origin), []);

  const listQuery = useQuery({
    queryKey: ["kiosks", locationId],
    queryFn: () => kioskClient.list(locationId!),
    enabled: !!locationId,
  });
  const kiosks = listQuery.data ?? [];

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["kiosks", locationId] });

  const createMut = useMutation({
    mutationFn: () =>
      kioskClient.create({ locationId: locationId!, name: name.trim() }),
    onSuccess: () => {
      setName("");
      invalidate();
      toast.success("Kiosk added");
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? "Couldn't add the kiosk"),
  });

  const updateMut = useMutation({
    mutationFn: (v: { id: string; input: any }) =>
      kioskClient.update(v.id, v.input),
    onSuccess: invalidate,
  });

  const rotateMut = useMutation({
    mutationFn: (id: string) => kioskClient.rotateToken(id),
    onSuccess: () => {
      invalidate();
      toast.success("New link issued — the old one has stopped working");
    },
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => kioskClient.remove(id),
    onSuccess: () => {
      invalidate();
      toast.success("Kiosk removed");
    },
  });

  const urlFor = (k: KioskDevice) => `${origin}/kiosk/${k.publicToken}`;

  if (!locationId) {
    return (
      <div className="p-8 text-sm text-zinc-500">
        Pick a location to manage its kiosks.
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-zinc-900">
          <MonitorSmartphone className="h-6 w-6" /> Kiosk
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Self-service screens in the shop. Customers order and collect at the
          counter — always walk-in, never delivery. The menu is the same one
          your till uses, so prices and sold-out items always match.
        </p>
      </div>

      {/* Add */}
      <div className="mb-6 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Screen name (e.g. Front door, Window 2)"
          className="w-full max-w-sm rounded-md border border-zinc-200 px-3 py-2 text-sm"
        />
        <Button
          onClick={() => createMut.mutate()}
          disabled={!name.trim()}
          loading={createMut.isPending}
        >
          <Plus className="mr-1 h-4 w-4" /> Add kiosk
        </Button>
      </div>

      {listQuery.isLoading ? (
        <p className="text-sm text-zinc-400">Loading…</p>
      ) : !kiosks.length ? (
        <div className="rounded-lg border border-dashed border-zinc-300 p-10 text-center">
          <MonitorSmartphone className="mx-auto h-8 w-8 text-zinc-300" />
          <p className="mt-3 text-sm text-zinc-600">
            No kiosk screens yet. Add one, then open its link on the tablet or
            screen you want customers to use.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {kiosks.map((k) => (
            <div
              key={k.id}
              className="rounded-xl border border-zinc-200 bg-white p-5"
            >
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-zinc-900">
                    {k.name}
                  </h2>
                  <p className="text-[11px] text-zinc-400">
                    {k.isActive ? "Active" : "Disabled"}
                  </p>
                </div>
                <div className="rounded-lg border border-zinc-200 p-2">
                  {origin ? <QRCodeSVG value={urlFor(k)} size={92} /> : null}
                </div>
              </div>

              <p className="mt-3 break-all rounded bg-zinc-50 p-2 text-[11px] text-zinc-500">
                {urlFor(k)}
              </p>

              <div className="mt-3 space-y-2">
                <Toggle
                  label="Pay at the counter"
                  hint="Order goes to the kitchen unpaid; staff take the money"
                  checked={k.config?.allowPayAtCounter !== false}
                  onChange={(v) =>
                    updateMut.mutate({
                      id: k.id,
                      input: { config: { ...k.config, allowPayAtCounter: v } },
                    })
                  }
                />
                <Toggle
                  label="Pay by card"
                  hint="Staff take the card at the counter"
                  checked={k.config?.allowCardPayment !== false}
                  onChange={(v) =>
                    updateMut.mutate({
                      id: k.id,
                      input: { config: { ...k.config, allowCardPayment: v } },
                    })
                  }
                />
                <Toggle
                  label="Screen enabled"
                  hint="Turn off to take this kiosk out of service"
                  checked={k.isActive}
                  onChange={(v) =>
                    updateMut.mutate({ id: k.id, input: { isActive: v } })
                  }
                />
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard
                      .writeText(urlFor(k))
                      .then(() => toast.success("Link copied"))
                      .catch(() => toast.error("Couldn't copy"));
                  }}
                >
                  <Copy className="mr-1 h-3.5 w-3.5" /> Copy link
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (
                      confirm(
                        "Issue a new link? The screen currently showing this kiosk will stop working until you reopen it.",
                      )
                    )
                      rotateMut.mutate(k.id);
                  }}
                >
                  <RefreshCw className="mr-1 h-3.5 w-3.5" /> New link
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (confirm(`Remove "${k.name}"?`)) removeMut.mutate(k.id);
                  }}
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" /> Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-zinc-300"
      />
      <span className="text-xs">
        <span className="font-medium text-zinc-800">{label}</span>
        <span className="block text-[11px] text-zinc-500">{hint}</span>
      </span>
    </label>
  );
}
