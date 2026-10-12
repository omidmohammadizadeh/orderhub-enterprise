'use client';

// A brand's supplier & ingredient list — shared by the Kitchen training tab
// and the printable sheet (/print/supplier-list).

import toast from 'react-hot-toast';
import { Copy, ExternalLink, Package } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  SUPPLIER_CATEGORIES,
  SUPPLIERS,
  supplierImage,
  type SupplierItem,
  type SupplierList,
} from '@/lib/supplier-lists';

export function groupByCategory(items: SupplierItem[]) {
  return SUPPLIER_CATEGORIES.map(
    (c) => [c, items.filter((it) => it.category === c)] as const,
  ).filter(([, list]) => list.length);
}

const host = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/.*$/, '');

function copyCode(code: string) {
  navigator.clipboard?.writeText(code).then(
    () => toast.success(`Copied ${code}`),
    () => toast.error('Could not copy'),
  );
}

function Photo({
  list,
  item,
  className,
}: {
  list: SupplierList;
  item: SupplierItem;
  className?: string;
}) {
  const src = supplierImage(list, item);
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-zinc-100 bg-white',
        className,
      )}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" loading="lazy" className="h-full w-full object-contain p-1" />
      ) : (
        <Package className="h-5 w-5 text-zinc-300" />
      )}
    </div>
  );
}

function Where({ item }: { item: SupplierItem }) {
  const first = item.suppliers[0];
  const url = item.link ?? item.site ?? (first && SUPPLIERS[first].website);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="text-sm text-zinc-700">
        {item.suppliers.map((k, i) => (
          <span key={k}>
            {i > 0 && <span className="text-zinc-400"> or </span>}
            <span className={i === 0 ? 'font-semibold text-zinc-900' : undefined}>
              {SUPPLIERS[k].name}
            </span>
          </span>
        ))}
      </span>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-orange-600 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-500 print:text-zinc-500"
        >
          {item.link ? 'Buy here' : host(url)} <ExternalLink className="h-3 w-3 print:hidden" />
        </a>
      )}
    </div>
  );
}

function Code({ code }: { code?: string }) {
  if (!code) return <span className="text-sm text-zinc-300">—</span>;
  return (
    <button
      type="button"
      onClick={() => copyCode(code)}
      aria-label={`Copy item code ${code}`}
      className="group inline-flex items-center gap-1.5 rounded-md bg-zinc-100 px-2 py-1 font-mono text-sm font-bold tracking-wide text-zinc-900 hover:bg-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-500 print:bg-transparent print:p-0"
    >
      {code}
      <Copy className="h-3 w-3 text-zinc-400 group-hover:text-zinc-700 print:hidden" />
    </button>
  );
}

/** Items grouped by category: cards on phones, a table from `sm` up (and on paper). */
export function SupplierItems({ list, items }: { list: SupplierList; items: SupplierItem[] }) {
  return (
    <div className="space-y-6">
      {groupByCategory(items).map(([cat, rows]) => (
        <section key={cat} className="break-inside-avoid-page">
          <h3 className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-zinc-500">
            <span className="h-2 w-2 rounded-full" style={{ background: list.accent }} />
            {cat} <span className="font-medium text-zinc-400">({rows.length})</span>
          </h3>

          <ul className="space-y-2 sm:hidden print:hidden">
            {rows.map((it) => (
              <li
                key={it.slug}
                className="flex gap-3 rounded-xl border border-zinc-200 bg-white p-3"
              >
                <Photo list={list} item={it} className="h-16 w-16" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <p className="font-semibold leading-snug text-zinc-900">
                    {it.name}
                    {it.itemBrand && (
                      <span className="ml-1.5 text-xs font-medium text-zinc-500">
                        · {it.itemBrand}
                      </span>
                    )}
                  </p>
                  {it.note && <p className="text-xs text-zinc-500">{it.note}</p>}
                  <Where item={it} />
                  {it.code && <Code code={it.code} />}
                </div>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-hidden rounded-xl border border-zinc-200 bg-white sm:block print:block print:rounded-none">
            <table className="w-full text-left">
              <thead className="bg-zinc-50 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                <tr>
                  <th scope="col" className="w-16 px-3 py-2">
                    <span className="sr-only">Photo</span>
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Ingredient
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Brand / type
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Where to buy
                  </th>
                  <th scope="col" className="w-32 px-3 py-2">
                    Item code
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {rows.map((it) => (
                  <tr key={it.slug} className="break-inside-avoid">
                    <td className="px-3 py-2">
                      <Photo list={list} item={it} className="h-12 w-12" />
                    </td>
                    <td className="px-3 py-2">
                      <p className="text-sm font-semibold text-zinc-900">{it.name}</p>
                      {it.note && <p className="text-xs text-zinc-500">{it.note}</p>}
                    </td>
                    <td className="px-3 py-2 text-sm text-zinc-600">
                      {it.itemBrand ?? <span className="text-zinc-300">—</span>}
                    </td>
                    <td className="px-3 py-2">
                      <Where item={it} />
                    </td>
                    <td className="px-3 py-2">
                      <Code code={it.code} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
