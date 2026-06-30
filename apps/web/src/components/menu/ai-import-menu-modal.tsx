"use client";

// "Import from photo/PDF" — upload a menu image or PDF, Claude reads it into
// a structured draft, the operator reviews, then we create the menu via the
// shared import writer. Two phases: upload → review.

import { useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  X,
  UploadCloud,
  FileText,
  ImageIcon,
  Sparkles,
  AlertTriangle,
  Trash2,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  menusClient,
  type AiMenuDraft,
  type AiMenuItem,
} from "@/lib/api/menus.client";

interface Props {
  open: boolean;
  brandId: string;
  locationId?: string | null;
  onCreated: (menuId: string) => void;
  onCancel: () => void;
}

interface PickedFile {
  name: string;
  mediaType: string;
  data: string; // data: URL
  size: number;
}

const ACCEPT = "application/pdf,image/png,image/jpeg,image/webp";
const MAX_FILES = 8;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024; // keep base64 under the 10 MB API limit

const CURRENCY_SYMBOL: Record<string, string> = { GBP: "£", EUR: "€", USD: "$" };

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function AiImportMenuModal({
  open,
  brandId,
  locationId,
  onCreated,
  onCancel,
}: Props) {
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [draft, setDraft] = useState<AiMenuDraft | null>(null);
  const [menuName, setMenuName] = useState("");
  const [menuType, setMenuType] = useState<"DELIVERY" | "DELIVERY_AND_PICKUP">(
    "DELIVERY_AND_PICKUP",
  );
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setFiles([]);
    setDraft(null);
    setMenuName("");
    setError(null);
  };

  const close = () => {
    reset();
    onCancel();
  };

  const parseMutation = useMutation({
    mutationFn: () =>
      menusClient.aiParseMenu(
        brandId,
        files.map((f) => ({ mediaType: f.mediaType, data: f.data })),
      ),
    onSuccess: (d) => {
      setDraft(d);
      setMenuName(d.menuName?.trim() || "Imported menu");
    },
    onError: (err: any) =>
      setError(
        err?.response?.data?.message ??
          err?.message ??
          "Couldn't read this menu. Try a clearer photo or a PDF.",
      ),
  });

  const commitMutation = useMutation({
    mutationFn: () =>
      menusClient.aiCommitMenu(brandId, {
        menuName: menuName.trim() || undefined,
        menuType,
        locationId: locationId ?? undefined,
        draft: draft!,
      }),
    onSuccess: (res) => {
      reset();
      onCreated(res.menuId);
    },
    onError: (err: any) =>
      setError(
        err?.response?.data?.message ?? err?.message ?? "Couldn't create the menu.",
      ),
  });

  const addFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setError(null);
    const picked: PickedFile[] = [];
    for (const file of Array.from(list)) {
      try {
        const data = await readAsDataUrl(file);
        picked.push({
          name: file.name,
          mediaType: file.type || "application/octet-stream",
          data,
          size: file.size,
        });
      } catch {
        setError(`Couldn't read "${file.name}".`);
      }
    }
    setFiles((prev) => {
      const next = [...prev, ...picked].slice(0, MAX_FILES);
      const total = next.reduce((n, f) => n + f.size, 0);
      if (total > MAX_TOTAL_BYTES) {
        setError(
          "Those files are a bit large — keep the total under ~5 MB (compress photos or upload fewer pages).",
        );
      }
      return next;
    });
    if (inputRef.current) inputRef.current.value = "";
  };

  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const canParse =
    files.length > 0 && totalBytes <= MAX_TOTAL_BYTES && !parseMutation.isPending;

  const stats = useMemo(() => {
    if (!draft) return { categories: 0, items: 0, groups: 0 };
    const items = draft.categories.reduce(
      (n, c) => n + (c.items?.length ?? 0),
      0,
    );
    return {
      categories: draft.categories.length,
      items,
      groups: draft.modifierGroups?.length ?? 0,
    };
  }, [draft]);

  const symbol = draft?.currency ? CURRENCY_SYMBOL[draft.currency] ?? "" : "";

  const priceLabel = (item: AiMenuItem): string => {
    const sizes = (item.sizes ?? []).filter((s) => s && s.name);
    if (sizes.length > 1) {
      const prices = sizes.map((s) => Number(s.price) || 0);
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      return min === max
        ? `${symbol}${min.toFixed(2)}`
        : `${symbol}${min.toFixed(2)}–${symbol}${max.toFixed(2)}`;
    }
    return `${symbol}${(Number(item.price) || 0).toFixed(2)}`;
  };

  const removeCategory = (idx: number) => {
    if (!draft) return;
    setDraft({
      ...draft,
      categories: draft.categories.filter((_, i) => i !== idx),
    });
  };

  if (!open) return null;

  const reviewing = !!draft;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="my-8 bg-white rounded-xl shadow-2xl w-full max-w-3xl">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-zinc-100">
          <div className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-violet-100 text-violet-700">
              <Sparkles className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-base font-semibold text-zinc-900">
                Import menu from photo or PDF
              </h2>
              <p className="text-[11px] text-zinc-500">
                {reviewing
                  ? "Review what we read, then create the menu."
                  : "Upload your menu — AI reads it into categories, items and options."}
              </p>
            </div>
          </div>
          <button onClick={close} className="text-zinc-400 hover:text-zinc-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        {!reviewing ? (
          <div className="p-6 space-y-4">
            {/* Drop zone */}
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-zinc-300 bg-zinc-50 px-4 py-10 text-center transition-colors hover:border-violet-400 hover:bg-violet-50/40"
            >
              <UploadCloud className="h-7 w-7 text-zinc-400" />
              <span className="text-sm font-semibold text-zinc-700">
                Click to upload menu files
              </span>
              <span className="text-[11px] text-zinc-500">
                PDF, JPEG, PNG or WebP · up to {MAX_FILES} files · ~5 MB total
              </span>
            </button>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              multiple
              className="hidden"
              onChange={(e) => addFiles(e.target.files)}
            />

            {files.length > 0 && (
              <ul className="space-y-1.5">
                {files.map((f, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-700"
                  >
                    {f.mediaType === "application/pdf" ? (
                      <FileText className="h-3.5 w-3.5 text-zinc-400" />
                    ) : (
                      <ImageIcon className="h-3.5 w-3.5 text-zinc-400" />
                    )}
                    <span className="flex-1 truncate">{f.name}</span>
                    <span className="text-[10px] text-zinc-400">
                      {(f.size / 1024).toFixed(0)} KB
                    </span>
                    <button
                      onClick={() =>
                        setFiles((prev) => prev.filter((_, j) => j !== i))
                      }
                      className="text-zinc-400 hover:text-red-600"
                      aria-label="Remove file"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <p className="rounded-md bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
              AI does the heavy lifting, but always double-check prices and
              options on the next screen before creating the menu.
            </p>

            {error && <p className="text-xs text-red-600">{error}</p>}
          </div>
        ) : (
          <div className="p-6 space-y-5">
            {/* Menu name + type */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="block">
                <span className="text-xs font-semibold text-zinc-700">
                  Menu name
                </span>
                <Input
                  value={menuName}
                  onChange={(e) => setMenuName(e.target.value)}
                  className="mt-1 h-9 text-sm"
                />
              </label>
              <label className="block">
                <span className="text-xs font-semibold text-zinc-700">Type</span>
                <select
                  value={menuType}
                  onChange={(e) => setMenuType(e.target.value as any)}
                  className="mt-1 h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm"
                >
                  <option value="DELIVERY_AND_PICKUP">Delivery and pickup</option>
                  <option value="DELIVERY">Delivery only</option>
                </select>
              </label>
            </div>

            {/* Summary */}
            <div className="flex flex-wrap gap-2 text-[11px]">
              <Stat label="Categories" value={stats.categories} />
              <Stat label="Items" value={stats.items} />
              <Stat label="Option groups" value={stats.groups} />
            </div>

            {/* Warnings */}
            {(draft?.warnings?.length ?? 0) > 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-amber-800">
                  <AlertTriangle className="h-3.5 w-3.5" /> Please double-check
                </div>
                <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-amber-800">
                  {draft!.warnings!.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Category/item preview */}
            <div className="max-h-[42vh] space-y-3 overflow-y-auto pr-1">
              {draft!.categories.map((cat, ci) => (
                <div
                  key={ci}
                  className="rounded-lg border border-zinc-200 bg-white"
                >
                  <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2">
                    <span className="text-sm font-semibold text-zinc-800">
                      {cat.name}{" "}
                      <span className="text-[11px] font-normal text-zinc-400">
                        ({cat.items?.length ?? 0})
                      </span>
                    </span>
                    <button
                      onClick={() => removeCategory(ci)}
                      className="text-zinc-300 hover:text-red-600"
                      aria-label="Remove category"
                      title="Remove this category"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <ul className="divide-y divide-zinc-50">
                    {(cat.items ?? []).map((it, ii) => (
                      <li
                        key={ii}
                        className="flex items-start justify-between gap-3 px-3 py-1.5"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-xs font-medium text-zinc-800">
                            {it.name}
                            {(it.sizes?.length ?? 0) > 1 && (
                              <span className="ml-1.5 rounded bg-zinc-100 px-1 py-0.5 text-[9px] font-semibold uppercase text-zinc-500">
                                {it.sizes!.length} sizes
                              </span>
                            )}
                            {(it.modifierGroupKeys?.length ?? 0) > 0 && (
                              <span className="ml-1.5 rounded bg-violet-50 px-1 py-0.5 text-[9px] font-semibold uppercase text-violet-600">
                                +options
                              </span>
                            )}
                          </p>
                          {it.description && (
                            <p className="truncate text-[10px] text-zinc-400">
                              {it.description}
                            </p>
                          )}
                        </div>
                        <span className="whitespace-nowrap text-xs font-semibold text-zinc-700">
                          {priceLabel(it)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            {error && <p className="text-xs text-red-600">{error}</p>}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-zinc-100 p-4">
          {reviewing ? (
            <button
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
              className="text-xs font-medium text-zinc-500 hover:text-zinc-800"
            >
              ← Upload different files
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={close}>
              Cancel
            </Button>
            {!reviewing ? (
              <Button
                size="sm"
                disabled={!canParse}
                onClick={() => {
                  setError(null);
                  parseMutation.mutate();
                }}
                className="bg-violet-600 hover:bg-violet-700 text-white"
              >
                {parseMutation.isPending ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading menu…
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5" /> Read menu with AI
                  </span>
                )}
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={commitMutation.isPending || stats.items === 0}
                onClick={() => {
                  setError(null);
                  commitMutation.mutate();
                }}
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                {commitMutation.isPending ? "Creating menu…" : "Create menu"}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-1 font-semibold text-zinc-600">
      <span className="text-zinc-900">{value}</span>
      {label}
    </span>
  );
}
