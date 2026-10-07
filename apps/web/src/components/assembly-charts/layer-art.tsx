"use client";

// Cartoon drawings for assembly-chart layers, in the style of a laminated
// kitchen build board: flat colours, soft shading, no outlines heavier than
// the food itself. Every drawing shares one 200×64 box so a column of them
// lines up whatever the mix. Pure SVG — prints crisp and costs no requests.

import { assemblyIngredient, type AssemblyLayerKind } from "@orderhub/shared";
import { ShapeArt } from "./shape-art";

const W = 200;
const H = 64;

/** Deterministic scatter so a drawing never changes between renders. */
function scatter(seed: number, n: number) {
  let s = seed;
  const r = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  return Array.from({ length: n }, () => ({ x: r(), y: r(), a: r() }));
}

function Bun({ flipped = false, flat = false }: { flipped?: boolean; flat?: boolean }) {
  if (flat) {
    // Heel: a low rounded slab with a toasted top face.
    return (
      <g>
        <ellipse cx={100} cy={46} rx={86} ry={13} fill="#d9811c" />
        <rect x={14} y={26} width={172} height={22} rx={11} fill="#f2a23a" />
        <ellipse cx={100} cy={28} rx={86} ry={9} fill="#f8c66b" />
        <ellipse cx={100} cy={28} rx={70} ry={5} fill="#fbd68b" opacity={0.7} />
      </g>
    );
  }
  const seeds = scatter(7, 16).filter((p) => p.y < 0.75);
  const dome = (
    <g>
      <ellipse cx={100} cy={54} rx={88} ry={8} fill="#f8c66b" />
      <path d="M12 54 C10 -8, 190 -8, 188 54 Z" fill="url(#bunGrad)" />
      <path d="M44 20 C66 8, 118 6, 148 14" stroke="#fff3d6" strokeWidth={5} strokeLinecap="round" fill="none" opacity={0.55} />
      {seeds.map((p, i) => (
        <ellipse
          key={i}
          cx={34 + p.x * 132}
          cy={12 + p.y * 30}
          rx={3.2}
          ry={1.7}
          fill="#fff8e6"
          transform={`rotate(${p.a * 140 - 70} ${34 + p.x * 132} ${12 + p.y * 30})`}
        />
      ))}
    </g>
  );
  return flipped ? <g transform={`translate(0 ${H}) scale(1 -1)`}>{dome}</g> : dome;
}

function Sauce({ color }: { color: string }) {
  const d = "M18 38 C34 18, 46 54, 62 34 S90 18, 104 36 S134 54, 148 32 S172 22, 184 34";
  return (
    <g>
      <path d={d} stroke="rgba(0,0,0,0.18)" strokeWidth={13} strokeLinecap="round" fill="none" transform="translate(0 3)" />
      <path d={d} stroke={color} strokeWidth={12} strokeLinecap="round" fill="none" />
      <path
        d="M24 33 C36 22, 44 40, 56 32"
        stroke="#ffffff"
        strokeWidth={2.5}
        strokeLinecap="round"
        fill="none"
        opacity={0.45}
      />
      <path d="M110 34 C122 46, 132 40, 142 30" stroke="#ffffff" strokeWidth={2.5} strokeLinecap="round" fill="none" opacity={0.45} />
    </g>
  );
}

function Onions() {
  const bits = scatter(11, 46);
  return (
    <g>
      {bits.map((p, i) => {
        const x = 18 + p.x * 160;
        const y = 16 + p.y * 30;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={9}
            height={8}
            rx={2}
            fill={i % 3 ? "#f6f3e6" : "#e9ecd2"}
            stroke="#cfc9a6"
            strokeWidth={1}
            transform={`rotate(${p.a * 60 - 30} ${x + 4} ${y + 4})`}
          />
        );
      })}
    </g>
  );
}

function Pickles() {
  return (
    <g>
      {[38, 79, 120, 161].map((x, i) => (
        <g key={i}>
          <ellipse cx={x} cy={34} rx={18} ry={11} fill="#7aa33a" />
          <ellipse cx={x} cy={33} rx={14} ry={8} fill="#b9d36a" />
          {scatter(i + 3, 6).map((p, j) => (
            <circle key={j} cx={x - 8 + p.x * 16} cy={29 + p.y * 8} r={1.3} fill="#e8f0b8" />
          ))}
        </g>
      ))}
    </g>
  );
}

function Patty({ cheese }: { cheese: boolean }) {
  const crumbs = scatter(21, 40);
  return (
    <g>
      <path
        d="M14 40 C10 26, 40 20, 70 22 C100 18, 140 20, 170 24 C192 28, 192 46, 176 52 C140 60, 70 60, 30 54 C18 52, 16 46, 14 40 Z"
        fill="#5b2f17"
      />
      <path d="M22 40 C40 30, 150 28, 182 38" stroke="#7b4424" strokeWidth={6} fill="none" opacity={0.6} />
      {crumbs.map((p, i) => (
        <circle key={i} cx={22 + p.x * 158} cy={30 + p.y * 24} r={1.4 + p.a * 1.6} fill={i % 2 ? "#3e1f0e" : "#8a5130"} />
      ))}
      {cheese && (
        <g>
          <path
            d="M30 30 C60 14, 140 12, 172 26 L166 34 C160 46, 150 36, 146 44 C140 56, 132 40, 126 38 C116 36, 112 54, 104 42 C96 32, 86 50, 78 40 C70 30, 62 48, 54 38 C46 30, 40 40, 30 30 Z"
            fill="#f7c22f"
          />
          <path d="M44 26 C74 16, 128 14, 160 24" stroke="#ffe27a" strokeWidth={4} strokeLinecap="round" fill="none" />
        </g>
      )}
    </g>
  );
}

function Cheese() {
  return (
    <g>
      <path
        d="M30 20 L170 14 L182 30 C176 40, 170 32, 164 42 C158 54, 150 38, 140 40 L60 44 C50 50, 46 38, 38 44 C30 48, 26 38, 22 36 Z"
        fill="#f7c22f"
      />
      <path d="M36 22 L166 16" stroke="#ffe58a" strokeWidth={4} strokeLinecap="round" />
    </g>
  );
}

function Tomato() {
  return (
    <g>
      <ellipse cx={100} cy={34} rx={84} ry={20} fill="#d4271f" />
      <ellipse cx={100} cy={33} rx={76} ry={16} fill="#ec4b3a" />
      {[-48, -16, 16, 48].map((dx, i) => (
        <g key={i}>
          <ellipse cx={100 + dx} cy={33} rx={13} ry={8} fill="#f7a08f" />
          {scatter(i + 40, 4).map((p, j) => (
            <ellipse key={j} cx={100 + dx - 6 + p.x * 12} cy={30 + p.y * 6} rx={1.8} ry={1.2} fill="#fff1c9" />
          ))}
        </g>
      ))}
    </g>
  );
}

function Lettuce() {
  return (
    <g>
      <path
        d="M12 36 C20 22, 30 46, 40 30 C50 18, 58 44, 70 28 C82 16, 90 44, 102 28 C114 16, 122 44, 134 28 C146 16, 154 44, 166 30 C176 20, 186 34, 190 40 C170 52, 40 54, 12 36 Z"
        fill="#5aa832"
      />
      <path d="M18 38 C60 30, 140 30, 184 40" stroke="#9bd35c" strokeWidth={4} fill="none" strokeLinecap="round" />
    </g>
  );
}

function Bacon() {
  const strip = (y: number) => (
    <g>
      <path
        d={`M16 ${y} C40 ${y - 12}, 60 ${y + 12}, 90 ${y} S140 ${y - 12}, 184 ${y}`}
        stroke="#b8322b"
        strokeWidth={13}
        strokeLinecap="round"
        fill="none"
      />
      <path
        d={`M18 ${y} C40 ${y - 12}, 60 ${y + 12}, 90 ${y} S140 ${y - 12}, 182 ${y}`}
        stroke="#f2b4a0"
        strokeWidth={3}
        strokeLinecap="round"
        fill="none"
      />
    </g>
  );
  return (
    <g>
      {strip(24)}
      {strip(44)}
    </g>
  );
}

function Chicken() {
  const bumps = scatter(33, 34);
  return (
    <g>
      <path
        d="M16 40 C14 22, 50 12, 92 14 C140 12, 182 18, 186 36 C188 52, 150 58, 100 56 C56 58, 18 54, 16 40 Z"
        fill="#c97f2c"
      />
      <path
        d="M24 36 C28 22, 70 18, 100 20 C140 18, 176 24, 178 36 C150 30, 60 30, 24 36 Z"
        fill="#e3a64c"
      />
      {bumps.map((p, i) => (
        <circle key={i} cx={24 + p.x * 152} cy={22 + p.y * 30} r={1.6 + p.a * 2} fill={i % 2 ? "#9a5a1a" : "#f0c06a"} />
      ))}
    </g>
  );
}

function Jalapeno() {
  const rings = scatter(51, 9);
  return (
    <g>
      {rings.map((p, i) => {
        const x = 26 + (i / 8) * 148 + (p.x - 0.5) * 8;
        const y = 30 + (p.y - 0.5) * 14;
        return (
          <g key={i}>
            <circle cx={x} cy={y} r={11} fill="#3f8d2c" />
            <circle cx={x} cy={y} r={7} fill="#cfe8a0" />
            <circle cx={x} cy={y} r={2.5} fill="#f4f1c8" />
          </g>
        );
      })}
    </g>
  );
}

function OnionRings() {
  return (
    <g>
      {[50, 100, 150].map((x, i) => (
        <g key={i}>
          <ellipse cx={x} cy={34} rx={24} ry={16} fill="none" stroke="#c9852f" strokeWidth={10} />
          <ellipse cx={x} cy={33} rx={24} ry={16} fill="none" stroke="#eab45c" strokeWidth={4} />
        </g>
      ))}
    </g>
  );
}

function Egg() {
  return (
    <g>
      <path
        d="M24 36 C20 20, 60 12, 96 16 C140 12, 182 20, 178 36 C176 52, 130 56, 100 54 C60 58, 26 52, 24 36 Z"
        fill="#fbfaf4"
        stroke="#d9d4c3"
        strokeWidth={2.5}
      />
      <path d="M40 44 C70 52, 140 52, 168 42" stroke="#e8c48a" strokeWidth={3} fill="none" opacity={0.6} />
      <circle cx={102} cy={34} r={15} fill="#f5a623" />
      <circle cx={97} cy={30} r={4} fill="#ffd27a" />
    </g>
  );
}

function Mushrooms() {
  return (
    <g>
      {[40, 80, 120, 160].map((x, i) => (
        <g key={i} transform={`rotate(${(i % 2 ? 1 : -1) * 8} ${x} 34)`}>
          <path d={`M${x - 18} 34 C${x - 18} 16, ${x + 18} 16, ${x + 18} 34 Z`} fill="#8b5a3c" />
          <rect x={x - 5} y={32} width={10} height={14} rx={4} fill="#e9d6bf" />
          <path d={`M${x - 16} 34 L${x + 16} 34`} stroke="#d8c0a3" strokeWidth={3} />
        </g>
      ))}
    </g>
  );
}

export function LayerArt({
  kind,
  color,
  imageUrl,
  className,
}: {
  kind: AssemblyLayerKind;
  color?: string | null;
  imageUrl?: string | null;
  className?: string;
}) {
  if (imageUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={imageUrl} alt="" className={className} style={{ aspectRatio: `${W} / ${H}`, objectFit: "contain" }} />;
  }
  // Library ingredients draw from their shape recipe; the original 18 keep
  // their hand-drawn art below. `color` (sauces) overrides the main colour.
  const ing = assemblyIngredient(kind);
  if (ing && ing.shape !== "legacy") {
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className={className} aria-hidden>
        <ShapeArt shape={ing.shape} c1={color || ing.colors[0]} c2={ing.colors[1]} seedKey={ing.key} />
      </svg>
    );
  }
  let art: React.ReactNode;
  switch (kind) {
    case "bun_top":
      art = <Bun />;
      break;
    case "bun_upside_down":
      art = <Bun flipped />;
      break;
    case "bun_bottom":
      art = <Bun flat />;
      break;
    case "sauce":
      art = <Sauce color={color || "#f39a2b"} />;
      break;
    case "onions":
      art = <Onions />;
      break;
    case "pickles":
      art = <Pickles />;
      break;
    case "patty_cheese":
      art = <Patty cheese />;
      break;
    case "patty":
      art = <Patty cheese={false} />;
      break;
    case "cheese":
      art = <Cheese />;
      break;
    case "tomato":
      art = <Tomato />;
      break;
    case "lettuce":
      art = <Lettuce />;
      break;
    case "bacon":
      art = <Bacon />;
      break;
    case "chicken":
      art = <Chicken />;
      break;
    case "jalapeno":
      art = <Jalapeno />;
      break;
    case "onion_rings":
      art = <OnionRings />;
      break;
    case "egg":
      art = <Egg />;
      break;
    case "mushrooms":
      art = <Mushrooms />;
      break;
    default:
      art = (
        <g>
          <rect x={20} y={14} width={160} height={36} rx={10} fill="#f4f4f5" stroke="#d4d4d8" strokeDasharray="5 4" />
        </g>
      );
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={className} aria-hidden>
      <defs>
        <linearGradient id="bunGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f6b649" />
          <stop offset="100%" stopColor="#e3871f" />
        </linearGradient>
      </defs>
      {art}
    </svg>
  );
}

/** Palette name and default label for an ingredient key. */
export function ingredientName(kind: AssemblyLayerKind): string {
  return assemblyIngredient(kind)?.name ?? kind;
}
export function ingredientLabel(kind: AssemblyLayerKind): string {
  const ing = assemblyIngredient(kind);
  return ing ? (ing.label ?? ing.name) : "";
}

/** Buns carry their label printed ON the bread, like the board. */
export const isBun = (k: AssemblyLayerKind) => k === "bun_top" || k === "bun_bottom" || k === "bun_upside_down";
