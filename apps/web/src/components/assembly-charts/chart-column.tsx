"use client";

// One column of the assembly board: navy name plate (product name, plus the
// same build's name on a second brand), the burger photo, then the white
// rounded stack of layers top to bottom — the laminated-poster look.

import { Archivo_Black } from "next/font/google";
import type { AssemblyChartDto, AssemblyLayer } from "@orderhub/shared";
import { cn } from "@/lib/utils";
import { LayerArt, isBun } from "./layer-art";

const display = Archivo_Black({ weight: "400", subsets: ["latin"], display: "swap" });

export const BOARD_BG = "#d81b6a";

type ChartLike = Pick<AssemblyChartDto, "title" | "altTitle" | "heroImageUrl" | "layers" | "footNote">;

export function ChartColumn({
  chart,
  quantity,
  size = "md",
  className,
}: {
  chart: ChartLike;
  /** "2×" badge on the name plate when an order line has more than one */
  quantity?: number;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const s = {
    sm: { w: "w-[150px]", title: "text-[11px]", alt: "text-[10px]", label: "text-[8.5px]", hero: "h-16", art: "w-[82%]" },
    md: { w: "w-[210px]", title: "text-sm", alt: "text-xs", label: "text-[11px]", hero: "h-24", art: "w-[84%]" },
    lg: { w: "w-[260px]", title: "text-base", alt: "text-sm", label: "text-[13px]", hero: "h-32", art: "w-[86%]" },
  }[size];

  return (
    <div className={cn("flex shrink-0 flex-col items-stretch", s.w, display.className, className)}>
      <div className="relative rounded-md bg-[#1d2242] px-2 py-1.5 text-center leading-tight shadow-md">
        {quantity && quantity > 1 ? (
          <span className="absolute -left-2 -top-2 rounded-full bg-amber-400 px-1.5 py-0.5 text-[11px] text-zinc-950 shadow">
            {quantity}×
          </span>
        ) : null}
        <p className={cn("uppercase text-white", s.title)}>{chart.title}</p>
        {chart.altTitle && (
          <p className={cn("mt-0.5 border-t border-dashed border-white/25 pt-0.5 uppercase text-[#f7c948]", s.alt)}>
            {chart.altTitle}
          </p>
        )}
      </div>

      {chart.heroImageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={chart.heroImageUrl}
          alt=""
          className={cn("mx-auto -mb-3 mt-1 w-[88%] object-contain drop-shadow-[0_6px_6px_rgba(0,0,0,0.35)]", s.hero)}
        />
      ) : (
        <div className="h-3" />
      )}

      <div className="relative rounded-[28px] bg-white px-1.5 pb-3 pt-3 shadow-[0_6px_0_rgba(0,0,0,0.18)]">
        {chart.layers.map((l, i) => (
          <Layer key={l.id ?? i} layer={l} labelCls={s.label} artCls={s.art} />
        ))}
      </div>

      {chart.footNote && (
        <p className={cn("mt-2 text-center uppercase text-white drop-shadow", s.label)}>{chart.footNote}</p>
      )}
    </div>
  );
}

function Layer({ layer, labelCls, artCls }: { layer: AssemblyLayer; labelCls: string; artCls: string }) {
  const bun = isBun(layer.kind) && !layer.imageUrl;
  return (
    <div className="flex flex-col items-center py-0.5">
      {layer.callout && (
        <p className={cn("mb-0.5 px-1 text-center uppercase leading-none text-[#d81b3a]", labelCls)} style={{ fontSize: "0.72em" }}>
          {layer.callout}
        </p>
      )}
      <div className={cn("relative", artCls)}>
        <LayerArt kind={layer.kind} color={layer.color} imageUrl={layer.imageUrl} className="block w-full" />
        {bun && layer.label && (
          <span
            className={cn(
              "absolute inset-x-0 text-center uppercase leading-none text-[#3b1a06]",
              labelCls,
              layer.kind === "bun_bottom" ? "top-[44%]" : layer.kind === "bun_upside_down" ? "top-[34%]" : "top-[52%]",
            )}
          >
            {layer.label}
          </span>
        )}
      </div>
      {!bun && layer.label && (
        <p className={cn("-mt-0.5 px-1 text-center uppercase leading-tight text-zinc-900", labelCls)}>{layer.label}</p>
      )}
    </div>
  );
}
