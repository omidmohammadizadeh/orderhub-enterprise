"use client";

// Stripe Terminal charge modal — opens after a "Card terminal" POS order is
// placed. Charges the order to a registered S700/WisePOS reader; the reader
// prompts the customer to tap/insert. Includes:
//   • inline reader registration (register a code, or a SIMULATED reader in
//     test mode — so you can test the whole flow with no hardware),
//   • a "Simulate tap" button in test mode to complete a simulated charge,
//   • a "Mark paid manually" fallback for shops using a separate terminal.

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CreditCard, Loader2, X, CheckCircle2, Plus } from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { terminalClient } from "@/lib/api/terminal.client";
import { apiClient } from "@/lib/api/client";

type Phase = "idle" | "charging" | "waiting" | "paid" | "error";

// A card can be declined, cancelled on the reader, or simply not
// presented. Before this, the poll only ever stopped on success, so a
// decline left the modal spinning on "Follow the prompts on the reader…"
// for ever — staff had to close it and lost the amount they had keyed in.
// These are the terminal states that mean "over, and not paid".
const FAILED_PI_STATUSES = new Set([
  "requires_payment_method", // declined, or the card was removed
  "canceled",
]);
function failureMessage(status: string): string {
  if (status === "canceled") return "Payment cancelled on the reader.";
  return "Card declined or not completed. You can try again.";
}

export function ChargeReaderModal({
  open,
  orderId,
  locationId,
  amount,
  onClose,
  partAmount,
  onPaid,
}: {
  open: boolean;
  orderId: string | null;
  locationId: string;
  amount: number;
  onClose: () => void;
  /**
   * Split bill: charge only this much rather than the whole order. The
   * order stays open until the parts cover the total, so the manual
   * "mark paid" escape hatch is hidden — it would settle the WHOLE bill
   * off the back of one person's share.
   */
  partAmount?: number | null;
  /** Fired once this charge has succeeded, before the modal closes. */
  onPaid?: () => void;
}) {
  const isPart = typeof partAmount === "number" && partAmount > 0;
  const chargeAmount = isPart ? partAmount : amount;
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [readerId, setReaderId] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [regCode, setRegCode] = useState("");
  // WisePad 3 (Bluetooth) and Tap to Pay (this device's own NFC) are only
  // available inside the native app, where the Stripe Terminal SDK is wired
  // to window.OrderHubTerminal (see the mobile app's PosWebView bridge). On
  // the desktop dashboard both stay hidden. Tap to Pay additionally needs
  // the native side's own OS/hardware eligibility check to have passed
  // (iOS 16.4+ / Android 11+) — see PosWebView's TAP_TO_PAY_SUPPORTED.
  const ohTerminal =
    typeof window !== "undefined"
      ? (window as { OrderHubTerminal?: { isReady?: boolean; tapToPaySupported?: boolean } })
          .OrderHubTerminal
      : undefined;
  const nativeReader = ohTerminal?.isReady === true;
  const tapToPayAvailable = nativeReader && ohTerminal?.tapToPaySupported === true;
  const [method, setMethod] = useState<"server" | "wisepad" | "tapToPay">("server");
  const [connectedLabel, setConnectedLabel] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  // Simulated reader — verify the flow with no hardware (test mode only).
  const [simulate, setSimulate] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const readersQuery = useQuery({
    queryKey: ["terminal-readers", locationId],
    queryFn: () => terminalClient.listReaders(locationId),
    enabled: open,
  });
  const readers = readersQuery.data?.readers ?? [];
  const testMode = readersQuery.data?.testMode ?? false;
  const activeReader = readers.find((r) => r.id === readerId) ?? readers[0] ?? null;

  useEffect(() => {
    if (open) {
      setPhase("idle");
      setError(null);
      setPaymentIntentId(null);
      setReaderId(null);
      // In the native app, default to the on-device WisePad 3 — except
      // for a split, where the mobile charge endpoint takes no amount
      // and would put the WHOLE bill on one person's card.
      setMethod(nativeReader && !isPart ? "wisepad" : "server");
      // (Tap to Pay isn't the default even when available — WisePad 3 stays
      // the operator's expected first tab; Tap to Pay is an extra option.)
      setConnectedLabel(null);
      setConnecting(false);
      setSimulate(false);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [open, orderId]);

  if (!open || !orderId) return null;

  const startCharge = async () => {
    const reader = activeReader;
    if (!reader) {
      setError("Register a card reader first.");
      return;
    }
    setError(null);
    setPhase("charging");
    try {
      const res = await terminalClient.charge(
        orderId,
        reader.id,
        isPart ? partAmount! : undefined,
      );
      setPaymentIntentId(res.paymentIntentId);
      setPhase("waiting");
      // Poll until paid (the webhook may also settle it first).
      pollRef.current = setInterval(async () => {
        try {
          const s = await terminalClient.status(res.paymentIntentId);
          if (s.paid) {
            if (pollRef.current) clearInterval(pollRef.current);
            setPhase("paid");
            toast.success("Card payment received");
            onPaid?.();
            setTimeout(onClose, 1200);
            return;
          }
          if (FAILED_PI_STATUSES.has(s.status)) {
            // Nothing was taken — leave the amount on screen so the same
            // share can be retried on another card without re-keying it.
            if (pollRef.current) clearInterval(pollRef.current);
            setPhase("error");
            setError(failureMessage(s.status));
          }
        } catch {
          /* transient network — keep polling */
        }
      }, 2000);
    } catch (e: any) {
      setPhase("error");
      setError(e?.response?.data?.message ?? e?.message ?? "Charge failed");
    }
  };

  // ── On-device reader (native app): WisePad 3 (Bluetooth) or Tap to Pay
  // (this device's own NFC) — both drive the same Stripe Terminal SDK
  // session and the same charge/poll flow below, just a different
  // discovery method under the hood (see services/terminal.ts).
  const oh = () =>
    (
      window as {
        OrderHubTerminal?: {
          connect: (
            loc?: string,
            simulated?: boolean,
            readerType?: "wisepad" | "tapToPay",
            orderHubLocationId?: string,
          ) => Promise<{ label: string }>;
          pay: (clientSecret: string) => Promise<{ status: string }>;
        };
      }
    ).OrderHubTerminal;

  const connectOnDeviceReader = async () => {
    setError(null);
    setConnecting(true);
    try {
      const { stripeLocationId } = await terminalClient.connectionToken(
        locationId,
        simulate,
      );
      if (!stripeLocationId) {
        throw new Error("Couldn't prepare the reader for this location.");
      }
      const res = await oh()!.connect(
        stripeLocationId,
        simulate,
        method === "tapToPay" ? "tapToPay" : "wisepad",
        locationId,
      );
      setConnectedLabel(
        res?.label ??
          (method === "tapToPay"
            ? "Tap to Pay"
            : simulate
              ? "Simulated reader"
              : "WisePad 3"),
      );
      toast.success("Reader connected");
    } catch (e: any) {
      setError(
        e?.response?.data?.message ?? e?.message ?? "Couldn't connect the reader",
      );
    } finally {
      setConnecting(false);
    }
  };

  // WisePad 3 and Tap to Pay are separate native connections (Bluetooth vs
  // this device's NFC) — the SDK can only be connected to one at a time, so
  // a connectedLabel carried over from the other one would misrepresent
  // what's actually paired. Switching to/from "server" doesn't need this:
  // that mode never touches connectedLabel.
  const selectOnDeviceMethod = (m: "wisepad" | "tapToPay") => {
    if (method !== m && (method === "wisepad" || method === "tapToPay")) {
      setConnectedLabel(null);
      setError(null);
    }
    setMethod(m);
  };

  const chargeOnDeviceReader = async () => {
    setError(null);
    setPhase("charging");
    try {
      const { paymentIntentId: piId, clientSecret } =
        await terminalClient.chargeMobile(orderId, simulate);
      setPaymentIntentId(piId);
      setPhase("waiting");
      // The reader collects + confirms; resolves once the payment is confirmed.
      await oh()!.pay(clientSecret);
      // Settle server-side (same poll as the S700). The confirm already
      // succeeded, so the first tick usually settles it.
      pollRef.current = setInterval(async () => {
        try {
          const s = await terminalClient.status(piId);
          if (s.paid) {
            if (pollRef.current) clearInterval(pollRef.current);
            setPhase("paid");
            toast.success("Card payment received");
            onPaid?.();
            setTimeout(onClose, 1200);
            return;
          }
          if (FAILED_PI_STATUSES.has(s.status)) {
            if (pollRef.current) clearInterval(pollRef.current);
            setPhase("error");
            setError(failureMessage(s.status));
          }
        } catch {
          /* transient network — keep polling */
        }
      }, 1500);
    } catch (e: any) {
      setPhase("error");
      setError(
        e?.response?.data?.message ?? e?.message ?? "Card payment failed",
      );
    }
  };

  const simulateTap = async () => {
    if (!activeReader) return;
    try {
      await terminalClient.simulatePresent(activeReader.id);
      toast("Simulated card presented", { icon: "💳" });
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Simulate failed");
    }
  };

  const markPaidManually = async () => {
    try {
      await apiClient.patch(`/v1/orders/${orderId}/payment-status`, {
        paymentStatus: "PAID",
      });
      toast.success("Marked paid");
      onClose();
    } catch (e: any) {
      // Fallback if no dedicated payment-status route — status endpoint.
      toast.error(e?.response?.data?.message ?? "Couldn't mark paid");
    }
  };

  const registerCode = async (code: string, simulated = false) => {
    try {
      const r = simulated
        ? await terminalClient.registerSimulated(locationId)
        : await terminalClient.registerReader(locationId, code, "Counter reader");
      setReaderId(r.id);
      setRegCode("");
      await readersQuery.refetch();
      toast.success("Reader registered");
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Registration failed");
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3">
          <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900">
            <CreditCard className="h-4 w-4" /> Take card payment
          </h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <p className="text-center text-3xl font-bold text-zinc-900">
            £{chargeAmount.toFixed(2)}
          </p>

          {nativeReader && !isPart && phase !== "paid" && (
            <div className="flex gap-1 rounded-lg bg-zinc-100 p-1 text-xs font-medium">
              <button
                onClick={() => selectOnDeviceMethod("wisepad")}
                className={`flex-1 rounded-md px-2 py-1.5 ${
                  method === "wisepad"
                    ? "bg-white text-zinc-900 shadow-sm"
                    : "text-zinc-500"
                }`}
              >
                WisePad 3
              </button>
              {tapToPayAvailable && (
                <button
                  onClick={() => selectOnDeviceMethod("tapToPay")}
                  className={`flex-1 rounded-md px-2 py-1.5 ${
                    method === "tapToPay"
                      ? "bg-white text-zinc-900 shadow-sm"
                      : "text-zinc-500"
                  }`}
                >
                  Tap to Pay
                </button>
              )}
              <button
                onClick={() => setMethod("server")}
                className={`flex-1 rounded-md px-2 py-1.5 ${
                  method === "server"
                    ? "bg-white text-zinc-900 shadow-sm"
                    : "text-zinc-500"
                }`}
              >
                Counter reader (S700)
              </button>
            </div>
          )}

          {phase === "paid" ? (
            <div className="flex flex-col items-center gap-2 py-4 text-emerald-600">
              <CheckCircle2 className="h-10 w-10" />
              <p className="font-semibold">Paid</p>
            </div>
          ) : method === "wisepad" || method === "tapToPay" ? (
            <div className="space-y-3">
              <p className="text-sm text-zinc-600">
                {connectedLabel
                  ? `Connected: ${connectedLabel}`
                  : method === "tapToPay"
                    ? "Connect Tap to Pay, then hold the customer's card or phone to the back of this device."
                    : "Connect the WisePad 3 over Bluetooth, then take the payment on the reader."}
              </p>
              {testMode && !connectedLabel && phase !== "waiting" && (
                <label className="flex items-center gap-2 rounded-md bg-violet-50 px-3 py-2 text-xs text-violet-800">
                  <input
                    type="checkbox"
                    checked={simulate}
                    onChange={(e) => setSimulate(e.target.checked)}
                    className="h-3.5 w-3.5"
                  />
                  Simulate reader — no hardware, test mode (no real charge)
                </label>
              )}
              {phase === "waiting" ? (
                <div className="flex flex-col items-center gap-2 py-3 text-zinc-600">
                  <Loader2 className="h-8 w-8 animate-spin text-emerald-600" />
                  <p className="text-sm">
                    {method === "tapToPay"
                      ? "Hold the card or phone to the back of this device…"
                      : "Follow the prompts on the reader…"}
                  </p>
                </div>
              ) : !connectedLabel ? (
                <Button
                  onClick={connectOnDeviceReader}
                  disabled={connecting}
                  className="w-full bg-violet-600 py-3 text-white hover:bg-violet-700"
                >
                  {connecting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : method === "tapToPay" ? (
                    "Connect Tap to Pay"
                  ) : (
                    "Connect WisePad 3"
                  )}
                </Button>
              ) : (
                <Button
                  onClick={chargeOnDeviceReader}
                  disabled={phase === "charging"}
                  className="w-full bg-emerald-600 py-3 text-white hover:bg-emerald-700"
                >
                  {phase === "charging" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    `Charge £${chargeAmount.toFixed(2)} on reader`
                  )}
                </Button>
              )}
              {error && (
                <div className="space-y-2">
                  <p className="text-center text-sm text-red-600">{error}</p>
                  {/* A decline is the normal case, not an exception — the
                      customer offers another card. Retrying must keep the
                      amount so nobody re-keys a split share, and it must
                      NOT have recorded anything. */}
                  {phase === "error" && (
                    <Button
                      onClick={
                        method === "wisepad" || method === "tapToPay"
                          ? chargeOnDeviceReader
                          : startCharge
                      }
                      className="w-full bg-emerald-600 py-3 text-white hover:bg-emerald-700"
                    >
                      Try again — £{chargeAmount.toFixed(2)}
                    </Button>
                  )}
                </div>
              )}
            </div>
          ) : readers.length === 0 ? (
            <div className="space-y-3">
              <p className="text-sm text-zinc-600">
                No card reader registered at this location yet.
              </p>
              {testMode && (
                <Button
                  onClick={() => registerCode("", true)}
                  className="w-full bg-violet-600 text-white hover:bg-violet-700"
                >
                  <Plus className="mr-1 h-4 w-4" /> Add simulated reader (test)
                </Button>
              )}
              <div className="flex gap-2">
                <input
                  value={regCode}
                  onChange={(e) => setRegCode(e.target.value)}
                  placeholder="Reader registration code"
                  className="flex-1 rounded-md border border-zinc-200 px-3 py-2 text-sm"
                />
                <Button
                  variant="outline"
                  disabled={!regCode.trim()}
                  onClick={() => registerCode(regCode.trim())}
                >
                  Register
                </Button>
              </div>
              <p className="text-[11px] text-zinc-500">
                On the S700: Settings → Register, then type the code shown.
              </p>
            </div>
          ) : (
            <>
              {readers.length > 1 && (
                <select
                  value={activeReader?.id}
                  onChange={(e) => setReaderId(e.target.value)}
                  className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                >
                  {readers.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label} {r.status ? `· ${r.status}` : ""}
                    </option>
                  ))}
                </select>
              )}

              {phase === "waiting" ? (
                <div className="flex flex-col items-center gap-2 py-3 text-zinc-600">
                  <Loader2 className="h-8 w-8 animate-spin text-emerald-600" />
                  <p className="text-sm">Waiting for card on the reader…</p>
                  {(testMode || activeReader?.simulated) && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={simulateTap}
                      className="mt-1"
                    >
                      Simulate tap
                    </Button>
                  )}
                </div>
              ) : (
                <Button
                  onClick={startCharge}
                  disabled={phase === "charging"}
                  className="w-full bg-emerald-600 py-3 text-white hover:bg-emerald-700"
                >
                  {phase === "charging" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    `Charge £${chargeAmount.toFixed(2)} to reader`
                  )}
                </Button>
              )}

              {error && (
                <div className="space-y-2">
                  <p className="text-center text-sm text-red-600">{error}</p>
                  {phase === "error" && (
                    <Button
                      onClick={startCharge}
                      className="w-full bg-emerald-600 py-3 text-white hover:bg-emerald-700"
                    >
                      Try again — £{chargeAmount.toFixed(2)}
                    </Button>
                  )}
                </div>
              )}
            </>
          )}

          {/* Hidden for a split: this marks the WHOLE order paid, which
              would clear the table off one person's share. Staff take an
              off-system part as Cash in the split modal instead. */}
          {phase !== "paid" && !isPart && (
            <button
              onClick={markPaidManually}
              className="w-full text-center text-xs text-zinc-500 underline hover:text-zinc-700"
            >
              Paid on a separate terminal — mark as paid
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
