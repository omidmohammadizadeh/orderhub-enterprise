"use client";

// The virtual-brand menu deck in the Fiesta Mexica template. Pages are drawn
// at a fixed 1920×1080 (the PDF page size) and scaled on screen with CSS zoom;
// printing prints them 1:1, one page per sheet.

import { useEffect, useRef, useState } from "react";
import { Bungee, Luckiest_Guy, Open_Sans } from "next/font/google";
import {
  buildPages,
  buildSections,
  type OptBlock,
  type PItem,
  type PPage,
  type PresentationBrand,
  type PresentationIcon,
} from "@/lib/menu-presentations";
import type { PresentationMenu } from "@/lib/api/assembly-charts.client";

const word = Bungee({ weight: "400", subsets: ["latin"], variable: "--mp-word", display: "block" });
const head = Luckiest_Guy({ weight: "400", subsets: ["latin"], variable: "--mp-head", display: "block" });
const body = Open_Sans({ weight: ["400", "600"], subsets: ["latin"], variable: "--mp-body", display: "block" });
export const PRESENTATION_FONTS = `${word.variable} ${head.variable} ${body.variable}`;

const GREY = "#d9d3d2";
const ORANGE = "#ff8a2a";
const GAP = 28;

const CSS = `
.mp { font-family: var(--mp-body), sans-serif; color: #111; }
.mp * { box-sizing: border-box; margin: 0; padding: 0; }
.mp .page { width: 1920px; height: 1080px; position: relative; overflow: hidden; background: #fff; padding: 0 60px; }
.mp .cover { background: ${GREY}; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.mp .cv-logo { position: relative; width: 1200px; height: 760px; display: flex; align-items: center; justify-content: center; }
.mp .sun { position: absolute; width: 720px; height: 720px; border-radius: 50%; background: ${ORANGE}; left: 50%; top: 50%; transform: translate(-50%, -48%); }
.mp .word { position: relative; font-family: var(--mp-word), sans-serif; line-height: .92; color: #1f1f1f; text-align: center; letter-spacing: -4px; transform: rotate(-3deg); }
.mp .icon-big { position: absolute; right: 70px; top: -30px; width: 230px; height: 230px; transform: rotate(14deg); }
.mp .icon-big svg, .mp .mini .ic svg { width: 100%; height: 100%; }
.mp .cv-sub { font-family: var(--mp-head), sans-serif; font-size: 58px; color: #1f1f1f; margin-top: 10px; letter-spacing: 3px; white-space: nowrap; text-transform: uppercase; }
.mp .mini { position: absolute; left: 0; top: 0; width: 170px; height: 160px; background: ${GREY}; display: flex; align-items: center; justify-content: center; }
.mp .mini::before { content: ""; position: absolute; width: 112px; height: 112px; border-radius: 50%; background: ${ORANGE}; left: 30px; top: 30px; }
.mp .mini span { position: relative; z-index: 1; font-family: var(--mp-word), sans-serif; line-height: .95; color: #1f1f1f; text-align: center; }
.mp .mini .ic { position: absolute; right: 6px; top: 4px; width: 40px; height: 40px; transform: rotate(14deg); }
.mp .pill { position: absolute; left: 50%; top: 22px; transform: translateX(-50%); background: #ffee00; border-radius: 34px; padding: 18px 54px 10px; font-family: var(--mp-head), sans-serif; font-size: 64px; line-height: 1; white-space: nowrap; }
.mp .price { font-family: var(--mp-head), sans-serif; color: #ff3b3b; white-space: nowrap; }
.mp .rows { position: absolute; left: 200px; right: 60px; top: 150px; display: grid; grid-template-columns: 1fr 1fr; gap: 26px 60px; align-content: start; }
.mp .row { display: flex; align-items: center; gap: 26px; min-height: 0; }
.mp .rph { flex: 0 0 auto; width: 200px; border-radius: 22px; }
.mp .rt { flex: 1; min-width: 0; }
.mp .rt h3 { font-family: var(--mp-head), sans-serif; font-size: 40px; line-height: 1.05; font-weight: normal; }
.mp .rt p { font-size: 21px; line-height: 1.35; margin-top: 6px; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.mp .row .price { font-size: 58px; }
.mp .grid { position: absolute; left: 200px; right: 60px; top: 160px; display: grid; gap: 28px 30px; align-content: start; }
.mp .gcard { position: relative; display: flex; flex-direction: column; align-items: center; text-align: center; min-height: 0; }
.mp .gph { width: 100%; border-radius: 22px; }
.mp .gcard h3 { font-family: var(--mp-head), sans-serif; font-weight: normal; font-size: 30px; line-height: 1.05; margin-top: 12px; }
.mp .gd { font-size: 17px; line-height: 1.3; margin-top: 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.mp .gcard .price { font-size: 44px; margin-top: 4px; }
.mp .ph { position: relative; overflow: hidden; background: #eee; }
.mp .ph img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.mp .nophoto { background: #ffee00; display: flex; align-items: center; justify-content: center; }
.mp .nophoto svg { height: 62%; width: auto; }
.mp .opts { position: absolute; left: 60px; right: 60px; bottom: 26px; height: 210px; display: grid; gap: 40px; border-top: 4px solid #ffee00; padding-top: 18px; }
.mp .og h4 { font-size: 34px; font-weight: 600; line-height: 1.1; }
.mp .og p { font-size: 21px; line-height: 1.4; margin-top: 6px; display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden; }
.mp .opts.big { top: 190px; bottom: 60px; height: auto; border-top: none; grid-template-columns: repeat(3, 1fr); align-content: start; gap: 50px 60px; }
.mp .opts.big h4 { font-size: 42px; }
.mp .opts.big p { font-size: 27px; -webkit-line-clamp: 8; }
`;

export function PresentationStyles() {
  return <style>{CSS}</style>;
}

// Flat fills, thick dark outline — the Fiesta Mexica chilli's style.
const O = { stroke: "#1f1f1f", strokeWidth: 4, strokeLinejoin: "round" as const };
export function BrandIcon({ icon }: { icon: PresentationIcon }) {
  switch (icon) {
    case "chilli":
      return (
        <svg viewBox="0 0 60 120" aria-hidden>
          <path {...O} fill="#e8352b" d="M30 18 C24 6 30 0 38 2 L36 8 C32 8 32 12 34 16 C46 22 50 40 46 62 C42 86 30 108 14 116 C8 118 6 112 10 106 C22 88 24 64 22 44 C21 32 24 22 30 18 Z" />
          <path {...O} fill="#3aa845" d="M28 20 C30 12 38 10 44 14 C40 16 36 18 34 22 Z" />
        </svg>
      );
    case "burger":
      return (
        <svg viewBox="0 0 120 110" aria-hidden>
          <path {...O} fill="#f2a33a" d="M10 48 C12 18 108 18 110 48 Z" />
          <circle cx="40" cy="32" r="2.6" fill="#fff4cf" />
          <circle cx="62" cy="26" r="2.6" fill="#fff4cf" />
          <circle cx="82" cy="34" r="2.6" fill="#fff4cf" />
          <path {...O} fill="#3aa845" d="M6 54 L18 48 L30 56 L42 48 L54 56 L66 48 L78 56 L90 48 L102 56 L114 50 L112 60 L8 60 Z" />
          <path {...O} fill="#ffd21f" d="M10 60 L110 60 L100 72 L90 64 L20 64 Z" />
          <rect {...O} fill="#6b3a1f" x="8" y="64" width="104" height="16" rx="8" />
          <path {...O} fill="#f2a33a" d="M10 84 L110 84 C110 98 100 104 90 104 L30 104 C20 104 10 98 10 84 Z" />
        </svg>
      );
    case "drumstick":
      return (
        <svg viewBox="0 0 120 120" aria-hidden>
          <path {...O} fill="#f2f0ea" d="M30 84 L14 100 C6 96 4 104 10 108 C8 116 18 118 20 110 L36 94 Z" />
          <path {...O} fill="#d9822b" d="M38 92 C24 80 28 52 48 32 C66 14 98 10 108 22 C118 34 108 64 88 80 C70 94 50 102 38 92 Z" />
          <path fill="none" stroke="#b5651d" strokeWidth="4" strokeLinecap="round" d="M60 40 L66 46 M80 34 L84 42 M72 60 L78 64 M54 66 L60 70" />
        </svg>
      );
    case "pizza":
      return (
        <svg viewBox="0 0 120 130" aria-hidden>
          <path {...O} fill="#ffd34d" d="M14 20 L106 20 L60 124 Z" />
          <path {...O} fill="#e8a54b" d="M8 10 C40 2 80 2 112 10 L106 24 C76 16 44 16 14 24 Z" />
          <circle {...O} fill="#e8352b" cx="48" cy="42" r="9" />
          <circle {...O} fill="#e8352b" cx="74" cy="50" r="8" />
          <circle {...O} fill="#e8352b" cx="58" cy="78" r="7" />
          <path fill="#3aa845" d="M36 34 l6 3 -6 3 z M84 36 l5 4 -6 2 z M66 66 l5 3 -5 3 z" />
        </svg>
      );
    case "gyro":
      return (
        <svg viewBox="0 0 120 130" aria-hidden>
          <path {...O} fill="#f4e2b8" d="M14 30 C40 18 80 18 106 30 L66 124 C62 128 58 128 54 124 Z" />
          <path {...O} fill="#3aa845" d="M18 28 C30 10 44 22 52 12 C60 24 74 8 84 20 C92 10 104 20 102 30 C80 22 40 22 18 28 Z" />
          <path {...O} fill="#e8352b" d="M30 28 C40 20 50 30 58 24 C66 30 78 22 90 28 L86 36 C70 32 50 32 34 36 Z" />
          <path fill="none" stroke="#c9a46a" strokeWidth="4" strokeLinecap="round" d="M34 50 L84 50 M42 72 L78 72 M50 94 L70 94" />
        </svg>
      );
  }
}

function sizes(brand: PresentationBrand) {
  const longest = Math.max(...brand.lines.map((l) => l.length));
  return {
    word: Math.min(215, Math.floor(1150 / (0.74 * longest)), Math.floor(540 / brand.lines.length)),
    mini: Math.min(27, Math.floor(118 / (0.74 * longest))),
  };
}

function WordMark({ brand }: { brand: PresentationBrand }) {
  return (
    <>
      {brand.lines.map((l, i) => (
        <span key={i}>
          {i > 0 && <br />}
          {l}
        </span>
      ))}
    </>
  );
}

export function CoverPage({ brand }: { brand: PresentationBrand }) {
  const s = sizes(brand);
  return (
    <section className="page cover">
      <div className="cv-logo">
        <div className="sun" />
        <div className="word" style={{ fontSize: s.word }}>
          <WordMark brand={brand} />
        </div>
        <div className="icon-big">
          <BrandIcon icon={brand.icon} />
        </div>
      </div>
      <div className="cv-sub">{brand.tagline.replace(/ • /g, "  •  ")}</div>
    </section>
  );
}

function Mini({ brand }: { brand: PresentationBrand }) {
  return (
    <div className="mini">
      <span style={{ fontSize: sizes(brand).mini }}>
        <WordMark brand={brand} />
      </span>
      <i className="ic">
        <BrandIcon icon={brand.icon} />
      </i>
    </div>
  );
}

function Photo({ item, cls, h, icon }: { item: PItem; cls: string; h: number; icon: PresentationIcon }) {
  const [failed, setFailed] = useState(false);
  if (!item.img || failed)
    return (
      <div className={`${cls} ph nophoto`} style={{ height: h }}>
        <BrandIcon icon={icon} />
      </div>
    );
  return (
    <div className={`${cls} ph`} style={{ height: h }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={item.img} alt="" loading="eager" onError={() => setFailed(true)} />
    </div>
  );
}

function Options({ blocks, big }: { blocks: OptBlock[]; big?: boolean }) {
  return (
    <div
      className={big ? "opts big" : "opts"}
      style={big ? undefined : { gridTemplateColumns: `repeat(${Math.min(blocks.length, 4)}, 1fr)` }}
    >
      {blocks.map((b) => (
        <div key={b.title} className="og">
          <h4>{b.title}:</h4>
          <p>{b.text}</p>
        </div>
      ))}
    </div>
  );
}

function ItemsPage({ brand, page }: { brand: PresentationBrand; page: Extract<PPage, { kind: "items" }> }) {
  const area = page.foot.length ? 650 : 880;
  const n = page.items.length;
  let body: React.ReactNode;
  if (page.grid) {
    const cols = n <= 5 ? n : Math.ceil(n / 2);
    const rows = Math.ceil(n / cols);
    const rowh = Math.min(470, (area - GAP * (rows - 1)) / rows);
    const hasDesc = page.items.some((i) => i.desc);
    const ph = Math.max(120, rowh - (120 + (hasDesc ? 52 : 0)));
    const colw = Math.min(400, (1660 - GAP * (cols - 1)) / cols, ph * 1.35);
    body = (
      <div
        className="grid"
        style={{ gridTemplateColumns: `repeat(${cols}, ${colw}px)`, gridTemplateRows: `repeat(${rows}, ${rowh}px)`, height: area }}
      >
        {page.items.map((it) => (
          <div key={it.name} className="gcard">
            <Photo item={it} cls="gph" h={ph} icon={brand.icon} />
            <h3>{it.name}</h3>
            {hasDesc && <p className="gd">{it.desc}</p>}
            <div className="price">{it.price}</div>
          </div>
        ))}
      </div>
    );
  } else {
    const rows = Math.ceil(n / 2);
    const rowh = Math.min(250, (area - GAP * (rows - 1)) / rows);
    const ph = Math.min(215, rowh - 8);
    body = (
      <div className="rows" style={{ gridTemplateRows: `repeat(${rows}, ${rowh}px)`, height: area }}>
        {page.items.map((it) => (
          <div key={it.name} className="row">
            <Photo item={it} cls="rph" h={ph} icon={brand.icon} />
            <div className="rt">
              <h3>{it.name}</h3>
              {it.desc && <p>{it.desc}</p>}
            </div>
            <div className="price">{it.price}</div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <section className="page">
      <Mini brand={brand} />
      <div className="pill">{page.title}</div>
      {body}
      {page.foot.length > 0 && <Options blocks={page.foot} />}
    </section>
  );
}

/** Every page of a brand's deck, at 1920×1080. */
export function Deck({ brand, menu, renderPage }: { brand: PresentationBrand; menu: PresentationMenu; renderPage: (node: React.ReactNode, i: number) => React.ReactNode }) {
  const pages = buildPages(buildSections(menu));
  return (
    <>
      {renderPage(<CoverPage brand={brand} />, 0)}
      {pages.map((p, i) =>
        renderPage(
          p.kind === "items" ? (
            <ItemsPage brand={brand} page={p} />
          ) : (
            <section className="page">
              <Mini brand={brand} />
              <div className="pill">{p.title}</div>
              <Options blocks={p.opts} big />
            </section>
          ),
          i + 1,
        ),
      )}
    </>
  );
}

/** The cover shrunk to whatever width its box has — Kitchen training's card thumbnail. */
export function CoverThumb({ brand }: { brand: PresentationBrand }) {
  const box = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(0.2);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setZoom(el.clientWidth / 1920));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} className={`mp ${PRESENTATION_FONTS} aspect-video w-full overflow-hidden`} style={{ background: GREY }}>
      <PresentationStyles />
      <div style={{ zoom }}>
        <CoverPage brand={brand} />
      </div>
    </div>
  );
}
