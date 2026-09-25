"use client";

// Stripe Terminal charge modal — opens after a "Card terminal" POS order is
// placed. Charges the order to a registered S700/WisePOS reader; the reader
// prompts the customer to tap/insert. Includes:
//   • inline reader registration (register a code, or a SIMULATED reader in
//     test mode — so you can test the whole flow with no hardware),
//   • a "Simulate tap" button in test mode to complete a simulated charge,
//   • a "Mark paid manually" fallback for shops using a separate terminal,
//   • Dojo card machines, for shops whose location has Dojo connected (see
//     dojo-card-machines.tsx) — same modal, same split-bill rules.

import { useEffect, useRef, useState } from "react";
import { useCurrency } from "@/hooks/use-currency";
import { useQuery } from "@tanstack/react-query";
import { CreditCard, Loader2, X, CheckCircle2, Plus } from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { terminalClient } from "@/lib/api/terminal.client";
import { dojoClient } from "@/lib/api/dojo.client";
import { DOJO_PROMPTS } from "@/lib/dojo-prompts";
import { useDeviceStore, chooseCardMachine } from "@/stores/device.store";
import { paymentLinkClient } from "@/lib/api/pos.client";
import {
  getTerminalStatus,
  subscribeTerminalStatus,
  isPreparing,
  type TerminalStatus,
} from "@/lib/pos/terminal-status";
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
// Stripe confirmed for this account that some UK-issued cards are
// insert-only under Strong Customer Authentication: Tap to Pay cannot read
// them at all, and the charge is declined BEFORE any PIN screen with
// `offline_pin_required`. Retrying the tap can never work, so the operator
// has to be told to switch method rather than tap again.
const INSERT_ONLY_DECLINES = new Set(["offline_pin_required", "online_or_offline_pin_required"]);

function failureMessage(status: string, declineCode?: string | null): string {
  if (declineCode && INSERT_ONLY_DECLINES.has(declineCode)) {
    return "This card must be inserted — it can't be read by tapping. Use another payment method below.";
  }
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
  // Prices follow the selected location's currency, not a hardcoded pound.
  const { money } = useCurrency();
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
      ? (
          window as {
            OrderHubTerminal?: {
              isReady?: boolean;
              tapToPaySupported?: boolean;
              tapToPayLabel?: string;
            };
          }
        ).OrderHubTerminal
      : undefined;
  const nativeReader = ohTerminal?.isReady === true;
  const tapToPayAvailable = nativeReader && ohTerminal?.tapToPaySupported === true;
  // Apple checklist 5.4 — the trigger must carry Apple's own naming on
  // iPhone. Decided natively (see PosWebView) since the same UI runs on
  // Android, where "on iPhone" would be wrong.
  const tapToPayLabel = ohTerminal?.tapToPayLabel ?? "Tap to Pay";
  const [method, setMethod] = useState<"server" | "wisepad" | "tapToPay" | "dojo">("server");
  // Set once staff pick a method themselves, so the "default to Dojo when
  // that's the only counter machine" choice below never overrides them.
  const [methodTouched, setMethodTouched] = useState(false);
  // Which machine THIS tablet charges to. Persisted per device, because two
  // tills in one shop must not both send their totals to the same machine —
  // the customer standing at it would pay the other till's amount.
  const pinnedMachine = useDeviceStore(
    (st) => (locationId ? st.cardMachineByLocation[locationId] : undefined) ?? null,
  );
  const setPinnedMachine = useDeviceStore((st) => st.setCardMachine);
  const [dojoNeedsSignature, setDojoNeedsSignature] = useState(false);
  const [dojoPrompt, setDojoPrompt] = useState<string | null>(null);
  // Expired session — Dojo never said whether the card went through.
  const [dojoUnconfirmed, setDojoUnconfirmed] = useState(false);
  const [connectedLabel, setConnectedLabel] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  // Simulated reader — verify the flow with no hardware (test mode only).
  const [simulate, setSimulate] = useState(false);
  // Digital receipt (Apple Tap to Pay checklist 5.10). Offered for declined
  // sales too, not just approved ones — the customer is entitled to a record
  // either way.
  // Live reader setup progress from the native SDK (Apple checklist 3.9.1
  // configuration indicator + 5.7 "initializing" state).
  const [readerStatus, setReaderStatus] = useState<TerminalStatus>({ stage: "idle" });
  // Why the last attempt failed. Drives the fallback options below — Apple
  // checklist 4.8 / 5.11 require routing the operator to another payment
  // method when a card can't be read, not just offering a doomed retry.
  const [declineCode, setDeclineCode] = useState<string | null>(null);
  const [receiptEmail, setReceiptEmail] = useState("");
  const [sendingReceipt, setSendingReceipt] = useState(false);
  const [receiptSentTo, setReceiptSentTo] = useState<string | null>(null);
  // Fallback payment state. MUST live with the other hooks, above the early
  // return below — declaring these further down (next to the handler that
  // uses them) put two useState calls after `if (!open) return null`, so the
  // hook count changed the moment the modal opened and React tore the whole
  // POS down with "Something went wrong".
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [makingLink, setMakingLink] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const readersQuery = useQuery({
    queryKey: ["terminal-readers", locationId],
    queryFn: () => terminalClient.listReaders(locationId),
    enabled: open,
  });
  const readers = readersQuery.data?.readers ?? [];
  const testMode = readersQuery.data?.testMode ?? false;
  const activeReader = readers.find((r) => r.id === readerId) ?? readers[0] ?? null;

  const dojoQuery = useQuery({
    queryKey: ["dojo-status", locationId],
    queryFn: () => dojoClient.status(locationId),
    enabled: open,
    // A shop without Dojo gets a clean "not connected", but a network blip
    // must never block taking a card on the Stripe reader.
    retry: false,
  });
  const dojo = dojoQuery.data?.connected ? dojoQuery.data : null;
  const dojoTerminals = dojo?.terminals ?? [];
  const dojoAvailable = dojoTerminals.length > 0;
  // One machine at the shop? Nothing to choose. More than one and no pin?
  // Deliberately NOTHING — the till asks rather than guessing, because the
  // guess is what sends this order to someone else's counter.
  const activeDojo = chooseCardMachine(dojoTerminals, pinnedMachine);

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
      setMethodTouched(false);
      // The machine pin is NOT reset here: it belongs to the tablet, not to
      // this order, and re-asking every sale is the behaviour we removed.
      setDojoNeedsSignature(false);
      setDojoPrompt(null);
      setDojoUnconfirmed(false);
      setConnectedLabel(null);
      setConnecting(false);
      setSimulate(false);
      setDeclineCode(null);
      setReceiptEmail("");
      setSendingReceipt(false);
      setReceiptSentTo(null);
      // Fire the moment this screen opens — well before the operator taps
      // Connect — so the native SDK's init cost is already paid by the time
      // they do (Apple's Tap to Pay requirement to warm up ahead of use).
      // Best-effort: errors are swallowed inside the bridge itself.
      if (nativeReader && orderId) {
        void oh()?.warmUp?.(locationId, orderId);
      }
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, orderId]);

  // A shop whose only counter machine is Dojo shouldn't land on an empty
  // "register an S700" screen every time. Once both lists are in, pick Dojo —
  // unless staff already chose, or the on-device reader is the default.
  useEffect(() => {
    if (!open || methodTouched || nativeReader) return;
    if (!readersQuery.isSuccess || !dojoAvailable) return;
    if (readers.length === 0) setMethod("dojo");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, methodTouched, nativeReader, readersQuery.isSuccess, dojoAvailable, readers.length]);

  // Subscribe for as long as the modal is mounted, seeding from the last
  // known value so opening mid-setup renders the right state immediately.
  useEffect(() => {
    if (!open) return;
    setReaderStatus(getTerminalStatus());
    return subscribeTerminalStatus(setReaderStatus);
  }, [open]);

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
            // Deliberately NOT auto-closing: the receipt step below needs to
            // stay reachable (Apple Tap to Pay checklist 5.10). Staff close
            // with the Done button.
            return;
          }
          if (FAILED_PI_STATUSES.has(s.status)) {
            // Nothing was taken — leave the amount on screen so the same
            // share can be retried on another card without re-keying it.
            if (pollRef.current) clearInterval(pollRef.current);
            setPhase("error");
            setDeclineCode(s.declineCode ?? null);
            setError(failureMessage(s.status, s.declineCode));
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

  // ── Dojo card machine ───────────────────────────────────────────────────
  // Server-driven like the S700: we push the payment to the machine, then
  // poll. The poll is also what settles the order — the server re-checks
  // the payment with Dojo before marking anything paid.
  const startDojoCharge = async () => {
    if (!activeDojo) {
      setError("No Dojo card machine found for this location.");
      return;
    }
    setError(null);
    setDeclineCode(null);
    setDojoNeedsSignature(false);
    setDojoPrompt(null);
    setDojoUnconfirmed(false);
    setPhase("charging");
    try {
      const res = await dojoClient.charge(orderId, activeDojo.id, isPart ? partAmount! : undefined);
      setPaymentIntentId(res.paymentIntentId);
      setPhase("waiting");
      pollRef.current = setInterval(async () => {
        try {
          const st = await dojoClient.chargeStatus(res.paymentIntentId);
          setDojoNeedsSignature(st.needsSignature);
          setDojoPrompt(st.prompt ?? null);
          if (st.paid) {
            if (pollRef.current) clearInterval(pollRef.current);
            setPhase("paid");
            toast.success("Card payment received");
            onPaid?.();
            return;
          }
          if (st.failed) {
            if (pollRef.current) clearInterval(pollRef.current);
            setPhase("error");
            setDojoUnconfirmed(!!st.unconfirmed);
            setError(st.message ?? "Card payment didn't go through. You can try again.");
          }
        } catch {
          /* transient network — keep polling */
        }
        // Dojo's go-live checklist asks the POS to poll the terminal session
        // once a second, so the machine's prompts show up without lag.
      }, 1000);
    } catch (e: any) {
      setPhase("error");
      setError(e?.response?.data?.message ?? e?.message ?? "Couldn't start the payment");
    }
  };

  const cancelDojoCharge = async () => {
    if (!paymentIntentId) return;
    try {
      await dojoClient.cancel(paymentIntentId);
      toast("Cancelling on the card machine…");
      // The poll picks up the Canceled status and moves the screen on.
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Couldn't cancel");
    }
  };

  const answerDojoSignature = async (accepted: boolean) => {
    if (!paymentIntentId) return;
    try {
      await dojoClient.signature(paymentIntentId, accepted);
      setDojoNeedsSignature(false);
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Couldn't send the answer to the card machine");
    }
  };

  const pickMethod = (m: "server" | "wisepad" | "tapToPay" | "dojo") => {
    setMethodTouched(true);
    if (m === "wisepad" || m === "tapToPay") selectOnDeviceMethod(m);
    else setMethod(m);
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
            orderId?: string,
            stripeAccountId?: string | null,
          ) => Promise<{ label: string }>;
          pay: (clientSecret: string) => Promise<{ status: string }>;
          warmUp?: (orderHubLocationId: string, orderId: string) => Promise<void>;
        };
      }
    ).OrderHubTerminal;

  const connectOnDeviceReader = async () => {
    setError(null);
    setConnecting(true);
    try {
      const { stripeLocationId, stripeAccountId } = await terminalClient.connectionToken(
        locationId,
        simulate,
        orderId ?? undefined,
      );
      if (!stripeLocationId) {
        throw new Error("Couldn't prepare the reader for this location.");
      }
      const res = await oh()!.connect(
        stripeLocationId,
        simulate,
        method === "tapToPay" ? "tapToPay" : "wisepad",
        locationId,
        orderId ?? undefined,
        stripeAccountId,
      );
      setConnectedLabel(
        res?.label ??
          (method === "tapToPay"
            ? tapToPayLabel
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
            // Deliberately NOT auto-closing: the receipt step below needs to
            // stay reachable (Apple Tap to Pay checklist 5.10). Staff close
            // with the Done button.
            return;
          }
          if (FAILED_PI_STATUSES.has(s.status)) {
            if (pollRef.current) clearInterval(pollRef.current);
            setPhase("error");
            setDeclineCode(s.declineCode ?? null);
            setError(failureMessage(s.status, s.declineCode));
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

  // Apple checklist 4.8 / 5.11 — when a card can't be read, the operator must
  // be routed to another way to collect, not left retrying a tap that (for an
  // insert-only UK card) can never succeed. Both routes already exist in
  // OrderHub: the counter reader, and a hosted Stripe payment link.
  const createPaymentLink = async () => {
    setMakingLink(true);
    try {
      const { url } = await paymentLinkClient.create(orderId);
      setLinkUrl(url);
      window.open(url, "_blank");
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Couldn't create a payment link");
    } finally {
      setMakingLink(false);
    }
  };
  const switchToCounterReader = () => {
    setMethodTouched(true);
    setMethod("server");
    setPhase("idle");
    setError(null);
    setDeclineCode(null);
  };

  const sendReceipt = async () => {
    const to = receiptEmail.trim();
    if (!to) return;
    setSendingReceipt(true);
    try {
      await terminalClient.emailReceipt(orderId, to);
      setReceiptSentTo(to);
      toast.success("Receipt sent");
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Couldn't send the receipt");
    } finally {
      setSendingReceipt(false);
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
            {money(chargeAmount)}
          </p>

          {phase !== "paid" && ((nativeReader && !isPart) || dojoAvailable) && (
            <div className="flex gap-1 rounded-lg bg-zinc-100 p-1 text-xs font-medium">
              {nativeReader && !isPart && (
              <button
                onClick={() => pickMethod("wisepad")}
                className={`flex-1 rounded-md px-2 py-1.5 ${
                  method === "wisepad"
                    ? "bg-white text-zinc-900 shadow-sm"
                    : "text-zinc-500"
                }`}
              >
                WisePad 3
              </button>
              )}
              {nativeReader && !isPart && tapToPayAvailable && (
                <button
                  onClick={() => pickMethod("tapToPay")}
                  className={`flex-1 rounded-md px-2 py-1.5 ${
                    method === "tapToPay"
                      ? "bg-white text-zinc-900 shadow-sm"
                      : "text-zinc-500"
                  }`}
                >
                  {tapToPayLabel}
                </button>
              )}
              {(readers.length > 0 || !dojoAvailable || nativeReader) && (
              <button
                onClick={() => pickMethod("server")}
                className={`flex-1 rounded-md px-2 py-1.5 ${
                  method === "server"
                    ? "bg-white text-zinc-900 shadow-sm"
                    : "text-zinc-500"
                }`}
              >
                Counter reader (S700)
              </button>
              )}
              {dojoAvailable && (
                <button
                  onClick={() => pickMethod("dojo")}
                  className={`flex-1 rounded-md px-2 py-1.5 ${
                    method === "dojo"
                      ? "bg-white text-zinc-900 shadow-sm"
                      : "text-zinc-500"
                  }`}
                >
                  Dojo
                </button>
              )}
            </div>
          )}

          {phase === "paid" ? (
            <div className="space-y-4">
              <div className="flex flex-col items-center gap-2 py-2 text-emerald-600">
                <CheckCircle2 className="h-10 w-10" />
                <p className="font-semibold">Paid</p>
              </div>
              <ReceiptBox
                email={receiptEmail}
                setEmail={setReceiptEmail}
                sending={sendingReceipt}
                sentTo={receiptSentTo}
                onSend={sendReceipt}
              />
              <Button onClick={onClose} className="w-full bg-zinc-900 py-3 text-white hover:bg-zinc-800">
                Done
              </Button>
            </div>
          ) : method === "dojo" ? (
            <div className="space-y-3">
              {dojo?.environment === "sandbox" && (
                <p className="rounded-md bg-amber-50 px-2.5 py-1.5 text-center text-[11px] font-medium text-amber-800">
                  Dojo sandbox — no real money moves
                </p>
              )}
              {dojoTerminals.length > 1 && (
                <div className="space-y-1">
                  <label
                    htmlFor="dojo-machine"
                    className="block text-xs font-medium text-zinc-500"
                  >
                    This tablet&rsquo;s card machine
                  </label>
                  <select
                    id="dojo-machine"
                    value={activeDojo?.id ?? ""}
                    onChange={(e) =>
                      locationId && setPinnedMachine(locationId, e.target.value || null)
                    }
                    disabled={phase === "waiting" || phase === "charging"}
                    className="w-full rounded-md border border-zinc-200 bg-white text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 px-3 py-2 text-sm"
                  >
                    <option value="">Choose a machine…</option>
                    {dojoTerminals.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label} · {t.status === "InUse" ? "in use" : t.status.toLowerCase()}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-zinc-500">
                    {activeDojo
                      ? "Remembered on this tablet — other tills keep their own."
                      : "Pick the machine standing at this till. It's remembered here."}
                  </p>
                </div>
              )}
              {phase === "waiting" ? (
                dojoNeedsSignature ? (
                  <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3" role="alert">
                    <p className="text-sm font-medium text-amber-900">
                      Check the customer&rsquo;s signature against their card.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        onClick={() => answerDojoSignature(true)}
                        className="flex-1 bg-emerald-600 text-white hover:bg-emerald-700"
                      >
                        Signature matches
                      </Button>
                      <Button variant="outline" onClick={() => answerDojoSignature(false)} className="flex-1">
                        Doesn&rsquo;t match
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2 py-3 text-zinc-600">
                    <Loader2 className="h-8 w-8 animate-spin text-emerald-600" />
                    <p className="text-sm" aria-live="polite">
                      {dojoPrompt && DOJO_PROMPTS[dojoPrompt]
                        ? DOJO_PROMPTS[dojoPrompt]
                        : `Follow the prompts on ${activeDojo?.label ?? "the Dojo machine"}…`}
                    </p>
                    <Button size="sm" variant="outline" onClick={cancelDojoCharge} className="mt-1">
                      Cancel on machine
                    </Button>
                  </div>
                )
              ) : (
                <Button
                  onClick={startDojoCharge}
                  disabled={phase === "charging" || !activeDojo}
                  title={!activeDojo ? "Choose this tablet's card machine first" : undefined}
                  className="w-full bg-emerald-600 py-3 text-white hover:bg-emerald-700"
                >
                  {phase === "charging" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : phase === "error" ? (
                    `Try again — ${money(chargeAmount)}`
                  ) : (
                    `Charge ${money(chargeAmount)} on Dojo`
                  )}
                </Button>
              )}
              {error && (
                <div className="space-y-2">
                  <p className="text-center text-sm text-red-600" role="alert">
                    {error}
                  </p>
                  {/* Expired: the machine may have taken the card anyway.
                      Dojo's checklist wants a manual-record option here as
                      well as retry — the operator checks the machine. */}
                  {phase === "error" && dojoUnconfirmed && !isPart && (
                    <Button variant="outline" onClick={markPaidManually} className="w-full">
                      Machine shows APPROVED — record as paid
                    </Button>
                  )}
                  {phase === "error" && (
                    <FallbackOptions
                      insertOnly={false}
                      canUseCounterReader={readers.length > 0}
                      onCounterReader={switchToCounterReader}
                      onPaymentLink={createPaymentLink}
                      makingLink={makingLink}
                      linkUrl={linkUrl}
                    />
                  )}
                </div>
              )}
            </div>
          ) : method === "wisepad" || method === "tapToPay" ? (
            <div className="space-y-3">
              <p className="text-sm text-zinc-600">
                {connectedLabel
                  ? `Connected: ${connectedLabel}`
                  : method === "tapToPay"
                    ? `Connect ${tapToPayLabel}, then hold the customer's card or phone to the back of this device.`
                    : "Connect the WisePad 3 over Bluetooth, then take the payment on the reader."}
              </p>
              {/* Apple checklist 3.9.1 / 5.7 — while the SDK is still
                  configuring the reader, say so and show real progress
                  rather than leaving the operator on a bare spinner. */}
              {isPreparing(readerStatus) && phase !== "waiting" && (
                <SetupProgress status={readerStatus} />
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
                    `Connect ${tapToPayLabel}`
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
                    `Charge ${money(chargeAmount)} on reader`
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
                      Try again — {money(chargeAmount)}
                    </Button>
                  )}
                  {phase === "error" && (
                    <FallbackOptions
                      insertOnly={!!declineCode && INSERT_ONLY_DECLINES.has(declineCode)}
                      canUseCounterReader
                      onCounterReader={switchToCounterReader}
                      onPaymentLink={createPaymentLink}
                      makingLink={makingLink}
                      linkUrl={linkUrl}
                    />
                  )}
                  {phase === "error" && (
                    <ReceiptBox
                      email={receiptEmail}
                      setEmail={setReceiptEmail}
                      sending={sendingReceipt}
                      sentTo={receiptSentTo}
                      onSend={sendReceipt}
                      declined
                    />
                  )}
                </div>
              )}
            </div>
          ) : readers.length === 0 ? (
            <div className="space-y-3">
              <p className="text-sm text-zinc-600">
                No counter reader registered at this location yet.
              </p>
              {/* Without the native bridge the on-device readers can't even be
                  offered, so the bare "no reader registered" line reads as
                  "you have no way to take a card" — wrong for a shop that
                  uses Tap to Pay every day, just not from a desktop. Say
                  where those live instead of implying hardware is missing. */}
              {!nativeReader && (
                <p className="rounded-md bg-blue-50 p-2.5 text-xs leading-relaxed text-blue-800">
                  Tap to Pay on iPhone and the WisePad 3 run on the device
                  itself, so they&rsquo;re only available in the OrderHub app on
                  your phone or tablet. Open this order there to use them — or
                  register a counter reader below to charge from any device.
                </p>
              )}
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
                    `Charge ${money(chargeAmount)} to reader`
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
                      Try again — {money(chargeAmount)}
                    </Button>
                  )}
                  {phase === "error" && (
                    <FallbackOptions
                      insertOnly={!!declineCode && INSERT_ONLY_DECLINES.has(declineCode)}
                      canUseCounterReader={false}
                      onCounterReader={switchToCounterReader}
                      onPaymentLink={createPaymentLink}
                      makingLink={makingLink}
                      linkUrl={linkUrl}
                    />
                  )}
                  {phase === "error" && (
                    <ReceiptBox
                      email={receiptEmail}
                      setEmail={setReceiptEmail}
                      sending={sendingReceipt}
                      sentTo={receiptSentTo}
                      onSend={sendReceipt}
                      declined
                    />
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

// Digital receipt — Apple's Tap to Pay App Review checklist (5.10) requires
// that the customer can be sent a confidential receipt for an in-person
// sale, approved OR declined, not just handed the printed one. Email rather
// than SMS: no per-message cost and no prepaid balance that can run dry
// mid-service on a compliance-required feature.
function ReceiptBox({
  email,
  setEmail,
  sending,
  sentTo,
  onSend,
  declined,
}: {
  email: string;
  setEmail: (v: string) => void;
  sending: boolean;
  sentTo: string | null;
  onSend: () => void;
  /** Softens the wording when the sale didn't go through. */
  declined?: boolean;
}) {
  if (sentTo) {
    return (
      <p className="flex items-center justify-center gap-1.5 text-sm text-emerald-700">
        <CheckCircle2 className="h-4 w-4" /> Receipt sent to {sentTo}
      </p>
    );
  }
  return (
    <div className="rounded-lg border border-zinc-200 p-3">
      <label className="text-xs font-semibold text-zinc-700">
        {declined ? "Email a record of this attempt" : "Email the receipt"}
      </label>
      <div className="mt-2 flex gap-2">
        <input
          type="email"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && email.trim() && !sending) onSend();
          }}
          placeholder="customer@example.com"
          className="flex-1 rounded-md border border-zinc-200 px-3 py-2 text-sm"
        />
        <Button
          variant="outline"
          disabled={!email.trim() || sending}
          onClick={onSend}
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send"}
        </Button>
      </div>
    </div>
  );
}

// Apple's Tap to Pay App Review checklist asks for a configuration progress
// indicator while the reader is being set up (3.9.1), and for the operator to
// be told "not ready yet, it's coming" rather than met with a dead button if
// they try to charge too early (5.7). Driven by the Stripe SDK's connection
// status + software-update progress events — its equivalent of Apple's
// PaymentCardReader updateProgress.
function SetupProgress({ status }: { status: TerminalStatus }) {
  const pct =
    typeof status.progress === "number"
      ? Math.max(0, Math.min(100, Math.round(status.progress * 100)))
      : null;
  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50 p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-violet-800">
        <Loader2 className="h-4 w-4 animate-spin" />
        {status.message ?? "Getting the reader ready…"}
        {pct !== null && <span className="ml-auto tabular-nums">{pct}%</span>}
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-violet-200">
        <div
          className={`h-full rounded-full bg-violet-600 ${
            pct === null ? "w-1/3 animate-pulse" : "transition-all"
          }`}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
      <p className="mt-1.5 text-[11px] text-violet-700">
        The reader will be available in a moment.
      </p>
    </div>
  );
}

// Apple's Tap to Pay checklist requires a fallback path when a card can't be
// read (4.8, and 5.11 for regional compliance). Stripe confirmed for this
// account that UK Strong Customer Authentication makes some cards
// insert-only — Tap to Pay physically cannot read them — so "try again" is
// not a valid answer there. Both fallbacks already existed in OrderHub; this
// just puts them in front of the operator at the moment they're needed.
function FallbackOptions({
  insertOnly,
  canUseCounterReader,
  onCounterReader,
  onPaymentLink,
  makingLink,
  linkUrl,
}: {
  /** True when the card can never be tapped — lead with the alternatives. */
  insertOnly: boolean;
  canUseCounterReader: boolean;
  onCounterReader: () => void;
  onPaymentLink: () => void;
  makingLink: boolean;
  linkUrl: string | null;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
      <p className="text-xs font-semibold text-zinc-700">
        {insertOnly ? "Take payment another way" : "Or take payment another way"}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {canUseCounterReader && (
          <Button variant="outline" onClick={onCounterReader}>
            Use counter reader
          </Button>
        )}
        <Button variant="outline" onClick={onPaymentLink} disabled={makingLink}>
          {makingLink ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : null}
          Send a payment link
        </Button>
      </div>
      {linkUrl && (
        <p className="mt-2 break-all text-[11px] text-zinc-500">
          Link created — it also opened in a new tab. {linkUrl}
        </p>
      )}
    </div>
  );
}
