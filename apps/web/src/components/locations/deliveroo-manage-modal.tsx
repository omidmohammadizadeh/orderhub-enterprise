"use client";

// Deliveroo channel management modal — same organised surface as the Uber
// Eats one: header with identity, action bar (open/close/push hours+prep),
// connection card with editable ids, danger-zone disconnect.

import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Clock,
  Link2,
  Loader2,
  Pause,
  Play,
  Trash2,
  X,
} from "lucide-react";
import toast from "react-hot-toast";
import { deliverooClient } from "@/lib/api/deliveroo.client";
import { PlatformLogo } from "@/components/ui/platform-logo";

export function DeliverooManageModal({
  connectionId,
  brandId,
  locationId,
  siteId,
  deliverooBrandId,
  open,
  onClose,
  onChanged,
}: {
  connectionId: string;
  brandId: string;
  locationId: string;
  siteId: string | null;
  deliverooBrandId: string | null;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [editSite, setEditSite] = useState(siteId ?? "");
  const [editBrand, setEditBrand] = useState(deliverooBrandId ?? "");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) {
      setEditSite(siteId ?? "");
      setEditBrand(deliverooBrandId ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, deliverooBrandId]);

  const err = (e: any) =>
    toast.error(
      e?.response?.data?.message ?? e?.message ?? "Deliveroo request failed",
    );

  const pause = useMutation({
    mutationFn: () => deliverooClient.pause(connectionId),
    onSuccess: () => {
      toast.success("Deliveroo store paused (closed)");
      onChanged();
    },
    onError: err,
  });
  const resume = useMutation({
    mutationFn: () => deliverooClient.resume(connectionId),
    onSuccess: () => {
      toast.success("Deliveroo store open");
      onChanged();
    },
    onError: err,
  });
  const publishHours = useMutation({
    mutationFn: () => deliverooClient.publishHours(connectionId),
    onSuccess: () => toast.success("Opening hours + prep pushed to Deliveroo"),
    onError: err,
  });
  const reconnect = useMutation({
    mutationFn: () =>
      deliverooClient.connect({
        brandId,
        locationId,
        storeId: editSite.trim(),
        deliverooBrandId: editBrand.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success("Deliveroo connection updated");
      setDirty(false);
      onChanged();
    },
    onError: err,
  });
  const disconnect = useMutation({
    mutationFn: () => deliverooClient.disconnect(connectionId),
    onSuccess: () => {
      toast.success("Deliveroo disconnected");
      onChanged();
      onClose();
    },
    onError: err,
  });

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-zinc-50 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="flex items-center gap-3 border-b border-zinc-200 bg-white px-5 py-4">
          <PlatformLogo platform="DELIVEROO" size={40} />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-zinc-900">Deliveroo</h2>
            <p className="truncate text-xs text-zinc-500">
              Site {siteId ?? "—"} · Brand {deliverooBrandId ?? "—"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {/* Action bar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 bg-white px-5 py-3">
          <button
            onClick={() => resume.mutate()}
            disabled={resume.isPending}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {resume.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Open store
          </button>
          <button
            onClick={() => pause.mutate()}
            disabled={pause.isPending}
            className="flex items-center gap-1.5 rounded-lg border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-100 disabled:opacity-50"
          >
            {pause.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Pause className="h-3.5 w-3.5" />
            )}
            Pause store
          </button>
          <button
            onClick={() => publishHours.mutate()}
            disabled={publishHours.isPending}
            title="Pushes the location's opening hours + prep time to Deliveroo"
            className="flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
          >
            {publishHours.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Clock className="h-3.5 w-3.5" />
            )}
            Push hours + prep
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <section className="rounded-xl border border-zinc-200 bg-white p-4">
            <h3 className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold text-zinc-800">
              <Link2 className="h-3.5 w-3.5 text-zinc-400" />
              Connection
            </h3>
            <div className="space-y-2">
              <div>
                <label className="text-[11px] text-zinc-500">
                  Site ID (rest-…)
                </label>
                <input
                  value={editSite}
                  onChange={(e) => {
                    setEditSite(e.target.value);
                    setDirty(true);
                  }}
                  className="mt-0.5 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-[11px] text-zinc-500">
                  Deliveroo Brand ID (optional — auto-resolved)
                </label>
                <input
                  value={editBrand}
                  onChange={(e) => {
                    setEditBrand(e.target.value);
                    setDirty(true);
                  }}
                  className="mt-0.5 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
                />
              </div>
              {dirty && (
                <button
                  onClick={() => reconnect.mutate()}
                  disabled={reconnect.isPending || !editSite.trim()}
                  className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                >
                  {reconnect.isPending && (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  )}
                  Save connection
                </button>
              )}
            </div>
          </section>

          <section className="rounded-xl border border-zinc-200 bg-white p-4">
            <h3 className="mb-1.5 text-xs font-semibold text-zinc-800">
              How syncing works
            </h3>
            <ul className="list-disc space-y-1 pl-4 text-[11px] text-zinc-500">
              <li>
                Orders arrive automatically; accept / ready / cancel push back
                from the Orders board.
              </li>
              <li>
                "Push hours + prep" sends the location's opening hours and prep
                time to this Deliveroo site.
              </li>
              <li>
                Pausing here (or "Stop taking orders" on the Orders board)
                closes the site on Deliveroo; opening reverses it.
              </li>
            </ul>
          </section>

          {/* Danger zone */}
          <section className="rounded-xl border border-red-200 bg-red-50/50 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-xs font-semibold text-red-800">
                  Disconnect Deliveroo
                </h3>
                <p className="text-[11px] text-red-600/80">
                  Removes the site link from OrderHub. The site itself stays
                  live on Deliveroo.
                </p>
              </div>
              <button
                onClick={() => disconnect.mutate()}
                disabled={disconnect.isPending}
                className="flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
              >
                {disconnect.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
                Disconnect
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
