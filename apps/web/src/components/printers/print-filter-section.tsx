"use client";

// "What this printer prints" — the per-printer category / product filter in
// the printer settings drawer. Controlled: the drawer owns the value and
// saves it to printer.defaults.printFilter. null = everything (the default).
//
// The print-time rules live in lib/printing/print-filter.ts.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { printersClient } from "@/lib/api/printers.client";
import type { PrintFilter } from "@/lib/printing/print-filter";

const EMPTY: PrintFilter = { categories: [], items: [], catchAll: false };
const norm = (s: string) => s.trim().toLowerCase();

export function PrintFilterSection({
  locationId,
  value,
  onChange,
}: {
  locationId: string;
  value: PrintFilter | null;
  onChange: (v: PrintFilter | null) => void;
}) {
  // Remember the picks while "Everything" is selected, so flipping back and
  // forth doesn't wipe a half-built list.
  const [draft, setDraft] = useState<PrintFilter>(value ?? EMPTY);
  const [limited, setLimited] = useState<boolean>(!!value);
  const [query, setQuery] = useState("");

  const catalogQuery = useQuery({
    queryKey: ["printers", "print-filter-catalog", locationId],
    queryFn: () => printersClient.printFilterCatalog(locationId),
    enabled: limited && !!locationId,
    staleTime: 60_000,
  });

  const update = (next: PrintFilter) => {
    setDraft(next);
    onChange(next);
  };
  const setMode = (on: boolean) => {
    setLimited(on);
    onChange(on ? draft : null);
  };

  const toggleIn = (list: string[], name: string) =>
    list.some((x) => norm(x) === norm(name))
      ? list.filter((x) => norm(x) !== norm(name))
      : [...list, name];
  const has = (list: string[], name: string) =>
    list.some((x) => norm(x) === norm(name));

  const q = norm(query);
  const categories = useMemo(
    () =>
      (catalogQuery.data?.categories ?? []).filter(
        (c) => !q || norm(c.name).includes(q),
      ),
    [catalogQuery.data, q],
  );
  // Products dedupe by name, like categories — one tick covers every brand.
  const items = useMemo(() => {
    const seen = new Map<string, { name: string; categories: string[] }>();
    for (const it of catalogQuery.data?.items ?? []) {
      const k = norm(it.name);
      const prev = seen.get(k);
      seen.set(k, {
        name: it.name,
        categories: Array.from(
          new Set([...(prev?.categories ?? []), ...it.categories]),
        ),
      });
    }
    return Array.from(seen.values()).filter(
      (i) => !q || norm(i.name).includes(q),
    );
  }, [catalogQuery.data, q]);

  const picked = draft.categories.length + draft.items.length;

  return (
    <div className="space-y-2">
      <div className="flex gap-1.5">
        {(
          [
            [false, "Everything", "Full receipt (default)"],
            [true, "Only what I choose", "e.g. drinks, or grill"],
          ] as const
        ).map(([on, label, hint]) => (
          <button
            key={label}
            type="button"
            onClick={() => setMode(on)}
            className={
              limited === on
                ? "flex-1 rounded-md bg-zinc-900 px-2 py-2 text-xs font-semibold text-white"
                : "flex-1 rounded-md border border-zinc-200 px-2 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
            }
          >
            {label}
            <span className="mt-0.5 block text-[10px] font-normal opacity-70">
              {hint}
            </span>
          </button>
        ))}
      </div>

      {!limited ? (
        <p className="text-[11px] leading-relaxed text-zinc-500">
          This printer prints every order in full, the way it does today.
        </p>
      ) : (
        <>
          <p className="text-[11px] leading-relaxed text-zinc-500">
            This printer gets a kitchen ticket with only the items below. It
            has no prices or totals and says how much of the order it is,
            e.g. &ldquo;PART ORDER - 2 OF 5 ITEMS&rdquo;. If an order has none
            of them, nothing prints here. Printers left on{" "}
            <span className="font-medium">Everything</span> still print the
            full receipt.
          </p>

          <label className="flex items-start justify-between gap-3 rounded-md border border-violet-200 bg-violet-50/50 px-3 py-2.5">
            <span>
              <span className="block text-sm font-semibold text-zinc-800">
                Also print everything else
              </span>
              <span className="block text-xs text-zinc-500">
                Items that no other limited printer is set to print, such as
                sides or new products, come out here too. Tick this on your
                main kitchen printer.
              </span>
            </span>
            <input
              type="checkbox"
              checked={draft.catchAll}
              onChange={(e) => update({ ...draft, catchAll: e.target.checked })}
              className="mt-0.5 h-5 w-5 shrink-0"
            />
          </label>

          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search categories and items"
              aria-label="Search categories and items"
              className="w-full rounded-md border border-zinc-300 bg-white py-2 pl-8 pr-3 text-sm text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
            />
          </div>

          {catalogQuery.isLoading ? (
            <div className="flex h-16 items-center justify-center text-xs text-zinc-400">
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Loading
              menu…
            </div>
          ) : catalogQuery.isError ? (
            <p className="text-xs text-red-600">
              Couldn&rsquo;t load this shop&rsquo;s menu. Close and reopen to
              try again.
            </p>
          ) : (
            <>
              <h4 className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                Categories
              </h4>
              {categories.length === 0 ? (
                <p className="text-xs text-zinc-400">No categories found.</p>
              ) : (
                <div className="grid max-h-48 grid-cols-2 gap-1.5 overflow-y-auto">
                  {categories.map((c) => (
                    <label
                      key={c.name}
                      className="flex items-center gap-2 rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={has(draft.categories, c.name)}
                        onChange={() =>
                          update({
                            ...draft,
                            categories: toggleIn(draft.categories, c.name),
                          })
                        }
                      />
                      <span className="truncate">{c.name}</span>
                    </label>
                  ))}
                </div>
              )}

              <h4 className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                Single items{" "}
                <span className="font-normal normal-case tracking-normal">
                  (on top of the categories above)
                </span>
              </h4>
              {items.length === 0 ? (
                <p className="text-xs text-zinc-400">No items found.</p>
              ) : (
                <div className="max-h-56 space-y-1 overflow-y-auto">
                  {items.map((i) => {
                    const viaCategory = i.categories.some((c) =>
                      has(draft.categories, c),
                    );
                    return (
                      <label
                        key={i.name}
                        className="flex items-center gap-2 rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={viaCategory || has(draft.items, i.name)}
                          disabled={viaCategory}
                          onChange={() =>
                            update({
                              ...draft,
                              items: toggleIn(draft.items, i.name),
                            })
                          }
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {i.name}
                        </span>
                        <span className="truncate text-[11px] text-zinc-400">
                          {i.categories.join(", ")}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {picked === 0 && !draft.catchAll && (
            <p className="text-xs text-amber-700">
              Nothing chosen yet. Until you pick something, this printer keeps
              printing everything.
            </p>
          )}
        </>
      )}
    </div>
  );
}
