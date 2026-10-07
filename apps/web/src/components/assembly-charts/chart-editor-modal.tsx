"use client";

// Assembly chart editor — build the poster column for one product: pick
// layers from the palette (bun, sauce, onions, patty…), label each, reorder,
// and watch the live preview. Shared by every location selling the brand.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Copy, Loader2, Printer, Sandwich, Trash2, X } from "lucide-react";
import {
  INGREDIENT_CATEGORIES,
  assemblyIngredient,
  searchAssemblyIngredients,
  type IngredientCategory,
  ASSEMBLY_MAX_LAYERS,
  ASSEMBLY_SAUCE_COLOURS,
  type AssemblyLayer,
  type AssemblyLayerKind,
} from "@orderhub/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ImageUploader } from "@/components/products/image-uploader";
import { cn } from "@/lib/utils";
import { assemblyChartsClient, CHART_KEYS_QUERY } from "@/lib/api/assembly-charts.client";
import { BOARD_BG, ChartColumn } from "./chart-column";
import { LayerArt, ingredientLabel } from "./layer-art";

function newId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `l-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const layer = (kind: AssemblyLayerKind, label?: string, color?: string): AssemblyLayer => ({
  id: newId(),
  kind,
  label: label ?? ingredientLabel(kind),
  ...(color ? { color } : {}),
});

/** One-click starting points, built from what kitchens actually make. */
const TEMPLATES: Array<{ name: string; build: () => AssemblyLayer[] }> = [
  {
    name: "Double smash burger",
    build: () => [
      layer("bun_top"),
      layer("burger_sauce"),
      layer("onions"),
      layer("pickles"),
      layer("patty_cheese"),
      layer("patty_cheese"),
      layer("garlic_mayo"),
      layer("bun_bottom"),
    ],
  },
  {
    name: "Single smash burger",
    build: () => [
      layer("bun_top"),
      layer("ketchup"),
      layer("onions"),
      layer("patty_cheese"),
      layer("garlic_mayo"),
      layer("bun_bottom"),
    ],
  },
  {
    name: "Fried chicken burger",
    build: () => [
      layer("bun_top"),
      layer("burger_sauce"),
      layer("pickles"),
      layer("chicken"),
      layer("lettuce"),
      layer("garlic_mayo"),
      layer("bun_bottom"),
    ],
  },
  {
    name: "Burrito",
    build: () => [
      layer("tortilla_12"),
      layer("mexican_rice"),
      layer("house_beans"),
      layer("chicken_pastor"),
      layer("grated_cheese"),
      layer("pico_de_gallo"),
      layer("sour_cream"),
      layer("burrito_wrap"),
      layer("tin_foil"),
    ],
  },
  {
    name: "Tacos (3)",
    build: () => [
      layer("corn_tortilla", "3x corn tortillas"),
      layer("pulled_beef"),
      layer("pickled_onions"),
      layer("coriander"),
      layer("medium_salsa"),
      layer("lime_wedge"),
      layer("taco_tray"),
    ],
  },
  {
    name: "Margherita pizza",
    build: () => [
      layer("pizza_dough"),
      layer("tomato_base"),
      layer("pizza_mozzarella"),
      layer("oregano"),
      layer("pizza_box"),
    ],
  },
  {
    name: "Pepperoni pizza",
    build: () => [
      layer("pizza_dough"),
      layer("tomato_base"),
      layer("pizza_mozzarella"),
      layer("pepperoni"),
      layer("oregano"),
      layer("pizza_box"),
    ],
  },
  {
    name: "Doner wrap",
    build: () => [
      layer("wrap"),
      layer("garlic_sauce"),
      layer("doner"),
      layer("salad_mix"),
      layer("red_cabbage"),
      layer("chilli_sauce"),
      layer("greaseproof"),
    ],
  },
  {
    name: "Wings box",
    build: () => [layer("fries"), layer("wings"), layer("buffalo"), layer("ranch"), layer("pot_2oz"), layer("kraft_clamshell")],
  },
  {
    name: "Grilled cheese (upside-down buns)",
    build: () => [
      layer("bun_upside_down"),
      layer("cheese"),
      layer("burger_sauce"),
      layer("onions"),
      layer("cheese"),
      layer("bun_upside_down"),
    ],
  },
];

interface Props {
  open: boolean;
  itemId: string;
  itemName: string;
  onClose: () => void;
}

export function ChartEditorModal({ open, itemId, itemName, onClose }: Props) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [altTitle, setAltTitle] = useState("");
  const [footNote, setFootNote] = useState("");
  const [hero, setHero] = useState<string | null>(null);
  const [layers, setLayers] = useState<AssemblyLayer[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteCat, setPaletteCat] = useState<IngredientCategory | "all">("all");

  const q = useQuery({
    queryKey: ["assembly-chart", itemId],
    queryFn: () => assemblyChartsClient.getForItem(itemId),
    enabled: open && !!itemId,
  });
  const others = useQuery({
    queryKey: ["assembly-charts-all"],
    queryFn: assemblyChartsClient.all,
    enabled: open,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!open || q.isLoading) return;
    const c = q.data?.chart;
    setTitle(c?.title ?? itemName);
    setAltTitle(c?.altTitle ?? "");
    setFootNote(c?.footNote ?? "");
    setHero(c?.heroImageUrl ?? null);
    setLayers(c?.layers?.length ? c.layers : []);
    setSelected(null);
    setError(null);
  }, [open, q.isLoading, q.data, itemName]);

  const save = useMutation({
    mutationFn: () =>
      assemblyChartsClient.saveForItem(itemId, {
        title: title.trim() || itemName,
        altTitle: altTitle.trim() || null,
        footNote: footNote.trim() || null,
        heroImageUrl: hero,
        layers,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["assembly-chart", itemId] });
      qc.invalidateQueries({ queryKey: ["assembly-charts-all"] });
      qc.invalidateQueries({ queryKey: CHART_KEYS_QUERY });
      onClose();
    },
    onError: (e: any) => setError(e?.response?.data?.message ?? "Could not save the chart"),
  });

  const preview = useMemo(
    () => ({
      title: title.trim() || itemName,
      altTitle: altTitle.trim() || null,
      footNote: footNote.trim() || null,
      heroImageUrl: hero ?? q.data?.productImageUrl ?? null,
      layers,
    }),
    [title, altTitle, footNote, hero, layers, itemName, q.data?.productImageUrl],
  );

  if (!open) return null;

  const palette = searchAssemblyIngredients(paletteQuery, paletteQuery.trim() ? "all" : paletteCat);

  const update = (id: string, patch: Partial<AssemblyLayer>) =>
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const move = (i: number, dir: -1 | 1) =>
    setLayers((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      const [m] = next.splice(i, 1);
      next.splice(j, 0, m!);
      return next;
    });
  const add = (kind: AssemblyLayerKind) => {
    // Built outside the updater: StrictMode runs updaters twice.
    const l = layer(kind);
    setSelected(l.id);
    setLayers((prev) => {
      if (prev.length >= ASSEMBLY_MAX_LAYERS) return prev;
      // New fillings go above the bottom bun, not under it.
      const last = prev[prev.length - 1];
      if (kind !== "bun_bottom" && last && (last.kind === "bun_bottom" || (last.kind === "bun_upside_down" && prev.length > 1))) {
        return [...prev.slice(0, -1), l, last];
      }
      return [...prev, l];
    });
  };
  const startFrom = (value: string) => {
    if (!value) return;
    if (layers.length && !confirm("Replace the current layers?")) return;
    if (value.startsWith("tpl:")) {
      const t = TEMPLATES[Number(value.slice(4))];
      if (t) setLayers(t.build());
    } else if (value.startsWith("chart:")) {
      const c = others.data?.find((x) => x.id === value.slice(6));
      if (c) setLayers(c.layers.map((l) => ({ ...l, id: newId() })));
    }
    setSelected(null);
  };

  const otherCharts = (others.data ?? []).filter((c) => c.id !== q.data?.chart?.id);

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-black/40 backdrop-blur-sm sm:p-4">
      <div className="min-h-full w-full max-w-6xl bg-white shadow-2xl sm:my-6 sm:min-h-0 sm:rounded-xl">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-zinc-100 bg-white px-4 py-3 sm:rounded-t-xl sm:px-6">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900">
              <Sandwich className="h-4 w-4 text-pink-600" /> Assembly chart
            </h2>
            <p className="truncate text-xs text-zinc-500">{itemName} · shared by every location selling this brand</p>
          </div>
          <div className="flex items-center gap-2">
            {q.data?.chart && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => window.open(`/print/assembly-charts?item=${encodeURIComponent(itemId)}`, "_blank")}
                title="Print this chart (saved version)"
              >
                <Printer className="mr-1.5 h-3.5 w-3.5" /> Print
              </Button>
            )}
            <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {q.isLoading ? (
          <div className="flex items-center justify-center py-20 text-sm text-zinc-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading chart…
          </div>
        ) : (
          <div className="grid gap-0 lg:grid-cols-[1fr_320px]">
            <div className="space-y-5 p-4 sm:p-6">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name on the chart">
                  <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} />
                </Field>
                <Field label="Second name (optional)" hint="same build on another brand">
                  <Input value={altTitle} onChange={(e) => setAltTitle(e.target.value)} maxLength={60} placeholder="e.g. The Proper Fitty" />
                </Field>
                <Field label="Note under the chart (optional)">
                  <Input value={footNote} onChange={(e) => setFootNote(e.target.value)} maxLength={120} placeholder="e.g. Cook time 3.5 mins" />
                </Field>
                <Field label="Start from">
                  <select
                    value=""
                    onChange={(e) => startFrom(e.target.value)}
                    className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm"
                  >
                    <option value="">Template or another chart…</option>
                    <optgroup label="Templates">
                      {TEMPLATES.map((t, i) => (
                        <option key={t.name} value={`tpl:${i}`}>
                          {t.name}
                        </option>
                      ))}
                    </optgroup>
                    {otherCharts.length > 0 && (
                      <optgroup label="Copy layers from">
                        {otherCharts.map((c) => (
                          <option key={c.id} value={`chart:${c.id}`}>
                            {c.title}
                            {c.brandName ? ` — ${c.brandName}` : ""}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </Field>
              </div>

              <details className="rounded-lg border border-zinc-200 p-3">
                <summary className="cursor-pointer text-sm font-medium text-zinc-700">
                  Burger photo above the column {hero ? "(custom)" : "(product photo)"}
                </summary>
                <div className="mt-3 max-w-xs">
                  <ImageUploader value={hero} onChange={setHero} targetWidth={600} targetHeight={450} fit="contain" />
                  <p className="mt-1 text-xs text-zinc-500">Leave empty to use the product photo. A cut-out PNG looks best.</p>
                </div>
              </details>

              <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-medium text-zinc-600">
                    Add an ingredient <span className="font-normal text-zinc-400">— {palette.length} shown</span>
                  </p>
                  <Input
                    value={paletteQuery}
                    onChange={(e) => setPaletteQuery(e.target.value)}
                    placeholder="Search — peri, pepperoni, foil, rice…"
                    className="h-8 w-full sm:w-64"
                  />
                </div>
                <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1">
                  {[{ id: "all" as const, name: "All" }, ...INGREDIENT_CATEGORIES].map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setPaletteCat(c.id)}
                      className={cn(
                        "shrink-0 rounded-full px-2.5 py-1 text-xs font-medium",
                        paletteCat === c.id ? "bg-pink-600 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200",
                      )}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
                <div className="max-h-72 overflow-y-auto rounded-lg border border-zinc-100 p-2">
                  {palette.length === 0 ? (
                    <p className="py-8 text-center text-sm text-zinc-500">
                      Nothing matches — use “Own photo” for anything not in the library.
                    </p>
                  ) : (
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-6">
                      {palette.map((ing) => (
                        <button
                          key={ing.key}
                          type="button"
                          onClick={() => add(ing.key)}
                          disabled={layers.length >= ASSEMBLY_MAX_LAYERS}
                          title={`Add ${ing.name}`}
                          className="flex flex-col items-center gap-1 rounded-lg border border-zinc-200 p-1.5 text-center text-[11px] font-medium leading-tight text-zinc-700 hover:border-pink-300 hover:bg-pink-50 disabled:opacity-40"
                        >
                          <LayerArt kind={ing.key} className="h-7 w-full" />
                          {ing.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div>
                <p className="mb-2 text-xs font-medium text-zinc-600">
                  Layers, top to bottom ({layers.length}) — the order the customer sees when they open it
                </p>
                {layers.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-zinc-300 py-8 text-center text-sm text-zinc-500">
                    Pick a template above or add layers from the palette.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {layers.map((l, i) => (
                      <li
                        key={l.id}
                        className={cn(
                          "rounded-lg border p-2",
                          selected === l.id ? "border-pink-400 bg-pink-50/40" : "border-zinc-200",
                        )}
                        onClick={() => setSelected(l.id)}
                      >
                        <div className="flex items-center gap-2">
                          <LayerArt kind={l.kind} color={l.color} imageUrl={l.imageUrl} className="h-9 w-24 shrink-0" />
                          <Input
                            value={l.label}
                            onChange={(e) => update(l.id, { label: e.target.value })}
                            maxLength={80}
                            placeholder="Label"
                            className="h-8 flex-1"
                          />
                          <div className="flex shrink-0 items-center">
                            <IconBtn title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                              <ArrowUp className="h-4 w-4" />
                            </IconBtn>
                            <IconBtn title="Move down" disabled={i === layers.length - 1} onClick={() => move(i, 1)}>
                              <ArrowDown className="h-4 w-4" />
                            </IconBtn>
                            <IconBtn
                              title="Duplicate"
                              disabled={layers.length >= ASSEMBLY_MAX_LAYERS}
                              onClick={() =>
                                setLayers((prev) => {
                                  const next = [...prev];
                                  next.splice(i + 1, 0, { ...l, id: newId() });
                                  return next;
                                })
                              }
                            >
                              <Copy className="h-4 w-4" />
                            </IconBtn>
                            <IconBtn title="Remove" danger onClick={() => setLayers((prev) => prev.filter((x) => x.id !== l.id))}>
                              <Trash2 className="h-4 w-4" />
                            </IconBtn>
                          </div>
                        </div>
                        {selected === l.id && (
                          <div className="mt-2 grid gap-3 border-t border-zinc-100 pt-2 sm:grid-cols-2">
                            {assemblyIngredient(l.kind)?.recolourable && (
                              <div className="sm:col-span-2">
                                <p className="mb-1 text-xs font-medium text-zinc-600">Sauce colour</p>
                                <div className="flex flex-wrap items-center gap-1.5">
                                  {ASSEMBLY_SAUCE_COLOURS.map((c) => (
                                    <button
                                      key={c.hex}
                                      type="button"
                                      title={c.name}
                                      onClick={() => update(l.id, { color: c.hex, label: l.label === "Sauce" ? c.name : l.label })}
                                      className={cn(
                                        "h-6 w-6 rounded-full ring-1 ring-zinc-300",
                                        l.color?.toLowerCase() === c.hex && "ring-2 ring-pink-500 ring-offset-1",
                                      )}
                                      style={{ background: c.hex }}
                                    />
                                  ))}
                                  <input
                                    type="color"
                                    value={l.color ?? assemblyIngredient(l.kind)?.colors[0] ?? "#f39a2b"}
                                    onChange={(e) => update(l.id, { color: e.target.value })}
                                    className="h-6 w-8 cursor-pointer rounded border border-zinc-200"
                                    title="Any colour"
                                  />
                                </div>
                              </div>
                            )}
                            <Field label="Red call-out above (optional)">
                              <Input
                                value={l.callout ?? ""}
                                onChange={(e) => update(l.id, { callout: e.target.value || null })}
                                maxLength={80}
                                placeholder="e.g. Check for cheese on order"
                                className="h-8"
                              />
                            </Field>
                            <div>
                              <p className="mb-1 text-xs font-medium text-zinc-600">
                                Own picture instead of the drawing {l.kind === "custom" && "(needed)"}
                              </p>
                              <ImageUploader
                                value={l.imageUrl ?? null}
                                onChange={(url) => update(l.id, { imageUrl: url })}
                                targetWidth={600}
                                targetHeight={192}
                                fit="contain"
                              />
                            </div>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {error && <p className="text-sm text-red-600">{error}</p>}
              <div className="flex items-center justify-between gap-2 border-t border-zinc-100 pt-4">
                <p className="text-xs text-zinc-400">Remove every layer and save to delete the chart.</p>
                <div className="flex gap-2">
                  <Button type="button" variant="ghost" onClick={onClose}>
                    Cancel
                  </Button>
                  <Button type="button" onClick={() => save.mutate()} disabled={save.isPending}>
                    {save.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                    Save chart
                  </Button>
                </div>
              </div>
            </div>

            <div className="border-t border-zinc-100 lg:border-l lg:border-t-0">
              <div className="sticky top-16 flex justify-center p-5" style={{ background: BOARD_BG }}>
                {layers.length ? (
                  <ChartColumn chart={preview} size="md" />
                ) : (
                  <p className="py-16 text-center text-sm font-semibold text-white/80">Preview appears here</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-600">
        {label} {hint && <span className="font-normal text-zinc-400">— {hint}</span>}
      </span>
      {children}
    </label>
  );
}

function IconBtn({
  children,
  title,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "rounded p-1.5 text-zinc-400 disabled:opacity-30",
        danger ? "hover:bg-red-50 hover:text-red-600" : "hover:bg-zinc-100 hover:text-zinc-700",
      )}
    >
      {children}
    </button>
  );
}
