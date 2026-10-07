"use client";

// Printable assembly board — the laminated wall poster: magenta board, a
// navy title bar, then the charts side by side, six to an A4 landscape sheet.
// ?menu=… prints every charted product on a menu; ?item=… prints one.

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useAuthHydrated } from "@/stores/auth.store";
import { Loader2, Printer } from "lucide-react";
import type { AssemblyChartDto } from "@orderhub/shared";
import { assemblyChartsClient } from "@/lib/api/assembly-charts.client";
import { BOARD_BG, ChartColumn } from "@/components/assembly-charts/chart-column";

const PER_SHEET = 6;

export default function PrintAssemblyChartsPage() {
  return (
    <Suspense fallback={<Centered>Loading…</Centered>}>
      <PrintAssemblyCharts />
    </Suspense>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center bg-zinc-100 p-6 text-zinc-600">{children}</div>;
}

function PrintAssemblyCharts() {
  const params = useSearchParams();
  const menuId = params.get("menu");
  const itemId = params.get("item");

  // This page is outside the dashboard tree, so nothing has restored the
  // signed-in session yet: wait for the persisted tokens before calling the
  // API, or the first request goes out without them, 401s, and bounces to /login.
  const hydrated = useAuthHydrated();
  const q = useQuery({
    queryKey: ["assembly-charts-print", menuId, itemId],
    enabled: hydrated && !!(menuId || itemId),
    retry: false,
    queryFn: async (): Promise<{ heading: string; charts: AssemblyChartDto[] }> => {
      if (menuId) {
        const r = await assemblyChartsClient.printMenu(menuId);
        return { heading: r.menuName, charts: r.charts };
      }
      const r = await assemblyChartsClient.getForItem(itemId!);
      return {
        heading: r.chart?.title ?? "",
        charts: r.chart ? [{ ...r.chart, heroImageUrl: r.chart.heroImageUrl ?? r.productImageUrl }] : [],
      };
    },
  });

  if (!menuId && !itemId) return <Centered>Nothing to print — open this from a product or a menu.</Centered>;
  if (q.isPending || !hydrated)
    return (
      <Centered>
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading charts…
      </Centered>
    );
  if (q.isError || !q.data)
    return <Centered>Could not load the charts. Make sure you are signed in to the dashboard in this browser.</Centered>;

  const { heading, charts } = q.data;
  const sheets: AssemblyChartDto[][] = [];
  for (let i = 0; i < charts.length; i += PER_SHEET) sheets.push(charts.slice(i, i + PER_SHEET));

  return (
    <div className="min-h-screen bg-zinc-300 print:bg-white">
      <style>{`
        @page { size: A4 landscape; margin: 0; }
        @media print {
          html, body { background: #fff !important; }
          .sheet { box-shadow: none !important; margin: 0 !important; }
          .sheet + .sheet { break-before: page; }
          * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>

      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-zinc-300 bg-white px-4 py-3 print:hidden">
        <div className="text-sm text-zinc-600">
          <span className="font-semibold text-zinc-900">{heading || "Assembly charts"}</span> · {charts.length}{" "}
          {charts.length === 1 ? "chart" : "charts"} on {sheets.length} A4 landscape {sheets.length === 1 ? "sheet" : "sheets"}
        </div>
        <button
          onClick={() => window.print()}
          disabled={charts.length === 0}
          className="inline-flex items-center gap-2 rounded-md bg-pink-600 px-4 py-2 text-sm font-semibold text-white hover:bg-pink-700 disabled:opacity-40"
        >
          <Printer className="h-4 w-4" /> Print / Save as PDF
        </button>
      </div>

      {charts.length === 0 ? (
        <Centered>No product here has an assembly chart yet. Add one with “Chart” on a product.</Centered>
      ) : (
        sheets.map((sheet, i) => (
          <section
            key={i}
            className="sheet mx-auto my-6 flex h-[210mm] w-[297mm] flex-col overflow-hidden p-[8mm] shadow-xl"
            style={{ background: BOARD_BG }}
          >
            <header className="mb-3 flex items-center justify-between rounded-lg bg-[#1d2242] px-5 py-2">
              <h1 className="text-[22px] font-black uppercase tracking-wide text-white">
                {heading} <span className="text-[#f7c948]">assembly table</span>
              </h1>
              {sheets.length > 1 && (
                <span className="text-sm font-bold text-white/70">
                  {i + 1}/{sheets.length}
                </span>
              )}
            </header>
            <div className="flex flex-1 items-start justify-center gap-[5mm]">
              {sheet.map((c) => (
                <ChartColumn key={c.id} chart={c} size="sm" className="w-[42mm]" />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
