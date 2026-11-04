// Virtual-brand menu presentations (Kitchen training → Menu presentations).
// Each brand points at one live menu and is drawn in the Fiesta Mexica
// template: grey cover with the word mark over an orange disc, then landscape
// 1920×1080 pages with yellow category pills, photo rows/cards and red prices.
// Prices and photos come from the menu at view time, so the deck never drifts.
// Add a brand = one row in PRESENTATIONS (+ an icon in brand-icons if new).

import type { PresentationMenu } from "@/lib/api/assembly-charts.client";

export type PresentationIcon = "chilli" | "burger" | "gyro" | "drumstick" | "pizza";

export interface PresentationBrand {
  slug: string;
  name: string;
  /** Word mark lines on the cover and the corner logo. */
  lines: string[];
  tagline: string;
  icon: PresentationIcon;
  /** The menu the deck is drawn from when the location has no copy of its own. */
  menuId: string;
  /** Menu / brand names that ARE this brand — the same test as the supplier lists. */
  match: RegExp;
}

export const PRESENTATIONS: PresentationBrand[] = [
  {
    slug: "monster-burgerz",
    name: "Monster Burgerz",
    lines: ["MONSTER", "BURGERZ"],
    tagline: "Smashed burgers • Chicken • Fries",
    icon: "burger",
    menuId: "cmrz24wi801zi3inm9xvx294d", // MONSTER BURGERZ-dunraven (Pizza Plannet)
    match: /monster\s*burger/i,
  },
  {
    slug: "greek-gyros",
    name: "Greek Gyros",
    lines: ["GREEK", "GYROS"],
    tagline: "Wraps • Platters • Bowls",
    icon: "gyro",
    menuId: "cmrz24lid01r83inmtudznn6c", // GREEK GYROS-dunraven (Pizza Plannet)
    match: /greek\s*gyros/i,
  },
  {
    slug: "korean-fried-chicken",
    name: "Korean Fried Chicken",
    lines: ["KOREAN", "FRIED", "CHICKEN"],
    tagline: "Buckets • Burgers • Wings",
    icon: "drumstick",
    menuId: "cmv30a8ga00puk3s7c1hhayu2", // Korean Fried Chicken — Crunch Menu
    match: /korean\s*fried|\bkfc\b/i,
  },
  {
    slug: "chicago-pizzeria",
    name: "Chicago Pizzeria",
    lines: ["CHICAGO", "PIZZERIA"],
    tagline: "Pizza • Grill • Burgers",
    icon: "pizza",
    menuId: "cmuv2obkq01sy3fr337fjw65e", // CHICAGO PIZZERIA-AYLESBURY
    match: /chicago/i,
  },
  {
    slug: "fiesta-mexica",
    name: "Fiesta Mexica",
    lines: ["FIESTA", "MEXICA"],
    tagline: "Tacos • Burritos • Bowls",
    icon: "chilli",
    menuId: "cmuvn70g7069inoenki3i4h5o", // FIESTA MEXA (Pizza Uno)
    match: /fiesta\s*mex/i,
  },
];

/**
 * The decks a location shows, each drawn from that location's OWN copy of the
 * brand's menu (its prices, photos and specials) — a shop isn't shown decks
 * for brands it doesn't cook. `menus` = the location's menus.
 */
export function presentationsForMenus(
  menus: Array<{ id: string; name?: string | null; brand?: { name?: string | null } | null }>,
): Array<PresentationBrand & { menuId: string }> {
  const out: Array<PresentationBrand & { menuId: string }> = [];
  for (const p of PRESENTATIONS) {
    const own = menus.find((m) => p.match.test(`${m.name ?? ""} ${m.brand?.name ?? ""}`));
    if (own) out.push({ ...p, menuId: own.id });
  }
  return out;
}

export const presentationBySlug = (slug: string | null) => PRESENTATIONS.find((p) => p.slug === slug) ?? null;

// ── text tidy-up (menus are typed by hand: SHOUTY, emoji, "(copy)") ─────────

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;
const ARABIC = /\([؀-ۿ\s]+\)/g;
const SMALL = new Set(["and", "or", "of", "with", "in", "the", "a", "&"]);

function tidy(s: string | null | undefined) {
  return (s ?? "")
    .replace(EMOJI, "")
    .replace(ARABIC, "")
    .replace(/\s*\((copy|Copy \d+)\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s\-–]+|[\s\-–]+$/g, "");
}

function shouty(s: string) {
  const letters = [...s].filter((c) => /\p{L}/u.test(c));
  return letters.length > 0 && letters.filter((c) => c === c.toUpperCase() && c !== c.toLowerCase()).length / letters.length > 0.6;
}

export function smartTitle(raw: string) {
  const s = tidy(raw);
  if (!shouty(s) && s.toLowerCase() !== s) return s; // already mixed case
  return s
    .toLowerCase()
    .split(" ")
    .map((w, i) => (i && SMALL.has(w) ? w : /^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ")
    .replace(/([&(/-])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());
}

function sentence(raw: string) {
  let s = tidy(raw);
  if (!s) return "";
  if (shouty(s) && s.length > 3) {
    s = s.toLowerCase().replace(/\s*,\s*/g, ", ");
    s = s.charAt(0).toUpperCase() + s.slice(1);
  }
  s = s.replace(/\s+,/g, ",");
  return /[.!?)]$/.test(s) ? s : s + ".";
}

export const money = (v: number) => `£${(Number(v) || 0).toFixed(2)}`;

// ── layout ───────────────────────────────────────────────────────────────────

export interface PItem {
  name: string;
  desc: string;
  price: string;
  img: string | null;
}
export type OptBlock = { title: string; text: string };
export interface PSection {
  title: string;
  grid: boolean;
  items: PItem[];
  opts: OptBlock[];
}

function optionBlocks(menu: PresentationMenu, groupIds: string[]): OptBlock[] {
  const order: string[] = [];
  const byTitle = new Map<string, Array<[string, number]>>();
  for (const gid of groupIds) {
    const g = menu.groups[gid];
    if (!g) continue;
    // Positional picks ("burger option 2", "gyro choice 3", "your second sauce") are one choice.
    let title = tidy(g.name)
      .toLowerCase()
      .replace("suace", "sauce")
      .replace("chesse", "cheese")
      .replace(/^select /, "choose ")
      .replace("yours ", "your ")
      .replace(/\s*(option|choice)?\s*\d+$/, "")
      .replace(/\b(first|second|third|fourth) /g, "");
    if (title === "burger" || title === "burger option") title = "choose your burgers";
    if (["gyro", "drink", "side", "wrap"].includes(title)) title = `choose your ${title}`;
    const names = g.options
      .map((o) => [smartTitle(o.name.replace(/^\+\s*/, "")), o.price] as [string, number])
      .filter(([n]) => !["no sauce", "no salad"].includes(n.toLowerCase()));
    if (!names.length) continue;
    const have = byTitle.get(title);
    if (have) {
      const seen = new Set(have.map(([n]) => n.toLowerCase()));
      for (const n of names) if (!seen.has(n[0].toLowerCase())) have.push(n);
      continue;
    }
    byTitle.set(title, names);
    order.push(title);
  }
  return order.map((title) => {
    const byPrice = new Map<number, string[]>();
    for (const [n, p] of byTitle.get(title)!) {
      const k = Math.round((p || 0) * 100) / 100;
      byPrice.set(k, [...(byPrice.get(k) ?? []), n]);
    }
    const parts: string[] = [];
    for (const [p, all] of [...byPrice.entries()].sort((a, b) => a[0] - b[0])) {
      const ns = all.length > 12 ? [...all.slice(0, 10), `+ ${all.length - 10} more`] : all;
      if (!p) parts.push(...ns);
      else if (ns.length === 1) parts.push(`${ns[0]} +${money(p)}`);
      else parts.push(`${ns.slice(0, -1).join(", ")}, ${ns[ns.length - 1]} (+${money(p)} each)`);
    }
    return { title, text: parts.join(", ") };
  });
}

export function buildSections(menu: PresentationMenu): PSection[] {
  const out: PSection[] = [];
  for (const c of menu.categories) {
    const seen = new Set<string>();
    const items: PItem[] = [];
    const gids: string[] = [];
    for (const it of c.items) {
      const name = smartTitle(it.name);
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      let desc = sentence(it.description);
      let price = it.price;
      if (it.skus.length) {
        desc = `${desc ? desc + " " : ""}Choose ${it.skus.map((s) => smartTitle(s.name)).join(" or ")}.`;
        price = Math.min(...it.skus.map((s) => s.price)) || price;
      }
      items.push({ name, desc, price: money(price), img: it.imageUrl });
      for (const g of it.groupIds) if (!gids.includes(g)) gids.push(g);
    }
    if (!items.length) continue;
    const avg = items.reduce((n, i) => n + i.desc.length, 0) / items.length;
    out.push({ title: smartTitle(c.name), grid: avg < 45 && items.length >= 3, items, opts: optionBlocks(menu, gids) });
  }
  return out;
}

export function chunkEven<T>(list: T[], cap: number): T[][] {
  const n = Math.max(1, Math.ceil(list.length / cap));
  const size = Math.ceil(list.length / n);
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export type PPage =
  | { kind: "items"; title: string; grid: boolean; items: PItem[]; foot: OptBlock[] }
  | { kind: "options"; title: string; opts: OptBlock[] };

/** Pages in deck order: up to 6 rows / 10 cards a page; ≤4 option groups sit under the first page, more get their own "make it yours" page. */
export function buildPages(sections: PSection[]): PPage[] {
  const pages: PPage[] = [];
  for (const s of sections) {
    const inline = s.opts.length > 0 && s.opts.length <= 4;
    chunkEven(s.items, s.grid ? 10 : 6).forEach((chunk, i) =>
      pages.push({ kind: "items", title: s.title, grid: s.grid, items: chunk, foot: inline && i === 0 ? s.opts : [] }),
    );
    if (s.opts.length && !inline)
      for (const part of chunkEven(s.opts, 6)) pages.push({ kind: "options", title: `${s.title} — make it yours`, opts: part });
  }
  return pages;
}
