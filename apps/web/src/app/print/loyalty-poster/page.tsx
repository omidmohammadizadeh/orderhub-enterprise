"use client";

// The counter poster for the walk-in loyalty card, on A4: the shop, the deal,
// and a big QR to the join page. Everything comes in the query string from the
// Marketing → Loyalty card panel, so the page needs no login to print.

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Printer } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { RewardIcon, StampIcon, readableOn } from "@/components/loyalty/wallet-card";

export default function LoyaltyPosterPage() {
  return (
    <Suspense fallback={null}>
      <Poster />
    </Suspense>
  );
}

function Poster() {
  const p = useSearchParams();
  const url = p.get("u") ?? "";
  const title = p.get("t") ?? "Our loyalty card";
  const reward = p.get("r") ?? "a free item";
  const stamps = Math.min(20, Math.max(2, Number(p.get("n")) || 6));
  const color = /^#[0-9a-fA-F]{6}$/.test(`#${p.get("c")}`) ? `#${p.get("c")}` : "#1F2937";
  const fg = readableOn(color);
  const icon = p.get("i");

  return (
    <div className="min-h-screen bg-zinc-200 py-8 print:bg-white print:py-0">
      <style>{`@page { size: A4; margin: 0 } @media print { .no-print { display: none !important } }`}</style>
      <div className="no-print mx-auto mb-4 flex w-[210mm] justify-end">
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex items-center gap-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-semibold text-white"
        >
          <Printer className="h-4 w-4" /> Print / Save as PDF
        </button>
      </div>

      <article
        className="mx-auto flex h-[297mm] w-[210mm] flex-col items-center overflow-hidden bg-white shadow-xl print:shadow-none"
        style={{ WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" }}
      >
        <header className="flex w-full flex-col items-center px-[18mm] pb-[14mm] pt-[18mm]" style={{ background: color, color: fg }}>
          <p className="text-[13pt] font-semibold uppercase tracking-[0.3em] opacity-80">{title}</p>
          <h1 className="mt-[6mm] text-center text-[46pt] font-bold leading-[1.02] tracking-tight">
            Collect {stamps} stamps,
            <br />
            get {reward.toLowerCase()}
          </h1>
          <div className="mt-[10mm] flex flex-wrap justify-center gap-[3mm]">
            {Array.from({ length: stamps }, (_, i) => {
              return (
                <span
                  key={i}
                  className="flex h-[14mm] w-[14mm] items-center justify-center rounded-full"
                  style={{ background: i < Math.ceil(stamps / 2) ? fg : "transparent", color: i < Math.ceil(stamps / 2) ? color : fg, border: `0.6mm ${i < Math.ceil(stamps / 2) ? "solid" : "dashed"} ${fg}` }}
                >
                  {i === stamps - 1 ? (
                    <RewardIcon className="h-[8mm] w-[8mm]" />
                  ) : (
                    <StampIcon icon={icon} className="h-[8mm] w-[8mm]" />
                  )}
                </span>
              );
            })}
          </div>
        </header>

        <section className="flex flex-1 flex-col items-center justify-center px-[18mm]">
          <p className="text-[22pt] font-semibold text-zinc-900">Scan to get your card</p>
          <div className="mt-[8mm] rounded-[6mm] border-[0.8mm] border-zinc-900 p-[7mm]">
            {url && <QRCodeSVG value={url} size={300} level="M" marginSize={0} />}
          </div>
          <div className="mt-[10mm] grid w-full max-w-[150mm] grid-cols-3 gap-[6mm] text-center text-[11.5pt] text-zinc-700">
            <Step n={1} text="Scan the code with your phone camera" />
            <Step n={2} text="Add the card to Apple or Google Wallet" />
            <Step n={3} text="Show it at the till every time you order" />
          </div>
        </section>

        <footer className="w-full pb-[12mm] text-center text-[9pt] text-zinc-400">{url.replace(/^https?:\/\//, "")}</footer>
      </article>
    </div>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <div className="flex flex-col items-center gap-[2mm]">
      <span className="flex h-[9mm] w-[9mm] items-center justify-center rounded-full bg-zinc-900 text-[12pt] font-bold text-white">
        {n}
      </span>
      <span className="leading-snug">{text}</span>
    </div>
  );
}
