"use client";

// Import a whole menu from a JSON file.
//
// Some shops have no Uber/Deliveroo/Just Eat connection to pull a menu from,
// so there is nothing to import and the alternative is typing a hundred items
// in by hand. This takes a JSON file describing the whole menu — categories,
// items, sizes, modifier groups, options — and commits it in one go.
//
// It reuses the AI import's commit endpoint rather than adding a second way to
// write a menu: that path already handles sizes, nested groups, PLU
// generation and the import lock. The only difference is where the draft came
// from — a file instead of a photo — so the file is validated here, since it
// has not been through the AI flow's review screen.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { FileJson, Loader2, X, AlertTriangle, Check } from "lucide-react";
import { validateMenuJson, type MenuJsonReport } from "@orderhub/shared";
import { menusClient, type AiMenuDraft } from "@/lib/api/menus.client";
import toast from "react-hot-toast";

interface Props {
  open: boolean;
  brandId: string | null;
  locationId: string | null;
  onCreated: (menuId: string) => void;
  onCancel: () => void;
}

export function ImportJsonMenuModal({
  open,
  brandId,
  locationId,
  onCreated,
  onCancel,
}: Props) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [draft, setDraft] = useState<AiMenuDraft | null>(null);
  const [report, setReport] = useState<MenuJsonReport | null>(null);
  const [menuName, setMenuName] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);

  const reset = () => {
    setFileName(null);
    setDraft(null);
    setReport(null);
    setMenuName("");
    setParseError(null);
  };

  const commit = useMutation({
    mutationFn: async () => {
      if (!brandId) throw new Error("Pick a brand first");
      if (!draft) throw new Error("Choose a file first");
      return menusClient.aiCommitMenu(brandId, {
        menuName: menuName.trim() || undefined,
        locationId: locationId ?? undefined,
        draft,
      });
    },
    onSuccess: (res) => {
      toast.success(
        `Menu created — ${res.createdCount} item${res.createdCount === 1 ? "" : "s"}`,
      );
      // Warnings from the writer are worth seeing but are not failures.
      for (const w of (res.warnings ?? []).slice(0, 3)) {
        toast(w, { icon: "⚠️", duration: 8000 });
      }
      reset();
      onCreated(res.menuId);
    },
    onError: (e: any) =>
      toast.error(
        e?.response?.data?.message ?? e?.message ?? "Couldn't import that menu",
      ),
  });

  const onFile = async (file: File) => {
    reset();
    setFileName(file.name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch (e: any) {
      // Say WHERE it broke — "Unexpected token } at position 4821" is the
      // only clue you get with a hand-edited file.
      setParseError(`That file isn't valid JSON — ${e?.message ?? "could not be read"}`);
      return;
    }
    const r = validateMenuJson(parsed);
    setReport(r);
    if (r.ok) {
      setDraft(parsed as AiMenuDraft);
      setMenuName(r.summary?.menuName ?? "");
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 p-5">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">
              Import menu from JSON
            </h2>
            <p className="text-xs text-zinc-500">
              Builds the whole menu — categories, items, sizes and options — in one go.
            </p>
          </div>
          <button
            onClick={() => {
              if (commit.isPending) return;
              reset();
              onCancel();
            }}
            className="text-zinc-400 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-zinc-200 px-4 py-8 text-center hover:border-zinc-300">
            <FileJson className="h-7 w-7 text-zinc-400" />
            <span className="text-sm font-medium text-zinc-700">
              {fileName ?? "Choose a .json file"}
            </span>
            <span className="text-xs text-zinc-400">
              Nothing is created until you press Import.
            </span>
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                // Clear the input so re-picking the same file after a fix
                // still fires a change event.
                e.target.value = "";
                if (f) void onFile(f);
              }}
            />
          </label>

          {parseError && <Problem>{parseError}</Problem>}

          {report && !report.ok && (
            <div className="space-y-2">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-red-700">
                <AlertTriangle className="h-4 w-4" />
                {report.errors.length} problem
                {report.errors.length === 1 ? "" : "s"} — nothing was imported
              </p>
              <ul className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-red-200 bg-red-50 p-3">
                {report.errors.map((e, i) => (
                  <li key={i} className="text-xs text-red-800">
                    {e}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report?.ok && report.summary && (
            <>
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                <p className="flex items-center gap-1.5 text-sm font-semibold text-emerald-900">
                  <Check className="h-4 w-4" />
                  Ready to import
                </p>
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-emerald-900 sm:grid-cols-4">
                  <Stat label="Categories" value={report.summary.categories} />
                  <Stat label="Items" value={report.summary.items} />
                  <Stat label="Option groups" value={report.summary.modifierGroups} />
                  <Stat label="Options" value={report.summary.options} />
                </div>
                {report.summary.sizedItems > 0 && (
                  <p className="mt-2 text-[11px] text-emerald-700">
                    {report.summary.sizedItems} item
                    {report.summary.sizedItems === 1 ? " has" : "s have"} sizes.
                  </p>
                )}
              </div>

              {report.warnings.length > 0 && (
                <details className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <summary className="cursor-pointer text-xs font-semibold text-amber-900">
                    {report.warnings.length} thing
                    {report.warnings.length === 1 ? "" : "s"} worth checking
                    (won&rsquo;t stop the import)
                  </summary>
                  <ul className="mt-2 space-y-1">
                    {report.warnings.map((w, i) => (
                      <li key={i} className="text-[11px] text-amber-800">
                        {w}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-600">
                  Menu name
                </label>
                <input
                  value={menuName}
                  onChange={(e) => setMenuName(e.target.value)}
                  placeholder="Menu name"
                  className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
                />
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-100 p-4">
          <button
            type="button"
            onClick={() => {
              reset();
              onCancel();
            }}
            disabled={commit.isPending}
            className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => commit.mutate()}
            disabled={!report?.ok || !brandId || commit.isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-40"
          >
            {commit.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Import menu
          </button>
        </div>
      </div>
    </div>
  );
}

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
      {children}
    </p>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span>
      <span className="font-semibold tabular-nums">{value}</span> {label}
    </span>
  );
}
