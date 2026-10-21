"use client";

// A brand's supplier & ingredient list on A4 (?brand=<slug>). "Print / Save as
// PDF" opens the print dialog; ?download=1 opens it once the photos load.

import { Suspense, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { Printer } from "lucide-react";
import { supplierListBySlug, suppliersOf } from "@/lib/supplier-lists";
import { SupplierItems } from "@/components/supplier-list/supplier-list";

export default function SupplierListPrintPage() {
  return (
    <Suspense fallback={<Centered>Loading…</Centered>}>
      <SupplierListSheet />
    </Suspense>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center bg-zinc-100 p-6 text-zinc-600">{children}</div>;
}

function SupplierListSheet() {
  const params = useSearchParams();
  const list = supplierListBySlug(params.get("brand"));
  const download = params.get("download") === "1";

  const printed = useRef(false);
  useEffect(() => {
    if (!download || !list || printed.current) return;
    printed.current = true;
    const pending = [...document.images].filter((img) => !img.complete);
    const loaded = Promise.all(
      pending.map(
        (img) =>
          new Promise((r) => {
            img.addEventListener("load", r, { once: true });
            img.addEventListener("error", r, { once: true });
          }),
      ),
    );
    Promise.race([loaded, new Promise((r) => setTimeout(r, 8000))]).then(() => window.print());
  }, [download, list]);

  if (!list) return <Centered>Unknown supplier list — open it from Kitchen training.</Centered>;

  return (
    <div className="min-h-screen bg-zinc-100 print:bg-white">
      <style>{`
        @page { size: A4; margin: 12mm; }
        @media print {
          html, body { background: #fff !important; }
          * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-zinc-300 bg-white px-4 py-3 print:hidden">
        <div className="min-w-0 truncate text-sm text-zinc-600">
          <span className="font-semibold text-zinc-900">{list.name}</span> · suppliers &amp; ingredients
        </div>
        <button
          onClick={() => window.print()}
          className="inline-flex shrink-0 items-center gap-2 rounded-md bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500"
        >
          <Printer className="h-4 w-4" /> Print / Save as PDF
        </button>
      </div>
      <main className="mx-auto max-w-4xl space-y-6 bg-white p-4 sm:my-6 sm:rounded-xl sm:p-8 sm:shadow print:m-0 print:max-w-none print:p-0 print:shadow-none">
        <header className="border-b-4 pb-4" style={{ borderColor: list.accent }}>
          <p className="text-xs font-bold uppercase tracking-[0.2em]" style={{ color: list.accent }}>
            Suppliers &amp; ingredients
          </p>
          <h1 className="mt-1 text-3xl font-black text-zinc-900">{list.name}</h1>
          <p className="mt-2 text-sm text-zinc-600">
            {list.items.length} items ·{" "}
            {suppliersOf(list)
              .map((s) => (s.website ? `${s.name} (${s.website.replace(/^https?:\/\/(www\.)?/, "")})` : s.name))
              .join(" · ")}
          </p>
        </header>
        <SupplierItems list={list} items={list.items} />
      </main>
    </div>
  );
}
