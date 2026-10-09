"use client";

// The same filter button, for picking SEVERAL things at once.
//
// A sibling of SearchableSelect rather than a `multi` flag on it: that one is
// used on a dozen screens where exactly one choice is the point, and giving it
// a mode that changes the type of `value` would put every caller at risk for
// the benefit of one. Same look, same keyboard behaviour, same Row — a user
// cannot tell them apart until they tick a second line.
//
// Empty means ALL. The caller omits the filter entirely in that case, so a page
// opens showing everything instead of nothing, which is how the channel filter
// next to it already behaves.

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SearchableOption } from "./searchable-select";

export function SearchableMultiSelect({
  options,
  values,
  onChange,
  placeholder = "All",
  searchPlaceholder = "Type to search…",
  emptyLabel = "No matches",
  className,
  buttonClassName,
  allLabel = "All",
  /** Shown on the button when several are picked, e.g. "locations". */
  pluralNoun = "selected",
}: {
  options: SearchableOption[];
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  className?: string;
  buttonClassName?: string;
  allLabel?: string;
  pluralNoun?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
    else setQuery("");
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        (o.hint ?? "").toLowerCase().includes(q),
    );
  }, [options, query]);

  // Toggling stays open — picking three shops should not mean reopening twice.
  const toggle = (v: string) => {
    onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v]);
  };

  // One pick reads as its own name; more than one reads as a count, because
  // "Mulgrave, Pelton, Chester-le-Street…" does not fit the button.
  const label =
    values.length === 0
      ? placeholder
      : values.length === 1
        ? (options.find((o) => o.value === values[0])?.label ?? placeholder)
        : `${values.length} ${pluralNoun}`;

  return (
    <div ref={wrap} className={cn("relative inline-block", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-lg border bg-white px-3 py-2 text-sm hover:border-zinc-300",
          values.length > 0
            ? "border-zinc-900 text-zinc-900"
            : "border-zinc-200 text-zinc-800",
          buttonClassName,
        )}
      >
        <span className="truncate">{label}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 flex-shrink-0 text-zinc-400" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[15rem] overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-lg">
          <div className="flex items-center gap-2 border-b border-zinc-100 px-3 py-2">
            <Search className="h-3.5 w-3.5 flex-shrink-0 text-zinc-400" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full bg-transparent text-sm outline-none placeholder:text-zinc-400"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="text-zinc-400 hover:text-zinc-700"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : values.length > 0 ? (
              <button
                type="button"
                onClick={() => onChange([])}
                className="whitespace-nowrap text-[11px] font-semibold text-violet-600 hover:text-violet-700"
              >
                Clear
              </button>
            ) : null}
          </div>

          <div className="max-h-64 overflow-y-auto py-1">
            {!query && (
              <MultiRow
                label={allLabel}
                selected={values.length === 0}
                onClick={() => {
                  onChange([]);
                  setOpen(false);
                }}
              />
            )}
            {filtered.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-zinc-400">
                {emptyLabel}
              </p>
            ) : (
              filtered.map((o) => (
                <MultiRow
                  key={o.value}
                  label={o.label}
                  hint={o.hint}
                  selected={values.includes(o.value)}
                  onClick={() => toggle(o.value)}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MultiRow({
  label,
  hint,
  selected,
  onClick,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-50",
        selected ? "text-zinc-900" : "text-zinc-700",
      )}
    >
      {/* A tickbox, not a tick: it has to be obvious these stack. */}
      <span
        className={cn(
          "grid h-4 w-4 flex-shrink-0 place-items-center rounded border",
          selected ? "border-zinc-900 bg-zinc-900" : "border-zinc-300 bg-white",
        )}
      >
        {selected && <Check className="h-3 w-3 text-white" />}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {label}
        {hint && <span className="ml-1.5 text-xs text-zinc-400">{hint}</span>}
      </span>
    </button>
  );
}
