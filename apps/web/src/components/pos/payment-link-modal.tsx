"use client";

// POS "Payment Link" modal — opens after a Payment Link order is placed.
// Fetches a hosted Stripe checkout URL for the (pending) order and shows it
// as a QR code + copyable link so the customer can pay remotely. The order
// stays "pending payment" and flips to PAID automatically via the Stripe
// webhook (which pushes an order:updated socket event to the board).
//
// Phase 2 adds "Text link to customer" — sends the same link over SMS via
// Twilio. Still metered per restaurant in sms_messages, but NOT billed to
// their prepaid wallet: a payment link is how the platform gets paid, so an
// empty wallet must never be able to block collecting on a live order. The
// wallet top-up prompt below is therefore unreachable for this send today;
// it's left in place so the error still guides correctly if billing is ever
// re-enabled.

import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { paymentLinkClient } from "@/lib/api/pos.client";

export function PaymentLinkModal({
  open,
  orderId,
  orderNumber,
  amount,
  customerPhone,
  onClose,
}: {
  open: boolean;
  orderId: string | null;
  orderNumber?: string | null;
  amount: number;
  customerPhone?: string | null;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const [smsConfigured, setSmsConfigured] = useState(false);
  const [phone, setPhone] = useState("");
  const [smsState, setSmsState] = useState<"idle" | "sending" | "sent">("idle");
  const [smsError, setSmsError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    setUrl(null);
    try {
      const res = await paymentLinkClient.create(id);
      setUrl(res.url);
      setSmsConfigured(!!res.smsConfigured);
    } catch (err: any) {
      setError(
        err?.response?.data?.message ??
          err?.message ??
          "Couldn't create the payment link",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && orderId) {
      load(orderId);
      setPhone(customerPhone ?? "");
      setSmsState("idle");
      setSmsError(null);
    }
  }, [open, orderId, customerPhone, load]);

  const sendSms = async () => {
    if (!orderId) return;
    const to = phone.trim();
    if (!to) {
      setSmsError("Enter the customer's mobile number");
      return;
    }
    setSmsState("sending");
    setSmsError(null);
    try {
      await paymentLinkClient.sendSms(orderId, to);
      setSmsState("sent");
    } catch (err: any) {
      setSmsState("idle");
      setSmsError(
        err?.response?.data?.message ??
          err?.message ??
          "Couldn't send the text",
      );
    }
  };

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the link is still visible to copy manually */
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-zinc-900">Payment link</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-700"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <p className="mt-1 text-xs text-zinc-500">
          {orderNumber ? `Order ${orderNumber} · ` : ""}
          <span className="font-semibold text-zinc-700">£{amount.toFixed(2)}</span>
          {" · "}pending payment
        </p>

        <div className="mt-4 flex flex-col items-center">
          {loading && (
            <div className="py-12 text-sm text-zinc-500">Creating link…</div>
          )}

          {error && (
            <div className="w-full space-y-3 py-4 text-center">
              <p className="text-sm text-red-600">{error}</p>
              {orderId && (
                <button
                  type="button"
                  onClick={() => load(orderId)}
                  className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                >
                  Try again
                </button>
              )}
            </div>
          )}

          {url && !loading && (
            <>
              <div className="rounded-lg border border-zinc-200 bg-white p-3">
                <QRCodeSVG value={url} size={196} level="M" />
              </div>
              <p className="mt-3 text-center text-xs text-zinc-500">
                Customer scans to pay. The order updates to{" "}
                <span className="font-semibold text-emerald-700">Paid</span>{" "}
                automatically once they do.
              </p>

              <div className="mt-4 flex w-full items-center gap-2">
                <input
                  readOnly
                  value={url}
                  onFocus={(e) => e.currentTarget.select()}
                  className="min-w-0 flex-1 truncate rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1.5 text-[11px] text-zinc-600"
                />
                <button
                  type="button"
                  onClick={copy}
                  className="shrink-0 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>

              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 text-[11px] text-zinc-400 hover:text-zinc-600"
              >
                Open payment page ↗
              </a>

              {smsConfigured && (
                <div className="mt-4 w-full border-t border-zinc-100 pt-4">
                  {smsState === "sent" ? (
                    <p className="text-center text-sm font-medium text-emerald-700">
                      ✓ Link texted to {phone}
                    </p>
                  ) : (
                    <>
                      <label className="mb-1 block text-xs font-medium text-zinc-600">
                        Text link to customer
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="tel"
                          inputMode="tel"
                          value={phone}
                          onChange={(e) => setPhone(e.target.value)}
                          placeholder="07… mobile number"
                          className="min-w-0 flex-1 rounded-md border border-zinc-300 px-2 py-1.5 text-sm text-zinc-800 placeholder:text-zinc-400"
                        />
                        <button
                          type="button"
                          onClick={sendSms}
                          disabled={smsState === "sending"}
                          className="shrink-0 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                          {smsState === "sending" ? "Sending…" : "Send"}
                        </button>
                      </div>
                      {smsError && (
                        <p className="mt-1.5 text-xs text-red-600">
                          {smsError}
                          {/wallet|balance|top up/i.test(smsError) && (
                            <>
                              {" "}
                              <a
                                href="/dashboard/wallet"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="font-semibold underline"
                              >
                                Top up wallet ↗
                              </a>
                            </>
                          )}
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <button
          type="button"
          onClick={onClose}
          className="mt-5 w-full rounded-md border border-zinc-200 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
        >
          Done
        </button>
      </div>
    </div>
  );
}
