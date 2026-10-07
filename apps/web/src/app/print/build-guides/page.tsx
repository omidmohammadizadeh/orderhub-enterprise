"use client";

// Printable A4 "How to build" charts — one product per sheet, for the wall
// or a binder by the line. Opened in a new tab from the guide editor
// (?item=…) or the menu editor (?menu=… prints every guided product on it).

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useAuthHydrated } from "@/stores/auth.store";
import { Loader2, Printer } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { formatVideoTime, parseYouTubeId, youTubeWatchUrl } from "@orderhub/shared";
import { buildGuidesClient, type BuildGuidePrintFeed } from "@/lib/api/build-guides.client";

export default function PrintBuildGuidesPage() {
  return (
    <Suspense fallback={<Centered>Loading…</Centered>}>
      <PrintBuildGuides />
    </Suspense>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center bg-zinc-100 p-6 text-zinc-600">{children}</div>;
}

function PrintBuildGuides() {
  const params = useSearchParams();
  const menuId = params.get("menu");
  const itemId = params.get("item");

  // This page is outside the dashboard tree, so nothing has restored the
  // signed-in session yet: wait for the persisted tokens before calling the
  // API, or the first request goes out without them, 401s, and bounces to /login.
  const hydrated = useAuthHydrated();
  const q = useQuery<BuildGuidePrintFeed>({
    queryKey: ["build-guides-print", menuId, itemId],
    queryFn: () => (menuId ? buildGuidesClient.printMenu(menuId) : buildGuidesClient.printItem(itemId!)),
    enabled: hydrated && !!(menuId || itemId),
    retry: false,
  });

  if (!menuId && !itemId) return <Centered>Nothing to print — open this from a product or a menu.</Centered>;
  if (q.isPending || !hydrated)
    return (
      <Centered>
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading build guides…
      </Centered>
    );
  if (q.isError || !q.data)
    return <Centered>Could not load the guides. Make sure you are signed in to the dashboard in this browser.</Centered>;

  const sheets = q.data.categories.flatMap((c) => c.items.map((item) => ({ category: c.name, item })));
  const brand = q.data.brandName;

  return (
    <div className="min-h-screen bg-zinc-200 print:bg-white">
      <style>{`
        @page { size: A4 portrait; margin: 10mm; }
        @media print {
          html, body { background: #fff !important; }
          .sheet { box-shadow: none !important; margin: 0 !important; width: auto !important; min-height: 0 !important; padding: 0 !important; }
          .sheet + .sheet { break-before: page; }
          * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
        .step { break-inside: avoid; }
      `}</style>

      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-zinc-300 bg-white px-4 py-3 print:hidden">
        <div className="min-w-0 text-sm text-zinc-600">
          <span className="font-semibold text-zinc-900">{q.data.menuName ?? "How to build"}</span>
          {" · "}
          {sheets.length} {sheets.length === 1 ? "sheet" : "sheets"} (A4)
        </div>
        <button
          onClick={() => window.print()}
          disabled={sheets.length === 0}
          className="inline-flex items-center gap-2 rounded-md bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-40"
        >
          <Printer className="h-4 w-4" /> Print / Save as PDF
        </button>
      </div>

      {sheets.length === 0 ? (
        <Centered>No product here has a build guide yet. Add one with “How to build” on a product.</Centered>
      ) : (
        sheets.map(({ category, item }) => (
          <section
            key={item.id}
            className="sheet mx-auto my-6 w-[210mm] min-h-[297mm] bg-white p-[10mm] text-zinc-900 shadow-lg"
          >
            <header className="flex items-stretch gap-4 border-b-4 border-orange-500 pb-3">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-orange-600">
                  How to build{brand ? ` · ${brand}` : ""}
                  {category ? ` · ${category}` : ""}
                </p>
                <h1 className="mt-1 text-[28px] font-black uppercase leading-none tracking-tight">{item.name}</h1>
                <p className="mt-2 text-xs text-zinc-500">
                  {item.guide.steps.length} steps · updated {new Date(item.guide.updatedAt).toLocaleDateString()}
                </p>
              </div>
              {item.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.imageUrl} alt="" className="h-[30mm] w-[40mm] shrink-0 rounded-md object-cover" />
              )}
              {(() => {
                const vid = parseYouTubeId(item.guide.videoUrl);
                return vid ? (
                  // Scan with a phone camera → the video opens in YouTube.
                  <div className="flex shrink-0 flex-col items-center justify-center rounded-md border-2 border-red-600 px-1.5 pt-1.5">
                    <QRCodeSVG value={youTubeWatchUrl(vid)} size={88} level="M" />
                    <p className="py-0.5 text-[9px] font-black uppercase tracking-wider text-red-600">▶ Scan for video</p>
                  </div>
                ) : null;
              })()}
            </header>

            <ol className="mt-4 grid grid-cols-3 gap-3">
              {item.guide.steps.map((s, i) => (
                <li key={s.id ?? i} className="step overflow-hidden rounded-lg border border-zinc-300">
                  {s.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={s.imageUrl} alt="" className="aspect-[4/3] w-full object-cover" />
                  ) : null}
                  <div className="p-2">
                    <div className="flex items-start gap-2">
                      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-orange-500 text-xs font-black text-white">
                        {i + 1}
                      </span>
                      <p className="whitespace-pre-line text-[12px] font-semibold leading-snug">{s.text}</p>
                    </div>
                    {(s.amount || (s.tools?.length ?? 0) > 0) && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {s.amount && (
                          <span className="rounded bg-amber-300 px-1.5 py-0.5 text-[10px] font-bold">{s.amount}</span>
                        )}
                        {s.tools?.map((t) => (
                          <span key={t} className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                    {s.videoStart != null && parseYouTubeId(item.guide.videoUrl) && (
                      <p className="mt-1 text-[10px] font-bold text-red-600">▶ VIDEO AT {formatVideoTime(s.videoStart)}</p>
                    )}
                    {(s.onlyWith?.length ?? 0) > 0 && (
                      <p className="mt-1 text-[10px] font-bold text-amber-700">ONLY WITH: {s.onlyWith!.join(", ")}</p>
                    )}
                    {(s.skipWith?.length ?? 0) > 0 && (
                      <p className="mt-1 text-[10px] font-bold text-red-700">SKIP IF: {s.skipWith!.join(", ")}</p>
                    )}
                  </div>
                </li>
              ))}
            </ol>

            {item.guide.packNote && (
              <div className="step mt-4 rounded-lg border-2 border-emerald-600 bg-emerald-50 p-3">
                <p className="text-[11px] font-black uppercase tracking-widest text-emerald-700">Pack</p>
                <p className="whitespace-pre-line text-[13px] font-semibold">{item.guide.packNote}</p>
              </div>
            )}
          </section>
        ))
      )}
    </div>
  );
}
