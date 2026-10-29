"use client";

// "Use on this computer" — link a printer record to a device attached to
// THIS desktop browser (see lib/printing/browser-printers.ts). For shops
// running the dashboard in Chrome/Edge on a Windows till instead of the
// Android tablet app.

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, X } from "lucide-react";
import type { Printer } from "@/lib/api/printers.client";
import {
  browserSupportsWebSerial,
  browserSupportsWebUsb,
  chooseSerialPrinter,
  chooseUsbPrinter,
  getBrowserPrinterLink,
  setBrowserPrinterLink,
  type BrowserPrinterLink,
} from "@/lib/printing/browser-printers";
import { buildTestReceipt, buildTestReceiptStar, writeToPrinter } from "@/lib/printing/bridge";

type Mode = BrowserPrinterLink["mode"];

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200];

export function LinkPrinterDialog({
  printer,
  onClose,
  onChanged,
}: {
  printer: Printer;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [link, setLink] = useState<BrowserPrinterLink | null>(() => getBrowserPrinterLink(printer.id));
  const [busy, setBusy] = useState<Mode | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [baudRate, setBaudRate] = useState(9600);
  const [canUsb, setCanUsb] = useState(false);
  const [canSerial, setCanSerial] = useState(false);
  useEffect(() => {
    setCanUsb(browserSupportsWebUsb());
    setCanSerial(browserSupportsWebSerial());
  }, []);

  const save = (next: BrowserPrinterLink | null) => {
    setBrowserPrinterLink(printer.id, next);
    setLink(next);
    onChanged();
  };

  const choose = async (mode: Mode) => {
    setBusy(mode);
    setError(null);
    setNotice(null);
    try {
      if (mode === "webusb") save(await chooseUsbPrinter());
      else if (mode === "webserial") save(await chooseSerialPrinter(baudRate));
      else save({ mode: "system", label: "Windows printer (print dialog)" });
      setNotice("Linked. Send a test print to check it.");
    } catch (e: any) {
      // Closing the browser's device chooser throws NotFoundError.
      if (e?.name !== "NotFoundError") setError(e?.message ?? "Couldn't link the printer");
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setError(null);
    setNotice(null);
    try {
      const star =
        String(printer.defaults?.commandSet ?? "").toUpperCase() === "STAR" ||
        String(printer.defaults?.brand ?? "").toLowerCase() === "star" ||
        /star/i.test(String(printer.model ?? ""));
      const width = printer.paperWidth ?? 80;
      await writeToPrinter(printer, star ? buildTestReceiptStar(width) : buildTestReceipt(width));
      setNotice("Test print sent.");
    } catch (e: any) {
      setError(e?.message ?? "Test print failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="link-printer-title"
    >
      <div className="w-full max-w-lg rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
          <h2 id="link-printer-title" className="text-base font-semibold text-zinc-900">
            Use &ldquo;{printer.name}&rdquo; on this computer
          </h2>
          <button onClick={onClose} aria-label="Close" className="rounded p-1 text-zinc-500 hover:bg-zinc-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4 text-sm">
          <p className="text-xs leading-relaxed text-zinc-600">
            Prints from this browser go straight to a printer attached to this
            computer. The link is saved in this browser only. Other tills and
            tablets keep their own setup. Keep the dashboard open in one tab;
            auto-print runs from it.
          </p>

          {link && (
            <div className="flex items-center justify-between rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-800">
                <CheckCircle2 className="h-4 w-4" /> Linked: {link.label}
              </span>
              <button
                onClick={() => {
                  save(null);
                  setNotice("Unlinked from this computer.");
                }}
                className="text-xs font-semibold text-emerald-800 underline-offset-2 hover:underline"
              >
                Unlink
              </button>
            </div>
          )}

          <Option
            title="Windows printer (print dialog)"
            badge="Works with any installed printer"
            body={
              <>
                Uses the printer&rsquo;s normal Windows driver (Epson, Star or
                a generic 80mm driver). Logos and QR codes print; the cash
                drawer can&rsquo;t open this way. To print without the dialog
                popping up, start Chrome or Edge with{" "}
                <code className="rounded bg-zinc-100 px-1">--kiosk-printing</code>{" "}
                and set the receipt printer as the Windows default.
              </>
            }
            action="Use print dialog"
            busy={busy === "system"}
            onClick={() => choose("system")}
          />

          <Option
            title="USB cable (direct)"
            badge={canUsb ? "Chrome / Edge" : "Needs Chrome or Edge"}
            body={
              <>
                Sends the receipt straight down the cable: fastest, and the
                cash drawer works. If Windows already has a driver installed
                for the printer it may refuse with &ldquo;driver is
                holding&rdquo;; use the print dialog instead, or switch the
                printer&rsquo;s driver to WinUSB with Zadig.
              </>
            }
            action="Choose USB printer"
            disabled={!canUsb}
            busy={busy === "webusb"}
            onClick={() => choose("webusb")}
          />

          <Option
            title="COM port (serial or Bluetooth)"
            badge={canSerial ? "Chrome / Edge" : "Needs Chrome or Edge"}
            body={
              <>
                For serial-cable printers, and Bluetooth printers paired in
                Windows Settings (they show up as an &ldquo;outgoing&rdquo; COM
                port).
                <label className="mt-2 flex items-center gap-2">
                  <span className="text-zinc-600">Speed</span>
                  <select
                    value={baudRate}
                    onChange={(e) => setBaudRate(Number(e.target.value))}
                    className="rounded border border-zinc-300 px-2 py-1 text-xs"
                  >
                    {BAUD_RATES.map((b) => (
                      <option key={b} value={b}>
                        {b} baud
                      </option>
                    ))}
                  </select>
                </label>
              </>
            }
            action="Choose COM port"
            disabled={!canSerial}
            busy={busy === "webserial"}
            onClick={() => choose("webserial")}
          />

          {error && <p className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
          {notice && <p className="rounded bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{notice}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3">
          <button
            onClick={test}
            disabled={!link || busy !== null}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 px-3 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            {busy === "test" && <Loader2 className="h-4 w-4 animate-spin" />}
            Test print
          </button>
          <button
            onClick={onClose}
            className="rounded-md bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-700"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function Option({
  title,
  badge,
  body,
  action,
  onClick,
  busy,
  disabled,
}: {
  title: string;
  badge: string;
  body: React.ReactNode;
  action: string;
  onClick: () => void;
  busy: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="rounded-md border border-zinc-200 px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-zinc-900">{title}</span>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{badge}</span>
      </div>
      <div className="mt-1 text-xs leading-relaxed text-zinc-600">{body}</div>
      <button
        onClick={onClick}
        disabled={disabled || busy}
        className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-700 hover:bg-violet-100 disabled:opacity-50"
      >
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {action}
      </button>
    </div>
  );
}
