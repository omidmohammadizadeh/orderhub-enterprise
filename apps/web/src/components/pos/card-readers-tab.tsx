"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Plus, Smartphone, Radio, Trash2 } from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { terminalClient } from "@/lib/api/terminal.client";

// Tap to Pay / WisePad 3 only exist inside the native app, where the Stripe
// Terminal SDK is wired to window.OrderHubTerminal — same bridge the
// checkout charge modal uses (see charge-reader-modal.tsx). On the desktop
// dashboard the connect buttons stay hidden; staff can still register/remove
// hardware from either surface.
function oh() {
  return (
    window as {
      OrderHubTerminal?: {
        isReady?: boolean;
        tapToPaySupported?: boolean;
        connect: (
          loc?: string,
          simulated?: boolean,
          readerType?: "wisepad" | "tapToPay",
          orderHubLocationId?: string,
          orderId?: string,
        ) => Promise<{ label: string }>;
      };
    }
  ).OrderHubTerminal;
}

export function CardReadersTab({ locationId }: { locationId: string }) {
  const qc = useQueryClient();
  const [regCode, setRegCode] = useState("");
  const [connecting, setConnecting] = useState<"wisepad" | "tapToPay" | null>(null);
  const [connectedLabel, setConnectedLabel] = useState<string | null>(null);

  const readersQuery = useQuery({
    queryKey: ["terminal-readers", locationId],
    queryFn: () => terminalClient.listReaders(locationId),
  });
  const readers = readersQuery.data?.readers ?? [];
  const testMode = readersQuery.data?.testMode ?? false;

  const ohTerminal =
    typeof window !== "undefined"
      ? (window as { OrderHubTerminal?: { isReady?: boolean; tapToPaySupported?: boolean } })
          .OrderHubTerminal
      : undefined;
  const nativeReader = ohTerminal?.isReady === true;
  const tapToPayAvailable = nativeReader && ohTerminal?.tapToPaySupported === true;

  const registerCode = async (code: string, simulated = false) => {
    try {
      simulated
        ? await terminalClient.registerSimulated(locationId)
        : await terminalClient.registerReader(locationId, code, "Counter reader");
      setRegCode("");
      await qc.invalidateQueries({ queryKey: ["terminal-readers", locationId] });
      toast.success("Reader registered");
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Registration failed");
    }
  };

  const removeReader = async (readerId: string) => {
    try {
      await terminalClient.removeReader(locationId, readerId);
      await qc.invalidateQueries({ queryKey: ["terminal-readers", locationId] });
      toast.success("Reader removed");
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Couldn't remove reader");
    }
  };

  // No order in this context — connectionToken resolves the connected
  // account at LOCATION level only (same as the S700 path), which is
  // correct here: this just links/enables the reader, it doesn't charge.
  const connect = async (readerType: "wisepad" | "tapToPay") => {
    setConnecting(readerType);
    try {
      const { stripeLocationId } = await terminalClient.connectionToken(locationId);
      if (!stripeLocationId) {
        throw new Error("Couldn't prepare the reader for this location.");
      }
      const res = await oh()!.connect(stripeLocationId, false, readerType, locationId);
      setConnectedLabel(res?.label ?? (readerType === "tapToPay" ? "Tap to Pay" : "WisePad 3"));
      toast.success("Reader connected");
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? e?.message ?? "Couldn't connect the reader");
    } finally {
      setConnecting(null);
    }
  };

  return (
    <div className="space-y-6">
      {nativeReader && (
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-zinc-900">Enable Tap to Pay / WisePad 3</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Link this device to accept contactless card payments. You only need to do
            this once — the reader stays connected for future orders.
          </p>
          {connectedLabel ? (
            <div className="mt-3 flex items-center gap-2 text-sm font-medium text-emerald-700">
              <CheckCircle2 className="h-4 w-4" /> Connected: {connectedLabel}
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              {tapToPayAvailable && (
                <Button
                  onClick={() => connect("tapToPay")}
                  disabled={connecting !== null}
                  className="bg-violet-600 text-white hover:bg-violet-700"
                >
                  {connecting === "tapToPay" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Smartphone className="mr-1.5 h-4 w-4" />
                  )}
                  Connect Tap to Pay
                </Button>
              )}
              <Button
                onClick={() => connect("wisepad")}
                disabled={connecting !== null}
                variant="outline"
              >
                {connecting === "wisepad" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Radio className="mr-1.5 h-4 w-4" />
                )}
                Connect WisePad 3
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-zinc-900">Counter readers (S700)</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Physical readers registered to this location, shared by every device.
        </p>

        {readersQuery.isLoading ? (
          <div className="mt-3 flex justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
          </div>
        ) : readers.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">No counter readers registered yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-zinc-100">
            {readers.map((r) => (
              <li key={r.id} className="flex items-center justify-between py-2">
                <div>
                  <p className="text-sm font-medium text-zinc-900">{r.label}</p>
                  {r.status && <p className="text-xs text-zinc-500">{r.status}</p>}
                </div>
                <button
                  onClick={() => removeReader(r.id)}
                  className="text-zinc-400 hover:text-red-600"
                  title="Remove reader"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex gap-2">
          <input
            value={regCode}
            onChange={(e) => setRegCode(e.target.value)}
            placeholder="Reader registration code"
            className="flex-1 rounded-md border border-zinc-200 px-3 py-2 text-sm"
          />
          <Button variant="outline" disabled={!regCode.trim()} onClick={() => registerCode(regCode.trim())}>
            Register
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-zinc-500">
          On the S700: Settings → Register, then type the code shown.
        </p>
        {testMode && (
          <Button
            onClick={() => registerCode("", true)}
            variant="outline"
            className="mt-3"
          >
            <Plus className="mr-1 h-4 w-4" /> Add simulated reader (test)
          </Button>
        )}
      </div>
    </div>
  );
}
