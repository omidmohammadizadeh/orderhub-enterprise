"use client";

// Digital Signage — set up in-store menu boards (TV screens) per location.
// Each board shows a chosen, ordered subset of the location's POS menu
// categories; prices + 86-state are pulled live from the POS menu by the
// public /signage/[token] page, so a board always matches the till.

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import toast from "react-hot-toast";
import {
  Monitor,
  Plus,
  Copy,
  ExternalLink,
  Pencil,
  Trash2,
  X,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { menusClient } from "@/lib/api/menus.client";
import {
  signageClient,
  type SignageDisplay,
  type SignageConfig,
} from "@/lib/api/signage.client";

export default function SignagePage() {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const qc = useQueryClient();
  const [editing, setEditing] = useState<SignageDisplay | null>(null);
  const [creating, setCreating] = useState(false);

  const displaysQuery = useQuery({
    queryKey: ["signage", locationId],
    queryFn: () => signageClient.list(locationId!),
    enabled: !!locationId,
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => signageClient.remove(id),
    onSuccess: () => {
      toast.success("Screen deleted");
      qc.invalidateQueries({ queryKey: ["signage", locationId] });
    },
    onError: () => toast.error("Couldn't delete the screen"),
  });

  if (!locationId) {
    return (
      <div className="p-6">
        <p className="text-sm text-zinc-500">
          Select a location to manage its menu-board screens.
        </p>
      </div>
    );
  }

  const displays = displaysQuery.data ?? [];

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-zinc-900">
            <Monitor className="h-5 w-5" /> Digital Signage
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Menu boards for TV screens. Prices and sold-out items always match
            your POS automatically.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="mr-1 h-4 w-4" /> New screen
        </Button>
      </div>

      {displaysQuery.isLoading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : displays.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 p-10 text-center">
          <Monitor className="mx-auto h-8 w-8 text-zinc-300" />
          <p className="mt-3 text-sm text-zinc-600">
            No screens yet. Create one, pick the categories to show, then open
            its link on a TV (Fire TV Stick, Android box, or the TV browser).
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {displays.map((d) => (
            <DisplayCard
              key={d.id}
              display={d}
              onEdit={() => setEditing(d)}
              onDelete={() => {
                if (confirm(`Delete screen "${d.name}"?`)) removeMut.mutate(d.id);
              }}
            />
          ))}
        </div>
      )}

      {(creating || editing) && (
        <DisplayEditor
          locationId={locationId}
          display={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            qc.invalidateQueries({ queryKey: ["signage", locationId] });
          }}
        />
      )}
    </div>
  );
}

function boardUrl(token: string): string {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/signage/${token}`;
}

function DisplayCard({
  display,
  onEdit,
  onDelete,
}: {
  display: SignageDisplay;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const url = boardUrl(display.publicToken);
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-semibold text-zinc-900">{display.name}</h3>
          <p className="mt-0.5 text-xs text-zinc-500">
            {display.orientation === "portrait" ? "Portrait" : "Landscape"} ·{" "}
            {display.categoryIds.length} categor
            {display.categoryIds.length === 1 ? "y" : "ies"}
            {display.isActive ? "" : " · paused"}
          </p>
        </div>
        <div className="flex gap-1">
          <button
            onClick={onEdit}
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
            aria-label="Edit"
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            onClick={onDelete}
            className="rounded-md p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600"
            aria-label="Delete"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <div className="rounded-lg border border-zinc-100 bg-white p-1.5">
          <QRCodeSVG value={url} size={72} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-zinc-500" title={url}>
            {url}
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                navigator.clipboard.writeText(url);
                toast.success("Link copied");
              }}
            >
              <Copy className="mr-1 h-3.5 w-3.5" /> Copy
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => window.open(url, "_blank")}
            >
              <ExternalLink className="mr-1 h-3.5 w-3.5" /> Open
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DisplayEditor({
  locationId,
  display,
  onClose,
  onSaved,
}: {
  locationId: string;
  display: SignageDisplay | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(display?.name ?? "");
  const [orientation, setOrientation] = useState<"landscape" | "portrait">(
    display?.orientation ?? "landscape",
  );
  // Ordered list of selected category ids.
  const [selected, setSelected] = useState<string[]>(
    display?.categoryIds ?? [],
  );
  const [config, setConfig] = useState<SignageConfig>(
    display?.config ?? { columns: 2, showImages: false, refreshSeconds: 45 },
  );

  // Category options come from the location's live POS menu — exactly what the
  // board will render from.
  const menuQuery = useQuery({
    queryKey: ["signage-active-menu", locationId],
    queryFn: () => menusClient.getActiveMenuForLocation(locationId),
  });
  const allCategories = useMemo(
    () =>
      (menuQuery.data?.categories ?? []).map((c) => ({
        id: c.id,
        name: c.name,
      })),
    [menuQuery.data],
  );
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of allCategories) m.set(c.id, c.name);
    return m;
  }, [allCategories]);

  const unselected = allCategories.filter((c) => !selected.includes(c.id));

  const saveMut = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        categoryIds: selected,
        orientation,
        config,
      };
      return display
        ? signageClient.update(display.id, payload)
        : signageClient.create({ locationId, ...payload });
    },
    onSuccess: () => {
      toast.success(display ? "Screen updated" : "Screen created");
      onSaved();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? "Couldn't save the screen"),
  });

  const move = (idx: number, dir: -1 | 1) => {
    setSelected((prev) => {
      const next = [...prev];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j]!, next[idx]!];
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-900">
            {display ? "Edit screen" : "New screen"}
          </h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 p-5">
          <div>
            <label className="mb-1 block text-sm font-medium text-zinc-700">
              Screen name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Front counter — Food"
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-zinc-700">
              Orientation
            </label>
            <div className="flex gap-1 rounded-lg bg-zinc-100 p-1 text-sm">
              {(["landscape", "portrait"] as const).map((o) => (
                <button
                  key={o}
                  onClick={() => setOrientation(o)}
                  className={`flex-1 rounded-md px-3 py-1.5 capitalize ${
                    orientation === o
                      ? "bg-white text-zinc-900 shadow-sm"
                      : "text-zinc-500"
                  }`}
                >
                  {o}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-zinc-700">
              Categories to show (in order)
            </label>
            {menuQuery.isLoading ? (
              <p className="text-xs text-zinc-500">Loading categories…</p>
            ) : allCategories.length === 0 ? (
              <p className="text-xs text-amber-600">
                This location has no published POS menu yet — publish a menu
                first, then its categories will appear here.
              </p>
            ) : (
              <div className="space-y-3">
                {selected.length > 0 && (
                  <ul className="space-y-1">
                    {selected.map((id, idx) => (
                      <li
                        key={id}
                        className="flex items-center gap-2 rounded-md border border-zinc-200 px-2 py-1.5 text-sm"
                      >
                        <span className="flex-1 truncate">
                          {nameById.get(id) ?? "(removed category)"}
                        </span>
                        <button
                          onClick={() => move(idx, -1)}
                          disabled={idx === 0}
                          className="text-zinc-400 hover:text-zinc-700 disabled:opacity-30"
                        >
                          <ChevronUp className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => move(idx, 1)}
                          disabled={idx === selected.length - 1}
                          className="text-zinc-400 hover:text-zinc-700 disabled:opacity-30"
                        >
                          <ChevronDown className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() =>
                            setSelected((p) => p.filter((x) => x !== id))
                          }
                          className="text-zinc-400 hover:text-red-600"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {unselected.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {unselected.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => setSelected((p) => [...p, c.id])}
                        className="rounded-full border border-zinc-200 px-3 py-1 text-xs text-zinc-600 hover:border-zinc-400 hover:text-zinc-900"
                      >
                        + {c.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-zinc-700">
                Columns (landscape)
              </label>
              <input
                type="number"
                min={1}
                max={4}
                value={config.columns ?? 2}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, columns: Number(e.target.value) }))
                }
                className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-zinc-700">
                Refresh (seconds)
              </label>
              <input
                type="number"
                min={15}
                max={600}
                value={config.refreshSeconds ?? 45}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    refreshSeconds: Number(e.target.value),
                  }))
                }
                className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-zinc-700">
            <input
              type="checkbox"
              checked={config.showImages ?? false}
              onChange={(e) =>
                setConfig((c) => ({ ...c, showImages: e.target.checked }))
              }
            />
            Show item photos
          </label>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-zinc-700">
                Background colour
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={config.background ?? "#0b0b0c"}
                  onChange={(e) =>
                    setConfig((c) => ({ ...c, background: e.target.value }))
                  }
                  className="h-9 w-12 cursor-pointer rounded-md border border-zinc-200"
                  aria-label="Background colour"
                />
                <button
                  type="button"
                  onClick={() =>
                    setConfig((c) => ({ ...c, background: "#0b0b0c" }))
                  }
                  className="rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
                >
                  Dark
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setConfig((c) => ({ ...c, background: "#ffffff" }))
                  }
                  className="rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
                >
                  White
                </button>
              </div>
              <p className="mt-1 text-[11px] text-zinc-400">
                Text colour adjusts automatically for contrast.
              </p>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-zinc-700">
                Screen rotation
              </label>
              <select
                value={config.rotation ?? 0}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    rotation: Number(e.target.value) as 0 | 90 | 180 | 270,
                  }))
                }
                className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
              >
                <option value={0}>0° — normal</option>
                <option value={90}>90° — clockwise</option>
                <option value={180}>180° — upside down</option>
                <option value={270}>270° — counter-clockwise</option>
              </select>
              <p className="mt-1 text-[11px] text-zinc-400">
                Use if the TV is mounted sideways.
              </p>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-100 px-5 py-3">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => saveMut.mutate()}
            disabled={
              saveMut.isPending || !name.trim() || selected.length === 0
            }
          >
            {display ? "Save changes" : "Create screen"}
          </Button>
        </div>
      </div>
    </div>
  );
}
