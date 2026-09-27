'use client';

// Retail R1 — "what do you sell here?" on the Add location form.
//
// A preset, not a fork: it decides how the till opens (scan mode for shops),
// whether a paid counter sale finishes on the spot, and which setup screens
// the shop is pointed at. Everything stays available to every type, so
// picking the wrong one is fixed by picking again.

import { Shirt, ShoppingBasket, UtensilsCrossed } from 'lucide-react';
import type { BusinessType } from '@/lib/api/locations.client';

const OPTIONS: Array<{
  value: BusinessType;
  label: string;
  hint: string;
  Icon: typeof Shirt;
}> = [
  {
    value: 'RESTAURANT',
    label: 'Restaurant / takeaway',
    hint: 'Menus, modifiers, kitchen tickets and the KDS.',
    Icon: UtensilsCrossed,
  },
  {
    value: 'GROCERY',
    label: 'Grocery / convenience',
    hint: 'Scan barcodes at the till, count stock, fast local delivery.',
    Icon: ShoppingBasket,
  },
  {
    value: 'RETAIL',
    label: 'Retail shop',
    hint: 'Clothes, shoes, gifts — sizes and colours, each with its own barcode.',
    Icon: Shirt,
  },
];

export function BusinessTypePicker({
  value,
  onChange,
  disabled,
}: {
  value: BusinessType;
  onChange: (v: BusinessType) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Business type" className="grid gap-2 sm:grid-cols-3">
      {OPTIONS.map(({ value: v, label, hint, Icon }) => {
        const active = v === value;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`${label} — ${hint}`}
            disabled={disabled}
            onClick={() => onChange(v)}
            className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition ${
              active
                ? 'border-zinc-900 bg-zinc-900 text-white'
                : 'border-zinc-200 bg-white text-zinc-900 hover:border-zinc-400'
            } disabled:cursor-not-allowed disabled:opacity-60`}
          >
            <Icon className={`h-4 w-4 ${active ? 'text-white' : 'text-zinc-500'}`} />
            <span className="text-xs font-semibold">{label}</span>
            <span className={`text-[11px] leading-snug ${active ? 'text-zinc-300' : 'text-zinc-500'}`}>
              {hint}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export const isShopType = (t: BusinessType | null | undefined) => t === 'GROCERY' || t === 'RETAIL';
