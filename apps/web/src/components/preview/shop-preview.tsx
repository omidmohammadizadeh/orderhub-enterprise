"use client";

// The private preview a shop owner opens from a QR code: their own menu, set
// out the way their customers would see it on OrderHub. Read-only on purpose:
// there is no basket and no checkout, so nobody can order from it.

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { PreviewItem, PreviewMenu } from "@/lib/api/prospects.client";

export interface ShopPreviewData {
  shopName: string;
  city: string | null;
  logoUrl: string | null;
  bannerUrl: string | null;
  menu: PreviewMenu;
  hygiene: { rating: string; url: string } | null;
}

function fromPrice(item: PreviewItem): number {
  if (item.sizes?.length) return Math.min(...item.sizes.map((s) => s.price));
  return item.price ?? 0;
}

/** A dead marketplace photo should leave no gap and no broken-image icon. */
function Photo({ src, alt, className }: { src: string; alt: string; className: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} loading="lazy" className={className} onError={() => setBroken(true)} />
  );
}

function ItemSheet({
  item,
  menu,
  money,
  onClose,
}: {
  item: PreviewItem;
  menu: PreviewMenu;
  money: (n: number) => string;
  onClose: () => void;
}) {
  const [sizeIndex, setSizeIndex] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const size = item.sizes?.[sizeIndex];
  const keys = size?.modifierGroupKeys?.length ? size.modifierGroupKeys : (item.modifierGroupKeys ?? []);
  const groups = keys
    .map((key) => menu.modifierGroups?.find((g) => g.key === key))
    .filter((g): g is NonNullable<typeof g> => !!g);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={item.name}>
      <button type="button" aria-label="Close" tabIndex={-1} className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex max-h-[88dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white sm:rounded-2xl">
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/90 text-stone-800 shadow focus-visible:outline focus-visible:outline-2 focus-visible:outline-stone-900"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
        <div className="overflow-y-auto overscroll-contain">
          {item.imageUrl && <Photo src={item.imageUrl} alt="" className="aspect-[16/10] w-full object-cover" />}
          <div className="p-5">
            <h2 className="pr-10 text-xl font-semibold text-stone-900">{item.name}</h2>
            {item.description && <p className="mt-1.5 whitespace-pre-line text-sm leading-relaxed text-stone-600">{item.description}</p>}

            {item.sizes && item.sizes.length > 1 && (
              <fieldset className="mt-5">
                <legend className="text-sm font-semibold text-stone-900">Size</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {item.sizes.map((s, i) => (
                    <button
                      key={`${s.name}-${i}`}
                      type="button"
                      aria-pressed={i === sizeIndex}
                      onClick={() => setSizeIndex(i)}
                      className={`min-h-11 rounded-full border px-4 text-sm tabular-nums transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 ${
                        i === sizeIndex ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300 text-stone-800"
                      }`}
                    >
                      {s.name} · {money(s.price)}
                    </button>
                  ))}
                </div>
              </fieldset>
            )}

            {groups.map((group) => (
              <section key={group.key} className="mt-5">
                <h3 className="text-sm font-semibold text-stone-900">{group.name}</h3>
                <ul className="mt-1 divide-y divide-stone-100">
                  {group.options.map((option) => (
                    <li key={option.name} className="flex justify-between gap-4 py-2 text-sm text-stone-700">
                      <span>{option.name}</span>
                      {!!option.priceAdjustment && (
                        <span className="shrink-0 tabular-nums text-stone-500">+{money(option.priceAdjustment)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
        <p className="border-t border-stone-100 bg-stone-50 px-5 py-3 text-center text-xs text-stone-500">
          This is a preview, so ordering is switched off.
        </p>
      </div>
    </div>
  );
}

export function ShopPreview({ shop }: { shop: ShopPreviewData }) {
  const { menu } = shop;
  const [open, setOpen] = useState<PreviewItem | null>(null);
  const [activeCategory, setActiveCategory] = useState(0);
  const sectionRefs = useRef<(HTMLElement | null)[]>([]);
  const tabRefs = useRef<(HTMLAnchorElement | null)[]>([]);

  const money = useMemo(() => {
    const format = new Intl.NumberFormat("en-GB", { style: "currency", currency: menu.currency || "GBP" });
    return (n: number) => format.format(n);
  }, [menu.currency]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveCategory(sectionRefs.current.indexOf(entry.target as HTMLElement));
        }
      },
      { rootMargin: "-120px 0px -70% 0px" },
    );
    sectionRefs.current.forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    tabRefs.current[activeCategory]?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [activeCategory]);

  return (
    <div className="min-h-dvh bg-[#faf8f5] text-stone-900">
      <p className="bg-stone-900 px-4 py-2 text-center text-xs text-stone-100">
        Private preview made for {shop.shopName} by OrderHub. Not a live shop.
      </p>

      <header className="relative">
        <div className="h-40 overflow-hidden bg-gradient-to-br from-stone-700 to-stone-900 sm:h-64">
          {shop.bannerUrl && <Photo src={shop.bannerUrl} alt="" className="h-full w-full object-cover" />}
        </div>
        <div className="mx-auto flex max-w-3xl items-end gap-4 px-4">
          {shop.logoUrl && (
            <Photo
              src={shop.logoUrl}
              alt=""
              className="-mt-10 h-20 w-20 shrink-0 rounded-2xl border-4 border-[#faf8f5] bg-white object-contain"
            />
          )}
          <div className="min-w-0 py-3">
            <h1 className="text-2xl font-bold tracking-tight [text-wrap:balance]">{shop.shopName}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-stone-600">
              {shop.city && <span>{shop.city}</span>}
              {shop.hygiene && (
                <a href={shop.hygiene.url} target="_blank" rel="noreferrer" className="font-medium text-emerald-800 underline-offset-2 hover:underline">
                  Food hygiene: {shop.hygiene.rating}
                  {/^\d$/.test(shop.hygiene.rating) ? " out of 5" : ""}
                </a>
              )}
            </div>
          </div>
        </div>
      </header>

      <nav aria-label="Menu sections" className="sticky top-0 z-30 border-b border-stone-200 bg-[#faf8f5]/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl gap-1 overflow-x-auto px-4 py-2 [scrollbar-width:none]">
          {menu.categories.map((category, i) => (
            <a
              key={`${category.name}-${i}`}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              href={`#section-${i}`}
              aria-current={i === activeCategory ? "true" : undefined}
              className={`flex min-h-10 shrink-0 items-center whitespace-nowrap rounded-full px-3.5 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-stone-900 ${
                i === activeCategory ? "bg-stone-900 text-white" : "text-stone-700 hover:bg-stone-200"
              }`}
            >
              {category.name}
            </a>
          ))}
        </div>
      </nav>

      <main className="mx-auto max-w-3xl px-4 pb-16">
        {menu.categories.map((category, i) => (
          <section
            key={`${category.name}-${i}`}
            id={`section-${i}`}
            ref={(el) => {
              sectionRefs.current[i] = el;
            }}
            className="scroll-mt-16 pt-8"
          >
            <h2 className="text-lg font-bold">{category.name}</h2>
            {category.description && <p className="mt-1 text-sm text-stone-600">{category.description}</p>}
            <ul className="mt-3 grid gap-3 sm:grid-cols-2">
              {category.items.map((item, j) => (
                <li key={`${item.name}-${j}`}>
                  <button
                    type="button"
                    onClick={() => setOpen(item)}
                    className="flex h-full min-h-24 w-full items-stretch justify-between gap-3 rounded-xl border border-stone-200 bg-white p-3 text-left transition-shadow hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="font-semibold leading-snug">{item.name}</span>
                      {item.description && <span className="mt-1 line-clamp-2 text-sm text-stone-600">{item.description}</span>}
                      <span className="mt-auto pt-2 text-sm font-medium tabular-nums">
                        {item.sizes && item.sizes.length > 1 ? "From " : ""}
                        {money(fromPrice(item))}
                      </span>
                    </span>
                    {item.imageUrl && (
                      <Photo src={item.imageUrl} alt="" className="h-24 w-24 shrink-0 rounded-lg object-cover" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </main>

      {open && <ItemSheet key={open.name} item={open} menu={menu} money={money} onClose={() => setOpen(null)} />}
    </div>
  );
}
