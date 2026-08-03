"use client";

// The shared basket, as everyone in a group order sees it.
//
// It deliberately looks like the ordinary cart panel — same slide-in, same
// totals footer — with one difference that is the whole point of the feature:
// lines are grouped BY PERSON, so a six-way office lunch reads as six little
// orders rather than one wall of items. That grouping is also what the kitchen
// ticket uses, so what the group sees is what the shop bags.
//
// Who sees what:
//   • everyone — the share link, everyone's lines, the running total
//   • you      — a Remove button on your OWN lines only (the API enforces it
//                too; the ref in the browser is the only credential there is)
//   • the host — Close basket, then the checkout form and Place order
//   • guests   — "waiting for <host>", and what their own share comes to

import { useState } from "react";
import {
  Check,
  ChevronRight,
  Copy,
  Link2,
  Loader2,
  Lock,
  LockOpen,
  Search,
  Trash2,
  Users,
  X,
} from "lucide-react";
import type { GroupOrderView } from "@/lib/api/group-orders.client";
import { AddressSearchField } from "@/components/storefront/address-search-field";

export interface GroupBasketPanelProps {
  basket: GroupOrderView;
  myRef: string;
  shareUrl: string;
  onClose: () => void;

  /** Remove one of your own lines. */
  onRemoveItem: (itemId: string) => void;
  removingItemId: string | null;

  // Host controls
  onLock: () => void;
  onUnlock: () => void;
  onPlace: () => void;
  onCancel: () => void;
  isLocking: boolean;
  isPlacing: boolean;
  actionError: string | null;

  // Checkout fields — owned by the storefront page so the postcode lookup,
  // delivery-zone matching and signed-in-customer prefill all keep working
  // exactly as they do for an ordinary order.
  customerName: string;
  setCustomerName: (v: string) => void;
  customerPhone: string;
  setCustomerPhone: (v: string) => void;
  customerEmail: string;
  setCustomerEmail: (v: string) => void;
  addrFlat: string;
  setAddrFlat: (v: string) => void;
  addrLine1: string;
  setAddrLine1: (v: string) => void;
  addrCity: string;
  setAddrCity: (v: string) => void;
  addrPostcode: string;
  setAddrPostcode: (v: string) => void;
  paymentMethod: "CASH" | "CARD";
  setPaymentMethod: (v: "CASH" | "CARD") => void;
  acceptsCash: boolean;
  acceptsCard: boolean;
  notes: string;
  setNotes: (v: string) => void;
  deliveryFee: number;
  matchedZone: { prefix: string; fee: number; minOrder: number | null } | null;
  postcodeSuggestions: Array<{
    id: string;
    label: string;
    line1: string;
    line2?: string;
    city?: string;
    postcode?: string;
  }>;
  postcodeLookupNote: string | null;
  postcodeLookupLoading: boolean;
  onPostcodeLookup: () => void;
  onPickPostcodeSuggestion: (s: {
    line1: string;
    line2?: string;
    city?: string;
    postcode?: string;
  }) => void;
}

export function GroupBasketPanel(props: GroupBasketPanelProps) {
  const {
    basket,
    myRef,
    shareUrl,
    onClose,
    onRemoveItem,
    removingItemId,
    onLock,
    onUnlock,
    onPlace,
    onCancel,
    isLocking,
    isPlacing,
    actionError,
  } = props;

  const [copied, setCopied] = useState(false);
  const isHost = basket.isHost;
  const isDelivery = basket.fulfillmentType === "DELIVERY";
  const open = basket.status === "OPEN";
  const locked = basket.status === "LOCKED";

  const deliveryFee = isDelivery ? props.deliveryFee : 0;
  const total = Math.round((basket.subtotal + deliveryFee) * 100) / 100;
  const myShare =
    basket.people.find((p) => p.ref === myRef)?.total ?? 0;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is blocked on insecure origins and in some in-app
      // browsers — select the text instead so they can copy by hand.
      const el = document.getElementById("group-share-url") as HTMLInputElement | null;
      el?.select();
    }
  };

  const canPlace =
    locked &&
    basket.items.length > 0 &&
    props.customerName.trim().length > 0 &&
    props.customerPhone.trim().length > 0 &&
    (!isDelivery ||
      (props.addrLine1.trim() && props.addrCity.trim() && props.addrPostcode.trim()));

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-md flex-col overflow-hidden bg-white shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900">
              <Users className="h-4 w-4 text-orange-500" />
              {basket.hostName ? `${basket.hostName}'s group order` : "Group order"}
            </h2>
            <p className="mt-0.5 text-[11px] text-zinc-500">
              {basket.people.length === 0
                ? "No one has added anything yet"
                : `${basket.people.length} ${
                    basket.people.length === 1 ? "person" : "people"
                  } · ${basket.items.length} ${
                    basket.items.length === 1 ? "item" : "items"
                  } · ${isDelivery ? "Delivery" : "Collection"}`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
          {/* Share link — the only way anyone else gets in, so it stays at
              the top for as long as the basket is open. */}
          {open && (
            <div className="rounded-lg border border-orange-200 bg-orange-50 p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-orange-900">
                <Link2 className="h-3.5 w-3.5" /> Share this link
              </p>
              <p className="mt-0.5 text-[11px] text-orange-800">
                Anyone with it can add their own items until the basket is
                closed.
              </p>
              <div className="mt-2 flex gap-1.5">
                <input
                  id="group-share-url"
                  readOnly
                  value={shareUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  className="min-w-0 flex-1 rounded-md border border-orange-200 bg-white px-2 py-1.5 text-[11px] text-zinc-700 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={copyLink}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md bg-orange-500 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-orange-600"
                >
                  {copied ? (
                    <>
                      <Check className="h-3 w-3" /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3" /> Copy
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {locked && (
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-700">
              <p className="flex items-center gap-1.5 font-semibold text-zinc-900">
                <Lock className="h-3.5 w-3.5" /> Basket closed
              </p>
              <p className="mt-0.5 text-[11px] text-zinc-600">
                {isHost
                  ? "No one can add anything else. Fill in your details below to place the order."
                  : `${basket.hostName ?? "The host"} is checking out. Nothing else can be added.`}
              </p>
            </div>
          )}

          {/* Everyone's lines, grouped by person. */}
          {basket.people.length === 0 ? (
            <p className="py-10 text-center text-sm text-zinc-400">
              Nothing in the basket yet — add something from the menu.
            </p>
          ) : (
            basket.people.map((person) => {
              const mine = person.ref === myRef;
              const lines = basket.items.filter((i) => i.addedByRef === person.ref);
              return (
                <div
                  key={person.ref}
                  className={`rounded-lg border p-3 ${
                    mine ? "border-orange-200 bg-orange-50/40" : "border-zinc-200"
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-xs font-semibold text-zinc-900">
                      {person.name}
                      {mine && (
                        <span className="ml-1 rounded-full bg-orange-500 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">
                          You
                        </span>
                      )}
                    </p>
                    <p className="shrink-0 text-xs font-semibold text-zinc-900">
                      £{person.total.toFixed(2)}
                    </p>
                  </div>
                  <ul className="mt-2 space-y-2">
                    {lines.map((line) => (
                      <li key={line.id} className="flex items-start gap-2">
                        <span className="mt-0.5 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-bold text-zinc-600">
                          {line.quantity}×
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs text-zinc-800">
                            {line.cartItem?.name ?? "Item"}
                          </p>
                          {!!line.cartItem?.modifiers?.length && (
                            <p className="text-[11px] leading-snug text-zinc-500">
                              {line.cartItem.modifiers
                                .map((m) => m.name)
                                .join(", ")}
                            </p>
                          )}
                          {line.cartItem?.notes && (
                            <p className="text-[11px] italic text-zinc-400">
                              {line.cartItem.notes}
                            </p>
                          )}
                        </div>
                        <span className="shrink-0 text-xs text-zinc-700">
                          £{line.lineTotal.toFixed(2)}
                        </span>
                        {mine && open && (
                          <button
                            type="button"
                            onClick={() => onRemoveItem(line.id)}
                            disabled={removingItemId === line.id}
                            title="Remove"
                            className="shrink-0 rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                          >
                            {removingItemId === line.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })
          )}

          {/* Host checkout form — only once the basket is closed, so the
              total the host is agreeing to can't move underneath them. */}
          {isHost && locked && (
            <div className="space-y-4 border-t border-zinc-200 pt-4">
              <Section title="Your details">
                <Field
                  value={props.customerName}
                  onChange={props.setCustomerName}
                  placeholder="Your name"
                />
                <Field
                  value={props.customerPhone}
                  onChange={props.setCustomerPhone}
                  placeholder="Phone number"
                  type="tel"
                />
                <Field
                  value={props.customerEmail}
                  onChange={props.setCustomerEmail}
                  placeholder="Email (for the receipt)"
                  type="email"
                />
              </Section>

              {isDelivery && (
                <Section title="Delivery address">
                  {/* Same search the ordinary cart has — the host is placing a
                      real delivery order and shouldn't get a worse address
                      form for having used the group flow. */}
                  <AddressSearchField
                    onPick={(a) => {
                      if (a.line1) props.setAddrLine1(a.line1);
                      if (a.city) props.setAddrCity(a.city);
                      if (a.postcode)
                        props.setAddrPostcode(a.postcode.toUpperCase());
                    }}
                  />
                  <Field
                    value={props.addrFlat}
                    onChange={props.setAddrFlat}
                    placeholder="House / flat number"
                  />
                  <Field
                    value={props.addrLine1}
                    onChange={props.setAddrLine1}
                    placeholder="Street name"
                  />
                  <div className="grid grid-cols-[1fr,1fr,auto] gap-1.5">
                    <input
                      value={props.addrCity}
                      onChange={(e) => props.setAddrCity(e.target.value)}
                      placeholder="City"
                      className="min-w-0 rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
                    />
                    <input
                      value={props.addrPostcode}
                      onChange={(e) =>
                        props.setAddrPostcode(e.target.value.toUpperCase())
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          props.onPostcodeLookup();
                        }
                      }}
                      placeholder="Postcode"
                      className="min-w-0 rounded-md border border-zinc-200 px-2 py-1.5 text-xs uppercase focus:border-zinc-900 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={props.onPostcodeLookup}
                      disabled={
                        props.postcodeLookupLoading ||
                        props.addrPostcode.trim().length < 5
                      }
                      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-zinc-300 bg-white px-2.5 text-[11px] font-medium hover:bg-zinc-50 disabled:opacity-50"
                    >
                      {props.postcodeLookupLoading ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Search className="h-3 w-3" />
                      )}
                      Find
                    </button>
                  </div>
                  {props.postcodeLookupNote && (
                    <p className="text-[11px] text-zinc-500">
                      {props.postcodeLookupNote}
                    </p>
                  )}
                  {props.postcodeSuggestions.length > 0 && (
                    <ul className="max-h-40 overflow-y-auto rounded-md border border-zinc-200 bg-white">
                      {props.postcodeSuggestions.map((s) => (
                        <li key={s.id}>
                          <button
                            type="button"
                            onClick={() => props.onPickPostcodeSuggestion(s)}
                            className="w-full px-2 py-1.5 text-left text-[11px] leading-snug hover:bg-zinc-50"
                          >
                            {s.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {props.matchedZone && (
                    <p className="text-[11px] text-emerald-700">
                      Matched zone <strong>{props.matchedZone.prefix}</strong> · £
                      {props.matchedZone.fee.toFixed(2)} delivery
                    </p>
                  )}
                  {!props.matchedZone && props.addrPostcode.length >= 3 && (
                    <p className="text-[11px] text-amber-600">
                      No matching delivery zone — restaurant may not deliver
                      here.
                    </p>
                  )}
                </Section>
              )}

              <Section title="Payment">
                <div className="flex gap-2">
                  {props.acceptsCash && (
                    <Toggle
                      active={props.paymentMethod === "CASH"}
                      onClick={() => props.setPaymentMethod("CASH")}
                    >
                      Cash
                    </Toggle>
                  )}
                  {props.acceptsCard && (
                    <Toggle
                      active={props.paymentMethod === "CARD"}
                      onClick={() => props.setPaymentMethod("CARD")}
                    >
                      Card
                    </Toggle>
                  )}
                </div>
                <p className="text-[11px] text-zinc-500">
                  {props.paymentMethod === "CARD"
                    ? "You pay for the whole group order now — card is authorised and only captured once the restaurant accepts."
                    : "You pay for the whole group order at the shop."}
                </p>
              </Section>

              <Section title="Order notes (optional)">
                <textarea
                  value={props.notes}
                  onChange={(e) => props.setNotes(e.target.value)}
                  placeholder="Allergies, doorbell instructions, etc."
                  rows={2}
                  className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
                />
              </Section>
            </div>
          )}
        </div>

        <footer className="space-y-2 border-t border-zinc-200 px-4 py-3">
          <Row label="Subtotal" value={`£${basket.subtotal.toFixed(2)}`} />
          {isDelivery && (
            <Row
              label="Delivery"
              value={deliveryFee > 0 ? `£${deliveryFee.toFixed(2)}` : "—"}
            />
          )}
          <Row label="Total" value={`£${total.toFixed(2)}`} bold />
          {!isHost && myShare > 0 && (
            <p className="text-[11px] text-zinc-500">
              Your items come to £{myShare.toFixed(2)} —{" "}
              {basket.hostName ?? "the host"} is paying for the order.
            </p>
          )}
          {actionError && (
            <p className="text-[11px] text-red-600">{actionError}</p>
          )}

          {isHost ? (
            <>
              {open && (
                <button
                  onClick={onLock}
                  disabled={basket.items.length === 0 || isLocking}
                  className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg bg-orange-500 px-3 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
                >
                  {isLocking ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Lock className="h-4 w-4" />
                  )}
                  Close basket &amp; checkout
                </button>
              )}
              {locked && (
                <>
                  <button
                    onClick={onPlace}
                    disabled={!canPlace || isPlacing}
                    className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg bg-orange-500 px-3 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
                  >
                    {isPlacing && <Loader2 className="h-4 w-4 animate-spin" />}
                    Place group order · £{total.toFixed(2)}
                  </button>
                  <button
                    onClick={onUnlock}
                    disabled={isLocking || isPlacing}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                  >
                    <LockOpen className="h-3.5 w-3.5" />
                    Reopen for more items
                  </button>
                </>
              )}
              <button
                onClick={onCancel}
                disabled={isPlacing}
                className="w-full rounded-lg px-3 py-1.5 text-[11px] font-medium text-zinc-400 hover:text-red-600 disabled:opacity-50"
              >
                Cancel this group order
              </button>
            </>
          ) : (
            <div className="mt-1 flex items-center justify-center gap-1.5 rounded-lg bg-zinc-100 px-3 py-2.5 text-xs font-medium text-zinc-600">
              <ChevronRight className="h-3.5 w-3.5" />
              {open
                ? `Add what you want — ${basket.hostName ?? "the host"} places the order`
                : `Waiting for ${basket.hostName ?? "the host"} to place the order`}
            </div>
          )}
        </footer>
      </aside>
    </div>
  );
}

// ── Small local field helpers (same look as the ordinary cart panel) ────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
        {title}
      </p>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Field({
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
    />
  );
}

function Toggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-md border px-3 py-1.5 text-xs font-medium ${
        active
          ? "border-zinc-900 bg-zinc-900 text-white"
          : "border-zinc-200 text-zinc-600 hover:border-zinc-300"
      }`}
    >
      {children}
    </button>
  );
}

function Row({
  label,
  value,
  bold,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between text-xs ${
        bold ? "font-bold text-zinc-900" : "text-zinc-600"
      }`}
    >
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
