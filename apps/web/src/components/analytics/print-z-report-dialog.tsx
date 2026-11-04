"use client";

// Analytics → Print Z report. Shows the 80mm ticket before any paper is used,
// then sends it to ONE printer: a report that also came out of the kitchen
// printer would put the shop's takings on the pass.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Loader2, Printer as PrinterIcon, X } from "lucide-react";
import {
  bridgeSupportsPrinter,
  hasNativeBridge,
  writeToPrinter,
} from "@/lib/printing/bridge";
import {
  printViaSystemDialog,
  receiptBytesToTickets,
  ticketsToHtml,
} from "@/lib/printing/browser-printers";
import { listPrintersCached, resolveCommandSet } from "@/lib/printing/print-order";
import { buildZReport, type ZReportInput } from "@/lib/printing/z-report";
import { pinnedPrinter } from "@/stores/device.store";

const BROWSER_DIALOG = "browser-dialog";

export function PrintZReportDialog({
  report,
  refreshing,
  locationId,
  onClose,
}: {
  /** Null until the figures have loaded. */
  report: ZReportInput | null;
  /** The figures are being re-read, so printing now would print old numbers. */
  refreshing: boolean;
  /** Whose printers to offer. Null when the viewer has no one location in view. */
  locationId: string | null;
  onClose: () => void;
}) {
  const [printers, setPrinters] = useState<any[] | null>(null);
  const [target, setTarget] = useState<string>("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState(480);
  const frame = useRef<HTMLIFrameElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  // The tablet app's WebView has no print dialog; only its own transports work.
  const canUseDialog = !hasNativeBridge();

  useEffect(() => {
    closeButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let reachable: any[] = [];
      if (locationId) {
        try {
          const list = await listPrintersCached(locationId);
          reachable = list.filter(
            (p: any) =>
              p.locationId === locationId && p.isActive !== false && bridgeSupportsPrinter(p),
          );
        } catch {
          // No list is the same as no printers: the print dialog still works.
        }
      }
      if (cancelled) return;
      setPrinters(reachable);
      // This till's own printer first, as for the cash drawer, then the counter.
      const pinned = pinnedPrinter(locationId);
      const preferred =
        reachable.find((p) => p.id === pinned) ??
        reachable.find((p) => p.kind === "FRONT_COUNTER") ??
        reachable[0];
      setTarget(preferred?.id ?? BROWSER_DIALOG);
    })();
    return () => {
      cancelled = true;
    };
  }, [locationId]);

  const printer = printers?.find((p) => p.id === target) ?? null;
  const paperWidth = printer?.paperWidth === 58 ? 58 : 80;
  const star = printer ? resolveCommandSet(printer) === "STAR" : false;

  const bytes = useMemo(
    () => (report ? buildZReport(report, paperWidth, star) : null),
    [report, paperWidth, star],
  );
  const previewHtml = useMemo(
    () => (bytes ? ticketsToHtml(receiptBytesToTickets(bytes, star), paperWidth) : ""),
    [bytes, star, paperWidth],
  );

  const noWayToPrint = printers !== null && printers.length === 0 && !canUseDialog;

  const print = async () => {
    if (!bytes) return;
    setSending(true);
    setError(null);
    setSent(null);
    try {
      if (printer) {
        await writeToPrinter(printer, bytes);
        setSent(`Sent to ${printer.name ?? "the printer"}.`);
      } else {
        await printViaSystemDialog(bytes, { paperWidth, star });
        setSent("Sent to the print dialog.");
      }
    } catch (e: any) {
      setError(e?.message ?? "The report didn't print. Check the printer and try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="z-report-title"
    >
      <div className="flex max-h-full w-full max-w-md flex-col rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
          <h2 id="z-report-title" className="text-base font-semibold text-zinc-900">
            Print Z report
          </h2>
          <button
            ref={closeButton}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-zinc-500 hover:bg-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto bg-zinc-100 p-3">
          {report && !refreshing ? (
            <iframe
              ref={frame}
              title="Z report preview"
              srcDoc={previewHtml}
              onLoad={() => {
                const doc = frame.current?.contentDocument;
                if (doc) setHeight(Math.max(200, doc.documentElement.scrollHeight + 8));
              }}
              style={{ height }}
              className="mx-auto block w-full max-w-[320px] rounded bg-white shadow-sm"
            />
          ) : (
            <div className="flex items-center justify-center gap-2 py-20 text-sm text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Getting the latest figures…
            </div>
          )}
        </div>

        <div className="space-y-3 border-t border-zinc-200 px-5 py-4">
          {noWayToPrint ? (
            <p className="text-xs leading-relaxed text-zinc-600">
              No printer is connected to this tablet for this location. Add one under{" "}
              <Link href="/dashboard/printers" className="font-semibold text-violet-700 underline">
                Printers
              </Link>
              .
            </p>
          ) : (
            <div>
              <label htmlFor="z-report-printer" className="mb-1 block text-xs font-medium text-zinc-700">
                Printer
              </label>
              <select
                id="z-report-printer"
                value={target}
                disabled={printers === null}
                onChange={(e) => {
                  setTarget(e.target.value);
                  setSent(null);
                  setError(null);
                }}
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm"
              >
                {(printers ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name ?? "Printer"} ({p.paperWidth === 58 ? 58 : 80}mm)
                  </option>
                ))}
                {canUseDialog && <option value={BROWSER_DIALOG}>This computer&rsquo;s print dialog</option>}
              </select>
              {target === BROWSER_DIALOG && (
                <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                  Choose your receipt printer in the dialog and leave the scale at 100%.
                </p>
              )}
            </div>
          )}

          {error && (
            <p role="alert" className="text-xs font-medium text-red-700">
              {error}
            </p>
          )}
          {sent && (
            <p role="status" className="flex items-center gap-1.5 text-xs font-medium text-emerald-700">
              <CheckCircle2 className="h-3.5 w-3.5" /> {sent}
            </p>
          )}

          <button
            type="button"
            onClick={print}
            disabled={!bytes || refreshing || sending || noWayToPrint || printers === null}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PrinterIcon className="h-4 w-4" />}
            {sending ? "Printing…" : "Print"}
          </button>
        </div>
      </div>
    </div>
  );
}
