"use client";

// "Scan to order" card for one table. The token lives on the table row, so
// rotating it kills whatever sticker is already stuck to the table without
// renaming the table or losing its history.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { QRCodeCanvas, QRCodeSVG } from "qrcode.react";
import { Copy, Download, Printer, QrCode, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { tablesClient, type RestaurantTable } from "@/lib/api/tables.client";
import { buildQrCardPdf } from "@/lib/qr-card-pdf";

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );

export function TableQrModal({
  table,
  locationId,
  onClose,
}: {
  table: RestaurantTable;
  locationId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [token, setToken] = useState<string | null>(table.qrToken);
  // window is only available client-side, and the token URL must point at
  // whatever host the tablet is actually on (custom domains included).
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);

  const cardRef = useRef<HTMLDivElement | null>(null);
  // A second, print-resolution copy of the same code rendered to a CANVAS,
  // kept off-screen purely so the PDF has real pixels to embed. The visible
  // code stays an SVG (crisp at any zoom, and what the Print window lifts).
  const pdfCanvasRef = useRef<HTMLDivElement | null>(null);
  const url = token ? `${origin}/t/${token}` : "";

  const mintMut = useMutation({
    mutationFn: () => tablesClient.rotateQr(table.id),
    onSuccess: (t) => {
      setToken(t.qrToken);
      qc.invalidateQueries({ queryKey: ["tables", locationId] });
      toast.success("QR code ready");
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? "Couldn't create the QR code"),
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy — select the link and copy it manually");
    }
  };

  // Download the same card as a real PDF, for sending to a print shop
  // that wants card stock. A6 portrait, the usual table-tent size.
  const [saving, setSaving] = useState(false);
  const downloadPdf = async () => {
    const canvas = pdfCanvasRef.current?.querySelector("canvas");
    if (!canvas) return;
    setSaving(true);
    try {
      const blob = await buildQrCardPdf({
        canvas,
        title: table.name,
        subtitle: "Scan to order",
        url,
      });
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      // Table names carry spaces and slashes; keep the filename sane.
      a.download = `${table.name.replace(/[^\w-]+/g, "-")}-qr.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
    } catch (e: any) {
      toast.error(e?.message ?? "Couldn't build the PDF");
    } finally {
      setSaving(false);
    }
  };

  const print = () => {
    // Lift the already-rendered SVG rather than pulling in a second QR
    // renderer just for the print window.
    const svg = cardRef.current?.querySelector("svg")?.outerHTML;
    if (!svg) return;
    const w = window.open("", "_blank", "width=460,height=620");
    if (!w) {
      toast.error("Allow pop-ups to print the QR card");
      return;
    }
    w.document.write(
      `<!doctype html><html><head><title>${escapeHtml(table.name)}</title>` +
        `<style>@page{margin:12mm}body{font-family:ui-sans-serif,system-ui,sans-serif;text-align:center;padding:24px}` +
        `h1{font-size:40px;margin:0 0 4px}p{margin:0;color:#52525b}` +
        `.qr{margin:24px auto}.url{margin-top:16px;font-size:11px;color:#a1a1aa;word-break:break-all}</style>` +
        `</head><body><h1>${escapeHtml(table.name)}</h1>` +
        `<p>Scan to order</p><div class="qr">${svg}</div>` +
        `<div class="url">${escapeHtml(url)}</div></body></html>`,
    );
    w.document.close();
    w.focus();
    // Give the browser a beat to lay the SVG out before the print dialog.
    setTimeout(() => {
      w.print();
      w.close();
    }, 300);
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3">
          <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900">
            <QrCode className="h-4 w-4" /> {table.name} QR
          </h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5">
          {!token ? (
            <div className="py-6 text-center">
              <QrCode className="mx-auto h-8 w-8 text-zinc-300" />
              <p className="mt-3 text-sm text-zinc-600">
                This table has no QR code yet. Create one and guests can scan
                it to open their own tab.
              </p>
              <Button
                className="mt-4"
                onClick={() => mintMut.mutate()}
                loading={mintMut.isPending}
              >
                Create QR code
              </Button>
            </div>
          ) : (
            <div ref={cardRef} className="relative text-center">
              <div className="inline-block rounded-lg border border-zinc-200 p-4">
                {origin ? (
                  <QRCodeSVG value={url} size={180} />
                ) : (
                  <div className="h-[180px] w-[180px] animate-pulse rounded bg-zinc-100" />
                )}
              </div>
              <p className="mt-3 text-xs font-medium text-zinc-700">
                Scan to order
              </p>
              <p className="mt-1 break-all text-[11px] text-zinc-400">{url}</p>

              {/* Off-screen, print-resolution canvas for the PDF. Positioned
                  away rather than display:none — a hidden canvas still
                  paints, but keeping it laid out avoids relying on that. */}
              <div
                ref={pdfCanvasRef}
                aria-hidden
                className="pointer-events-none absolute -left-[9999px] top-0"
              >
                {origin ? <QRCodeCanvas value={url} size={700} /> : null}
              </div>
            </div>
          )}
        </div>

        {token && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-100 px-5 py-3">
            <button
              onClick={() => {
                if (
                  confirm(
                    "Create a new code? Any sticker already on this table will stop working.",
                  )
                )
                  mintMut.mutate();
              }}
              disabled={mintMut.isPending}
              className="inline-flex items-center gap-1 text-[11px] text-zinc-400 underline hover:text-zinc-700 disabled:opacity-50"
            >
              <RefreshCw className="h-3 w-3" /> New code
            </button>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={copy}>
                <Copy className="mr-1 h-3.5 w-3.5" /> Copy link
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={downloadPdf}
                loading={saving}
              >
                <Download className="mr-1 h-3.5 w-3.5" /> PDF
              </Button>
              <Button size="sm" onClick={print}>
                <Printer className="mr-1 h-3.5 w-3.5" /> Print
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
