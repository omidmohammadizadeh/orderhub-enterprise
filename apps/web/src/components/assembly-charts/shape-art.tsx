// Parametric drawings for the ingredient library: each shape is one SVG
// recipe in a 200×64 box, coloured per ingredient (main + accent). A few
// dozen shapes cover a few hundred ingredients in the same flat, laminated-
// poster style as the hand-drawn originals in layer-art.tsx.

import type { IngredientShape } from "@orderhub/shared";

/** Deterministic scatter so a drawing never changes between renders. */
function scatter(seed: number, n: number) {
  let s = seed;
  const r = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  return Array.from({ length: n }, () => ({ x: r(), y: r(), a: r() }));
}

/** Small stable number from a string, so two ingredients with one shape differ. */
function hash(str: string) {
  let h = 7;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 9973;
  return h;
}

const SHADOW = "rgba(0,0,0,0.16)";

export function ShapeArt({ shape, c1, c2, seedKey }: { shape: IngredientShape; c1: string; c2: string; seedKey: string }) {
  const seed = hash(seedKey) + 3;
  switch (shape) {
    case "squiggle": {
      const d = "M18 38 C34 18, 46 54, 62 34 S90 18, 104 36 S134 54, 148 32 S172 22, 184 34";
      return (
        <g>
          <path d={d} stroke={SHADOW} strokeWidth={13} strokeLinecap="round" fill="none" transform="translate(0 3)" />
          <path d={d} stroke={c1} strokeWidth={12} strokeLinecap="round" fill="none" />
          <path d="M24 33 C36 22, 44 40, 56 32" stroke="#fff" strokeWidth={2.5} strokeLinecap="round" fill="none" opacity={0.45} />
          <path d="M110 34 C122 46, 132 40, 142 30" stroke="#fff" strokeWidth={2.5} strokeLinecap="round" fill="none" opacity={0.45} />
        </g>
      );
    }
    case "drizzle":
      return (
        <g>
          {[0, 1].map((k) => (
            <path
              key={k}
              d={`M16 ${26 + k * 14} L40 ${18 + k * 14} L64 ${30 + k * 14} L88 ${18 + k * 14} L112 ${30 + k * 14} L136 ${18 + k * 14} L160 ${30 + k * 14} L184 ${22 + k * 14}`}
              stroke={c1}
              strokeWidth={4.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          ))}
        </g>
      );
    case "dollop": {
      const blobs = [
        [70, 38, 30, 16],
        [104, 32, 34, 20],
        [136, 38, 28, 15],
        [100, 44, 52, 14],
      ];
      return (
        <g>
          <ellipse cx={102} cy={50} rx={70} ry={8} fill={SHADOW} />
          {blobs.map(([cx, cy, rx, ry], i) => (
            <ellipse key={i} cx={cx} cy={cy} rx={rx} ry={ry} fill={c1} />
          ))}
          <path d="M80 30 C92 22, 112 20, 124 26" stroke={c2} strokeWidth={5} strokeLinecap="round" fill="none" opacity={0.85} />
          <ellipse cx={92} cy={28} rx={10} ry={4} fill="#fff" opacity={0.35} />
        </g>
      );
    }
    case "diced":
      return (
        <g>
          {scatter(seed, 44).map((p, i) => {
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
                fill={i % 3 ? c1 : c2}
                stroke={SHADOW}
                strokeWidth={0.8}
                transform={`rotate(${p.a * 60 - 30} ${x + 4} ${y + 4})`}
              />
            );
          })}
        </g>
      );
    case "slices":
      return (
        <g>
          {[34, 67, 100, 133, 166].map((x, i) => (
            <g key={i}>
              <circle cx={x} cy={34} r={15} fill={c2} />
              <circle cx={x} cy={33} r={12.5} fill={c1} />
              {scatter(seed + i, 5).map((p, j) => (
                <circle key={j} cx={x - 7 + p.x * 14} cy={27 + p.y * 12} r={1.4} fill={c2} opacity={0.8} />
              ))}
            </g>
          ))}
        </g>
      );
    case "rings":
      return (
        <g>
          {scatter(seed, 9).map((p, i) => {
            const x = 26 + (i / 8) * 148 + (p.x - 0.5) * 10;
            const y = 32 + (p.y - 0.5) * 14;
            return (
              <g key={i}>
                <circle cx={x} cy={y} r={11} fill="none" stroke={c1} strokeWidth={5} />
                <circle cx={x} cy={y} r={11} fill="none" stroke={c2} strokeWidth={1.5} opacity={0.8} />
              </g>
            );
          })}
        </g>
      );
    case "shreds":
      return (
        <g>
          {scatter(seed, 60).map((p, i) => {
            const x = 16 + p.x * 166;
            const y = 16 + p.y * 32;
            const len = 10 + p.a * 12;
            return (
              <path
                key={i}
                d={`M${x} ${y} q${len / 2} ${-4 + p.a * 8} ${len} ${-2 + p.a * 4}`}
                stroke={i % 3 ? c1 : c2}
                strokeWidth={2.6}
                strokeLinecap="round"
                fill="none"
              />
            );
          })}
        </g>
      );
    case "leaves":
      return (
        <g>
          {scatter(seed, 16).map((p, i) => {
            const x = 22 + p.x * 156;
            const y = 22 + p.y * 22;
            const rot = p.a * 180 - 90;
            return (
              <g key={i} transform={`rotate(${rot} ${x} ${y})`}>
                <path d={`M${x - 10} ${y} Q${x} ${y - 9} ${x + 10} ${y} Q${x} ${y + 9} ${x - 10} ${y} Z`} fill={i % 4 ? c1 : c2} />
                <path d={`M${x - 8} ${y} L${x + 8} ${y}`} stroke="#fff" strokeWidth={0.8} opacity={0.5} />
              </g>
            );
          })}
        </g>
      );
    case "slab":
      return (
        <g>
          <ellipse cx={100} cy={50} rx={82} ry={8} fill={SHADOW} />
          <rect x={20} y={18} width={160} height={30} rx={14} fill={c1} />
          <rect x={26} y={20} width={148} height={8} rx={4} fill="#fff" opacity={0.18} />
          {[50, 80, 110, 140].map((x) => (
            <path key={x} d={`M${x} 22 L${x + 14} 44`} stroke={c2} strokeWidth={4} strokeLinecap="round" opacity={0.75} />
          ))}
        </g>
      );
    case "strips":
      return (
        <g>
          {scatter(seed, 9).map((p, i) => {
            const x = 18 + p.x * 140;
            const y = 18 + p.y * 28;
            return (
              <path
                key={i}
                d={`M${x} ${y} c8 -6, 16 6, 24 0 s16 -6, 22 0`}
                stroke={i % 3 ? c1 : c2}
                strokeWidth={7}
                strokeLinecap="round"
                fill="none"
              />
            );
          })}
        </g>
      );
    case "flatbread":
      return (
        <g>
          <ellipse cx={100} cy={38} rx={88} ry={20} fill={SHADOW} />
          <ellipse cx={100} cy={34} rx={88} ry={20} fill={c1} />
          {scatter(seed, 14).map((p, i) => (
            <ellipse key={i} cx={30 + p.x * 140} cy={24 + p.y * 20} rx={4 + p.a * 4} ry={2 + p.a * 2} fill={c2} opacity={0.6} />
          ))}
        </g>
      );
    case "pizza_base":
      return (
        <g>
          <ellipse cx={100} cy={38} rx={90} ry={22} fill={SHADOW} />
          <ellipse cx={100} cy={34} rx={90} ry={22} fill={c1} />
          <ellipse cx={100} cy={33} rx={76} ry={16} fill={c2} />
          {c1 === c2 && <ellipse cx={100} cy={33} rx={76} ry={16} fill="#f6e2b8" />}
        </g>
      );
    case "chunks":
      return (
        <g>
          {scatter(seed, 18).map((p, i) => {
            const x = 20 + p.x * 160;
            const y = 18 + p.y * 28;
            const w = 9 + p.a * 7;
            return (
              <path
                key={i}
                d={`M${x} ${y} l${w} -3 l4 ${w * 0.7} l-${w * 0.8} 5 Z`}
                fill={i % 3 ? c1 : c2}
                stroke={SHADOW}
                strokeWidth={0.8}
                strokeLinejoin="round"
              />
            );
          })}
        </g>
      );
    case "balls":
      return (
        <g>
          {[38, 70, 102, 134, 166].map((x, i) => (
            <g key={i}>
              <ellipse cx={x} cy={46} rx={14} ry={4} fill={SHADOW} />
              <circle cx={x} cy={34} r={14} fill={c1} />
              <circle cx={x - 4} cy={29} r={5} fill={c2} opacity={0.75} />
            </g>
          ))}
        </g>
      );
    case "sticks":
      return (
        <g>
          {scatter(seed, 8).map((p, i) => {
            const x = 22 + i * 21;
            const rot = -20 + p.a * 40;
            return (
              <g key={i} transform={`rotate(${rot} ${x + 6} 32)`}>
                <rect x={x} y={14} width={12} height={36} rx={5} fill={c1} />
                <rect x={x + 2} y={16} width={3} height={30} rx={1.5} fill={c2} opacity={0.8} />
              </g>
            );
          })}
        </g>
      );
    case "grains":
      return (
        <g>
          <ellipse cx={100} cy={46} rx={78} ry={9} fill={SHADOW} />
          {scatter(seed, 140).map((p, i) => {
            const x = 24 + p.x * 152;
            const y = 22 + p.y * 24 - Math.sin(p.x * Math.PI) * 8;
            return (
              <ellipse
                key={i}
                cx={x}
                cy={y}
                rx={3}
                ry={1.5}
                fill={i % 4 ? c1 : c2}
                transform={`rotate(${p.a * 180} ${x} ${y})`}
              />
            );
          })}
        </g>
      );
    case "beans":
      return (
        <g>
          {scatter(seed, 40).map((p, i) => {
            const x = 22 + p.x * 156;
            const y = 18 + p.y * 28;
            return (
              <ellipse
                key={i}
                cx={x}
                cy={y}
                rx={6}
                ry={3.8}
                fill={i % 3 ? c1 : c2}
                transform={`rotate(${p.a * 180} ${x} ${y})`}
              />
            );
          })}
        </g>
      );
    case "wedge":
      return (
        <g>
          <path d="M40 50 L160 50 L150 18 Z" fill={SHADOW} transform="translate(0 3)" />
          <path d="M40 50 L160 50 L150 18 Z" fill={c1} />
          <path d="M40 50 L160 50 L157 40 L44 46 Z" fill={c2} />
          <path d="M150 18 L160 50" stroke={c2} strokeWidth={4} />
        </g>
      );
    case "crumbs":
      return (
        <g>
          {scatter(seed, 90).map((p, i) => (
            <circle key={i} cx={20 + p.x * 160} cy={18 + p.y * 30} r={1.2 + p.a * 1.8} fill={i % 3 ? c1 : c2} />
          ))}
        </g>
      );
    case "wings":
      return (
        <g>
          {[46, 100, 154].map((x, i) => (
            <g key={i} transform={`rotate(${i % 2 ? 12 : -12} ${x} 34)`}>
              <ellipse cx={x} cy={44} rx={22} ry={4} fill={SHADOW} />
              <path d={`M${x - 22} 34 C${x - 22} 16, ${x + 14} 14, ${x + 18} 30 C${x + 20} 44, ${x - 16} 48, ${x - 22} 34 Z`} fill={c1} />
              <path d={`M${x - 12} 28 C${x - 4} 22, ${x + 8} 22, ${x + 12} 30`} stroke={c2} strokeWidth={4} strokeLinecap="round" fill="none" />
            </g>
          ))}
        </g>
      );
    case "nuggets":
      return (
        <g>
          {scatter(seed, 7).map((p, i) => {
            const x = 30 + i * 24;
            const y = 32 + (p.y - 0.5) * 10;
            return (
              <g key={i}>
                <path
                  d={`M${x - 11} ${y} C${x - 12} ${y - 10}, ${x + 8} ${y - 13}, ${x + 11} ${y - 3} C${x + 13} ${y + 8}, ${x - 8} ${y + 11}, ${x - 11} ${y} Z`}
                  fill={c1}
                />
                {scatter(seed + i, 4).map((q, j) => (
                  <circle key={j} cx={x - 6 + q.x * 12} cy={y - 5 + q.y * 9} r={1.4} fill={c2} />
                ))}
              </g>
            );
          })}
        </g>
      );
    case "wrap":
      return (
        <g>
          <rect x={22} y={20} width={156} height={30} rx={15} fill={SHADOW} transform="translate(0 3)" />
          <rect x={22} y={18} width={156} height={30} rx={15} fill={c1} />
          {[60, 100, 140].map((x) => (
            <path key={x} d={`M${x} 20 C${x - 6} 30, ${x - 6} 38, ${x} 46`} stroke={c2} strokeWidth={2.5} fill="none" />
          ))}
        </g>
      );
    case "chips":
      return (
        <g>
          {scatter(seed, 10).map((p, i) => {
            const x = 24 + i * 16;
            const y = 22 + p.y * 16;
            return (
              <path
                key={i}
                d={`M${x} ${y + 18} L${x + 14} ${y} L${x + 24} ${y + 20} Z`}
                fill={i % 2 ? c1 : c2}
                stroke={SHADOW}
                strokeWidth={0.8}
                transform={`rotate(${p.a * 50 - 25} ${x + 12} ${y + 10})`}
              />
            );
          })}
        </g>
      );
    case "taco":
      return (
        <g>
          <path d="M28 50 C28 10, 172 10, 172 50 Z" fill={SHADOW} transform="translate(0 3)" />
          <path d="M28 50 C28 10, 172 10, 172 50 Z" fill={c1} />
          <path d="M40 50 C44 22, 156 22, 160 50" stroke={c2} strokeWidth={3} fill="none" />
        </g>
      );
    case "sheet":
      return (
        <g>
          <path
            d="M30 20 L170 14 L182 30 C176 40, 170 32, 164 42 C158 54, 150 38, 140 40 L60 44 C50 50, 46 38, 38 44 C30 48, 26 38, 22 36 Z"
            fill={c1}
          />
          <path d="M36 22 L166 16" stroke={c2} strokeWidth={4} strokeLinecap="round" />
        </g>
      );
    case "curly":
      return (
        <g>
          {[30, 70, 110, 150].map((x, i) => (
            <path
              key={i}
              d={`M${x} 46 c-8 -6, -2 -16, 6 -12 s6 -14, 14 -8 s4 -14, 12 -8`}
              stroke={i % 2 ? c1 : c2}
              strokeWidth={6}
              strokeLinecap="round"
              fill="none"
            />
          ))}
        </g>
      );
    // ── Packaging ──────────────────────────────────────────────────────────
    case "box_clam":
      return (
        <g>
          <path d="M40 52 L160 52 L168 30 L32 30 Z" fill={c1} stroke={c2} strokeWidth={2} />
          <path d="M36 30 L52 12 L150 12 L166 30 Z" fill={c1} stroke={c2} strokeWidth={2} />
          <path d="M60 30 L140 30" stroke={c2} strokeWidth={2} />
          <rect x={92} y={26} width={16} height={6} rx={2} fill={c2} />
        </g>
      );
    case "box_burger":
      return (
        <g>
          <path d="M44 54 L156 54 L162 28 L38 28 Z" fill={c1} stroke={c2} strokeWidth={2} />
          <path d="M38 28 L60 10 L140 10 L162 28 Z" fill={c2} opacity={0.85} />
          <circle cx={100} cy={42} r={6} fill={c2} />
        </g>
      );
    case "box_pizza":
      return (
        <g>
          <path d="M24 50 L176 50 L176 30 L24 30 Z" fill={c1} stroke={c2} strokeWidth={2} />
          <path d="M24 30 L48 14 L152 14 L176 30 Z" fill={c2} opacity={0.6} stroke={c2} strokeWidth={2} />
          <circle cx={100} cy={40} r={6} fill="#c62f20" />
        </g>
      );
    case "tray_taco":
      return (
        <g>
          <path d="M28 50 L172 50 L180 26 L20 26 Z" fill={c1} stroke={c2} strokeWidth={2} />
          {[56, 100, 144].map((x) => (
            <path key={x} d={`M${x - 18} 28 C${x - 18} 44, ${x + 18} 44, ${x + 18} 28`} fill={c2} opacity={0.6} />
          ))}
        </g>
      );
    case "bowl":
      return (
        <g>
          <ellipse cx={100} cy={22} rx={70} ry={9} fill={c2} />
          <path d="M30 22 C34 52, 166 52, 170 22 Z" fill={c1} stroke={c2} strokeWidth={2} />
          <ellipse cx={100} cy={22} rx={66} ry={7} fill="#fff" opacity={0.25} />
        </g>
      );
    case "foil":
      return (
        <g>
          <path d="M26 44 L42 18 L160 16 L176 42 L150 52 L50 52 Z" fill={c1} />
          {scatter(seed, 14).map((p, i) => (
            <path key={i} d={`M${34 + p.x * 130} ${22 + p.y * 26} l${6 + p.a * 8} ${-3 + p.a * 6}`} stroke={c2} strokeWidth={2} />
          ))}
        </g>
      );
    case "pot":
      return (
        <g>
          <ellipse cx={100} cy={16} rx={36} ry={6} fill={c2} />
          <path d="M66 18 L74 50 L126 50 L134 18 Z" fill={c1} stroke={c2} strokeWidth={2} />
          <ellipse cx={100} cy={50} rx={26} ry={4} fill={c2} opacity={0.6} />
        </g>
      );
    case "cup":
      return (
        <g>
          <rect x={78} y={6} width={44} height={6} rx={3} fill={c2} />
          <path d="M76 12 L84 56 L116 56 L124 12 Z" fill={c1} stroke={c2} strokeWidth={2} />
          <path d="M80 30 L120 30" stroke={c2} strokeWidth={5} />
          <path d="M106 0 L112 12" stroke="#555" strokeWidth={3} />
        </g>
      );
    case "bag":
      return (
        <g>
          <path d="M64 14 L136 14 L142 56 L58 56 Z" fill={c1} stroke={c2} strokeWidth={2} />
          <path d="M80 14 C80 2, 120 2, 120 14" stroke={c2} strokeWidth={3} fill="none" />
        </g>
      );
    case "cone":
      return (
        <g>
          <path d="M72 10 L128 10 L104 58 L96 58 Z" fill={c1} stroke={c2} strokeWidth={2} />
          {[82, 96, 110].map((x) => (
            <rect key={x} x={x} y={2} width={6} height={16} rx={2} fill="#f4c142" />
          ))}
          <path d="M78 22 L122 22" stroke={c2} strokeWidth={4} />
        </g>
      );
    case "paper":
      return (
        <g>
          <path d="M40 12 L160 12 L168 52 L32 52 Z" fill={c1} stroke={SHADOW} strokeWidth={1} />
          {[56, 80, 104, 128, 152].map((x) => (
            <path key={x} d={`M${x} 12 L${x + 2} 52`} stroke={c2} strokeWidth={1.4} opacity={0.6} />
          ))}
          {[24, 36, 46].map((y) => (
            <path key={y} d={`M36 ${y} L164 ${y}`} stroke={c2} strokeWidth={1.4} opacity={0.6} />
          ))}
        </g>
      );
    case "can":
      return (
        <g>
          <rect x={82} y={6} width={36} height={52} rx={6} fill={c1} />
          <rect x={82} y={6} width={36} height={6} rx={3} fill={c2} />
          <rect x={82} y={52} width={36} height={6} rx={3} fill={c2} />
          <rect x={88} y={14} width={5} height={36} rx={2} fill="#fff" opacity={0.35} />
        </g>
      );
    default:
      return <rect x={20} y={14} width={160} height={36} rx={10} fill="#f4f4f5" stroke="#d4d4d8" strokeDasharray="5 4" />;
  }
}
