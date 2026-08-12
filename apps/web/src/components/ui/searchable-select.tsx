"use client";

// A filter button that opens a searchable list.
//
// Built for the case a row of chips handles badly: once a group has a dozen
// shops, the chips wrap over two lines, push the content down, and finding one
// means reading every label. This collapses to a single button showing the
// current choice, and typing narrows the list.
//
// Deliberately plain — keyboard first, no dependency, no portal. It closes on
// outside click and on Escape, which is what anyone reaching for it expects.

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SearchableOption {
  value: string;
  label: string;
  /** Optional second line — an address, a role, an email. */
  hint?: string;
}

export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = "All",
  searchPlaceholder = "Type to search…",
  emptyLabel = "No matches",
  className,
  buttonClassName,
  /** Adds a clear "All" entry at the top that selects undefined. */
  allowAll = true,
  allLabel = "All",
}: {
  options: SearchableOption[];
  value?: string;
  onChange: (value: string | undefined) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  className?: string;
  buttonClassName?: string;
  allowAll?: boolean;
  allLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Close on outside click / Escape. Both, because a filter left hanging open
  // over the content is worse than one that closes a touch eagerly.
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

  // Straight to the search box — the whole reason for opening it is to type.
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

  const current = options.find((o) => o.value === value);

  const pick = (v: string | undefined) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <div ref={wrap} className={cn("relative inline-block", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 hover:border-zinc-300",
          buttonClassName,
        )}
      >
        <span className="truncate">{current?.label ?? placeholder}</span>
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
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="text-zinc-400 hover:text-zinc-700"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="max-h-64 overflow-y-auto py-1">
            {allowAll && !query && (
              <Row
                label={allLabel}
                selected={value === undefined}
                onClick={() => pick(undefined)}
              />
            )}
            {filtered.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-zinc-400">
                {emptyLabel}
              </p>
            ) : (
              filtered.map((o) => (
                <Row
                  key={o.value}
                  label={o.label}
                  hint={o.hint}
                  selected={o.value === value}
                  onClick={() => pick(o.value)}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({
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
      <Check
        className={cn(
          "h-3.5 w-3.5 flex-shrink-0",
          selected ? "text-zinc-900" : "text-transparent",
        )}
      />
      <span className="min-w-0 flex-1 truncate">
        {label}
        {hint && (
          <span className="ml-1.5 text-xs text-zinc-400">{hint}</span>
        )}
      </span>
    </button>
  );
}
