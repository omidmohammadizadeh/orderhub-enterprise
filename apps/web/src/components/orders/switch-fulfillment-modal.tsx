"use client";

// "Actually, can you bring it?"
//
// A customer rings back and the order changes shape. Until now that meant
// voiding it and keying the whole thing again, losing the number the kitchen
// is already working to.
//
// Switching TO delivery is the side that needs care: it asks for the address
// and looks the fee up from the shop's own delivery zones — the same lookup
// the POS cart uses — so the money matches what the till would have charged.
// Switching to collection only has to confirm, because it takes an address
// away rather than inventing one.

import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Bike, ShoppingBag } from "lucide-react";
import { apiClient } from "@/lib/api/client";
import { deliveryZonesClient } from "@/lib/api/pos.client";
import {
  DeliveryAddressField,
  type DeliveryAddressValue,
} from "@/components/pos/delivery-address-field";
import { useCurrency } from "@/hooks/use-currency";
import { Button } from "@/components/ui/button";

export function SwitchFulfillmentModal({
  open,
  orderId,
  locationId,
  to,
  onClose,
}: {
  open: boolean;
  orderId: string | null;
  locationId?: string | null;
  /** The type we are switching TO. */
  to: "PICKUP" | "DELIVERY";
  onClose: () => void;
}) {
  const { money } = useCurrency();
  const queryClient = useQueryClient();
  const [addr, setAddr] = useState<DeliveryAddressValue>({});
  const [fee, setFee] = useState<number>(0);
  const [feeNote, setFeeNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAddr({});
    setFee(0);
    setFeeNote(null);
  }, [open]);

  // Postcode → zone fee, debounced, exactly as the POS cart does it. The
  // operator can still overwrite the number: a shop that waives the fee for a
  // regular should not have to argue with the form.
  // Postcode OR area — the zone rows decide which one prices the order, which
  // is why both go to the same lookup the till uses. A Gulf shop prices on the
  // area and has no postcode at all, so keying this on postcode alone left the
  // fee stuck at zero for every one of them.
  const postcode = (addr.postcode ?? "").trim();
  const area = (addr.area ?? "").trim();
  useEffect(() => {
    if (!open || to !== "DELIVERY" || !locationId) return;
    if (!postcode && !area) {
      setFeeNote(null);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      try {
        const lookup = await deliveryZonesClient.lookup(locationId, {
          postcode: postcode || undefined,
          area: area || undefined,
        });
        if (cancelled) return;
        if (lookup.matched) {
          setFee(Number(lookup.fee ?? 0));
          setFeeNote(`Delivery fee ${money(Number(lookup.fee ?? 0))} from this shop's zones`);
        } else if (lookup.unserviceable) {
          setFee(0);
          setFeeNote("This shop doesn't deliver there — add the area first if you want to.");
        } else {
          setFeeNote("No zone matched this address — set the fee by hand.");
        }
      } catch {
        if (!cancelled) setFeeNote("Couldn't check the zone — set the fee by hand.");
      }
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [open, to, locationId, postcode, area, money]);

  if (!open || !orderId) return null;

  const toDelivery = to === "DELIVERY";
  const canSave =
    !saving && (!toDelivery || (addr.addressLine1 ?? "").trim().length > 0);

  async function save() {
    if (!orderId) return;
    setSaving(true);
    try {
      await apiClient.patch(`/v1/orders/${orderId}/fulfillment`, {
        fulfillmentType: to,
        ...(toDelivery
          ? {
              deliveryAddress: {
                line1: (addr.addressLine1 ?? "").trim(),
                line2: (addr.addressLine2 ?? "").trim() || undefined,
                city: (addr.city ?? "").trim() || undefined,
                postcode: postcode || undefined,
              },
              deliveryFee: fee,
            }
          : {}),
      });
      toast.success(
        toDelivery
          ? "Switched to delivery — the ticket has been reprinted"
          : "Switched to collection — the delivery address has been removed",
      );
      queryClient.invalidateQueries({ queryKey: ["orders", "live"] });
      onClose();
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Couldn't switch this order");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4"
      onClick={() => !saving && onClose()}
    >
      <div
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900">
          {toDelivery ? (
            <Bike className="h-4 w-4" />
          ) : (
            <ShoppingBag className="h-4 w-4" />
          )}
          {toDelivery ? "Switch to delivery" : "Switch to collection"}
        </h2>

        {toDelivery ? (
          <>
            <p className="mt-1 text-xs text-zinc-500">
              Search the address the same way the till does. The fee comes
              from this shop&rsquo;s delivery zones and is added to the total.
            </p>
            <div className="mt-4 space-y-3">
              <DeliveryAddressField
                draft={addr}
                set={(patch) => setAddr((prev) => ({ ...prev, ...patch }))}
                locationId={locationId}
                label="Deliver to"
              />
              <label className="block text-xs font-medium text-zinc-600">
                Delivery fee
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={fee}
                  onChange={(e) => setFee(Number(e.target.value))}
                  className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
                />
              </label>
              {feeNote && <p className="text-[11px] text-zinc-500">{feeNote}</p>}
            </div>
          </>
        ) : (
          <p className="mt-2 text-sm text-zinc-600">
            The delivery address will be removed and the delivery fee taken off
            the total. The kitchen ticket reprints so whoever hands it over
            knows the customer is coming in for it.
          </p>
        )}

        <div className="mt-5 flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            disabled={saving}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="flex-1"
            disabled={!canSave}
            onClick={save}
          >
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {toDelivery ? "Switch to delivery" : "Switch to collection"}
          </Button>
        </div>
      </div>
    </div>
  );
}
