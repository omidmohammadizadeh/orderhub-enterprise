"use client";

// Retail R1 — build the whole shop catalogue from a spreadsheet.
//
// Parsed in the browser (the same `xlsx` library the SMS contact import
// uses), checked with a dry run so every bad row is listed before anything
// is written, then sent in chunks. A chunk never splits a product's sizes
// across two requests, and the server never deletes — re-importing a sheet
// updates prices and counts in place.

import { useState } from "react";
import { FileSpreadsheet, Loader2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { retailClient, type ImportSummary } from "@/lib/api/retail.client";

const TEMPLATE_HEADERS = ["Name", "Category", "Price", "Barcode", "SKU", "Size", "Colour", "Stock", "Cost"];
const TEMPLATE_ROWS = [
  ["Coca-Cola 330ml", "Drinks", "1.25", "5000112637922", "", "", "", "24", "0.55"],
  ["Oxford Shirt", "Shirts", "30.00", "", "", "M", "Blue", "3", "12.00"],
  ["Oxford Shirt", "Shirts", "30.00", "", "", "L", "Blue", "2", "12.00"],
];
const CHUNK_ROWS = 500;

type Row = Record<string, unknown>;

export function downloadTemplate() {
  const csv = [TEMPLATE_HEADERS, ...TEMPLATE_ROWS]
    .map((r) => r.map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","))
    .join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: "orderhub-products-template.csv" });
  a.click();
  URL.revokeObjectURL(url);
}

async function readSheet(file: File): Promise<Row[]> {
  const XLSX = await import("xlsx");
  // A CSV is read as TEXT: parsing it as numbers turns 0036000291452 into
  // 36000291452 and a long EAN into 5.01235E+12 — both unscannable. A real
  // .xlsx keeps whatever type the cell has, and a whole-number barcode
  // survives as a number (the server normalises it).
  const wb = /\.csv$/i.test(file.name)
    ? XLSX.read(await file.text(), { type: "string", raw: true })
    : XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]!];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json<Row>(sheet, { defval: "", raw: true });
}

/** Keep each product's rows together, then cut into request-sized chunks.
 *  Returns, per chunk, the rows and each row's original sheet line. */
export function chunkByProduct(rows: Row[], size = CHUNK_ROWS) {
  const nameOf = (r: Row) => {
    const key = Object.keys(r).find((k) => /^(name|product|productname|item|itemname|title)$/i.test(k.replace(/[^a-z]/gi, "")));
    return String(key ? r[key] : "").trim().toLowerCase();
  };
  const groups = new Map<string, Array<{ row: Row; line: number }>>();
  rows.forEach((row, i) => {
    const k = nameOf(row) || `__blank${i}`;
    groups.set(k, [...(groups.get(k) ?? []), { row, line: i + 2 }]); // +1 header, +1 one-based
  });
  const chunks: Array<{ rows: Row[]; lines: number[] }> = [];
  let cur: { rows: Row[]; lines: number[] } = { rows: [], lines: [] };
  for (const g of groups.values()) {
    if (cur.rows.length && cur.rows.length + g.length > size) {
      chunks.push(cur);
      cur = { rows: [], lines: [] };
    }
    for (const { row, line } of g) {
      cur.rows.push(row);
      cur.lines.push(line);
    }
  }
  if (cur.rows.length) chunks.push(cur);
  return chunks;
}

function merge(results: Array<{ s: ImportSummary; lines: number[] }>) {
  const total = {
    products: 0,
    created: 0,
    updated: 0,
    variantsCreated: 0,
    variantsUpdated: 0,
    stockSet: 0,
    errors: [] as Array<{ line: number; message: string }>,
  };
  for (const { s, lines } of results) {
    total.products += s.products;
    total.created += s.created;
    total.updated += s.updated;
    total.variantsCreated += s.variantsCreated;
    total.variantsUpdated += s.variantsUpdated;
    total.stockSet += s.stockSet;
    for (const e of s.errors) total.errors.push({ line: lines[e.row - 1] ?? e.row, message: e.message });
  }
  total.errors.sort((a, b) => a.line - b.line);
  return total;
}

export function ImportProductsModal({
  locationId,
  onClose,
  onDone,
}: {
  locationId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [chunks, setChunks] = useState<ReturnType<typeof chunkByProduct> | null>(null);
  const [check, setCheck] = useState<ReturnType<typeof merge> | null>(null);
  const [result, setResult] = useState<ReturnType<typeof merge> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (f: File) => {
    setFile(f);
    setCheck(null);
    setResult(null);
    setError(null);
    try {
      setBusy("Reading the sheet…");
      const rows = await readSheet(f);
      if (!rows.length) throw new Error("That sheet has no rows under the header.");
      const c = chunkByProduct(rows);
      setChunks(c);
      setBusy("Checking every row…");
      const out = [];
      for (const ch of c) out.push({ s: await retailClient.importRows(locationId, ch.rows, true), lines: ch.lines });
      setCheck(merge(out));
    } catch (e: any) {
      setError(e?.response?.data?.message ?? e?.message ?? "Couldn't read that file");
    } finally {
      setBusy(null);
    }
  };

  const run = async () => {
    if (!chunks) return;
    setError(null);
    const out = [];
    try {
      for (const [i, ch] of chunks.entries()) {
        setBusy(`Importing${chunks.length > 1 ? ` part ${i + 1} of ${chunks.length}` : ""}…`);
        out.push({ s: await retailClient.importRows(locationId, ch.rows), lines: ch.lines });
      }
    } catch (e: any) {
      setError(e?.response?.data?.message ?? e?.message ?? "The import stopped part-way — run it again; finished rows are updated, not duplicated.");
    } finally {
      setBusy(null);
      if (out.length) {
        setResult(merge(out));
        onDone();
      }
    }
  };

  const summary = result ?? check;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
            <FileSpreadsheet className="h-4 w-4" /> Import products
          </h2>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto p-4 text-sm">
          <p className="text-zinc-600">
            One row per product — or per size/colour for clothes. Columns: <strong>Name</strong> and{" "}
            <strong>Price</strong> are required; Category, Barcode, SKU, Size, Colour, Stock and Cost are optional.
            Rows matching an existing barcode or name are updated, never duplicated.
          </p>
          <button type="button" onClick={downloadTemplate} className="text-xs font-medium text-orange-600 hover:underline">
            Download a template (.csv)
          </button>

          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-zinc-200 p-6 text-center hover:border-zinc-400">
            <Upload className="h-5 w-5 text-zinc-400" aria-hidden />
            <span className="text-sm font-medium text-zinc-800">{file ? file.name : "Choose a .csv or .xlsx file"}</span>
            <span className="text-xs text-zinc-500">Keep the barcode column formatted as Text so every digit survives.</span>
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void load(f);
                e.target.value = "";
              }}
            />
          </label>

          {busy && (
            <p className="flex items-center gap-2 text-zinc-600">
              <Loader2 className="h-4 w-4 animate-spin" /> {busy}
            </p>
          )}
          {error && <p className="rounded-lg bg-red-50 p-3 text-xs text-red-700">{error}</p>}

          {summary && (
            <div className={`rounded-lg border p-3 ${result ? "border-emerald-200 bg-emerald-50" : "border-zinc-200"}`}>
              <p className="font-semibold text-zinc-900">
                {result
                  ? `Imported: ${result.created} new, ${result.updated} updated`
                  : `${summary.products} products ready to import`}
              </p>
              {result && (
                <p className="text-xs text-zinc-600">
                  {result.variantsCreated + result.variantsUpdated} barcodes/sizes saved · {result.stockSet} stock counts set
                </p>
              )}
              {summary.errors.length > 0 && (
                <div className="mt-2">
                  <p className="text-xs font-semibold text-amber-800">
                    {summary.errors.length} row{summary.errors.length === 1 ? "" : "s"} will be skipped:
                  </p>
                  <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-xs text-amber-900">
                    {summary.errors.map((e, i) => (
                      <li key={i}>
                        Row {e.line}: {e.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-zinc-200 p-4">
          <Button variant="outline" onClick={onClose}>
            {result ? "Done" : "Cancel"}
          </Button>
          {!result && (
            <Button disabled={!check || !check.products || !!busy} loading={!!busy && !!check} onClick={() => void run()}>
              Import {check?.products ? `${check.products} products` : ""}
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}
