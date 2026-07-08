// Server-safe catalog of the marketing detail routes. Pure data — NO "use
// client", NO JSX — so Server Components (generateStaticParams,
// generateMetadata, notFound checks) can read the real arrays. The rich,
// renderable configs with mockups live in the sibling "use client" data
// modules (solutions-data / integrations-data), keyed by the same slugs.

export interface RouteMeta {
  slug: string;
  name: string;
  description: string;
}

export const SOLUTION_META: RouteMeta[] = [
  {
    slug: "pos",
    name: "POS",
    description:
      "Every order — walk-in, phone, online and marketplace — on one board and one printer queue. Stop juggling tablets at the pass.",
  },
  {
    slug: "online-ordering",
    name: "Direct online ordering",
    description:
      "Take orders on your own branded storefront and keep 100% of the basket — zero marketplace commission, live order tracking.",
  },
  {
    slug: "menu-manager",
    name: "Menu Manager",
    description:
      "One catalog with sizes, modifiers and per-channel prices, published to POS, storefront and every marketplace. AI menu import included.",
  },
  {
    slug: "driver-app",
    name: "Driver app",
    description:
      "A native app for your own drivers — go online, get assigned, navigate and slide to confirm delivery, all tracked live.",
  },
  {
    slug: "dispatch",
    name: "Dispatch console",
    description:
      "See every driver and order on one live map, assign in a click, and fall back to Uber Direct or Stuart couriers at peak.",
  },
  {
    slug: "whatsapp-ordering",
    name: "WhatsApp AI ordering",
    description:
      "Customers order on WhatsApp in plain English; an AI assistant builds the basket, sends a Stripe pay link and drops it on your board.",
  },
];

export const INTEGRATION_META: RouteMeta[] = [
  {
    slug: "ubereats",
    name: "Uber Eats",
    description:
      "A direct, certified Uber Eats integration — orders, menu, store status, hours, self-delivery and reporting straight into Order Hub.",
  },
  {
    slug: "deliveroo",
    name: "Deliveroo",
    description:
      "A direct Deliveroo integration — orders on your board and menu publishing, so the orange tablet can leave the pass.",
  },
  {
    slug: "uberdirect",
    name: "Uber Direct",
    description:
      "Hand your own website and phone orders to Uber Direct couriers from the dispatch console, tracked to the customer's door.",
  },
  {
    slug: "stuart",
    name: "Stuart",
    description:
      "On-demand Stuart couriers for your direct orders — dispatch from the console when your own fleet is stretched.",
  },
  {
    slug: "hubrise",
    name: "HubRise",
    description:
      "Bridge Order Hub to a wider ecosystem of catalogs, POS systems and marketplaces — sync menus and pull orders through HubRise.",
  },
  {
    slug: "justeat",
    name: "Just Eat",
    description:
      "A direct Just Eat integration is on the roadmap — orders and menu sync on the same board as every other channel.",
  },
  {
    slug: "stripe",
    name: "Stripe",
    description:
      "Card payments across Order Hub — storefront checkout, WhatsApp pay links and in-person Stripe Terminal, all settling direct to you.",
  },
  {
    slug: "whatsapp",
    name: "WhatsApp",
    description:
      "Customers order on WhatsApp in plain English — an AI assistant builds the basket, sends a Stripe pay link and drops the order on your board.",
  },
  {
    slug: "orderhub",
    name: "Order Hub POS",
    description:
      "The native till at the centre of it all — every channel connects into one board that prints from one kitchen printer.",
  },
];

export const SOLUTION_META_BY_SLUG: Record<string, RouteMeta> = Object.fromEntries(
  SOLUTION_META.map((s) => [s.slug, s]),
);

export const INTEGRATION_META_BY_SLUG: Record<string, RouteMeta> = Object.fromEntries(
  INTEGRATION_META.map((i) => [i.slug, i]),
);
