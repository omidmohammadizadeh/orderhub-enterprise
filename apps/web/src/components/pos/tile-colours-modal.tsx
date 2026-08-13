"use client";

// Paint the POS menu.
//
// Pick a category, give it a colour, and every item in it turns that colour.
// Expand the category and you can override a single item — the bestseller you
// want to stand out from its own section.
//
// Nothing saves until Save is pressed. Colouring a menu is a fiddly, several-
// minute job and an autosave that fires per tap would leave a half-painted
// menu behind on the tills the moment someone changed their mind.

import { useMemo, useState } from "react";
import { ChevronDown, Loader2, Paintbrush, RotateCcw, X } from "lucide-react";
import {
  TILE_PALETTE,
  type TileColours,
  paletteEntry,
} from "@/lib/pos/tile-colours";
import { cn } from "@/lib/utils";

interface Category {
  id: string;
  name: string;
  items: Array<{ id: string; name: string }>;
}

export function TileColoursModal({
  open,
  categories,
  initial,
  saving,
  onSave,
  onClose,
}: {
  open: boolean;
  categories: Category[];
  initial: TileColours;
  saving: boolean;
  onSave: (next: TileColours) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<TileColours>(initial);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Remount on open so a cancelled edit doesn't linger into the next one.
  const [seen, setSeen] = useState(false);
  if (open && !seen) {
    setSeen(true);
    setDraft(initial);
  }
  if (!open && seen) setSeen(false);

  const painted = useMemo(
    () =>
      Object.keys(draft.categories).length + Object.keys(draft.items).length,
    [draft],
  );

  if (!open) return null;

  const setCategory = (id: string, bg: string) =>
    setDraft((d) => {
      const categories = { ...d.categories };
      if (bg) categories[id] = bg;
      else delete categories[id];
      return { ...d, categories };
    });

  const setItem = (id: string, bg: string) =>
    setDraft((d) => {
      const items = { ...d.items };
      if (bg) items[id] = bg;
      else delete items[id];
      return { ...d, items };
    });

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-t-2xl bg-white sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3.5">
          <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900">
            <Paintbrush className="h-4 w-4" /> Tile colours
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-zinc-400 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="border-b border-zinc-100 px-5 py-2.5 text-xs text-zinc-500">
          Colour a category and every item in it follows. Open a category to
          give one item a colour of its own.
        </p>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {categories.length === 0 ? (
            <p className="py-10 text-center text-sm text-zinc-400">
              No categories on this menu yet.
            </p>
          ) : (
            <div className="space-y-2">
              {categories.map((cat) => {
                const isOpen = expanded === cat.id;
                const catColour = draft.categories[cat.id];
                return (
                  <div
                    key={cat.id}
                    className="overflow-hidden rounded-xl border border-zinc-200"
                  >
                    <div className="flex items-center gap-2 px-3 py-2.5">
                      <button
                        type="button"
                        onClick={() => setExpanded(isOpen ? null : cat.id)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <ChevronDown
                          className={cn(
                            "h-4 w-4 flex-shrink-0 text-zinc-400 transition-transform",
                            isOpen && "rotate-180",
                          )}
                        />
                        <span className="truncate text-sm font-medium text-zinc-900">
                          {cat.name}
                        </span>
                        <span className="flex-shrink-0 text-[11px] text-zinc-400">
                          {cat.items.length}
                        </span>
                      </button>
                      <Swatches
                        value={catColour}
                        onChange={(bg) => setCategory(cat.id, bg)}
                      />
                    </div>

                    {isOpen && (
                      <div className="space-y-1 border-t border-zinc-100 bg-zinc-50/60 px-3 py-2">
                        {cat.items.length === 0 ? (
                          <p className="py-2 text-xs text-zinc-400">
                            No items in this category.
                          </p>
                        ) : (
                          cat.items.map((item) => {
                            const own = draft.items[item.id];
                            return (
                              <div
                                key={item.id}
                                className="flex items-center gap-2"
                              >
                                <span className="min-w-0 flex-1 truncate text-xs text-zinc-700">
                                  {item.name}
                                  {!own && catColour && (
                                    <span className="ml-1.5 text-[10px] text-zinc-400">
                                      follows category
                                    </span>
                                  )}
                                </span>
                                <Swatches
                                  small
                                  value={own}
                                  onChange={(bg) => setItem(item.id, bg)}
                                />
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-zinc-100 px-5 py-3">
          <button
            type="button"
            onClick={() => setDraft({ categories: {}, items: {} })}
            disabled={painted === 0}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-900 disabled:opacity-40"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Clear all
          </button>
          <span className="text-xs text-zinc-400">
            {painted} coloured
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(draft)}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save colours
          </button>
        </div>
      </div>
    </div>
  );
}

function Swatches({
  value,
  onChange,
  small,
}: {
  value?: string;
  onChange: (bg: string) => void;
  small?: boolean;
}) {
  return (
    <div className="flex flex-shrink-0 flex-wrap items-center gap-1">
      {TILE_PALETTE.map((p) => {
        const active = (value ?? "") === p.bg;
        const isNone = !p.bg;
        return (
          <button
            key={p.name}
            type="button"
            title={p.name}
            aria-label={p.name}
            aria-pressed={active}
            onClick={() => onChange(p.bg)}
            style={isNone ? undefined : { backgroundColor: p.bg, borderColor: p.border }}
            className={cn(
              "rounded-md border transition-transform",
              small ? "h-5 w-5" : "h-6 w-6",
              active && "scale-110 ring-2 ring-zinc-900 ring-offset-1",
              isNone &&
                "flex items-center justify-center border-dashed border-zinc-300 bg-white text-[9px] text-zinc-400",
            )}
          >
            {isNone && "✕"}
          </button>
        );
      })}
    </div>
  );
}

export { paletteEntry };
