"use client";

// "How to build" editor — photo steps for one product, plus a pack note.
//
// The guide is stored per BRAND + product name, so every location selling
// this brand (including menus cloned to another shop) sees the same chart.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, BookmarkPlus, BookOpen, Check, ClipboardList, Eye, Loader2, Plus, Printer, Sparkles, Trash2, X } from "lucide-react";
import { StepLibraryPicker, STEP_LIBRARY_QUERY } from "./step-library-picker";
import { productsClient } from "@/lib/api/catalog.client";
import { ModifierTagInput } from "./modifier-tag-input";
import { BUILD_GUIDE_MAX_STEPS } from "@orderhub/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ImageUploader } from "@/components/products/image-uploader";
import {
  BUILD_GUIDE_KEYS_QUERY,
  buildGuidesClient,
  type BuildGuideStep,
} from "@/lib/api/build-guides.client";
import { BuildGuideSteps } from "./build-guide-viewer-modal";

interface DraftStep {
  id: string;
  text: string;
  imageUrl: string | null;
  amount: string;
  tools: string;
  onlyWith: string[];
  skipWith: string[];
}

function newId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function toDraft(s: BuildGuideStep): DraftStep {
  return {
    id: s.id || newId(),
    text: s.text ?? "",
    imageUrl: s.imageUrl ?? null,
    amount: s.amount ?? "",
    tools: (s.tools ?? []).join(", "),
    onlyWith: s.onlyWith ?? [],
    skipWith: s.skipWith ?? [],
  };
}

function fromDraft(d: DraftStep): BuildGuideStep {
  return {
    id: d.id,
    text: d.text.trim(),
    imageUrl: d.imageUrl,
    amount: d.amount.trim() || null,
    tools: d.tools.split(",").map((t) => t.trim()).filter(Boolean),
    ...(d.onlyWith.length ? { onlyWith: d.onlyWith } : {}),
    ...(d.skipWith.length ? { skipWith: d.skipWith } : {}),
  };
}

const emptyStep = (): DraftStep => ({ id: newId(), text: "", imageUrl: null, amount: "", tools: "", onlyWith: [], skipWith: [] });

interface Props {
  open: boolean;
  itemId: string;
  itemName: string;
  onClose: () => void;
}

export function BuildGuideEditorModal({ open, itemId, itemName, onClose }: Props) {
  const qc = useQueryClient();
  const [steps, setSteps] = useState<DraftStep[]>([]);
  const [packNote, setPackNote] = useState("");
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const guideQuery = useQuery({
    queryKey: ["build-guide", itemId],
    queryFn: () => buildGuidesClient.getForItem(itemId),
    enabled: open && !!itemId,
  });

  // Seed the form once the guide (or its absence) arrives.
  useEffect(() => {
    if (!open || guideQuery.isLoading) return;
    const g = guideQuery.data;
    setSteps(g?.steps?.length ? g.steps.map(toDraft) : [emptyStep()]);
    setPackNote(g?.packNote ?? "");
    setError(null);
    setPreview(false);
  }, [open, guideQuery.isLoading, guideQuery.data]);

  // The product's own modifier names, offered when a step is tied to one.
  const productQuery = useQuery({
    queryKey: ["catalog", "product", itemId, "build-guide-modifiers"],
    queryFn: () => productsClient.get(itemId),
    enabled: open && !!itemId,
    staleTime: 60_000,
  });
  const modifierNames = useMemo(() => {
    const p = productQuery.data;
    const groups = [
      ...(p?.modifierGroupLinks ?? []).map((l) => l.group),
      ...(p?.skuModifierGroups ?? []),
    ];
    const names = new Set<string>();
    for (const g of groups) for (const o of g?.options ?? []) if (o?.name) names.add(o.name);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [productQuery.data]);

  const [libraryOpen, setLibraryOpen] = useState(false);
  const [savedToLibrary, setSavedToLibrary] = useState<Set<string>>(new Set());
  const saveToLibrary = useMutation({
    mutationFn: (d: DraftStep) =>
      buildGuidesClient.saveToLibrary({
        text: d.text.trim(),
        imageUrl: d.imageUrl,
        amount: d.amount.trim() || null,
        tools: d.tools.split(",").map((t) => t.trim()).filter(Boolean),
        brandId: guideQuery.data?.brandId ?? null,
      }),
    onSuccess: (_r, d) => {
      setSavedToLibrary((prev) => new Set(prev).add(d.id));
      qc.invalidateQueries({ queryKey: STEP_LIBRARY_QUERY });
    },
    onError: (e: any) => setError(e?.response?.data?.message ?? "Could not save the step to the library"),
  });

  const aiDraft = useMutation({
    mutationFn: () => buildGuidesClient.aiDraft(itemId),
    onSuccess: (draft) => {
      if (!draft.steps.length) {
        setError("The AI could not draft steps for this product.");
        return;
      }
      // Photos stay with the operator: keep any photo already on the same step
      // number so a re-draft does not wipe pictures that were taken.
      setSteps((prev) =>
        draft.steps.map((st, i) => ({
          ...toDraft({ ...st, id: newId() }),
          imageUrl: prev[i]?.imageUrl ?? null,
        })),
      );
      if (draft.packNote) setPackNote(draft.packNote);
      setError(null);
      setPreview(false);
    },
    onError: (e: any) => setError(e?.response?.data?.message ?? "AI draft failed — try again."),
  });

  const save = useMutation({
    mutationFn: () =>
      buildGuidesClient.saveForItem(itemId, {
        steps: steps.map(fromDraft).filter((s) => s.text || s.imageUrl),
        packNote: packNote.trim() || null,
      }),
    onSuccess: (guide) => {
      qc.setQueryData(["build-guide", itemId], guide);
      qc.invalidateQueries({ queryKey: BUILD_GUIDE_KEYS_QUERY });
      onClose();
    },
    onError: (e: any) =>
      setError(e?.response?.data?.message ?? e?.message ?? "Could not save the guide"),
  });

  if (!open) return null;

  const update = (i: number, patch: Partial<DraftStep>) =>
    setSteps((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, dir: -1 | 1) =>
    setSteps((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(i, 1);
      next.splice(j, 0, moved!);
      return next;
    });
  const remove = (i: number) => setSteps((prev) => prev.filter((_, j) => j !== i));

  const filled = steps.map(fromDraft).filter((s) => s.text || s.imageUrl);

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-black/40 backdrop-blur-sm sm:p-4">
      <div className="min-h-full w-full max-w-4xl bg-white shadow-2xl sm:my-8 sm:min-h-0 sm:rounded-xl">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-zinc-100 bg-white px-4 py-3 sm:rounded-t-xl sm:px-6">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900">
              <ClipboardList className="h-4 w-4 text-orange-500" />
              How to build
            </h2>
            <p className="truncate text-xs text-zinc-500">
              {itemName} · shared by every location selling this brand
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={aiDraft.isPending || guideQuery.isLoading}
              onClick={() => {
                const hasWork = steps.some((st) => st.text.trim());
                if (hasWork && !confirm("Replace the current steps with an AI draft? Photos on matching step numbers are kept. Nothing is saved until you press Save.")) return;
                aiDraft.mutate();
              }}
              className="border-violet-200 text-violet-700 hover:bg-violet-50"
              title="Draft steps from the product's name, photo and modifiers"
            >
              {aiDraft.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              )}
              {aiDraft.isPending ? "Drafting…" : "Draft with AI"}
            </Button>
            {guideQuery.data && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => window.open(`/print/build-guides?item=${encodeURIComponent(itemId)}`, "_blank")}
                title="Print this guide on A4 (saved version)"
              >
                <Printer className="mr-1.5 h-3.5 w-3.5" />
                A4
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPreview((p) => !p)}
              disabled={filled.length === 0 && !packNote.trim()}
            >
              <Eye className="mr-1.5 h-3.5 w-3.5" />
              {preview ? "Edit" : "Preview"}
            </Button>
            <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700" title="Close">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="p-4 sm:p-6">
          {guideQuery.isLoading ? (
            <div className="flex items-center justify-center py-16 text-sm text-zinc-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading guide…
            </div>
          ) : guideQuery.isError ? (
            <p className="py-10 text-center text-sm text-red-600">Could not load this guide.</p>
          ) : preview ? (
            <div className="rounded-xl bg-zinc-950 p-4">
              <BuildGuideSteps steps={filled} packNote={packNote.trim() || null} />
            </div>
          ) : (
            <div className="space-y-4">
              {steps.map((s, i) => (
                <div key={s.id} className="rounded-xl border border-zinc-200 p-3 sm:p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-orange-500 text-sm font-bold text-white">
                      {i + 1}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => saveToLibrary.mutate(s)}
                        disabled={(!s.text.trim() && !s.imageUrl) || savedToLibrary.has(s.id) || saveToLibrary.isPending}
                        className="rounded p-1.5 text-zinc-400 hover:bg-orange-50 hover:text-orange-600 disabled:opacity-40"
                        title={savedToLibrary.has(s.id) ? "Saved to the step library" : "Save this step to the library for reuse"}
                      >
                        {savedToLibrary.has(s.id) ? <Check className="h-4 w-4 text-emerald-600" /> : <BookmarkPlus className="h-4 w-4" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => move(i, -1)}
                        disabled={i === 0}
                        className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-30"
                        title="Move up"
                      >
                        <ArrowUp className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => move(i, 1)}
                        disabled={i === steps.length - 1}
                        className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-30"
                        title="Move down"
                      >
                        <ArrowDown className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(i)}
                        className="rounded p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600"
                        title="Remove step"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <div className="grid gap-4 md:grid-cols-[280px_1fr]">
                    <ImageUploader
                      value={s.imageUrl}
                      onChange={(url) => update(i, { imageUrl: url })}
                      targetWidth={800}
                      targetHeight={600}
                    />
                    <div className="space-y-3">
                      <div>
                        <label className="mb-1 block text-xs font-medium text-zinc-600">Instruction</label>
                        <textarea
                          value={s.text}
                          onChange={(e) => update(i, { text: e.target.value })}
                          rows={3}
                          maxLength={1000}
                          placeholder="e.g. Lay the tortilla flat, spread rice down the centre"
                          className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none"
                        />
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <label className="mb-1 block text-xs font-medium text-zinc-600">Amount (optional)</label>
                          <Input
                            value={s.amount}
                            onChange={(e) => update(i, { amount: e.target.value })}
                            maxLength={80}
                            placeholder="e.g. 2 scoops / 120g"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-xs font-medium text-zinc-600">Tools (optional)</label>
                          <Input
                            value={s.tools}
                            onChange={(e) => update(i, { tools: e.target.value })}
                            placeholder="e.g. Spoodle, squeeze bottle"
                          />
                        </div>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <ModifierTagInput
                          label="Only with"
                          hint="an extra; highlighted when ordered"
                          tone="amber"
                          value={s.onlyWith}
                          onChange={(v) => update(i, { onlyWith: v })}
                          suggestions={modifierNames}
                        />
                        <ModifierTagInput
                          label="Skip if"
                          hint="e.g. No onion; struck through"
                          tone="red"
                          value={s.skipWith}
                          onChange={(v) => update(i, { skipWith: v })}
                          suggestions={modifierNames}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              ))}

              <div className="grid gap-2 sm:grid-cols-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setSteps((prev) => [...prev, emptyStep()])}
                  disabled={steps.length >= BUILD_GUIDE_MAX_STEPS}
                  className="w-full border-dashed"
                >
                  <Plus className="mr-1.5 h-4 w-4" /> Add step
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setLibraryOpen(true)}
                  disabled={steps.length >= BUILD_GUIDE_MAX_STEPS}
                  className="w-full border-dashed"
                >
                  <BookOpen className="mr-1.5 h-4 w-4" /> Add from library
                </Button>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-600">Pack note (optional)</label>
                <textarea
                  value={packNote}
                  onChange={(e) => setPackNote(e.target.value)}
                  rows={2}
                  maxLength={1000}
                  placeholder="e.g. Wrap in foil, cut on the diagonal, sauce pot on the side"
                  className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none"
                />
              </div>
            </div>
          )}

          {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

          <div className="mt-6 flex items-center justify-end gap-2 border-t border-zinc-100 pt-4">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" onClick={() => save.mutate()} disabled={save.isPending || guideQuery.isLoading}>
              {save.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Save guide
            </Button>
          </div>
        </div>
      </div>
      <StepLibraryPicker
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        onPick={(t) => {
          const copy: DraftStep = {
            ...emptyStep(),
            text: t.text,
            imageUrl: t.imageUrl,
            amount: t.amount ?? "",
            tools: (t.tools ?? []).join(", "),
          };
          // Replace a blank trailing card rather than leaving an empty step behind it.
          setSteps((prev) => {
            const last = prev[prev.length - 1];
            const blank = last && !last.text.trim() && !last.imageUrl;
            return [...(blank ? prev.slice(0, -1) : prev), copy];
          });
          setLibraryOpen(false);
        }}
      />
    </div>
  );
}
