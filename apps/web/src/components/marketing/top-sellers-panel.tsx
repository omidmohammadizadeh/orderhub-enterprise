"use client";

// Top sellers — the items pinned above every category on the storefront.
//
// The candidate list comes from the PUBLIC storefront endpoint rather than the
// menu tables, deliberately: that endpoint is what actually decides which menu
// a customer sees (assignment-first, with the legacy fallback, minus anything
// 86'd or hidden). Reading the menu directly would let the operator feature an
// item the storefront isn't serving, which is exactly the kind of mismatch
// that ends with a customer tapping a row that doesn't exist.

import { useEffect, useMemo, useState } from "react";
import { useCurrency } from "@/hooks/use-currency";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Search, Star, X } from "lucide-react";
import { apiClient } from "@/lib/api/client";
import { brandsClient, type Brand } from "@/lib/api/locations.client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Candidate {
  id: string;
  name: string;
  price: number;
  imageUrl: string | null;
  category: string;
}

// money() comes from useCurrency inside the component — a module-level
// helper cannot read a hook, and a £-hardcoded one is what this was.

export function TopSellersPanel() {
  // Prices follow the selected location's currency, not a hardcoded pound.
  const { money, symbol } = useCurrency();
  const qc = useQueryClient();
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);

  const { data: brands = [] } = useQuery({
    queryKey: ["brands", locationId],
    queryFn: () => brandsClient.list(locationId ?? undefined),
    enabled: !!locationId,
  });

  // A kitchen can run several brands; each has its own storefront and so its
  // own rail. Default to the first and let the operator switch.
  const [brandId, setBrandId] = useState<string | null>(null);
  const brand: Brand | undefined =
    brands.find((b) => b.id === brandId) ?? brands[0];
  useEffect(() => {
    if (!brandId && brands[0]) setBrandId(brands[0].id);
  }, [brands, brandId]);

  const { data: storefront, isLoading } = useQuery({
    queryKey: ["top-sellers", "storefront", locationId, brand?.id],
    queryFn: () =>
      apiClient
        .get(
          `/v1/ordering/store/${encodeURIComponent(locationId!)}` +
            (brand?.id ? `?brand=${encodeURIComponent(brand.id)}` : ""),
        )
        .then((r) => r.data as any),
    enabled: !!locationId && !!brand?.id,
  });

  const candidates: Candidate[] = useMemo(() => {
    const out: Candidate[] = [];
    for (const cat of storefront?.menu?.categories ?? []) {
      for (const link of cat.items ?? []) {
        const it = link?.item;
        if (!it?.id) continue;
        out.push({
          id: it.id,
          name: it.name,
          price: Number(it.basePrice ?? 0),
          imageUrl: it.imageUrl ?? null,
          category: cat.name ?? "",
        });
      }
    }
    return out;
  }, [storefront]);

  const [picked, setPicked] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [dirty, setDirty] = useState(false);

  // Seed from the brand, and re-seed when the operator switches brand.
  useEffect(() => {
    setPicked(brand?.topSellerItemIds ?? []);
    setDirty(false);
  }, [brand?.id, brand?.topSellerItemIds]);

  const byId = useMemo(
    () => new Map(candidates.map((c) => [c.id, c])),
    [candidates],
  );
  // Only ids still on the live menu — a pick whose item has since been pulled
  // shouldn't sit in the list looking active when the storefront ignores it.
  const live = picked.filter((id) => byId.has(id));
  const dropped = picked.length - live.length;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = candidates.filter((c) => !picked.includes(c.id));
    if (!q) return base;
    return base.filter(
      (c) =>
        c.name.toLowerCase().includes(q) || c.category.toLowerCase().includes(q),
    );
  }, [candidates, picked, search]);

  const save = useMutation({
    mutationFn: () =>
      brandsClient.update(brand!.id, { topSellerItemIds: live } as any),
    onSuccess: () => {
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["brands"] });
    },
  });

  const move = (from: number, to: number) => {
    if (to < 0 || to >= live.length) return;
    const next = [...live];
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row!);
    setPicked(next);
    setDirty(true);
  };

  if (!locationId) {
    return (
      <p className="text-sm text-zinc-500">
        Choose a location to set its top sellers.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-zinc-900">Top sellers</h2>
          <p className="mt-0.5 max-w-prose text-sm text-zinc-500">
            Pinned to the top of your online menu, above every category.
            Customers see these first.
          </p>
        </div>
        {brands.length > 1 && (
          <select
            value={brand?.id ?? ""}
            onChange={(e) => setBrandId(e.target.value)}
            className="h-9 rounded-lg border border-zinc-300 bg-white px-2 text-sm"
          >
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {dropped > 0 && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
          {dropped} featured item{dropped === 1 ? " is" : "s are"} no longer on
          the live menu, so {dropped === 1 ? "it isn't" : "they aren't"} showing.
          Saving will remove {dropped === 1 ? "it" : "them"}.
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {/* Featured, in the order customers will see them. */}
        <section className="rounded-xl border border-zinc-200 bg-white">
          <header className="flex items-center justify-between border-b border-zinc-100 px-4 py-2.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Featured · in order
            </h3>
            <span className="text-xs tabular-nums text-zinc-400">
              {live.length}
            </span>
          </header>
          {live.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-zinc-400">
              Nothing featured yet. Pick items from the right.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {live.map((id, i) => {
                const c = byId.get(id)!;
                return (
                  <li key={id} className="flex items-center gap-3 px-3 py-2">
                    <Thumb url={c.imageUrl} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-zinc-900">
                        {c.name}
                      </p>
                      <p className="text-xs text-zinc-500">
                        {c.category} · {money(c.price)}
                      </p>
                    </div>
                    <div className="flex items-center gap-0.5">
                      <IconBtn
                        label="Move up"
                        disabled={i === 0}
                        onClick={() => move(i, i - 1)}
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </IconBtn>
                      <IconBtn
                        label="Move down"
                        disabled={i === live.length - 1}
                        onClick={() => move(i, i + 1)}
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </IconBtn>
                      <IconBtn
                        label="Remove"
                        onClick={() => {
                          setPicked(live.filter((x) => x !== id));
                          setDirty(true);
                        }}
                      >
                        <X className="h-3.5 w-3.5" />
                      </IconBtn>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Everything else on the live menu. */}
        <section className="rounded-xl border border-zinc-200 bg-white">
          <header className="border-b border-zinc-100 px-3 py-2.5">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search your live menu…"
                className="h-8 pl-8 text-sm"
              />
            </div>
          </header>
          <div className="max-h-[420px] overflow-y-auto">
            {isLoading ? (
              <p className="px-4 py-8 text-center text-sm text-zinc-400">
                Loading your live menu…
              </p>
            ) : filtered.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-zinc-400">
                {candidates.length === 0
                  ? "Nothing is published to online ordering for this brand yet."
                  : "Everything matching is already featured."}
              </p>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {filtered.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setPicked([...live, c.id]);
                        setDirty(true);
                      }}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-zinc-50"
                    >
                      <Thumb url={c.imageUrl} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-zinc-900">
                          {c.name}
                        </p>
                        <p className="text-xs text-zinc-500">
                          {c.category} · {money(c.price)}
                        </p>
                      </div>
                      <Star className="h-4 w-4 flex-shrink-0 text-zinc-300" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={!dirty || save.isPending || !brand}
          onClick={() => save.mutate()}
          className="bg-orange-500 text-white hover:bg-orange-600"
        >
          {save.isPending ? "Saving…" : "Save top sellers"}
        </Button>
        {!dirty && !save.isPending && live.length > 0 && (
          <span className="text-xs text-zinc-500">Saved.</span>
        )}
        {save.isError && (
          <span className="text-xs text-red-600">
            Couldn&rsquo;t save — try again.
          </span>
        )}
      </div>
    </div>
  );
}

function Thumb({ url }: { url: string | null }) {
  return (
    <div className="h-10 w-10 flex-shrink-0 overflow-hidden rounded-md bg-zinc-100">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : null}
    </div>
  );
}

function IconBtn({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-7 w-7 place-items-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
