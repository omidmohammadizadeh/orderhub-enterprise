"use client";

// Retail R1 — one product on the Stock & barcodes page: each variant's
// barcode, price and count, editable in place.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, Minus, Plus, ScanBarcode } from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { retailClient, type RetailProduct, type RetailVariant } from "@/lib/api/retail.client";

const errMsg = (e: any) => e?.response?.data?.message ?? e?.message ?? "Couldn't save";

export function StockProductCard({
  product,
  locationId,
  canManage,
  money,
  onChanged,
}: {
  product: RetailProduct;
  locationId: string;
  canManage: boolean;
  money: (n: number) => string;
  onChanged: () => void;
}) {
  const addFirst = useMutation({
    mutationFn: () => retailClient.createVariant(product.id, { name: "Default" }),
    onSuccess: onChanged,
    onError: (e) => toast.error(errMsg(e)),
  });

  return (
    <li className="rounded-lg border border-zinc-200 bg-white">
      <div className="flex items-center gap-3 border-b border-zinc-100 px-3 py-2">
        {product.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={product.imageUrl} alt="" className="h-8 w-8 flex-shrink-0 rounded object-cover" />
        ) : (
          <div className="h-8 w-8 flex-shrink-0 rounded bg-zinc-100" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-zinc-900">{product.name}</p>
          <p className="text-xs text-zinc-500">
            {money(product.basePrice)}
            {product.plu ? ` · ${product.plu}` : ""}
          </p>
        </div>
      </div>
      {product.variants.length === 0 ? (
        <div className="flex items-center justify-between gap-3 px-3 py-2 text-xs text-zinc-500">
          <span>No barcode yet — the till can't scan this, and its stock isn't counted.</span>
          {canManage && (
            <Button size="sm" variant="outline" loading={addFirst.isPending} onClick={() => addFirst.mutate()}>
              <ScanBarcode className="mr-1 h-3.5 w-3.5" /> Add barcode
            </Button>
          )}
        </div>
      ) : (
        <ul className="divide-y divide-zinc-100">
          {product.variants.map((v) => (
            <VariantRow
              key={v.id}
              variant={v}
              basePrice={product.basePrice}
              single={product.variants.length === 1}
              locationId={locationId}
              canManage={canManage}
              money={money}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function VariantRow({
  variant: v,
  basePrice,
  single,
  locationId,
  canManage,
  money,
  onChanged,
}: {
  variant: RetailVariant;
  basePrice: number;
  single: boolean;
  locationId: string;
  canManage: boolean;
  money: (n: number) => string;
  onChanged: () => void;
}) {
  const [barcode, setBarcode] = useState(v.barcode ?? "");
  const [counting, setCounting] = useState(false);
  const [count, setCount] = useState("");
  const low = v.trackStock && v.stock <= (v.lowStockAt ?? 0);

  const saveBarcode = useMutation({
    mutationFn: () => retailClient.updateVariant(v.id, { barcode: barcode.trim() || null }),
    onSuccess: () => {
      toast.success("Barcode saved");
      onChanged();
    },
    onError: (e) => {
      toast.error(errMsg(e));
      setBarcode(v.barcode ?? "");
    },
  });
  const adjust = useMutation({
    mutationFn: (body: { mode: "delta" | "count"; quantity: number; reason?: string }) =>
      retailClient.adjustStock(locationId, { variantId: v.id, ...body }),
    onSuccess: () => {
      setCounting(false);
      setCount("");
      onChanged();
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  const commitBarcode = () => {
    if (barcode.trim() !== (v.barcode ?? "")) saveBarcode.mutate();
  };

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 text-sm">
      <div className="w-28 min-w-0">
        <p className="truncate text-xs font-medium text-zinc-700">{single && v.name === "Default" ? "—" : v.name}</p>
        <p className="text-xs text-zinc-500">{money(v.price ?? basePrice)}</p>
      </div>

      <label className="flex min-w-0 flex-1 items-center gap-2">
        <span className="sr-only">Barcode for {v.name}</span>
        <ScanBarcode className="h-4 w-4 flex-shrink-0 text-zinc-400" aria-hidden />
        <input
          value={barcode}
          disabled={!canManage || saveBarcode.isPending}
          onChange={(e) => setBarcode(e.target.value)}
          onBlur={commitBarcode}
          onKeyDown={(e) => {
            // A scanner types into the box and presses Enter.
            if (e.key === "Enter") {
              e.preventDefault();
              commitBarcode();
            }
          }}
          placeholder={canManage ? "Scan or type a barcode" : "No barcode"}
          inputMode="numeric"
          autoComplete="off"
          className="w-full min-w-0 rounded-md border border-zinc-200 px-2 py-1 font-mono text-xs focus:border-zinc-900 focus:outline-none disabled:bg-zinc-50"
        />
      </label>

      <div className="flex items-center gap-1">
        {!v.trackStock ? (
          <span className="text-xs text-zinc-400">Not counted</span>
        ) : counting ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(count);
              if (Number.isInteger(n) && n >= 0) adjust.mutate({ mode: "count", quantity: n, reason: "Stock count" });
            }}
          >
            <input
              autoFocus
              value={count}
              onChange={(e) => setCount(e.target.value.replace(/\D/g, ""))}
              inputMode="numeric"
              aria-label={`Counted quantity of ${v.name}`}
              placeholder="On shelf"
              className="w-20 rounded-md border border-zinc-300 px-2 py-1 text-xs"
            />
            <Button type="submit" size="icon-sm" variant="outline" aria-label="Save count" loading={adjust.isPending}>
              <Check className="h-3.5 w-3.5" />
            </Button>
          </form>
        ) : (
          <>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove one ${v.name} from stock`}
              disabled={adjust.isPending}
              onClick={() => adjust.mutate({ mode: "delta", quantity: -1, reason: "Adjusted" })}
            >
              <Minus className="h-3.5 w-3.5" />
            </Button>
            <button
              type="button"
              onClick={() => setCounting(true)}
              title="Set the counted figure"
              className={`min-w-[3rem] rounded-md px-2 py-1 text-center text-sm font-semibold tabular-nums ${
                low ? "bg-amber-100 text-amber-900" : "text-zinc-900 hover:bg-zinc-100"
              }`}
            >
              {v.stock}
            </button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Add one ${v.name} to stock`}
              disabled={adjust.isPending}
              onClick={() => adjust.mutate({ mode: "delta", quantity: 1, reason: "Delivery" })}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
