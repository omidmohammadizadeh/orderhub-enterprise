"use client";

// Content model for the Integrations detail pages. Each entry drives the shared
// IntegrationDetail template: brand hero, a status badge, a capability grid and
// a numbered flow. Copy reflects what each integration actually does today.

import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Banknote,
  Bike,
  Clock,
  CreditCard,
  Download,
  FileBarChart,
  Layers,
  MapPin,
  MessageCircle,
  Radio,
  RefreshCw,
  Sparkles,
  Store,
  Tag,
  Terminal,
  Truck,
  UploadCloud,
  UtensilsCrossed,
  Wallet,
} from "lucide-react";
import type { ReactNode } from "react";
import type { SiteBrandKey } from "@/lib/site-brand";
import type { BrandKey } from "../brand-logo";
import {
  DispatchConsoleMockup,
  MenuManagerMockup,
  PosBoardMockup,
} from "./mockups";

export type IntegrationStatus = "live" | "beta" | "soon";

export interface IntegrationCapability {
  icon: LucideIcon;
  title: string;
  body: string;
}

export interface Integration {
  slug: string;
  name: string;
  brand: BrandKey;
  navDescription: string;
  category: "Marketplace" | "Courier" | "Payments" | "Platform";
  accent: string;
  status: IntegrationStatus;
  badge: string;
  title: string;
  subtitle: string;
  highlights: string[];
  heroMockup: ReactNode;
  capabilities: IntegrationCapability[];
  flow: { title: string; body: string }[];
}

export const INTEGRATIONS: Integration[] = [
  // ── Uber Eats ─────────────────────────────────────────────────────────────
  {
    slug: "ubereats",
    name: "Uber Eats",
    brand: "ubereats",
    navDescription: "Direct, certified two-way integration",
    category: "Marketplace",
    accent: "#06C167",
    status: "live",
    badge: "Marketplace · Direct integration",
    title: "Uber Eats, wired in direct",
    subtitle:
      "A first-party, certified Uber Eats integration — orders, menu, store status, hours and self-delivery all flow straight to Order Hub. No middleware, no per-order surcharge.",
    highlights: ["Certified two-way orders", "Menu publish & import", "Store status & hours sync"],
    heroMockup: <PosBoardMockup />,
    capabilities: [
      { icon: Activity, title: "Two-way orders", body: "Accept, deny, cancel and mark ready straight from your board — every state syncs back to Uber in real time." },
      { icon: UtensilsCrossed, title: "Menu publish & import", body: "Push your Order Hub menu to Uber Eats, or import an existing Uber menu in — sizes, modifiers and prices intact." },
      { icon: Store, title: "Store status & hours", body: "Pause and resume the store, set prep times and push opening hours without logging into Uber's dashboard." },
      { icon: Bike, title: "Self-delivery status", body: "For merchant-fulfilled orders, report out-for-delivery and delivered back to Uber automatically." },
      { icon: FileBarChart, title: "Reporting", body: "Pull payment, order-history and finance reports from Uber directly into Order Hub." },
      { icon: Tag, title: "Promotions", body: "Create and manage Uber Eats promotions from the Marketing page — happy hour, percent-off, BOGO and more." },
    ],
    flow: [
      { title: "Connect the store", body: "Authorise Order Hub once; the store is provisioned and order management is enabled automatically." },
      { title: "Publish your menu", body: "Send your catalog to Uber Eats — or import theirs — from the Menu manager." },
      { title: "Orders flow in", body: "New Uber orders land on your POS board and print in the kitchen with everything else." },
      { title: "Statuses sync back", body: "Accept, ready and delivery updates return to Uber and the customer without a second screen." },
    ],
  },

  // ── Deliveroo ─────────────────────────────────────────────────────────────
  {
    slug: "deliveroo",
    name: "Deliveroo",
    brand: "deliveroo",
    navDescription: "Direct orders and menu sync",
    category: "Marketplace",
    accent: "#00CCBC",
    status: "beta",
    badge: "Marketplace · Direct integration",
    title: "Deliveroo without the tablet",
    subtitle:
      "A direct Deliveroo integration — orders arrive on your board and your menu publishes straight across, so the orange tablet can finally leave the pass.",
    highlights: ["Direct order sync", "Secure webhook delivery", "Menu publishing"],
    heroMockup: <PosBoardMockup />,
    capabilities: [
      { icon: Activity, title: "Direct order sync", body: "Deliveroo orders drop onto the same board as every other channel — accept and prepare in one place." },
      { icon: Radio, title: "Verified webhooks", body: "Orders are delivered over HMAC-verified webhooks, so what hits your board is genuine and tamper-proof." },
      { icon: UtensilsCrossed, title: "Menu publishing", body: "Publish your Order Hub menu to Deliveroo with sizes, modifiers and per-channel prices." },
      { icon: Store, title: "One printer queue", body: "Deliveroo tickets print from the same kitchen printer as your POS and direct orders." },
    ],
    flow: [
      { title: "Connect Deliveroo", body: "Authorise the integration and link your Deliveroo site to Order Hub." },
      { title: "Publish your menu", body: "Send your catalog across so the two menus always match." },
      { title: "Orders arrive", body: "New Deliveroo orders land on your board and print automatically." },
      { title: "Prepare & complete", body: "Work the order on your board; the kitchen never touches the Deliveroo tablet." },
    ],
  },

  // ── Uber Direct ───────────────────────────────────────────────────────────
  {
    slug: "uberdirect",
    name: "Uber Direct",
    brand: "uberdirect",
    navDescription: "On-demand couriers for your own orders",
    category: "Courier",
    accent: "#d4d4d8",
    status: "live",
    badge: "Courier · On-demand delivery",
    title: "Uber couriers, on your orders",
    subtitle:
      "Hand off your own website and phone orders to Uber Direct couriers when your fleet is stretched — dispatched straight from the console, tracked to the customer's door.",
    highlights: ["On-demand courier fleet", "Dispatch in one click", "Live tracking to the door"],
    heroMockup: <DispatchConsoleMockup />,
    capabilities: [
      { icon: Truck, title: "On-demand couriers", body: "Tap into Uber's courier network for your direct orders — no need to grow your own fleet for every peak." },
      { icon: MapPin, title: "One-click dispatch", body: "Send a delivery to Uber Direct from the dispatch console the moment your own drivers are all busy." },
      { icon: Activity, title: "Live tracking", body: "The courier's progress feeds the customer's tracking page just like your own drivers do." },
      { icon: Clock, title: "Automatic fallback", body: "Use your own fleet first and overflow to Uber Direct only when you need to — you stay in control." },
    ],
    flow: [
      { title: "A direct order needs delivering", body: "Your storefront or phone order is ready and no own-driver is free." },
      { title: "Dispatch to Uber Direct", body: "One click requests an Uber courier for the pickup." },
      { title: "Courier collects", body: "The assigned courier heads to your kitchen and picks up." },
      { title: "Tracked to the door", body: "The customer follows the courier live until it's delivered." },
    ],
  },

  // ── Stuart ────────────────────────────────────────────────────────────────
  {
    slug: "stuart",
    name: "Stuart",
    brand: "stuart",
    navDescription: "On-demand courier network fallback",
    category: "Courier",
    accent: "#FF7A45",
    status: "live",
    badge: "Courier · On-demand delivery",
    title: "Stuart couriers on tap",
    subtitle:
      "Another on-demand courier network for your direct orders — dispatch to Stuart from the console when your own drivers are maxed out, and keep everything on one map.",
    highlights: ["On-demand couriers", "Console dispatch", "Own-fleet-first"],
    heroMockup: <DispatchConsoleMockup />,
    capabilities: [
      { icon: Truck, title: "On-demand fleet", body: "Reach Stuart's courier network for overflow deliveries without any long-term fleet commitment." },
      { icon: MapPin, title: "Dispatch from the console", body: "Send a job to Stuart from the same dispatch view you use for your own drivers." },
      { icon: Bike, title: "Own fleet first", body: "Prioritise your own drivers and only reach for Stuart when you're stretched at peak." },
      { icon: Activity, title: "Unified tracking", body: "Stuart deliveries appear on the same live map and feed the customer's tracker." },
    ],
    flow: [
      { title: "No driver free", body: "A direct order is ready but your own fleet is fully committed." },
      { title: "Dispatch to Stuart", body: "Request a Stuart courier straight from the console." },
      { title: "Pickup", body: "The courier collects from your kitchen." },
      { title: "Delivered & tracked", body: "The customer tracks the drop-off to completion." },
    ],
  },

  // ── HubRise ───────────────────────────────────────────────────────────────
  {
    slug: "hubrise",
    name: "HubRise",
    brand: "hubrise",
    navDescription: "Bridge to catalogs, orders and more POS",
    category: "Platform",
    accent: "#a78bfa",
    status: "live",
    badge: "Platform · Data bridge",
    title: "One bridge, more channels",
    subtitle:
      "HubRise connects Order Hub to a wider ecosystem of catalogs, POS systems and marketplaces — sync your menu and pull orders across everything HubRise plugs into.",
    highlights: ["Catalog sync", "Order pass-through", "Wider channel reach"],
    heroMockup: <MenuManagerMockup />,
    capabilities: [
      { icon: UtensilsCrossed, title: "Catalog sync", body: "Publish your menu into HubRise with categories, options and per-channel price variants." },
      { icon: Download, title: "Menu import", body: "Pull an existing HubRise catalog into Order Hub to seed your menu without re-keying it." },
      { icon: Activity, title: "Order pass-through", body: "Orders from HubRise-connected channels arrive on your board and print like any other." },
      { icon: Layers, title: "Wider reach", body: "Reach the extra POS systems and marketplaces HubRise bridges — from one connection." },
    ],
    flow: [
      { title: "Connect HubRise", body: "Link your HubRise location to Order Hub." },
      { title: "Sync the catalog", body: "Publish or import so both catalogs match." },
      { title: "Orders flow through", body: "Connected-channel orders land on your board automatically." },
      { title: "Manage in one place", body: "Work every HubRise channel from the same Order Hub board." },
    ],
  },

  // ── Just Eat ──────────────────────────────────────────────────────────────
  {
    slug: "justeat",
    name: "Just Eat",
    brand: "justeat",
    navDescription: "Coming soon",
    category: "Marketplace",
    accent: "#FF8000",
    status: "soon",
    badge: "Marketplace · Coming soon",
    title: "Just Eat is on the way",
    subtitle:
      "A direct Just Eat integration is next on the roadmap — orders and menu sync on the same board as every other channel. Want it for your shop? Tell us and we'll line you up.",
    highlights: ["Order sync — planned", "Menu publishing — planned", "Same unified board"],
    heroMockup: <PosBoardMockup />,
    capabilities: [
      { icon: Activity, title: "Order sync (planned)", body: "Just Eat orders will land on the same board as your POS, storefront and other marketplaces." },
      { icon: UtensilsCrossed, title: "Menu publishing (planned)", body: "Publish your Order Hub menu to Just Eat with sizes, modifiers and per-channel pricing." },
      { icon: Store, title: "One printer queue (planned)", body: "Just Eat tickets will print from the same kitchen printer as everything else." },
    ],
    flow: [
      { title: "On the roadmap", body: "The Just Eat integration is in planning, following the Uber Eats and Deliveroo model." },
      { title: "Register interest", body: "Let us know you want it and we'll prioritise and keep you posted." },
      { title: "Connect at launch", body: "When it ships, you'll link your Just Eat store in a few clicks." },
      { title: "One board", body: "Just Eat joins your unified orders board alongside every channel." },
    ],
  },

  // ── Stripe ────────────────────────────────────────────────────────────────
  {
    slug: "stripe",
    name: "Stripe",
    brand: "stripe",
    navDescription: "Online payments, Terminal & payouts",
    category: "Payments",
    accent: "#8b9bff",
    status: "live",
    badge: "Payments · Cards & Terminal",
    title: "Payments, online and in person",
    subtitle:
      "Stripe powers card payments across Order Hub — checkout on your storefront, WhatsApp pay links, and in-person taps on a shared Stripe Terminal S700, all settling direct to you.",
    highlights: ["Online card checkout", "Stripe Terminal S700", "Direct payouts"],
    heroMockup: <PaymentMockup />,
    capabilities: [
      { icon: CreditCard, title: "Online checkout", body: "Take card payments on your branded storefront with a fast, secure Stripe checkout." },
      { icon: Terminal, title: "Stripe Terminal S700", body: "Tap cards in person on a shared server-driven reader — no card details ever touch your staff." },
      { icon: Wallet, title: "WhatsApp pay links", body: "The WhatsApp assistant sends hosted Stripe links so customers pay right inside the chat." },
      { icon: Banknote, title: "Direct payouts", body: "Funds settle straight to your account via Stripe Connect — you keep the whole basket on direct orders." },
    ],
    flow: [
      { title: "Connect Stripe", body: "Link your Stripe account to Order Hub once." },
      { title: "Take payments anywhere", body: "Storefront checkout, WhatsApp links or an in-person Terminal tap." },
      { title: "Settle direct", body: "Money lands in your account through Stripe Connect." },
      { title: "Reconciled on the board", body: "Every payment is tied to its order for clean end-of-day totals." },
    ],
  },

  // ── WhatsApp ──────────────────────────────────────────────────────────────
  {
    slug: "whatsapp",
    name: "WhatsApp",
    brand: "whatsapp",
    navDescription: "AI ordering inside WhatsApp chat",
    category: "Platform",
    accent: "#25D366",
    status: "live",
    badge: "Channel · AI ordering",
    title: "Take orders right inside WhatsApp",
    subtitle:
      "Customers order by chatting on WhatsApp — an AI assistant reads your live menu, builds the basket and sends a secure Stripe pay link, and the order lands on your board and prints like any other.",
    highlights: ["AI chat ordering", "Stripe pay links", "Lands on your board"],
    heroMockup: <PosBoardMockup />,
    capabilities: [
      { icon: MessageCircle, title: "Chat ordering", body: "Customers message your WhatsApp number and order in plain English — no app to download, no login." },
      { icon: Sparkles, title: "AI builds the basket", body: "The assistant reads your live menu, understands sizes and modifiers, and assembles the order for them." },
      { icon: Wallet, title: "Stripe pay links", body: "A hosted Stripe link is sent right in the chat, so the customer pays securely without leaving WhatsApp." },
      { icon: Activity, title: "Lands on your board", body: "Confirmed, paid orders drop onto the same board as every channel and print in the kitchen." },
    ],
    flow: [
      { title: "Customer messages", body: "They text your WhatsApp number to start an order." },
      { title: "AI takes the order", body: "The assistant walks them through the menu and builds the basket." },
      { title: "Pay in chat", body: "A Stripe pay link is sent; the customer pays inside WhatsApp." },
      { title: "On your board", body: "The paid order lands on your POS board and prints automatically." },
    ],
  },

  // ── Order Hub POS ─────────────────────────────────────────────────────────
  {
    slug: "orderhub",
    name: "Order Hub POS",
    brand: "orderhub",
    navDescription: "The native till at the centre of it all",
    category: "Platform",
    accent: "#34d399",
    status: "live",
    badge: "Platform · Native POS",
    title: "The till everything runs through",
    subtitle:
      "Order Hub's own POS is the hub every channel connects into — walk-ins, phone orders and each integration meet here, on one board, printing from one kitchen printer.",
    highlights: ["Native orders board", "One printer queue", "Every channel unified"],
    heroMockup: <PosBoardMockup />,
    capabilities: [
      { icon: Layers, title: "Unified orders board", body: "Every channel — POS, storefront, marketplaces — on one board with live prep timers." },
      { icon: Store, title: "One printer queue", body: "Accepted orders print to the same kitchen printer via Bluetooth bridge or network." },
      { icon: RefreshCw, title: "Two-way sync", body: "Statuses you set on the board flow back to each connected channel and the customer." },
      { icon: UploadCloud, title: "Central menu", body: "One catalog publishes to the POS and out to every integration from the Menu manager." },
    ],
    flow: [
      { title: "Everything connects in", body: "Each marketplace, courier and payment integration links into the POS." },
      { title: "Orders land on one board", body: "No matter the source, they queue in the same place." },
      { title: "Prepare & print", body: "Accept, print and bump — one workflow for every channel." },
      { title: "Sync back out", body: "Statuses return to each channel automatically." },
    ],
  },
];

export const INTEGRATIONS_BY_SLUG: Record<string, Integration> = Object.fromEntries(
  INTEGRATIONS.map((i) => [i.slug, i]),
);

// menumanager.uk presents a different launch story than orderhubsolutions.com:
// Uber Eats + Uber Direct show as "coming soon" and Just Eat as live. These
// overrides apply ONLY for the Menu Manager brand; orderhubsolutions.com keeps
// the accurate live/soon statuses from the base catalog above.
const MENUMANAGER_SOON = new Set(["ubereats", "uberdirect"]);

const JUSTEAT_LIVE: Integration = {
  ...INTEGRATIONS_BY_SLUG.justeat!,
  status: "live",
  navDescription: "Direct orders and menu sync",
  badge: "Marketplace · Direct integration",
  title: "Just Eat, wired in direct",
  subtitle:
    "A direct Just Eat integration — orders arrive on your board and your menu publishes straight across, on the same board as every other channel.",
  highlights: ["Direct order sync", "Menu publishing", "Same unified board"],
  capabilities: [
    { icon: Activity, title: "Order sync", body: "Just Eat orders land on the same board as your POS, storefront and other marketplaces." },
    { icon: UtensilsCrossed, title: "Menu publishing", body: "Publish your Order Hub menu to Just Eat with sizes, modifiers and per-channel pricing." },
    { icon: Store, title: "One printer queue", body: "Just Eat tickets print from the same kitchen printer as everything else." },
  ],
  flow: [
    { title: "Connect Just Eat", body: "Link your Just Eat store to Order Hub." },
    { title: "Publish your menu", body: "Send your catalog across so both menus always match." },
    { title: "Orders arrive", body: "New Just Eat orders land on your board and print automatically." },
    { title: "One board", body: "Just Eat joins your unified orders board alongside every channel." },
  ],
};

function forMenuManager(i: Integration): Integration {
  if (MENUMANAGER_SOON.has(i.slug)) {
    return {
      ...i,
      status: "soon",
      navDescription: "Coming soon",
      badge: `${i.category} · Coming soon`,
    };
  }
  if (i.slug === "justeat") return JUSTEAT_LIVE;
  return i;
}

/** Integrations list for a marketing brand. menumanager.uk gets the coming-soon
 *  overrides; every other brand gets the accurate base catalog. */
export function integrationsForBrand(key: SiteBrandKey): Integration[] {
  if (key !== "menumanager") return INTEGRATIONS;
  return INTEGRATIONS.map(forMenuManager);
}

/** A single integration by slug, brand-aware (mirrors integrationsForBrand). */
export function integrationForBrand(
  slug: string,
  key: SiteBrandKey,
): Integration | undefined {
  const base = INTEGRATIONS_BY_SLUG[slug];
  if (!base) return undefined;
  return key === "menumanager" ? forMenuManager(base) : base;
}

// Small inline payment mockup, kept here so Stripe has a bespoke hero visual.
function PaymentMockup() {
  return (
    <div className="relative mx-auto w-full max-w-sm">
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-[#1a1f3a] to-[#0d1119] p-6 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)]">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-indigo-300">
            Order Hub · Pay
          </span>
          <CreditCard className="h-5 w-5 text-indigo-300" />
        </div>
        <p className="mt-6 text-3xl font-bold text-white">£16.50</p>
        <p className="text-xs text-zinc-400">Large Pepperoni · Garlic Bread</p>
        <div className="mt-5 space-y-2">
          <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5">
            <div className="h-4 w-6 rounded bg-gradient-to-r from-orange-400 to-red-500" />
            <span className="font-mono text-[11px] tracking-widest text-zinc-300">
              •••• •••• •••• 4242
            </span>
          </div>
          <button className="w-full rounded-lg bg-indigo-500 py-2.5 text-sm font-semibold text-white">
            Pay £16.50
          </button>
        </div>
        <div className="mt-3 flex items-center justify-center gap-1 text-[10px] text-zinc-500">
          <Terminal className="h-3 w-3" /> Secured by Stripe
        </div>
      </div>
    </div>
  );
}
