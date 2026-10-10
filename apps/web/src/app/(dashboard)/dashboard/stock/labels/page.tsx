"use client";

// Test labels — managers only. Everything a shop needs to try the till before
// its real stock is in: every product's barcode (bars + a QR, either scans),
// a scale label for each weighed product in this shop's layout, and the
// receipt QR of recent till sales for trying returns without a printer.
//
// "Give test barcodes" assigns made-up in-store codes (049…) to products that
// have none; real barcodes can replace them any time on the Stock page.

import Link from "next/link";
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import toast from "react-hot-toast";
import { ArrowLeft, Barcode, Printer, Receipt, Scale } from "lucide-react";
import {
  buildScaleBarcode,
  formatWeight,
  normaliseScaleFormat,
  priceForWeight,
  sellByLabel,
} from "@orderhub/shared";
import { Button } from "@/components/ui/button";
import { useCurrency } from "@/hooks/use-currency";
import { locationsClient } from "@/lib/api/locations.client";
import { ordersClient } from "@/lib/api/orders.client";
import { queryKeys } from "@/lib/api/query-keys";
import { retailClient } from "@/lib/api/retail.client";
import { RETURNS_CODE_PREFIX } from "@/lib/printing/print-order";
import { ean13Modules } from "@/lib/retail/ean13";
import { useAuthStore } from "@/stores/auth.store";
import { useSelectedLocationStore } from "@/stores/selected-location.store";

const CATALOG_MANAGERS = ["PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "MANAGER", "DARK_KITCHEN_MANAGER"];

/** EAN-13 bars as SVG; null for codes that aren't EAN/UPC (the QR covers those). */
function Bars({ code }: { code: string }) {
  const modules = ean13Modules(code);
  if (!modules) return null;
  const quiet = 9;
  const w = modules.length + quiet * 2;
  return (
    <svg viewBox={`0 0 ${w} 40`} className="h-12 w-full" role="img" aria-label={`Barcode ${code}`} shapeRendering="crispEdges">
      <rect width={w} height="40" fill="#fff" />
      {modules.split("").map((m, i) => (m === "1" ? <rect key={i} x={quiet + i} width="1" height="40" fill="#000" /> : null))}
    </svg>
  );
}

function Label({ title, sub, code, tag }: { title: string; sub: string; code: string; tag?: string | null }) {
  return (
    <div className="label flex gap-2 rounded-lg border border-dashed border-zinc-400 bg-white p-2 text-black">
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-[12px] font-semibold leading-tight">{title}</p>
        <p className="text-[11px] text-zinc-600">
          {sub}
          {tag ? <span className="ml-1 rounded bg-black px-1 text-[9px] font-bold text-white">{tag}</span> : null}
        </p>
        <Bars code={code} />
        <p className="font-mono text-[10px] tracking-wider">{code}</p>
      </div>
      <QRCodeSVG value={code} size={64} level="M" marginSize={1} className="shrink-0" />
    </div>
  );
}

export default function TestLabelsPage() {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const role = useAuthStore((s) => s.user?.role);
  const canManage = CATALOG_MANAGERS.includes(String(role));
  const { money } = useCurrency();
  const qc = useQueryClient();

  const location = useQuery({
    queryKey: queryKeys.locationDetail(locationId ?? ""),
    queryFn: () => locationsClient.get(locationId!),
    enabled: !!locationId,
    staleTime: 60_000,
  });
  const products = useQuery({
    queryKey: ["retail-products", locationId, "labels"],
    queryFn: () => retailClient.products(locationId!),
    enabled: !!locationId && canManage,
  });
  const sales = useQuery({
    queryKey: ["retail-labels-sales", locationId],
    queryFn: () => ordersClient.list({ locationId: locationId!, orderSource: "POS", limit: 8 }),
    enabled: !!locationId && canManage,
  });

  const assign = useMutation({
    mutationFn: () => retailClient.assignTestBarcodes(locationId!),
    onSuccess: (r) => {
      const n = r.assigned + r.created;
      toast.success(n ? `${n} product${n === 1 ? "" : "s"} now have a test barcode` : "Every product already has a barcode");
      void qc.invalidateQueries({ queryKey: ["retail-products"] });
      void qc.invalidateQueries({ queryKey: ["retail-barcodes"] });
    },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? "Couldn't assign test barcodes"),
  });

  const format = normaliseScaleFormat((location.data as any)?.settings?.scaleLabels?.format);
  const { barcoded, missing, weighed } = useMemo(() => {
    const barcoded: Array<{ key: string; title: string; sub: string; code: string; tag: string | null }> = [];
    let missing = 0;
    const weighed: Array<{ key: string; title: string; sub: string; code: string }> = [];
    for (const p of products.data?.products ?? []) {
      if (p.sellBy) {
        // One label per weighed product, at a typical amount for its unit.
        const grams = p.sellBy === "KG" ? 642 : 150;
        const price = priceForWeight(p.basePrice, p.sellBy, grams);
        const code = p.scaleCode ? buildScaleBarcode(p.scaleCode, format, { price, grams }) : null;
        if (code)
          weighed.push({
            key: p.id,
            title: `${p.name} — ${formatWeight(grams)}`,
            sub: `${money(price)} · ${money(p.basePrice)}${sellByLabel(p.sellBy)}`,
            code,
          });
        continue;
      }
      for (const v of p.variants) {
        if (!v.isActive) continue;
        if (!v.barcode) {
          missing++;
          continue;
        }
        barcoded.push({
          key: v.id,
          title: p.variants.length > 1 ? `${p.name} — ${v.name}` : p.name,
          sub: money(v.price ?? p.basePrice),
          code: v.barcode,
          tag: p.minAge ? `${p.minAge}+` : null,
        });
      }
    }
    return { barcoded, missing, weighed };
  }, [products.data, format, money]);

  if (!canManage) {
    return <p className="p-6 text-sm text-zinc-600">Test labels are for managers and owners.</p>;
  }

  return (
    <div className="flex flex-col gap-5 p-4 sm:p-6">
      {/* Print only the labels, not the dashboard around them. */}
      <style>{`@media print {
        body * { visibility: hidden !important; }
        #test-labels, #test-labels * { visibility: visible !important; }
        #test-labels { position: absolute; inset: 0; padding: 8mm; }
        .label { break-inside: avoid; }
        .no-print { display: none !important; }
      }`}</style>

      <header className="no-print flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/dashboard/stock" className="mb-1 inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-800">
            <ArrowLeft className="h-3.5 w-3.5" /> Stock & barcodes
          </Link>
          <h1 className="text-base font-semibold text-zinc-900">Test labels</h1>
          <p className="mt-0.5 max-w-xl text-xs text-zinc-500">
            Print this page (or show it on a second screen) and scan it at the till like real stock. Each label works as
            a barcode and as a QR code.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" loading={assign.isPending} onClick={() => assign.mutate()}>
            <Barcode className="mr-1.5 h-4 w-4" /> Give test barcodes
            {missing ? ` (${missing})` : ""}
          </Button>
          <Button size="sm" onClick={() => window.print()}>
            <Printer className="mr-1.5 h-4 w-4" /> Print
          </Button>
        </div>
      </header>

      <div id="test-labels" className="flex flex-col gap-5">
        <section>
          <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            <Barcode className="h-3.5 w-3.5" /> Products ({barcoded.length})
          </h2>
          {products.isLoading ? (
            <p className="text-sm text-zinc-400">Loading…</p>
          ) : barcoded.length === 0 ? (
            <p className="no-print rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-600">
              No product on this till has a barcode yet. Press <b>Give test barcodes</b> above, or import the demo
              spreadsheet on the Stock page.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {barcoded.map((l) => (
                <Label key={l.key} title={l.title} sub={l.sub} code={l.code} tag={l.tag} />
              ))}
            </div>
          )}
        </section>

        {weighed.length > 0 && (
          <section>
            <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <Scale className="h-3.5 w-3.5" /> Scale labels — loose & deli
            </h2>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {weighed.map((l) => (
                <Label key={l.key} title={l.title} sub={l.sub} code={l.code} tag="scale" />
              ))}
            </div>
          </section>
        )}

        <section>
          <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            <Receipt className="h-3.5 w-3.5" /> Receipts — scan one in Returns
          </h2>
          {(sales.data?.orders ?? []).length === 0 ? (
            <p className="no-print text-sm text-zinc-500">Ring up a sale on the till, then come back: its receipt QR shows here.</p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(sales.data?.orders ?? []).map((o: any) => (
                <div key={o.id} className="label flex flex-col items-center gap-1 rounded-lg border border-dashed border-zinc-400 bg-white p-2 text-black">
                  <QRCodeSVG value={`${RETURNS_CODE_PREFIX}${o.id}`} size={96} level="M" marginSize={1} />
                  <p className="text-[11px] font-semibold">#{o.orderNumber ?? o.displayId ?? o.id.slice(-6)}</p>
                  <p className="text-[10px] text-zinc-600">
                    {money(Number(o.total ?? 0))} · {new Date(o.createdAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
