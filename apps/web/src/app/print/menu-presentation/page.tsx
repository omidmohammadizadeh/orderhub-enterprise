"use client";

// A virtual brand's menu presentation (?brand=<slug>), drawn live from its
// menu in the Fiesta Mexica template. "Print / Save as PDF" prints one
// 1920×1080 page per sheet; ?download=1 opens that dialog once photos load.

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Printer } from "lucide-react";
import { useAuthHydrated } from "@/stores/auth.store";
import { assemblyChartsClient, type PresentationMenu } from "@/lib/api/assembly-charts.client";
import { printLinksClient } from "@/lib/print-links";
import { presentationBySlug } from "@/lib/menu-presentations";
import { Deck, PRESENTATION_FONTS, PresentationStyles } from "@/components/menu-presentation/presentation";

export default function MenuPresentationPage() {
  return (
    <Suspense fallback={<Centered>Loading…</Centered>}>
      <MenuPresentation />
    </Suspense>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center bg-zinc-100 p-6 text-zinc-600">{children}</div>;
}

function MenuPresentation() {
  const params = useSearchParams();
  const brand = presentationBySlug(params.get("brand"));
  const download = params.get("download") === "1";
  // ?menu= draws the deck from a location's own copy of the brand's menu.
  const menuId = params.get("menu") || brand?.menuId;
  // ?pt= is a signed print link (opened from the tablet app) — no session needed.
  const pt = params.get("pt");

  // Outside the dashboard tree: wait for the persisted session before calling
  // the API, or the first request goes out without a token and bounces to /login.
  const hydrated = useAuthHydrated();
  const q = useQuery({
    queryKey: ["menu-presentation", menuId, pt],
    enabled: (!!pt || hydrated) && !!brand && !!menuId,
    retry: false,
    queryFn: () => (pt ? printLinksClient.read<PresentationMenu>(pt) : assemblyChartsClient.presentation(menuId!)),
  });

  // Fit 1920px pages to the window on screen; print is always 1:1.
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const fit = () => setZoom(Math.min(1, (window.innerWidth - 32) / 1920));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  const printed = useRef(false);
  useEffect(() => {
    if (!download || !q.data || printed.current) return;
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
    Promise.race([loaded, new Promise((r) => setTimeout(r, 10000))]).then(() =>
      document.fonts.ready.then(() => window.print()),
    );
  }, [download, q.data]);

  if (!brand) return <Centered>Unknown menu presentation — open it from Kitchen training.</Centered>;
  if ((!pt && !hydrated) || q.isPending)
    return (
      <Centered>
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading the {brand.name} menu…
      </Centered>
    );
  if (q.isError || !q.data)
    return (
      <Centered>
        {pt
          ? "This link has expired — tap Download again in Kitchen training."
          : `Could not load the ${brand.name} menu. Make sure you are signed in to the dashboard in this browser.`}
      </Centered>
    );

  return (
    <div className={`min-h-screen bg-zinc-300 print:bg-white ${PRESENTATION_FONTS}`}>
      <style>{`
        @page { size: 1920px 1080px; margin: 0; }
        @media print {
          html, body { background: #fff !important; }
          .mp-zoom { zoom: 1 !important; }
          .mp-sheet { margin: 0 !important; box-shadow: none !important; break-after: page; }
          * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>
      <PresentationStyles />
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-zinc-300 bg-white px-4 py-3 print:hidden">
        <div className="min-w-0 truncate text-sm text-zinc-600">
          <span className="font-semibold text-zinc-900">{brand.name}</span> · menu presentation
        </div>
        <button
          onClick={() => window.print()}
          className="inline-flex shrink-0 items-center gap-2 rounded-md bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500"
        >
          <Printer className="h-4 w-4" /> Print / Save as PDF
        </button>
      </div>
      <div className="mp mp-zoom py-4 print:py-0" style={{ zoom }}>
        <Deck
          brand={brand}
          menu={q.data}
          renderPage={(node, i) => (
            <div key={i} className="mp-sheet mx-auto mb-6 w-[1920px] shadow-xl">
              {node}
            </div>
          )}
        />
      </div>
    </div>
  );
}
