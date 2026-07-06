"use client";

// Content model for the six Solutions detail pages. Each entry drives the
// shared SolutionDetail template — nav label, hero, capability grid, a
// numbered "how it works" flow, and alternating showcase sections with the
// dark product mockups. Copy is written against the real product.

import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Banknote,
  Bike,
  BrainCircuit,
  Clock,
  CreditCard,
  Globe,
  Layers,
  MapPin,
  MessageCircle,
  Navigation,
  Printer,
  Radio,
  Route,
  ScanLine,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Store,
  Tags,
  UtensilsCrossed,
  Wallet,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  DispatchConsoleMockup,
  DriverHomeMockup,
  DriverJobMockup,
  MenuManagerMockup,
  PosBoardMockup,
  StorefrontMockup,
  WhatsAppChatMockup,
} from "./mockups";

export interface Capability {
  icon: LucideIcon;
  title: string;
  body: string;
}

export interface FlowStep {
  title: string;
  body: string;
}

export interface Showcase {
  eyebrow: string;
  title: string;
  body: string;
  bullets: string[];
  mockup: ReactNode;
}

export interface Solution {
  slug: string;
  name: string;
  navDescription: string;
  accent: string;
  icon: LucideIcon;
  badge: string;
  title: string;
  subtitle: string;
  highlights: string[];
  heroMockup: ReactNode;
  stats: { value: number; suffix?: string; prefix?: string; label: string; decimals?: number }[];
  capabilities: Capability[];
  flow: FlowStep[];
  showcases: Showcase[];
}

export const SOLUTIONS: Solution[] = [
  // ── POS ─────────────────────────────────────────────────────────────────
  {
    slug: "pos",
    name: "POS",
    navDescription: "Every channel into one till and one printer queue",
    accent: "#34d399",
    icon: ShoppingBag,
    badge: "Point of sale",
    title: "Every order, one till",
    subtitle:
      "Walk-in, phone, your website and every marketplace land on the same orders board and print from the same kitchen printer. Stop juggling five tablets at the pass.",
    highlights: ["Unified orders board", "One shared printer queue", "Card, cash & Terminal"],
    heroMockup: <PosBoardMockup />,
    stats: [
      { value: 5, suffix: "+", label: "Channels in one board" },
      { value: 100, suffix: "%", label: "Tablets removed from the pass" },
      { value: 1, suffix: "hr", label: "Typical time to first order", prefix: "<" },
    ],
    capabilities: [
      { icon: Layers, title: "Unified orders board", body: "New → Preparing → Ready columns with every channel colour-coded. Accept, bump and complete in one tap." },
      { icon: Printer, title: "One printer queue", body: "Every accepted order prints to the same kitchen printer — Bluetooth bridge or network — with per-printer copy counts." },
      { icon: UtensilsCrossed, title: "Modifiers & multi-SKU", body: "Sizes, modifier groups and combo items map cleanly from any marketplace onto the ticket the kitchen reads." },
      { icon: MapPin, title: "Postcode delivery fees", body: "Charge by distance or postcode zone, with minimum-basket and free-delivery thresholds you control." },
      { icon: Sparkles, title: "Quick promos", body: "Fire happy-hour, percent-off and free-delivery offers straight from the till without touching a menu file." },
      { icon: CreditCard, title: "Card, cash & Terminal", body: "Take payment in person on a shared Stripe Terminal S700, or record cash — reconciled at the end of the day." },
    ],
    flow: [
      { title: "Order lands", body: "A walk-in, phone order or a marketplace ticket drops onto the board in real time." },
      { title: "Accept", body: "One tap accepts and sets a prep time — the customer and the marketplace are notified automatically." },
      { title: "Kitchen prints", body: "The ticket prints to the kitchen printer the moment it's accepted. No tablet relay." },
      { title: "Mark ready & done", body: "Bump to Ready, hand to the driver or customer, and it clears — every status syncs back to the channel." },
    ],
    showcases: [
      {
        eyebrow: "One board",
        title: "The pass finally has one screen",
        body: "Uber Eats, Deliveroo, your own storefront and the till all feed the same board. The cashier never reaches for a marketplace tablet again.",
        bullets: [
          "Colour-coded by channel at a glance",
          "Live prep timers on every ticket",
          "Re-print, refund and adjust in place",
        ],
        mockup: <PosBoardMockup />,
      },
    ],
  },

  // ── Direct online ordering ────────────────────────────────────────────────
  {
    slug: "online-ordering",
    name: "Direct online ordering",
    navDescription: "Your own branded storefront — keep 100% of the basket",
    accent: "#fb923c",
    icon: Globe,
    badge: "Direct ordering",
    title: "Your storefront, your margin",
    subtitle:
      "Customers order direct from your own branded URL and pay by card — you keep the whole basket instead of handing 30% to a marketplace. Same menu, same board, zero commission.",
    highlights: ["Custom domain per brand", "0% marketplace commission", "Live order tracking"],
    heroMockup: <StorefrontMockup />,
    stats: [
      { value: 30, suffix: "%", label: "Commission you stop paying" },
      { value: 100, suffix: "%", label: "Of the basket kept" },
      { value: 7, suffix: " days", label: "Schedule-ahead window" },
    ],
    capabilities: [
      { icon: Globe, title: "Custom domain per brand", body: "Run each brand on its own hostname over HTTPS — order.yourshop.com — with your logo, colours and menu." },
      { icon: Wallet, title: "Keep 100% of the basket", body: "Direct card payments settle to you via Stripe. No per-order marketplace commission, ever." },
      { icon: Activity, title: "Live order tracking", body: "Every customer gets a live tracking page — accepted, preparing, ready, out for delivery — driven by your kitchen." },
      { icon: Clock, title: "Schedule ahead", body: "Let customers order up to seven days out for pickup or delivery, slotted against your opening hours." },
      { icon: Store, title: "Delivery & collection", body: "Offer both, with postcode-based fees, minimum baskets and prep-time-aware ETAs." },
      { icon: ShieldCheck, title: "Own the relationship", body: "It's your customer, your data and your repeat business — not the marketplace's." },
    ],
    flow: [
      { title: "Publish your storefront", body: "Point a domain at Order Hub and your menu goes live with your branding in minutes." },
      { title: "Customer orders & pays", body: "They browse, build a basket and pay by card — no app download, no commission." },
      { title: "It hits your board", body: "The order lands on the same POS board and prints in the kitchen alongside every other channel." },
      { title: "They track it live", body: "The customer follows each milestone on their tracking page as your staff moves the order along." },
    ],
    showcases: [
      {
        eyebrow: "Branded storefront",
        title: "Looks like you, not like a marketplace",
        body: "Your hero image, your logo, your menu — on your own domain. Customers order in a couple of taps and pay securely.",
        bullets: [
          "Delivery & collection toggle",
          "Item photos, sizes and modifiers",
          "Mobile-first, fast checkout",
        ],
        mockup: <StorefrontMockup />,
      },
    ],
  },

  // ── Menu Manager ──────────────────────────────────────────────────────────
  {
    slug: "menu-manager",
    name: "Menu Manager",
    navDescription: "Build once, publish to every channel — AI import included",
    accent: "#a78bfa",
    icon: UtensilsCrossed,
    badge: "Menu manager",
    title: "Build once, publish everywhere",
    subtitle:
      "One catalog with sizes, modifier groups and per-channel prices — pushed to your POS, your storefront and every marketplace. Import an existing menu from a PDF or a photo and it's built for you.",
    highlights: ["AI menu import", "Per-channel price variants", "One source of truth"],
    heroMockup: <MenuManagerMockup />,
    stats: [
      { value: 5, suffix: "+", label: "Channels from one menu" },
      { value: 1, label: "Source of truth" },
      { value: 60, suffix: "s", label: "To import a full menu", prefix: "~" },
    ],
    capabilities: [
      { icon: ScanLine, title: "AI menu import", body: "Upload a PDF or a photo of your menu — Claude vision reads it into categories, items, sizes and modifiers for review." },
      { icon: Tags, title: "Per-channel price variants", body: "Charge more on the marketplaces to cover commission and keep your direct prices sharp — one item, many prices." },
      { icon: Layers, title: "Modifier groups & sizes", body: "Multi-size products, required and optional modifier groups, combos — modelled once and mapped everywhere." },
      { icon: Sparkles, title: "Drag-drop & image crop", body: "Reorder categories and items by drag, upload photos with an in-place cropper, and stock-86 items instantly." },
      { icon: Radio, title: "Push to every channel", body: "Publish to POS, your storefront, Uber Eats, Deliveroo and HubRise from one screen — same data, no re-keying." },
      { icon: Clock, title: "Availability & hours", body: "Snooze items when they run out and ride your opening hours onto each channel's service availability." },
    ],
    flow: [
      { title: "Import or build", body: "Drop in a PDF/photo for AI to parse, or build categories and items by hand." },
      { title: "Set prices per channel", body: "Add price variants so each marketplace and your storefront carry the right price." },
      { title: "Publish", body: "Choose the channels and publish — the menu appears live everywhere at once." },
      { title: "Edit once, sync everywhere", body: "Change a price or 86 an item and every channel updates without a re-upload." },
    ],
    showcases: [
      {
        eyebrow: "AI import",
        title: "A photo of your menu is enough",
        body: "Snap or upload your existing menu and Claude Opus vision turns it into a structured catalog — categories, items, sizes and modifiers — ready for you to review and publish.",
        bullets: [
          "PDF or photo in, full menu out",
          "Sizes & modifier groups detected",
          "Review before anything goes live",
        ],
        mockup: <MenuManagerMockup />,
      },
    ],
  },

  // ── Driver app ────────────────────────────────────────────────────────────
  {
    slug: "driver-app",
    name: "Driver app",
    navDescription: "Your own delivery fleet, tracked live end to end",
    accent: "#38bdf8",
    icon: Bike,
    badge: "Driver app",
    title: "Your own fleet, tracked live",
    subtitle:
      "A native app for your own drivers — go online, get assigned, navigate turn-by-turn and confirm delivery with a slide. Every position streams back to dispatch and onto the customer's tracking page.",
    highlights: ["Live GPS tracking", "Slide-to-confirm proof", "End-of-day cash-up"],
    heroMockup: <DriverHomeMockup />,
    stats: [
      { value: 100, suffix: "%", label: "Own-fleet, own margin" },
      { value: 1, suffix: " tap", label: "To go online" },
      { value: 0, label: "Third-party courier fees" },
    ],
    capabilities: [
      { icon: Radio, title: "One-tap online", body: "Drivers flip a single Online toggle to start receiving jobs. Presence and location stream to dispatch instantly." },
      { icon: Navigation, title: "Turn-by-turn navigation", body: "Pickup and drop-off stops with distances, one-tap navigation and a direct line to call the customer." },
      { icon: ShieldCheck, title: "Slide-to-confirm proof", body: "A deliberate slide-to-confirm marks each stop delivered — clean proof of completion, no accidental taps." },
      { icon: MapPin, title: "Live GPS", body: "Position updates follow the driver on the map and feed straight into the customer's live tracking page." },
      { icon: Banknote, title: "End-of-day cash-up", body: "Cash-on-delivery is tallied per driver and reconciled at shift end so the float always balances." },
      { icon: MessageCircle, title: "In-app chat", body: "Dispatch and drivers message in-app with unread badges — no personal numbers, no WhatsApp groups." },
    ],
    flow: [
      { title: "Go online", body: "The driver taps Online; the live map and their availability light up in dispatch." },
      { title: "Get assigned", body: "Dispatch assigns the order — or auto-assign picks the nearest free driver." },
      { title: "Navigate the stops", body: "Pickup then drop-off, with turn-by-turn navigation and customer contact one tap away." },
      { title: "Slide to confirm", body: "A slide marks the stop delivered, updates the customer's tracker and closes the job." },
    ],
    showcases: [
      {
        eyebrow: "The real app",
        title: "Built for the seat of a moped",
        body: "Big targets, a dark live map, and a deliberate slide to confirm delivery. This is the actual Order Hub Driver interface — not a marketing mock-up.",
        bullets: [
          "Live map that follows the driver",
          "Pickup & drop-off stops with ETAs",
          "Slide-to-confirm on each delivery",
        ],
        mockup: <DriverJobMockup />,
      },
    ],
  },

  // ── Dispatch console ──────────────────────────────────────────────────────
  {
    slug: "dispatch",
    name: "Dispatch console",
    navDescription: "See every driver and order live; assign in a click",
    accent: "#22d3ee",
    icon: Route,
    badge: "Dispatch",
    title: "See every driver, live",
    subtitle:
      "A real-time console for your delivery operation — drivers and orders on one map, assign in a click, and fall back to Uber Direct or Stuart on-demand couriers when your own fleet is stretched.",
    highlights: ["Real-time fleet map", "Own fleet + on-demand", "Auto or manual assign"],
    heroMockup: <DispatchConsoleMockup />,
    stats: [
      { value: 1, label: "Console for the whole fleet" },
      { value: 2, label: "On-demand courier fallbacks" },
      { value: 100, suffix: "%", label: "Live driver visibility" },
    ],
    capabilities: [
      { icon: MapPin, title: "Real-time fleet map", body: "Every driver and every live order on one Google map, colour-coded by status and updating as they move." },
      { icon: Route, title: "One-click assign", body: "Drag or tap an order onto a driver — or let auto-assign pick the nearest available one for you." },
      { icon: Bike, title: "Own fleet + on-demand", body: "Run your own drivers first, then hand off to Uber Direct or Stuart couriers when you're stretched." },
      { icon: Clock, title: "Live ETAs", body: "Pickup and drop-off ETAs update as drivers move, so the pass and the customer always know what's next." },
      { icon: Radio, title: "Driver presence", body: "See who's online, on a job or offline at a glance, with live location and current workload per driver." },
      { icon: Activity, title: "Feeds the tracker", body: "Dispatch state flows straight to the customer's live tracking page — assigned, picked up, on the way." },
    ],
    flow: [
      { title: "Orders queue up", body: "Accepted delivery orders from every channel arrive in the dispatch queue automatically." },
      { title: "Assign a driver", body: "Auto-assign to the nearest free driver, or place it by hand from the live map." },
      { title: "Track to the door", body: "Watch the driver move pickup → drop-off with live ETAs the whole way." },
      { title: "Overflow to couriers", body: "No driver free? Dispatch to Uber Direct or Stuart on-demand without leaving the console." },
    ],
    showcases: [
      {
        eyebrow: "Live console",
        title: "The whole operation on one map",
        body: "Drivers, orders and destinations in real time. Assign with a click, watch ETAs tick down, and never lose sight of a delivery.",
        bullets: [
          "Every driver's live position",
          "Auto-assign nearest free driver",
          "Uber Direct & Stuart fallback",
        ],
        mockup: <DispatchConsoleMockup />,
      },
    ],
  },

  // ── WhatsApp AI ordering ──────────────────────────────────────────────────
  {
    slug: "whatsapp-ordering",
    name: "WhatsApp AI ordering",
    navDescription: "Take orders in the chat customers already use",
    accent: "#4ade80",
    icon: MessageCircle,
    badge: "WhatsApp ordering",
    title: "Take orders in the chat",
    subtitle:
      "Customers message your shop on WhatsApp in plain English. An AI assistant understands the order, builds the basket, sends a secure pay link and drops it on your board — no app, no phone tag.",
    highlights: ["Claude-powered NLU", "Secure Stripe pay link", "Lands on your board"],
    heroMockup: <WhatsAppChatMockup />,
    stats: [
      { value: 2, suffix: "B", label: "People already on WhatsApp" },
      { value: 0, label: "Apps to download" },
      { value: 24, suffix: "/7", label: "Always-on ordering" },
    ],
    capabilities: [
      { icon: BrainCircuit, title: "Understands plain English", body: "Claude reads free-text messages — “large pepperoni + garlic bread” — and maps them to your real menu items." },
      { icon: MessageCircle, title: "Meta Cloud API", body: "Runs on the official WhatsApp Business Cloud API on your own number — verified, reliable, no grey-market gateway." },
      { icon: CreditCard, title: "Secure Stripe pay link", body: "The assistant sends a hosted Stripe link; the customer pays in the chat and you settle direct." },
      { icon: Layers, title: "Builds the basket", body: "Sizes, modifiers and quantities are confirmed back to the customer before anything is charged." },
      { icon: ShoppingBag, title: "Lands on your board", body: "A paid WhatsApp order drops onto the same POS board and prints in the kitchen like any other channel." },
      { icon: Radio, title: "Voice ordering next", body: "The same assistant is coming to voice calls — answer the phone with AI when the kitchen is slammed." },
    ],
    flow: [
      { title: "Customer messages you", body: "They text your shop's WhatsApp number in their own words — no app, no menu link required." },
      { title: "AI builds the order", body: "Claude maps it to your menu, confirms sizes and modifiers, and totals the basket." },
      { title: "They pay in the chat", body: "A secure Stripe link closes the sale right inside WhatsApp." },
      { title: "It hits your board", body: "The paid order lands on the POS board and prints — you just make it." },
    ],
    showcases: [
      {
        eyebrow: "AI assistant",
        title: "Conversational ordering that just works",
        body: "No menus to scroll, no app to install. Customers chat the way they already do, and the assistant does the rest — right down to the pay link.",
        bullets: [
          "Natural-language understanding",
          "Confirms before it charges",
          "Pay without leaving WhatsApp",
        ],
        mockup: <WhatsAppChatMockup />,
      },
    ],
  },
];

export const SOLUTIONS_BY_SLUG: Record<string, Solution> = Object.fromEntries(
  SOLUTIONS.map((s) => [s.slug, s]),
);
