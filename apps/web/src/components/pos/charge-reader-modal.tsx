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

export function ChargeReaderModal({
  open,
  orderId,
  locationId,
  amount,
  onClose,
}: {
  open: boolean;
  orderId: string | null;
  locationId: string;
  amount: number;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [readerId, setReaderId] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [regCode, setRegCode] = useState("");
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
      const res = await terminalClient.charge(orderId, reader.id);
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
            setTimeout(onClose, 1200);
          }
        } catch {
          /* keep polling */
        }
      }, 2000);
    } catch (e: any) {
      setPhase("error");
      setError(e?.response?.data?.message ?? e?.message ?? "Charge failed");
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
            £{amount.toFixed(2)}
          </p>

          {phase === "paid" ? (
            <div className="flex flex-col items-center gap-2 py-4 text-emerald-600">
              <CheckCircle2 className="h-10 w-10" />
              <p className="font-semibold">Paid</p>
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
                    `Charge £${amount.toFixed(2)} to reader`
                  )}
                </Button>
              )}

              {error && <p className="text-center text-sm text-red-600">{error}</p>}
            </>
          )}

          {phase !== "paid" && (
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
