// Drawn food tiles: what a shop or an item shows when it has no photo of its
// own. Simple flat shapes ported from the approved app design (Tile) — never
// stock photos, never anyone else's imagery.

export type FoodKind =
  | "pizza"
  | "burger"
  | "kebab"
  | "dessert"
  | "curry"
  | "chicken"
  | "chinese"
  | "fries"
  | "breakfast"
  | "healthy";

const BACKGROUNDS: Record<FoodKind, string> = {
  pizza: "#F5E6D6",
  burger: "#F3EBD3",
  kebab: "#EAF0E4",
  dessert: "#F8E4EC",
  curry: "#F4E2CF",
  chicken: "#F6E0D6",
  chinese: "#F7E3D9",
  fries: "#F6EDD2",
  breakfast: "#EEF0DA",
  healthy: "#E3F0DF",
};

/** The main object of each drawing, for round icons. */
const ICON_VIEWBOX: Record<FoodKind, string> = {
  pizza: "100 -14 220 220",
  burger: "80 0 180 180",
  kebab: "80 6 170 170",
  dessert: "52 32 136 136",
  curry: "40 0 200 200",
  chicken: "80 18 160 160",
  chinese: "72 6 176 176",
  fries: "72 6 176 176",
  breakfast: "78 8 164 164",
  healthy: "72 4 176 176",
};

const KIND_WORDS: Array<[FoodKind, RegExp]> = [
  ["pizza", /pizza|calzone|italian/i],
  ["burger", /burger|smash|american/i],
  ["kebab", /kebab|doner|donner|shawarma|grill|gyro|turkish|greek/i],
  ["curry", /curry|indian|tikka|masala|biryani|bangladeshi|nepal|pakistani/i],
  ["chicken", /chicken|wing|peri/i],
  ["chinese", /chinese|noodle|asian|thai|japanese|sushi|wok|cantonese/i],
  ["fries", /fast food|chips|fish|fries|chippy/i],
  ["dessert", /dessert|cake|ice|sweet|waffle|donut|shake|bakery/i],
  ["breakfast", /breakfast|brunch|cafe|coffee|egg/i],
  ["healthy", /healthy|salad|vegan|vegetarian|bowl|poke/i],
];

/** Which drawing stands in for a shop or an item, from its words. */
export function foodKindFor(...words: Array<string | null | undefined>): FoodKind {
  const text = words.filter(Boolean).join(" ");
  for (const [kind, pattern] of KIND_WORDS) if (pattern.test(text)) return kind;
  return "pizza";
}

export function foodBackground(kind: FoodKind): string {
  return BACKGROUNDS[kind];
}

function Shapes({ kind }: { kind: FoodKind }) {
  switch (kind) {
    case "pizza":
      return (
        <>
          <circle cx="210" cy="96" r="104" fill="#E2A54A" />
          <circle cx="210" cy="96" r="92" fill="#C9432A" />
          <circle cx="210" cy="96" r="86" fill="#F2C75C" />
          <path d="M210 10v172M124 96h172M149 35l122 122M271 35L149 157" stroke="#E2A54A" strokeWidth="3" />
          <circle cx="176" cy="66" r="12" fill="#A9301C" />
          <circle cx="242" cy="60" r="12" fill="#A9301C" />
          <circle cx="248" cy="124" r="12" fill="#A9301C" />
          <circle cx="182" cy="130" r="12" fill="#A9301C" />
          <circle cx="212" cy="96" r="10" fill="#A9301C" />
          <circle cx="160" cy="98" r="4" fill="#3E7A3A" />
          <circle cx="262" cy="92" r="4" fill="#3E7A3A" />
          <circle cx="222" cy="150" r="4" fill="#3E7A3A" />
          <circle cx="60" cy="140" r="26" fill="#FFFFFF" opacity=".6" />
          <circle cx="60" cy="140" r="18" fill="#C9432A" />
        </>
      );
    case "burger":
      return (
        <>
          <path d="M96 92c0-46 30-70 74-70s74 24 74 70z" fill="#D98B3A" />
          <ellipse cx="146" cy="46" rx="5" ry="3" fill="#F6E1B5" />
          <ellipse cx="178" cy="38" rx="5" ry="3" fill="#F6E1B5" />
          <ellipse cx="202" cy="58" rx="5" ry="3" fill="#F6E1B5" />
          <path d="M90 98c20 8 30-6 44 2s28-6 42 2 28-6 42 2 20-6 30 0v-10H90z" fill="#5FA343" />
          <path d="M96 104h148l-14 18H110z" fill="#F2C238" />
          <rect x="92" y="112" width="156" height="22" rx="11" fill="#5A2E1C" />
          <path d="M96 138h148c0 12-10 20-22 20H118c-12 0-22-8-22-20z" fill="#D98B3A" />
          <path d="M262 150l6-60M276 150l2-62M290 150l-3-58" stroke="#F2C238" strokeWidth="9" strokeLinecap="round" />
          <path d="M252 112h50l-6 50h-38z" fill="#C9432A" />
        </>
      );
    case "kebab":
      return (
        <>
          <path d="M110 176L160 14l62 162z" fill="#EFE3CB" />
          <path d="M126 128l36-96 42 96z" fill="#B5652E" />
          <path d="M130 118c14-6 26 4 40-2s20 4 30 2" stroke="#5FA343" strokeWidth="8" fill="none" strokeLinecap="round" />
          <path d="M140 92c10-4 20 2 28-2s14 2 22 0" stroke="#C9432A" strokeWidth="7" fill="none" strokeLinecap="round" />
          <circle cx="258" cy="120" r="34" fill="#FFFFFF" opacity=".7" />
          <circle cx="258" cy="120" r="24" fill="#E9E2D0" />
          <path d="M244 120h28" stroke="#C9432A" strokeWidth="6" strokeLinecap="round" />
        </>
      );
    case "dessert":
      return (
        <>
          <circle cx="120" cy="100" r="58" fill="#D9A066" />
          <circle cx="120" cy="100" r="50" fill="#E8789A" />
          <circle cx="120" cy="100" r="18" fill="#F7E7EE" />
          <path d="M96 70l6 4M140 66l-4 6M150 110l6 2M92 120l6-4M120 140l2 6M126 60l4-6" stroke="#FFFFFF" strokeWidth="4" strokeLinecap="round" />
          <path d="M214 100h64l-12 64h-40z" fill="#F2C238" />
          <circle cx="246" cy="84" r="30" fill="#FDF3E3" />
          <circle cx="230" cy="70" r="18" fill="#8A4B2A" />
          <circle cx="262" cy="74" r="16" fill="#E8789A" />
          <circle cx="246" cy="52" r="8" fill="#C9432A" />
        </>
      );
    case "curry":
      return (
        <>
          <ellipse cx="140" cy="104" rx="96" ry="60" fill="#2F2F2F" />
          <ellipse cx="140" cy="98" rx="84" ry="48" fill="#C2571E" />
          <circle cx="112" cy="90" r="10" fill="#F2E3C6" />
          <circle cx="150" cy="104" r="12" fill="#F2E3C6" />
          <circle cx="170" cy="84" r="9" fill="#F2E3C6" />
          <path d="M104 112l8-4M184 104l8 2M130 78l6 6" stroke="#5FA343" strokeWidth="4" strokeLinecap="round" />
          <path d="M236 40c40-10 70 20 66 60-4 44-50 70-80 56 30-20 36-80 14-116z" fill="#E7C27C" />
          <circle cx="262" cy="80" r="5" fill="#B5652E" />
          <circle cx="276" cy="110" r="5" fill="#B5652E" />
        </>
      );
    case "chicken":
      return (
        <>
          <path d="M120 80h96l-12 96h-72z" fill="#FFFFFF" />
          <path d="M132 80h14l-4 96h-10zM164 80h14v96h-14zM198 80h14l-6 96h-10z" fill="#C9432A" />
          <ellipse cx="146" cy="66" rx="28" ry="22" fill="#C9772E" />
          <ellipse cx="192" cy="60" rx="30" ry="24" fill="#B8692A" />
          <ellipse cx="168" cy="52" rx="24" ry="20" fill="#D38A3C" />
          <path d="M240 140c20-30 50-30 62-14-6 20-30 30-62 14z" fill="#C9772E" />
          <path d="M236 142l-14 10" stroke="#F3E9D6" strokeWidth="7" strokeLinecap="round" />
        </>
      );
    case "chinese":
      return (
        <>
          <path d="M124 40c10 30 30 40 36 40M150 34c4 28 16 40 20 46M182 38c-6 26-10 36-14 42" stroke="#F2C75C" strokeWidth="6" fill="none" strokeLinecap="round" />
          <path d="M112 76h96l-12 92h-72z" fill="#FFFFFF" />
          <path d="M112 76l-10-18h116l-10 18z" fill="#EDEDED" />
          <path d="M120 112h80" stroke="#C9432A" strokeWidth="10" />
          <path d="M214 20l-40 70M232 26l-50 66" stroke="#8A4B2A" strokeWidth="6" strokeLinecap="round" />
          <circle cx="262" cy="134" r="26" fill="#FFFFFF" opacity=".7" />
          <circle cx="262" cy="134" r="16" fill="#E7C27C" />
        </>
      );
    case "fries":
      return (
        <>
          <path d="M128 76l-4-50M142 76l2-56M156 76l-2-60M170 76l4-54M184 76l0-48M198 76l6-44" stroke="#F2C238" strokeWidth="10" strokeLinecap="round" />
          <path d="M116 72h96l-12 96h-72z" fill="#C9432A" />
          <path d="M140 110c8 10 40 10 48 0" stroke="#FFFFFF" strokeWidth="6" fill="none" strokeLinecap="round" />
          <path d="M238 92h44l-6 76h-32z" fill="#FFFFFF" />
          <path d="M240 108h40" stroke="#0B0B0B" strokeWidth="5" />
          <path d="M262 92l10-34" stroke="#C9432A" strokeWidth="5" strokeLinecap="round" />
        </>
      );
    case "breakfast":
      return (
        <>
          <circle cx="160" cy="92" r="76" fill="#FFFFFF" />
          <circle cx="160" cy="92" r="62" fill="#F7F4EE" />
          <path d="M120 82c0-22 22-30 38-22 18-8 40 4 34 26 10 16-8 34-28 28-18 12-50 2-44-32z" fill="#FFFFFF" stroke="#EDE6D8" strokeWidth="2" />
          <circle cx="156" cy="88" r="16" fill="#F2B22E" />
          <path d="M118 132c14-6 22 4 36-2s22 4 34-2" stroke="#C25A3A" strokeWidth="9" fill="none" strokeLinecap="round" />
          <circle cx="198" cy="58" r="9" fill="#5FA343" />
          <circle cx="210" cy="72" r="7" fill="#C9432A" />
        </>
      );
    case "healthy":
      return (
        <>
          <circle cx="132" cy="80" r="22" fill="#5FA343" />
          <circle cx="160" cy="68" r="24" fill="#7DBA55" />
          <circle cx="190" cy="80" r="22" fill="#5FA343" />
          <circle cx="146" cy="92" r="12" fill="#C9432A" />
          <ellipse cx="182" cy="92" rx="14" ry="10" fill="#B9D27A" />
          <circle cx="182" cy="92" r="5" fill="#8A4B2A" />
          <path d="M92 96h136c0 40-30 66-68 66s-68-26-68-66z" fill="#FFFFFF" />
          <path d="M100 112h120" stroke="#E2E2E2" strokeWidth="4" />
        </>
      );
  }
}

/** A full-bleed tile (fills its box, cropping to cover). */
export function FoodTile({ kind, className = "" }: { kind: FoodKind; className?: string }) {
  return (
    <div aria-hidden="true" className={`h-full w-full overflow-hidden ${className}`} style={{ background: BACKGROUNDS[kind] }}>
      <svg width="100%" height="100%" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" className="block">
        <Shapes kind={kind} />
      </svg>
    </div>
  );
}

/** Just the main object, for round cuisine icons. */
export function FoodIcon({ kind, size = 56 }: { kind: FoodKind; size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox={ICON_VIEWBOX[kind]} className="block">
      <Shapes kind={kind} />
    </svg>
  );
}

/** The cuisines the feed filters by, with their drawing. */
export const CUISINES: ReadonlyArray<{ name: string; kind: FoodKind }> = [
  { name: "Pizza", kind: "pizza" },
  { name: "Burgers", kind: "burger" },
  { name: "Kebab", kind: "kebab" },
  { name: "Indian", kind: "curry" },
  { name: "Chicken", kind: "chicken" },
  { name: "Chinese", kind: "chinese" },
  { name: "Fast food", kind: "fries" },
  { name: "Desserts", kind: "dessert" },
  { name: "Breakfast", kind: "breakfast" },
  { name: "Healthy", kind: "healthy" },
];
