"use client";

// "Import from channel" / "Import from POS" modal.
//
// Phase AM scaffold: the actual import handlers live behind
// /v1/menus/:menuId/import/{uber,deliveroo} which need a connected
// Integration row. Until those connections are wired through the UI,
// this modal lets the operator pick a brand + target location +
// channel/POS source, then warns that the source needs configuring.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { brandsClient } from "@/lib/api/menus.client";
import { locationsClient } from "@/lib/api/locations.client";

interface Props {
  open: boolean;
  source: "channel" | "pos";
  onCancel: () => void;
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

export function ImportMenuModal({ open, source, onCancel }: Props) {
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

  if (!open) return null;

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

          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <p>
              {source === "channel"
                ? "The selected channel needs to be connected in Integrations first. Once connected, this importer will pull menus directly from its API."
                : "POS integrations are not yet connected. Configure your POS in Integrations to enable import."}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-zinc-100">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled
            title="Connect the integration in the Integrations tab first."
            className="bg-zinc-900 text-white opacity-50 cursor-not-allowed"
          >
            Import menu
          </Button>
        </div>
      </div>
    </div>
  );
}
