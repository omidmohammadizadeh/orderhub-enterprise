"use client";

// Menu preview — what customers will see for THIS menu (draft or published),
// opened from "Preview Menu" in the menu editor. Read-only: tapping a product
// shows its sizes and options, but nothing can be ordered. Hidden categories
// and products are left out exactly as the storefront leaves them out; sold-out
// items show as sold out.

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Eye, ImageIcon, Loader2, Monitor, Smartphone, X } from "lucide-react";
import { formatMoney } from "@orderhub/shared";
import { cn } from "@/lib/utils";
import { menusClient } from "@/lib/api/menus.client";

type AnyItem = Record<string, any>;

interface PreviewOption {
  name: string;
  price: number;
  available: boolean;
}
interface PreviewGroup {
  name: string;
  min: number;
  max: number;
  options: PreviewOption[];
}
interface PreviewItem {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  price: number;
  fromPrice: boolean;
  soldOut: boolean;
  sizes: Array<{ name: string; price: number }>;
  groups: PreviewGroup[];
}

function toPreviewItem(link: AnyItem): PreviewItem | null {
  const it = link?.item;
  if (!it) return null;
  if (it.isAvailable === false || it.visibleToCustomers === false) return null;
  const base = Number(link.priceOverride ?? it.basePrice ?? 0);
  const sizes = (it.hasMultipleSkus && Array.isArray(it.productSkus) ? it.productSkus : [])
    .filter((s: AnyItem) => s?.name)
    .map((s: AnyItem) => ({ name: String(s.name), price: Number(s.price ?? base) }));
  const groups: PreviewGroup[] = (it.modifierGroupLinks ?? [])
    .map((l: AnyItem) => l?.group)
    .filter((g: AnyItem) => g && g.visibleToCustomers !== false && (g.options ?? []).length)
    .map((g: AnyItem) => ({
      name: String(g.name ?? ""),
      min: Number(g.minSelections ?? 0),
      max: Number(g.maxSelections ?? 0),
      options: (g.options ?? [])
        .filter((o: AnyItem) => o?.visibleToCustomers !== false)
        .map((o: AnyItem) => ({
          name: String(o.name ?? ""),
          price: Number(o.priceAdjustment ?? 0),
          available: o.isAvailable !== false,
        })),
    }));
  const prices = sizes.length ? sizes.map((s: { price: number }) => s.price) : [base];
  return {
    id: String(it.id),
    name: String(it.name ?? ""),
    description: it.description ?? null,
    imageUrl: it.imageUrl ?? null,
    price: Math.min(...prices),
    fromPrice: sizes.length > 1 && new Set(prices).size > 1,
    soldOut: it.outOfStock === true,
    sizes,
    groups,
  };
}

function ruleText(g: PreviewGroup): string {
  if (g.min > 0 && g.max === g.min) return g.min === 1 ? "Choose 1 · Required" : `Choose ${g.min} · Required`;
  if (g.min > 0) return `Choose ${g.min}–${g.max || "any"} · Required`;
  if (g.max === 1) return "Choose up to 1 · Optional";
  return g.max > 0 && g.max < g.options.length ? `Choose up to ${g.max} · Optional` : "Optional";
}

export default function MenuPreviewPage() {
  const { menuId } = useParams<{ menuId: string }>();
  const [device, setDevice] = useState<"phone" | "desktop">("desktop");
  const [open, setOpen] = useState<PreviewItem | null>(null);
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  const q = useQuery({
    queryKey: ["menu-preview", menuId],
    queryFn: () => menusClient.getMenu(menuId),
    enabled: !!menuId,
    retry: false,
  });

  const menu = q.data as AnyItem | undefined;
  const categories = useMemo(
    () =>
      ((menu?.categories ?? []) as AnyItem[])
        .filter((c) => c.isVisible !== false && c.available !== false && c.visibleToCustomers !== false)
        .map((c) => ({
          id: String(c.id),
          name: String(c.name ?? ""),
          items: ((c.items ?? []) as AnyItem[]).map(toPreviewItem).filter(Boolean) as PreviewItem[],
        }))
        .filter((c) => c.items.length > 0),
    [menu],
  );

  useEffect(() => {
    if (!activeCat && categories[0]) setActiveCat(categories[0].id);
  }, [categories, activeCat]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const money = (n: number) => formatMoney(n);
  const banner = menu?.heroImage || menu?.bannerImage || null;
  const logo = menu?.logoImage || null;
  const itemCount = categories.reduce((n, c) => n + c.items.length, 0);

  return (
    <div className="min-h-screen bg-zinc-200">
      {/* Preview bar — never part of what customers see */}
      <div className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-2 bg-zinc-900 px-4 py-2 text-white">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Eye className="h-4 w-4 text-orange-400" />
          Preview{menu?.name ? ` · ${menu.name}` : ""}
          {menu?.status && (
            <span className="rounded bg-white/15 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide">
              {String(menu.status).toLowerCase()}
            </span>
          )}
          <span className="hidden text-xs font-normal text-zinc-400 sm:inline">— ordering is disabled</span>
        </p>
        <div className="flex rounded-lg bg-white/10 p-0.5">
          {(
            [
              ["phone", Smartphone, "Phone"],
              ["desktop", Monitor, "Desktop"],
            ] as const
          ).map(([k, Icon, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setDevice(k)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold",
                device === k ? "bg-white text-zinc-900" : "text-zinc-300 hover:text-white",
              )}
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </div>
      </div>

      <div
        className={cn(
          "mx-auto bg-white transition-all",
          device === "phone" ? "my-4 w-[390px] max-w-full overflow-hidden rounded-[28px] shadow-2xl ring-8 ring-zinc-900" : "w-full max-w-6xl",
        )}
      >
        {/* A failed background refresh must not replace a menu already on screen. */}
        {!menu && q.isLoading ? (
          <div className="flex items-center justify-center py-32 text-sm text-zinc-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading menu…
          </div>
        ) : !menu ? (
          <p className="px-6 py-32 text-center text-sm text-zinc-600">
            Could not load this menu. Make sure you are signed in to the dashboard in this browser.
          </p>
        ) : (
          <>
            {/* Header */}
            <div className="relative">
              {banner ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={banner} alt="" className={cn("w-full object-cover", device === "phone" ? "h-36" : "h-56")} />
              ) : (
                <div className={cn("w-full bg-gradient-to-br from-orange-500 to-rose-600", device === "phone" ? "h-24" : "h-36")} />
              )}
              <div className={cn("flex items-end gap-3 px-4", device === "phone" ? "-mt-8" : "-mt-10 px-6")}>
                {logo && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={logo} alt="" className="h-16 w-16 rounded-xl bg-white object-contain p-1 shadow-md ring-1 ring-black/5" />
                )}
              </div>
              <div className={cn("px-4 pb-3 pt-2", device === "desktop" && "px-6")}>
                <h1 className="text-2xl font-black tracking-tight text-zinc-900">{menu.name}</h1>
                {menu.description && <p className="mt-1 text-sm text-zinc-500">{menu.description}</p>}
                <p className="mt-1 text-xs text-zinc-400">
                  {categories.length} categories · {itemCount} products
                </p>
              </div>
            </div>

            {/* Category chips */}
            <div className="sticky top-[44px] z-20 border-y border-zinc-100 bg-white/95 backdrop-blur">
              <div className={cn("flex gap-2 overflow-x-auto px-4 py-2.5", device === "desktop" && "px-6")}>
                {categories.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      setActiveCat(c.id);
                      sectionRefs.current[c.id]?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                    className={cn(
                      "shrink-0 rounded-full px-3.5 py-1.5 text-sm font-semibold",
                      activeCat === c.id ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200",
                    )}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            </div>

            {categories.length === 0 ? (
              <p className="px-6 py-24 text-center text-sm text-zinc-500">
                Nothing on this menu is visible to customers yet.
              </p>
            ) : (
              <div className={cn("space-y-8 px-4 py-6", device === "desktop" && "px-6")}>
                {categories.map((c) => (
                  <section key={c.id} ref={(el) => void (sectionRefs.current[c.id] = el)} className="scroll-mt-28">
                    <h2 className="mb-3 text-lg font-extrabold text-zinc-900">{c.name}</h2>
                    <div className={cn("grid gap-3", device === "desktop" && "md:grid-cols-2")}>
                      {c.items.map((it) => (
                        <button
                          key={it.id}
                          type="button"
                          onClick={() => setOpen(it)}
                          className={cn(
                            "flex w-full items-stretch gap-3 rounded-xl border border-zinc-200 p-3 text-left transition hover:border-zinc-300 hover:shadow-sm",
                            it.soldOut && "opacity-60",
                          )}
                        >
                          <div className="min-w-0 flex-1">
                            <p className="font-bold leading-snug text-zinc-900">{it.name}</p>
                            {it.description && (
                              <p className="mt-1 line-clamp-2 text-sm leading-snug text-zinc-500">{it.description}</p>
                            )}
                            <p className="mt-2 text-sm font-semibold text-zinc-900">
                              {it.soldOut ? (
                                <span className="text-red-600">Sold out</span>
                              ) : (
                                <>
                                  {it.fromPrice && <span className="font-normal text-zinc-500">from </span>}
                                  {money(it.price)}
                                </>
                              )}
                            </p>
                          </div>
                          {it.imageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={it.imageUrl} alt="" className="h-24 w-24 shrink-0 rounded-lg object-cover" />
                          ) : (
                            <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-300">
                              <ImageIcon className="h-6 w-6" />
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Product sheet */}
      {open && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 sm:items-center sm:p-4" onClick={() => setOpen(null)}>
          <div
            className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative">
              {open.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={open.imageUrl} alt="" className="h-56 w-full object-cover" />
              ) : null}
              <button
                type="button"
                onClick={() => setOpen(null)}
                className="absolute right-3 top-3 rounded-full bg-white/90 p-1.5 text-zinc-700 shadow hover:bg-white"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-5 p-5">
              <div>
                <h3 className={cn("text-xl font-black text-zinc-900", !open.imageUrl && "pr-10")}>{open.name}</h3>
                {open.description && <p className="mt-1 text-sm text-zinc-600">{open.description}</p>}
                <p className="mt-2 font-bold text-zinc-900">
                  {open.fromPrice && <span className="font-normal text-zinc-500">from </span>}
                  {money(open.price)}
                </p>
              </div>
              {open.sizes.length > 0 && (
                <OptionBlock
                  title="Size"
                  rule="Choose 1 · Required"
                  options={open.sizes.map((s) => ({ name: s.name, price: s.price, available: true, absolute: true }))}
                  money={money}
                />
              )}
              {open.groups.map((g, i) => (
                <OptionBlock key={i} title={g.name} rule={ruleText(g)} options={g.options} money={money} />
              ))}
              <button
                type="button"
                disabled
                className="w-full cursor-not-allowed rounded-xl bg-zinc-200 py-3 text-sm font-bold text-zinc-500"
              >
                Add to basket — disabled in preview
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function OptionBlock({
  title,
  rule,
  options,
  money,
}: {
  title: string;
  rule: string;
  options: Array<PreviewOption & { absolute?: boolean }>;
  money: (n: number) => string;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-2 border-b border-zinc-100 pb-1.5">
        <p className="font-bold text-zinc-900">{title}</p>
        <p className="shrink-0 text-xs font-medium text-zinc-500">{rule}</p>
      </div>
      <ul className="divide-y divide-zinc-50">
        {options.map((o, i) => (
          <li key={i} className={cn("flex items-center justify-between py-2 text-sm", !o.available && "opacity-50")}>
            <span className="text-zinc-800">
              {o.name}
              {!o.available && <span className="ml-2 text-xs font-semibold text-red-600">Sold out</span>}
            </span>
            <span className="text-zinc-500">
              {o.absolute ? money(o.price) : o.price > 0 ? `+${money(o.price)}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
