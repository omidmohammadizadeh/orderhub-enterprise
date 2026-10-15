"use client";

// Content model for the six Solutions detail pages. Each entry drives the
// shared SolutionDetail template — nav label, hero, capability grid, a
// numbered "how it works" flow, and alternating showcase sections with the
// dark product mockups. Copy is written against the real product.

import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftRight,
  AudioLines,
  CalendarCheck,
  ListChecks,
  PhoneForwarded,
  Repeat2,
  StickyNote,
  UserRound,
  Activity,
  Users,
  PhoneCall,
  CalendarClock,
  Percent,
  SplitSquareHorizontal,
  QrCode,
  LayoutGrid,
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
  Barcode,
  Scale,
  Scissors,
  Gift,
  BellRing,
  Smartphone,
  Package,
  Tv,
  Wine,
  Mail,
  Star,
  Flower2,
  Receipt,
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
  FloorPlanMockup,
  SplitBillMockup,
  CallerIdMockup,
  VoiceCallMockup,
  VoiceBoardMockup,
  KitchenNoteMockup,
} from "./mockups";
import { VoiceAssembly } from "./voice-assembly";
import {
  BARBER_DIARY,
  BEAUTY_DIARY,
  BookingPageMockup,
  GroceryPickingMockup,
  GroceryTillMockup,
  LoyaltyTillMockup,
  SalonCheckoutMockup,
  SalonDiaryMockup,
  SalonReminderMockup,
  WalkInQueueMockup,
  WalletPassMockup,
} from "./industry-mockups";

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
  /** A page-specific section shown after the stats, when a page has one. */
  centerpiece?: ReactNode;
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
      { icon: Radio, title: "On the phone too", body: "The same ordering assistant answers your phone line, so the calls you can’t pick up still become orders." },
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
  {
    slug: "table-ordering",
    name: "Table ordering",
    navDescription: "QR ordering, floor plan and split bills",
    accent: "#f59e0b",
    icon: UtensilsCrossed,
    badge: "Table service",
    title: "Run the room, not just the pass",
    subtitle:
      "Build your floor plan, let guests order from a QR code on the table, keep a running tab across every round, then split the bill any way they ask. Dine-in works the way delivery already does — on the same till, the same menu and the same kitchen screen.",
    highlights: ["QR ordering at the table", "Split any bill", "Live floor plan"],
    heroMockup: <FloorPlanMockup />,
    stats: [
      { value: 0, label: "Extra tablets on the pass" },
      { value: 100, suffix: "%", label: "Of the bill you keep" },
      { value: 1, label: "Menu behind every channel" },
    ],
    capabilities: [
      { icon: LayoutGrid, title: "Your actual floor plan", body: "Drag out rooms, areas and tables in the shapes your room really has. Colour-coded live: free, seated, bill requested — with each table's running total and how long they've been sat." },
      { icon: QrCode, title: "QR ordering at the table", body: "A unique code per table. Guests scan, browse your real menu with photos, and order round after round without waving anyone down. Every order lands on the same kitchen screen." },
      { icon: SplitSquareHorizontal, title: "Split the bill properly", body: "By item or by amount. Paid items cross off the screen live so two staff can take payments at once without double-charging anybody." },
      { icon: CreditCard, title: "Pay how they like", body: "Card on your Stripe reader, cash, or a payment link sent to their phone. A declined card retries without losing the tab." },
      { icon: Percent, title: "Service charge and tips", body: "Set an automatic service charge per location, add tips at the reader, and see exactly what the team earned in reporting." },
      { icon: CalendarClock, title: "Reservations built in", body: "Take bookings from your own site straight into the diary, with covers, and mark tables unavailable so nobody double-books a table you're holding." },
      { icon: ShieldCheck, title: "Manager PIN on voids", body: "Voiding or comping a line needs a manager PIN, and every one is logged — so a busy Saturday doesn't become a stock mystery on Monday." },
      { icon: Printer, title: "Rounds print as they're sent", body: "Each round fires only its new items to the kitchen, so the pass never re-cooks a starter because someone added a side." },
    ],
    flow: [
      { title: "Lay out your room", body: "Create areas and tables once — the floor plan mirrors the room your staff actually walk." },
      { title: "Seat the table", body: "Tap a table to open a tab, or the guest scans the QR code and starts one themselves." },
      { title: "Rounds go to the kitchen", body: "Every round fires only the new items, keeping earlier tickets and their tick-states intact." },
      { title: "Pay and turn the table", body: "Settle in full or split it. The table frees itself and the order completes — no refresh, no chasing." },
    ],
    showcases: [
      {
        eyebrow: "QR at the table",
        title: "Guests order without waiting for anyone",
        body: "A code on the table opens your real menu — photos, sizes, modifiers and live sold-out flags. They add rounds through the meal and it all lands on one tab.",
        bullets: [
          "One code per table",
          "Same menu as the till",
          "Rounds land on the same tab",
        ],
        mockup: <FloorPlanMockup />,
      },
      {
        eyebrow: "Splitting up",
        title: "The awkward bit, handled",
        body: "Six people, four cards, one who only had a starter. Split by item or amount, watch paid items cross off live, and take two payments at once without anything being charged twice.",
        bullets: [
          "Split by item or amount",
          "Paid items lock instantly",
          "Retry a decline without losing the tab",
        ],
        mockup: <SplitBillMockup />,
      },
    ],
  },
  {
    slug: "caller-id",
    name: "Caller ID",
    navDescription: "The phone rings and you already know them",
    accent: "#38bdf8",
    icon: PhoneCall,
    badge: "Caller ID",
    title: "Know who's calling before you say hello",
    subtitle:
      "Plug a caller-ID box into the shop's landline and every till pops the caller's name, address and order history the moment it rings. Answer with their name, tap once, and the order is half-built before they've finished saying it.",
    highlights: ["Pops on every till", "Address pre-filled", "Order history on screen"],
    heroMockup: <CallerIdMockup />,
    stats: [
      { value: 0, suffix: "s", label: "Spent asking for their address" },
      { value: 1, label: "Tap to start their order" },
      { value: 100, suffix: "%", label: "Of tills get the pop-up" },
    ],
    capabilities: [
      { icon: PhoneCall, title: "Rings every screen at once", body: "One box on the landline, and the card appears on every till in the shop — whoever is free takes it." },
      { icon: Users, title: "Recognises returning customers", body: "Matched against your own customer records: their name, how many orders they've placed and what they usually get." },
      { icon: MapPin, title: "Address already filled in", body: "Their last delivery address is on the card and drops straight into the order — no spelling out a postcode over a busy kitchen." },
      { icon: ShoppingBag, title: "One tap to start", body: "Tap Start order and the POS opens with the customer attached. No name, no number, no retyping." },
      { icon: Sparkles, title: "New callers too", body: "An unknown number still pops, so you can take the details once and never ask for them again." },
      { icon: Clock, title: "Nothing is missed", body: "The card holds for a minute and logs against the customer, so a call taken during a rush is still there when you get back to it." },
    ],
    flow: [
      { title: "Plug in the box", body: "A caller-ID unit sits between the landline and one tablet in the shop. Ten-minute job, no rewiring." },
      { title: "The phone rings", body: "The number is read off the line and matched against your customers instantly." },
      { title: "Every till pops", body: "Name, history and last address appear on every screen at once." },
      { title: "Tap and take the order", body: "Start order opens the POS with everything already attached." },
    ],
    showcases: [
      {
        eyebrow: "On the counter",
        title: "The busiest phone in the shop, made easy",
        body: "Friday at eight, four people waiting and the phone going. Answering with “Hi Sarah, the usual to Rectory Road?” takes ten seconds instead of two minutes — and sounds like a shop that knows its regulars.",
        bullets: [
          "Answer by name",
          "Address and usual order on screen",
          "Works on every till at once",
        ],
        mockup: <CallerIdMockup />,
      },
    ],
  },
  // ── AI phone ordering ─────────────────────────────────────────────────────
  // Copy is limited to what the phone line really does today. It answers only
  // calls that ring out or arrive while the line is busy, reads every order
  // back before placing it, never cancels, and sends complaints to a person.
  {
    slug: "voice-ai",
    name: "AI phone ordering",
    navDescription: "Answers the calls you can’t get to",
    accent: "#7c83ff",
    icon: AudioLines,
    badge: "AI phone line",
    title: "The calls you can’t pick up, answered",
    subtitle:
      "When the counter is too busy to answer, the call comes through to an AI that takes the order in a normal conversation. It knows your menu, reads the whole order back, and puts it on your board and kitchen printer like any other order.",
    highlights: ["Answers when you can’t", "Reads every order back", "Prints in the kitchen"],
    heroMockup: <VoiceCallMockup />,
    centerpiece: <VoiceAssembly accent="#7c83ff" />,
    stats: [
      { value: 100, suffix: "%", label: "Of orders read back before they’re placed" },
      { value: 10, suffix: "s", label: "Calls shorter than this are never charged" },
      { value: 1, label: "Board for phone, online and app orders" },
    ],
    capabilities: [
      { icon: PhoneForwarded, title: "Only picks up when you can’t", body: "Your shop’s phone rings first. Calls that ring out, or arrive while you’re already on the phone, come through to the AI, so staff still take every call they can." },
      { icon: ListChecks, title: "Knows your real menu", body: "It works from your POS menu: the same prices, sizes, extras and sold-out items as the till. Paid extras are always charged, and cooking requests stay as notes." },
      { icon: UserRound, title: "Recognises regulars", body: "Returning callers are greeted by name and offered their usual, with their saved address ready if it’s for delivery." },
      { icon: MapPin, title: "Checks the delivery area", body: "Addresses are taken postcode first and checked against your delivery zones before the order goes any further." },
      { icon: Repeat2, title: "Reads every order back", body: "Items, extras, collection or delivery and the total are read back in full. Nothing is placed until the caller says yes." },
      { icon: Wallet, title: "Cash or card", body: "Cash orders go straight through. Card orders get a secure payment link by text, and the order waits until it’s paid." },
      { icon: StickyNote, title: "Handles calls about an order", body: "Callers can check on an order, add to one placed by phone or at the till, or pass a note to the kitchen that prints straight away." },
      { icon: CalendarCheck, title: "Books tables too", body: "If your location takes reservations, callers can book, change or cancel a table over the phone." },
      { icon: ArrowLeftRight, title: "Hands over when it should", body: "Complaints go to a member of staff. It never cancels an order, and delivery-app customers are told to contact the app they ordered through." },
    ],
    flow: [
      { title: "Get your AI number", body: "We set up a phone number for your shop and connect it to your menu, board and kitchen printer." },
      { title: "Divert unanswered calls", body: "Your phone provider sends calls that ring out, or arrive while you’re busy, to that number." },
      { title: "Add a number for staff", body: "Give the AI a separate number to hand calls to, so a complaint always reaches a person." },
      { title: "Top up and go live", body: "Answered calls are paid from a prepaid balance, with automatic top-up so the line never goes quiet." },
    ],
    showcases: [
      {
        eyebrow: "On the board",
        title: "A phone order looks like every other order",
        body: "No notepad by the phone and no separate screen. Orders the AI takes arrive on the same board as your online and delivery-app orders, marked AI Voice, and print on the same kitchen printer.",
        bullets: [
          "Marked AI Voice on the board",
          "Prints and shows on kitchen screens",
          "Customer and order history attached",
        ],
        mockup: <VoiceBoardMockup />,
      },
      {
        eyebrow: "After the order",
        title: "Changes and notes, without the phone tag",
        body: "A customer rings back to add a drink, ask how long their order will be, or have the pizza cut into squares. The AI updates the order, gives them the status, or sends the note to the kitchen, where it prints clearly marked so nothing is cooked twice.",
        bullets: [
          "Adds to orders taken by phone or at the till",
          "Order status on request",
          "Notes print marked do not remake",
        ],
        mockup: <KitchenNoteMockup />,
      },
    ],
  },
  // ── Loyalty card ──────────────────────────────────────────────────────────
  // The walk-in card: an Apple / Google Wallet pass the till scans. Works for
  // every business type — cafés, takeaways, shops and salons.
  {
    slug: "loyalty-card",
    name: "Loyalty card",
    navDescription: "A stamp card in their phone’s wallet",
    accent: "#f472b6",
    icon: Gift,
    badge: "Loyalty card",
    title: "The stamp card that never gets lost",
    subtitle:
      "Customers join in seconds with just an email and add your card to Apple Wallet or Google Wallet. Scan it at the till, the stamp lands when the sale is paid, and the card on their phone updates by itself. No app to download, no paper cards in the bin.",
    highlights: ["Apple & Google Wallet", "Scanned at the till", "Works online too"],
    heroMockup: <WalletPassMockup />,
    stats: [
      { value: 0, label: "Apps for customers to download" },
      { value: 1, label: "Scan to add a stamp" },
      { value: 34, label: "Stamp icons to match your shop" },
    ],
    capabilities: [
      { icon: Smartphone, title: "Lives in their wallet", body: "A real Apple Wallet and Google Wallet pass with your name, your colours and their stamps — always on their phone, never left at home." },
      { icon: ScanLine, title: "Scan at the till", body: "The till’s scanner reads the card’s QR. The customer is attached to the sale and their stamp is added the moment it’s paid." },
      { icon: BellRing, title: "Updates by itself", body: "Stamps and rewards appear on the pass straight away. Nobody has to reopen anything or refresh a page." },
      { icon: Gift, title: "Rewards spent at the till", body: "When the card is full the reward shows on the till. One tap redeems it, and it can only be used once." },
      { icon: Mail, title: "Join with an email", body: "Customers sign up at the counter or from a QR on the window. A new phone? A code by email brings the same card back." },
      { icon: Globe, title: "Same card online", body: "Customers who order from your website see the same card on their Rewards page, so in-store and online stamps count together." },
      { icon: Star, title: "Your look", body: "Pick from 34 stamp icons — coffee, pizza, scissors, flowers and more — and choose how many stamps earn the reward." },
      { icon: Users, title: "Grows your list", body: "Members can opt in to your email offers when they join, so every regular becomes someone you can bring back." },
      { icon: Store, title: "Any kind of business", body: "Cafés, takeaways, supermarkets, salons and barbers all use the same card — stamps per visit or per purchase." },
    ],
    flow: [
      { title: "Design your card", body: "Name it, pick the stamp icon and how many stamps earn the reward." },
      { title: "Customer joins", body: "They scan the QR at the counter, enter their email and tap Add to Apple Wallet or Google Wallet." },
      { title: "Scan at the till", body: "Every visit, the till scans the card. The stamp lands when the sale is paid." },
      { title: "Reward redeemed", body: "A full card shows the reward on the till. One tap and it’s theirs." },
    ],
    showcases: [
      {
        eyebrow: "At the counter",
        title: "Stamping a card takes one scan",
        body: "Hold the customer’s phone under the scanner and their card is on the sale: their name, how many stamps they have and what they’re working towards. No fiddling with a stamp, no forgotten cards.",
        bullets: ["Customer attached to the sale", "Stamp added when it’s paid", "Reward redeemed in one tap"],
        mockup: <LoyaltyTillMockup />,
      },
    ],
  },
  // ── Supermarkets & convenience ────────────────────────────────────────────
  {
    slug: "supermarkets",
    name: "Supermarkets & convenience",
    navDescription: "Scan till, stock, weighed goods and online grocery",
    accent: "#22c55e",
    icon: Barcode,
    badge: "Supermarkets & convenience stores",
    title: "A till built for the corner shop and the supermarket",
    subtitle:
      "Scan barcodes, weigh fruit and veg, check ID for age-restricted items and run multi-buy deals — with stock that counts itself down every time you sell. Then put the same shelves online for delivery and collection.",
    highlights: ["Barcode scan till", "Stock that counts itself", "Online grocery orders"],
    heroMockup: <GroceryTillMockup />,
    stats: [
      { value: 1, label: "Scan per item at the till" },
      { value: 3, label: "Multi-buy deal types built in" },
      { value: 100, suffix: "%", label: "Of sales taken off stock automatically" },
    ],
    capabilities: [
      { icon: Barcode, title: "Scan till", body: "Use a USB or Bluetooth scanner, or the tablet’s camera. Products with sizes and variants each get their own barcode." },
      { icon: Scale, title: "Weighed goods", body: "Sell by the kilo or per 100 g. Key the weight in, or scan the label from your shop scale and the price comes straight off it." },
      { icon: Wine, title: "Age checks", body: "Mark alcohol, tobacco and knives 16+ or 18+. The till asks for an ID check once per sale and records who did it." },
      { icon: Tags, title: "Multi-buy deals", body: "Any 3 for £5, buy one get the cheapest free, and meal deals — applied automatically on the till and online." },
      { icon: Package, title: "Stock that counts itself", body: "Every sale, return and delivery in is logged per shop. Receive stock, see what’s low and export it to a spreadsheet." },
      { icon: Receipt, title: "Returns from the receipt", body: "Every receipt has a QR. Scan it, tick what’s coming back and refund to cash or card — the items go back into stock." },
      { icon: Globe, title: "Online grocery", body: "Your shelves on your own website for delivery or collection. Sold-out items hide themselves, and customers pick substitutes." },
      { icon: ListChecks, title: "Picking screen", body: "Staff pick online orders from a phone: swap an item, weigh meat and veg, and anything you’re out of is refunded automatically." },
      { icon: CreditCard, title: "Cash, card and contactless", body: "Cash with change and the drawer, Stripe or Dojo card machines, and the loyalty card scanned on the same till." },
    ],
    flow: [
      { title: "Import your products", body: "Upload a spreadsheet of names, prices and barcodes — leading zeros kept, nothing deleted." },
      { title: "Scan and sell", body: "Plug in a scanner and start ringing sales through on day one." },
      { title: "Stock looks after itself", body: "Every sale counts down. Receive deliveries in and check what’s low." },
      { title: "Go online", body: "Switch on delivery and collection and your shelves are on your own website." },
    ],
    showcases: [
      {
        eyebrow: "Online orders",
        title: "Pick, swap and refund from one phone",
        body: "An online order lands, and whoever is on the shop floor picks it from their phone. If something’s out, they swap it for what the customer allowed or mark it short — and the difference is refunded without anyone touching a card machine.",
        bullets: ["Customer-approved substitutes", "Weighed items charged by the real weight", "Shortfalls refunded automatically"],
        mockup: <GroceryPickingMockup />,
      },
      {
        eyebrow: "Keep them coming back",
        title: "A loyalty card for your regulars",
        body: "Give your regulars a stamp card in their phone’s wallet. Scan it with the same scanner you use for products, and the stamp lands when they pay.",
        bullets: ["Apple & Google Wallet", "Same scanner as your products", "Rewards spent at the till"],
        mockup: <LoyaltyTillMockup />,
      },
    ],
  },
  // ── Beauty salons ─────────────────────────────────────────────────────────
  {
    slug: "beauty-salons",
    name: "Beauty salons",
    navDescription: "Bookings, deposits, diary and checkout for salons",
    accent: "#e879f9",
    icon: Flower2,
    badge: "Beauty, nail & hair salons",
    title: "Your salon’s diary, bookings and till in one place",
    subtitle:
      "Clients book online from your Instagram or Google link, pay a deposit to hold the slot, and get reminders without you lifting a finger. Your team’s diary, colour processing times, checkout with tips and products — all on the same system.",
    highlights: ["Online booking 24/7", "Deposits stop no-shows", "Reminders sent for you"],
    heroMockup: <BookingPageMockup />,
    stats: [
      { value: 24, suffix: "/7", label: "Online booking from your own link" },
      { value: 0, label: "Reminder texts to send by hand" },
      { value: 1, label: "Diary for the whole team" },
    ],
    capabilities: [
      { icon: CalendarCheck, title: "Online booking", body: "Your own booking page for Instagram, Google and your website. Clients pick the treatment, who with — or anyone — and a free time." },
      { icon: ShieldCheck, title: "Deposits", body: "Take a fixed, percentage or full deposit to hold a slot. Cancel in time and it’s refunded on its own; a no-show keeps it." },
      { icon: LayoutGrid, title: "Team diary", body: "One column per stylist, drag to move, drop onto someone else to hand it over. Hours, lunch and time off are shaded." },
      { icon: Clock, title: "Processing gaps", body: "While colour develops the stylist shows free, so a quick brow or fringe trim can slot into the gap." },
      { icon: Sparkles, title: "Services & add-ons", body: "Lengths, clean-down time, add-ons, “from” prices, senior and junior prices, and a patch-test flag." },
      { icon: BellRing, title: "Reminders & rebooking", body: "Confirmation, a reminder the day before, a review request after, and a nudge when it’s time for their next visit." },
      { icon: CreditCard, title: "Checkout with tips", body: "Add retail products and a tip, scan their loyalty card, then take cash, card machine or a payment link." },
      { icon: Users, title: "Commission & reports", body: "Takings, tips, commission due per stylist, how full each book was, no-shows and new clients." },
      { icon: ArrowLeftRight, title: "Move from your old system", body: "Import your price list and client list from Fresha, Booksy, Treatwell, Square or a spreadsheet." },
    ],
    flow: [
      { title: "Add your services", body: "Import your price list or start from a typical salon list and edit it." },
      { title: "Add your team", body: "Their hours, the treatments they do, their prices and commission." },
      { title: "Share your link", body: "Put the booking link on Instagram, Google and your website." },
      { title: "Bookings roll in", body: "They land in the diary live, deposits paid and reminders already scheduled." },
    ],
    showcases: [
      {
        eyebrow: "The diary",
        title: "Everyone’s day on one screen",
        body: "See the whole team at a glance. Colour processing time shows as free so you can fit a quick job in, online bookings appear as they’re made, and every tablet in the salon updates live.",
        bullets: ["One column per stylist", "Drag to move or hand over", "Processing gaps you can book into"],
        mockup: <SalonDiaryMockup accent="#e879f9" staff={BEAUTY_DIARY} />,
      },
      {
        eyebrow: "Checkout",
        title: "Treatment, products and tip in one go",
        body: "Set the final price on a “from” service, add the shampoo they’re taking home and a tip. The deposit they paid online comes off the total automatically.",
        bullets: ["Deposit taken off the bill", "Tips tracked per stylist", "Loyalty card scanned at the till"],
        mockup: <SalonCheckoutMockup accent="#e879f9" />,
      },
      {
        eyebrow: "Keeps them coming back",
        title: "Reminders and reviews, sent for you",
        body: "Every booking gets a confirmation with a link to change or cancel, a reminder the day before, a Google review request after the visit, and a nudge when it’s time to book again.",
        bullets: ["Fewer no-shows", "More Google reviews", "Clients rebook on their own"],
        mockup: <SalonReminderMockup accent="#e879f9" />,
      },
    ],
  },
  // ── Hair & barber shops ───────────────────────────────────────────────────
  {
    slug: "barbers",
    name: "Hair & barber shops",
    navDescription: "Walk-in queue, bookings and a TV by the door",
    accent: "#f59e0b",
    icon: Scissors,
    badge: "Hair & barber shops",
    title: "Walk-ins and bookings, in the same chair",
    subtitle:
      "Customers join the queue from a QR in the window and see their real wait, worked out against the bookings already in. Online booking, a TV screen by the door, quick sales and a till that pays out tips and commission — built for a busy barber shop.",
    highlights: ["Walk-in queue with real waits", "Online booking", "TV queue screen"],
    heroMockup: <WalkInQueueMockup />,
    stats: [
      { value: 0, label: "Chairs promised that are already booked" },
      { value: 1, label: "QR in the window to join the queue" },
      { value: 24, suffix: "/7", label: "Online booking from your own link" },
    ],
    capabilities: [
      { icon: Users, title: "Walk-in queue", body: "Add walk-ins at the counter, or let customers join from the window QR. Waits are worked out against real bookings." },
      { icon: Tv, title: "TV by the door", body: "A queue screen for the shop TV: who’s in the chair, who’s next and the QR to join." },
      { icon: Smartphone, title: "Their place on their phone", body: "Customers who join by QR get a live page with their place, so they can grab a coffee instead of waiting inside." },
      { icon: CalendarCheck, title: "Online booking", body: "Your booking link for Instagram and Google. Customers pick the cut, the barber — or anyone — and a time." },
      { icon: LayoutGrid, title: "Barber diary", body: "One column per barber with split shifts and time off. Drag a booking to move it or hand it to someone else." },
      { icon: Banknote, title: "Quick sale", body: "A cut that never touched the diary? Ring it through in seconds — cash, card machine or payment link." },
      { icon: Percent, title: "Tips & commission", body: "Tips at checkout and commission per barber, worked out for you in the reports." },
      { icon: BellRing, title: "Time for a trim", body: "An email when it’s time for their next cut (three weeks by default) and a review request after they pay." },
      { icon: Gift, title: "Loyalty card", body: "A stamp card in their phone’s wallet — say every tenth cut free, scanned at the till." },
    ],
    flow: [
      { title: "Switch to barber shop", body: "Start from a typical barber price list and add your team." },
      { title: "Put up the QR", body: "Print the window QR and open the queue screen on the shop TV." },
      { title: "Share your booking link", body: "Add it to Instagram and Google so regulars can book a time." },
      { title: "Cut, pay, repeat", body: "Call the next one up, take payment, and the next person’s wait updates." },
    ],
    showcases: [
      {
        eyebrow: "The diary",
        title: "Bookings and walk-ins side by side",
        body: "Bookings, walk-ins and online appointments sit in the same diary, so the queue knows which chairs are really free. Nobody is told ten minutes when the next slot is booked.",
        bullets: ["One column per barber", "Walk-ins fitted around bookings", "Every till updates live"],
        mockup: <SalonDiaryMockup accent="#f59e0b" staff={BARBER_DIARY} />,
      },
      {
        eyebrow: "Online booking",
        title: "Your booking link, everywhere",
        body: "Regulars book their usual barber from Instagram or Google at midnight. They get a confirmation with a link to change it, and a reminder the day before.",
        bullets: ["“Anyone available” option", "Change or cancel from the email", "Optional deposit for no-shows"],
        mockup: (
          <BookingPageMockup
            accent="#f59e0b"
            shop="Sharp Lines"
            service="Skin fade"
            price="£22"
            staff={["Anyone", "Marco", "Leon", "Ali"]}
          />
        ),
      },
    ],
  },
];

export const SOLUTIONS_BY_SLUG: Record<string, Solution> = Object.fromEntries(
  SOLUTIONS.map((s) => [s.slug, s]),
);
