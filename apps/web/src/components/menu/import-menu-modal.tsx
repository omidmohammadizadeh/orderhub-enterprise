"use client";

// "Import from channel" / "Import from POS" modal.
//
// Phase AM scaffold: the actual import handlers live behind
// /v1/menus/:menuId/import/{uber,deliveroo} which need a connected
// Integration row. Until those connections are wired through the UI,
// this modal lets the operator pick a brand + target location +
// channel/POS source, then warns that the source needs configuring.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X, AlertCircle, Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { brandsClient, menusClient } from "@/lib/api/menus.client";
import { locationsClient } from "@/lib/api/locations.client";

interface Props {
  open: boolean;
  source: "channel" | "pos";
  onCancel: () => void;
  /** Called with the new menu's id after a successful import. */
  onImported?: (menuId: string) => void;
}

const CHANNELS = [
  { id: "ubereats", label: "Uber Eats" },
  { id: "deliveroo", label: "Deliveroo" },
  { id: "justeat", label: "Just Eat" },
  { id: "hubrise", label: "HubRise" },
];

const POS_SYSTEMS = [
  { id: "epos", label: "Epos Now" },
  { id: "square", label: "Square" },
  { id: "lightspeed", label: "Lightspeed" },
];

export function ImportMenuModal({ open, source, onCancel, onImported }: Props) {
  const qc = useQueryClient();
  const { data: brands = [] } = useQuery({
    queryKey: ["brands"],
    queryFn: () => brandsClient.list(),
    enabled: open,
  });
  const { data: locations = [] } = useQuery({
    queryKey: ["locations"],
    queryFn: () => locationsClient.list(),
    enabled: open,
  });

  const [brandId, setBrandId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [sourceId, setSourceId] = useState("");

  const importMutation = useMutation({
    mutationFn: () =>
      menusClient.importFromDeliveroo({ brandId, locationId }),
    onSuccess: (menu) => {
      toast.success(`Imported "${menu.name}" from Deliveroo`);
      qc.invalidateQueries({ predicate: (q) => q.queryKey.includes("menus") });
      onImported?.(menu.id);
      onCancel();
    },
    onError: (err: any) =>
      toast.error(
        `Import failed: ${err?.response?.data?.message ?? err?.message ?? "Unknown error"}`,
      ),
  });

  if (!open) return null;

  // Deliveroo is wired end-to-end (pull via its API using the brand's saved
  // connection); the other channels are still connect-first placeholders.
  const isWired = source === "channel" && sourceId === "deliveroo";
  const canImport = isWired && !!brandId && !!locationId;

  const options = source === "channel" ? CHANNELS : POS_SYSTEMS;
  const title =
    source === "channel" ? "Import menu from channel" : "Import menu from POS";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg">
        <div className="flex items-center justify-between p-5 border-b border-zinc-100">
          <h2 className="text-base font-semibold text-zinc-900">{title}</h2>
          <button
            onClick={onCancel}
            className="text-zinc-400 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <label className="block">
            <span className="text-xs font-semibold text-zinc-700">
              {source === "channel" ? "Channel" : "POS"}
            </span>
            <select
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm"
            >
              <option value="">Pick one…</option>
              {options.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-semibold text-zinc-700">Brand</span>
            <select
              value={brandId}
              onChange={(e) => setBrandId(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm"
            >
              <option value="">Pick a brand…</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-semibold text-zinc-700">
              Link products to location
            </span>
            <select
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm"
            >
              <option value="">Pick a location…</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>

          {isWired ? (
            <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <p>
                Pulls the brand&apos;s live Deliveroo menu into a new menu here.
                Make sure Deliveroo is connected for this brand (Locations →
                Brands → Deliveroo).
              </p>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <p>
                {source === "channel"
                  ? "This channel isn't wired for direct import yet. Deliveroo is available today — pick it above."
                  : "POS integrations are not yet connected. Configure your POS in Integrations to enable import."}
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-zinc-100">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!canImport || importMutation.isPending}
            onClick={() => importMutation.mutate()}
            title={
              canImport
                ? "Import the menu from Deliveroo"
                : "Pick Deliveroo, a brand and a location"
            }
            className="bg-zinc-900 text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {importMutation.isPending ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Importing…
              </span>
            ) : (
              "Import menu"
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
