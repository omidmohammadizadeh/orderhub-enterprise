"use client";

// Printer drawer → ticket design: 1–30 text sizes, what shows on the ticket,
// and a live preview drawn by the same renderer the printer gets.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildOrderReceipt,
  buildOrderReceiptStar,
  type FontScale,
  type PrintFont,
} from "@/lib/printing/bridge";
import { receiptBytesToTickets, ticketsToHtml } from "@/lib/printing/browser-printers";
import {
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
  TEXT_SIZE_NATIVE,
  TICKET_FIELD_GROUPS,
  type TicketFieldKey,
} from "@/lib/printing/ticket-layout";

const SIZE_PRESETS: ReadonlyArray<readonly [number, string]> = [
  [7, "Small"],
  [10, "Normal"],
  [15, "Large"],
  [20, "Double"],
  [26, "Huge"],
];

/** What the old Standard / Large / Extra large presets look like on the 1–30 scale. */
export function presetToSize(scale: FontScale): number {
  return scale === "NORMAL" ? TEXT_SIZE_NATIVE : 20;
}

export function TextSizeControl({
  label,
  value,
  fallback,
  onChange,
}: {
  label: string;
  /** null = still on the old preset; the slider shows `fallback` until moved. */
  value: number | null;
  fallback: number;
  onChange: (n: number) => void;
}) {
  const shown = value ?? fallback;
  const id = `size-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <label htmlFor={id} className="sr-only">
          {label}
        </label>
        <input
          id={id}
          type="range"
          min={TEXT_SIZE_MIN}
          max={TEXT_SIZE_MAX}
          step={1}
          value={shown}
          onChange={(e) => onChange(Number(e.target.value))}
          className="h-2 flex-1 cursor-pointer accent-violet-600"
        />
        <input
          type="number"
          min={TEXT_SIZE_MIN}
          max={TEXT_SIZE_MAX}
          value={shown}
          aria-label={`${label} (1 to 30)`}
          onChange={(e) => {
            const n = Math.round(Number(e.target.value));
            if (Number.isFinite(n)) onChange(Math.min(TEXT_SIZE_MAX, Math.max(TEXT_SIZE_MIN, n)));
          }}
          className="w-16 rounded-md border border-zinc-300 px-2 py-1.5 text-center text-sm tabular-nums"
        />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {SIZE_PRESETS.map(([n, name]) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
              value === n
                ? "border-violet-600 bg-violet-50 text-violet-700"
                : "border-zinc-200 text-zinc-600 hover:border-zinc-400"
            }`}
          >
            {name} <span className="font-normal tabular-nums opacity-70">{n}</span>
          </button>
        ))}
      </div>
      {value === null && (
        <p className="text-[11px] text-zinc-500">
          Using the old size setting. Pick a number to set an exact size.
        </p>
      )}
    </div>
  );
}

export function ShowOnTicket({
  hidden,
  onChange,
}: {
  hidden: ReadonlySet<TicketFieldKey>;
  onChange: (next: Set<TicketFieldKey>) => void;
}) {
  const toggle = (key: TicketFieldKey, show: boolean) => {
    const next = new Set(hidden);
    if (show) next.delete(key);
    else next.add(key);
    onChange(next);
  };
  return (
    <div className="space-y-3">
      {TICKET_FIELD_GROUPS.map((group) => (
        <fieldset key={group.title}>
          <legend className="mb-1 text-[11px] font-semibold text-zinc-700">{group.title}</legend>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {group.fields.map(([key, label]) => (
              <label
                key={key}
                className="flex cursor-pointer items-center gap-2 rounded-md border border-zinc-200 px-2.5 py-2 text-xs text-zinc-700 hover:bg-zinc-50"
              >
                <input
                  type="checkbox"
                  checked={!hidden.has(key)}
                  onChange={(e) => toggle(key, e.target.checked)}
                  className="h-4 w-4 accent-violet-600"
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <p className="text-[11px] leading-relaxed text-zinc-500">
        Item names, and banners like ORDER CANCELLED, always print.
      </p>
    </div>
  );
}

// A busy sample order, so every switch above has something to show.
function sampleOrder(currency: string) {
  return {
    currency,
    brandName: "Your Shop",
    locationAddress: "12 High Street, Newcastle NE1 1AA",
    locationPhone: "0191 000 0000",
    customerVisitTag: "RETURNING CUSTOMER - 5th order",
    displayId: "1042",
    receivedAt: new Date().toISOString(),
    platform: "Just Eat",
    fulfillmentType: "DELIVERY",
    estimatedReadyAt: new Date(Date.now() + 35 * 60_000).toISOString(),
    customerName: "Sam Taylor",
    customerPhone: "07700 900123",
    deliveryAddress: "Flat 3, 48 Westgate Road, Newcastle NE4 6AR",
    items: [
      {
        quantity: 2,
        name: "Large Margherita Pizza",
        totalPrice: 23.98,
        modifiers: [
          { name: "Extra mozzarella", price: 1.5 },
          { name: "Stuffed crust", price: 2 },
        ],
        notes: "Well done please",
      },
      {
        quantity: 1,
        name: "Chicken Wings (8)",
        totalPrice: 6.5,
        modifiers: [{ name: "BBQ sauce" }],
      },
      { quantity: 1, name: "Coca-Cola 1.5L", totalPrice: 3.2 },
    ],
    subtotal: 37.18,
    deliveryFee: 2.99,
    serviceCharge: 0.5,
    discount: 3,
    total: 37.67,
    paymentLabel: "PAID ONLINE",
    specialInstructions: "Ring the bell, don't knock.",
  };
}

export function TicketPreview({
  paperWidth,
  star,
  printFont,
  fontScale,
  modifierScale,
  itemSize,
  modifierSize,
  boldItems,
  hidden,
  currency,
}: {
  paperWidth: number;
  star: boolean;
  printFont: PrintFont;
  fontScale: FontScale;
  modifierScale: FontScale;
  itemSize: number | null;
  modifierSize: number | null;
  boldItems: boolean;
  hidden: ReadonlySet<TicketFieldKey>;
  currency: string;
}) {
  const [html, setHtml] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(600);

  // Hidden list as a stable dependency (a Set is a new object every render).
  const hiddenKey = useMemo(() => [...hidden].sort().join(","), [hidden]);

  useEffect(() => {
    // Rasters need a canvas, so this only runs in the browser.
    const style = { hide: hidden, itemSize, modifierSize, boldItems };
    const width = paperWidth === 58 ? 58 : 80;
    const bytes = star
      ? buildOrderReceiptStar(sampleOrder(currency), width, { fontScale, modifierScale, ...style })
      : buildOrderReceipt(sampleOrder(currency), width, {
          fontScale,
          modifierScale,
          printFont,
          ...style,
        });
    setHtml(ticketsToHtml(receiptBytesToTickets(bytes, star), width));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperWidth, star, printFont, fontScale, modifierScale, itemSize, modifierSize, boldItems, hiddenKey, currency]);

  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-100 p-3">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
        Preview · {paperWidth === 58 ? 58 : 80}mm
      </p>
      <iframe
        ref={frame}
        title="Ticket preview"
        srcDoc={html}
        onLoad={() => {
          const doc = frame.current?.contentDocument;
          if (doc) setHeight(Math.max(200, doc.documentElement.scrollHeight + 8));
        }}
        style={{ height }}
        className="mx-auto block w-full max-w-[320px] rounded bg-white shadow-sm"
      />
      <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
        Sample order. The real ticket uses your logo, QR and copy settings.
      </p>
    </div>
  );
}
