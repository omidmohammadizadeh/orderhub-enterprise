"use client";

// "Tag brand" — pick one brand and apply it to EVERY item in a menu in one shot.
// Replaces each item's brand tags with just the chosen brand (unticks any
// previous brand), so the operator doesn't have to open every product.

import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { X, Tag, Loader2, Check } from "lucide-react";
import { menusClient, type Brand } from "@/lib/api/menus.client";

interface Props {
  open: boolean;
  menuId: string;
  menuName: string;
  brands: Brand[];
  onClose: () => void;
  onTagged: (updatedCount: number) => void;
}

export function TagBrandModal({
  open,
  menuId,
  menuName,
  brands,
  onClose,
  onTagged,
}: Props) {
  const [brandId, setBrandId] = useState<string>("");

  useEffect(() => {
    if (open) setBrandId("");
  }, [open, menuId]);

  const tag = useMutation({
    mutationFn: () => menusClient.tagMenuBrand(menuId, brandId),
    onSuccess: (res) => onTagged(res.updated),
  });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 p-5">
          <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900">
            <Tag className="h-4 w-4" /> Tag menu to a brand
          </h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5">
          <p className="text-sm text-zinc-500">
            Assign <span className="font-medium text-zinc-800">every item</span> in{" "}
            <span className="font-medium text-zinc-800">“{menuName}”</span> to one
            brand. This replaces any brand already set on those items.
          </p>

          <div className="mt-3 max-h-72 space-y-1.5 overflow-y-auto">
            {brands.length === 0 ? (
              <p className="rounded-md border border-zinc-200 px-3 py-4 text-center text-sm text-zinc-400">
                No brands available.
              </p>
            ) : (
              brands.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => setBrandId(b.id)}
                  className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition ${
                    brandId === b.id
                      ? "border-violet-500 bg-violet-50"
                      : "border-zinc-200 hover:bg-zinc-50"
                  }`}
                >
                  <span className="truncate font-medium text-zinc-900">{b.name}</span>
                  {brandId === b.id && (
                    <Check className="h-4 w-4 shrink-0 text-violet-600" />
                  )}
                </button>
              ))
            )}
          </div>

          {tag.isError && (
            <p className="mt-2 text-xs text-red-600">
              {(tag.error as any)?.response?.data?.message ??
                "Couldn’t tag the menu."}
            </p>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded-md border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50"
            >
              Cancel
            </button>
            <button
              onClick={() => tag.mutate()}
              disabled={!brandId || tag.isPending}
              className="flex items-center gap-1.5 rounded-md bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {tag.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Apply to all items
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
