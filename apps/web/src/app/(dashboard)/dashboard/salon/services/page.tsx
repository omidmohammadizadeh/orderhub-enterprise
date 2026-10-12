"use client";

// The price list: what you do, how long it takes, what it costs, and what
// the booking page may sell. Length matters as much as price here — it's
// what the diary uses to decide which times are free.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { ArrowDown, ArrowUp, Globe2, Plus, Trash2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCurrency } from "@/hooks/use-currency";
import { apiError, minutesLabel, salonClient, type DepositType, type SalonAddon, type SalonService } from "@/lib/api/salon.client";
import { SalonFrame, inputBase, inputCls, useSalonLocation, useSalonServices } from "@/components/salon/salon-shared";

export default function SalonServicesPage() {
  return (
    <SalonFrame title="Services" subtitle="Your price list — the lengths decide which times the diary offers.">
      <Services />
    </SalonFrame>
  );
}

function Services() {
  const qc = useQueryClient();
  const { money } = useCurrency();
  const { locationId } = useSalonLocation();
  const q = useSalonServices(locationId);
  const list = q.data ?? [];
  const [editing, setEditing] = useState<SalonService | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const groups = useMemo(() => {
    const m = new Map<string, SalonService[]>();
    for (const s of list) m.set(s.category, [...(m.get(s.category) ?? []), s]);
    return Array.from(m.entries());
  }, [list]);
  const refresh = () => qc.invalidateQueries({ queryKey: ["salon", "services", locationId] });

  const reorder = useMutation({
    mutationFn: (ids: string[]) => salonClient.reorderServices(locationId!, ids),
    onSuccess: (rows) => qc.setQueryData(["salon", "services", locationId], rows),
    onError: (e) => toast.error(apiError(e, "Couldn't reorder")),
  });
  const nudge = (s: SalonService, dir: -1 | 1) => {
    const ids = list.map((x) => x.id);
    const i = ids.indexOf(s.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    reorder.mutate(ids);
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => setImporting(true)}>
          <Upload className="h-4 w-4" aria-hidden /> Import price list
        </Button>
        <Button onClick={() => setEditing("new")}>
          <Plus className="h-4 w-4" aria-hidden /> Add service
        </Button>
      </div>
      {q.isLoading && <div className="h-40 animate-pulse rounded-2xl bg-zinc-100" />}
      {q.isSuccess && list.length === 0 && (
        <p className="rounded-2xl border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">No services yet. Add the first thing you do.</p>
      )}
      {groups.map(([cat, rows]) => (
        <section key={cat} className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
          <h2 className="border-b border-zinc-100 bg-zinc-50 px-4 py-2 text-sm font-semibold text-zinc-700">{cat}</h2>
          <ul className="divide-y divide-zinc-100">
            {rows.map((s) => (
              <li key={s.id} className={`flex items-center gap-3 px-4 py-3 ${s.isActive ? "" : "opacity-50"}`}>
                <div className="flex flex-col">
                  <button type="button" aria-label={`Move ${s.name} up`} onClick={() => nudge(s, -1)} className="grid h-6 w-6 place-items-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700">
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" aria-label={`Move ${s.name} down`} onClick={() => nudge(s, 1)} className="grid h-6 w-6 place-items-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700">
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                </div>
                <button type="button" onClick={() => setEditing(s)} className="min-w-0 flex-1 text-left">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-zinc-900">{s.name}</span>
                    {s.bookableOnline && s.isActive && <Globe2 className="h-3.5 w-3.5 shrink-0 text-sky-600" aria-label="Bookable online" />}
                  </span>
                  <span className="block truncate text-xs text-zinc-500">
                    {minutesLabel(s.durationMins)}
                    {s.bufferMins ? ` + ${s.bufferMins}m clean-down` : ""}
                    {s.processingMins ? ` · ${s.processingMins}m processing` : ""}
                    {s.addons.length ? ` · ${s.addons.length} add-on${s.addons.length === 1 ? "" : "s"}` : ""}
                    {s.depositType !== "NONE" ? ` · deposit` : ""}
                    {s.requiresPatchTest ? " · patch test" : ""}
                    {!s.isActive ? " · hidden" : ""}
                  </span>
                </button>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-zinc-900">
                  {s.priceFrom ? "from " : ""}
                  {money(s.price)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {importing && locationId && (
        <ImportSheet
          locationId={locationId}
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            refresh();
          }}
        />
      )}
      {editing && locationId && (
        <ServiceEditor
          locationId={locationId}
          service={editing === "new" ? null : editing}
          categories={groups.map(([c]) => c)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function ServiceEditor({
  locationId,
  service,
  categories,
  onClose,
  onSaved,
}: {
  locationId: string;
  service: SalonService | null;
  categories: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { symbol } = useCurrency();
  const [f, setF] = useState({
    name: service?.name ?? "",
    category: service?.category ?? categories[0] ?? "Services",
    description: service?.description ?? "",
    price: String(service?.price ?? ""),
    priceFrom: service?.priceFrom ?? false,
    durationMins: String(service?.durationMins ?? 30),
    bufferMins: String(service?.bufferMins ?? 0),
    processing: !!service?.processingMins,
    processingStartMins: String(service?.processingStartMins ?? 30),
    processingMins: String(service?.processingMins ?? 30),
    depositType: (service?.depositType ?? "NONE") as DepositType,
    depositValue: String(service?.depositValue ?? ""),
    requiresPatchTest: service?.requiresPatchTest ?? false,
    bookableOnline: service?.bookableOnline ?? true,
    isActive: service?.isActive ?? true,
    addons: (service?.addons ?? []) as SalonAddon[],
  });
  const up = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const body = () => ({
    name: f.name.trim(),
    category: f.category.trim() || "Services",
    description: f.description.trim() || null,
    price: Number(f.price) || 0,
    priceFrom: f.priceFrom,
    durationMins: Number(f.durationMins) || 30,
    bufferMins: Number(f.bufferMins) || 0,
    processingStartMins: f.processing ? Number(f.processingStartMins) || null : null,
    processingMins: f.processing ? Number(f.processingMins) || null : null,
    depositType: f.depositType,
    depositValue: f.depositType === "FIXED" || f.depositType === "PERCENT" ? Number(f.depositValue) || 0 : null,
    requiresPatchTest: f.requiresPatchTest,
    bookableOnline: f.bookableOnline,
    isActive: f.isActive,
    addons: f.addons.filter((a) => a.name.trim()),
  });
  const save = useMutation({
    mutationFn: () => (service ? salonClient.updateService(service.id, body()) : salonClient.createService(locationId, body())),
    onSuccess: () => {
      toast.success(service ? "Saved" : `${f.name.trim()} added`);
      onSaved();
    },
    onError: (e) => toast.error(apiError(e, "Couldn't save")),
  });
  const del = useMutation({
    mutationFn: () => salonClient.deleteService(service!.id),
    onSuccess: () => {
      toast.success("Deleted — past appointments keep their details");
      onSaved();
    },
    onError: (e) => toast.error(apiError(e, "Couldn't delete")),
  });

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={service ? `Edit ${service.name}` : "New service"}>
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 cursor-default bg-zinc-950/40" />
      <aside className="relative flex h-full w-full max-w-lg flex-col bg-white shadow-2xl motion-safe:animate-slide-in-right">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <h2 className="text-lg font-semibold text-zinc-900">{service ? service.name : "New service"}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-10 w-10 place-items-center rounded-full text-zinc-400 hover:bg-zinc-100">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="sm:col-span-2">
              <span className="text-sm font-medium text-zinc-800">Name</span>
              <input value={f.name} onChange={(e) => up("name", e.target.value)} placeholder="Skin fade" className={`${inputCls} mt-1`} />
            </label>
            <label>
              <span className="text-sm font-medium text-zinc-800">Group</span>
              <input list="salon-cats" value={f.category} onChange={(e) => up("category", e.target.value)} className={`${inputCls} mt-1`} />
              <datalist id="salon-cats">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </label>
            <label>
              <span className="text-sm font-medium text-zinc-800">Price ({symbol})</span>
              <input inputMode="decimal" value={f.price} onChange={(e) => up("price", e.target.value.replace(/[^\d.]/g, ""))} className={`${inputCls} mt-1`} />
            </label>
            <label className="flex items-center gap-2 text-sm text-zinc-700 sm:col-span-2">
              <input type="checkbox" checked={f.priceFrom} onChange={(e) => up("priceFrom", e.target.checked)} className="h-4 w-4 accent-orange-500" />
              Show as &ldquo;from&rdquo; — the final price is set at checkout
            </label>
            <label className="sm:col-span-2">
              <span className="text-sm font-medium text-zinc-800">Description (shown on the booking page)</span>
              <textarea value={f.description} onChange={(e) => up("description", e.target.value)} rows={2} className={`${inputCls} mt-1 h-auto py-2`} />
            </label>
          </div>

          <fieldset className="space-y-3 rounded-2xl border border-zinc-200 p-4">
            <legend className="px-1 text-sm font-semibold text-zinc-800">Time</legend>
            <div className="grid grid-cols-2 gap-3">
              <label>
                <span className="text-xs text-zinc-600">Takes (minutes)</span>
                <input inputMode="numeric" value={f.durationMins} onChange={(e) => up("durationMins", e.target.value.replace(/\D/g, ""))} className={`${inputCls} mt-1`} />
              </label>
              <label>
                <span className="text-xs text-zinc-600">Clean-down after (minutes)</span>
                <input inputMode="numeric" value={f.bufferMins} onChange={(e) => up("bufferMins", e.target.value.replace(/\D/g, ""))} className={`${inputCls} mt-1`} />
              </label>
            </div>
            <label className="flex items-start gap-2 text-sm text-zinc-700">
              <input type="checkbox" checked={f.processing} onChange={(e) => up("processing", e.target.checked)} className="mt-0.5 h-4 w-4 accent-orange-500" />
              <span>
                Has processing time (colour developing) — free to take someone else meanwhile
              </span>
            </label>
            {f.processing && (
              <div className="grid grid-cols-2 gap-3">
                <label>
                  <span className="text-xs text-zinc-600">Starts after (minutes)</span>
                  <input inputMode="numeric" value={f.processingStartMins} onChange={(e) => up("processingStartMins", e.target.value.replace(/\D/g, ""))} className={`${inputCls} mt-1`} />
                </label>
                <label>
                  <span className="text-xs text-zinc-600">Lasts (minutes)</span>
                  <input inputMode="numeric" value={f.processingMins} onChange={(e) => up("processingMins", e.target.value.replace(/\D/g, ""))} className={`${inputCls} mt-1`} />
                </label>
              </div>
            )}
          </fieldset>

          <fieldset className="space-y-3 rounded-2xl border border-zinc-200 p-4">
            <legend className="px-1 text-sm font-semibold text-zinc-800">Add-ons</legend>
            {f.addons.map((a, i) => (
              <div key={a.id || i} className="flex items-center gap-2">
                <input
                  aria-label="Add-on name"
                  value={a.name}
                  onChange={(e) => up("addons", f.addons.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                  placeholder="Beard trim"
                  className={`${inputBase} min-w-0 flex-1`}
                />
                <input
                  aria-label="Add-on price"
                  inputMode="decimal"
                  value={String(a.price)}
                  onChange={(e) => up("addons", f.addons.map((x, j) => (j === i ? { ...x, price: Number(e.target.value.replace(/[^\d.]/g, "")) || 0 } : x)))}
                  className={`${inputBase} w-20 text-right`}
                />
                <input
                  aria-label="Add-on extra minutes"
                  inputMode="numeric"
                  value={String(a.durationMins)}
                  onChange={(e) => up("addons", f.addons.map((x, j) => (j === i ? { ...x, durationMins: Number(e.target.value.replace(/\D/g, "")) || 0 } : x)))}
                  className={`${inputBase} w-16 text-right`}
                />
                <span className="text-xs text-zinc-400">min</span>
                <button type="button" aria-label="Remove add-on" onClick={() => up("addons", f.addons.filter((_, j) => j !== i))} className="grid h-10 w-10 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-red-600">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => up("addons", [...f.addons, { id: "", name: "", price: 0, durationMins: 10 }])}
              className="inline-flex items-center gap-1 text-sm font-medium text-orange-600 hover:text-orange-700"
            >
              <Plus className="h-4 w-4" aria-hidden /> Add an extra
            </button>
          </fieldset>

          <fieldset className="space-y-3 rounded-2xl border border-zinc-200 p-4">
            <legend className="px-1 text-sm font-semibold text-zinc-800">Online booking</legend>
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input type="checkbox" checked={f.bookableOnline} onChange={(e) => up("bookableOnline", e.target.checked)} className="h-4 w-4 accent-orange-500" />
              Can be booked online
            </label>
            <label className="block">
              <span className="text-xs text-zinc-600">Deposit when booked online</span>
              <select value={f.depositType} onChange={(e) => up("depositType", e.target.value as DepositType)} className={`${inputCls} mt-1`}>
                <option value="NONE">No deposit</option>
                <option value="FIXED">A fixed amount</option>
                <option value="PERCENT">A percentage</option>
                <option value="FULL">Pay in full</option>
              </select>
            </label>
            {(f.depositType === "FIXED" || f.depositType === "PERCENT") && (
              <label className="block">
                <span className="text-xs text-zinc-600">{f.depositType === "FIXED" ? `Amount (${symbol})` : "Percentage"}</span>
                <input inputMode="decimal" value={f.depositValue} onChange={(e) => up("depositValue", e.target.value.replace(/[^\d.]/g, ""))} className={`${inputCls} mt-1`} />
              </label>
            )}
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input type="checkbox" checked={f.requiresPatchTest} onChange={(e) => up("requiresPatchTest", e.target.checked)} className="h-4 w-4 accent-orange-500" />
              Needs a patch test 48 hours before (we remind the client)
            </label>
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input type="checkbox" checked={f.isActive} onChange={(e) => up("isActive", e.target.checked)} className="h-4 w-4 accent-orange-500" />
              Offered (untick to hide without deleting)
            </label>
          </fieldset>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-zinc-100 px-5 py-4">
          {service ? (
            <Button
              variant="ghost"
              className="text-red-600 hover:bg-red-50"
              loading={del.isPending}
              onClick={() => confirm(`Delete ${service.name}?`) && del.mutate()}
            >
              <Trash2 className="h-4 w-4" aria-hidden /> Delete
            </Button>
          ) : (
            <span />
          )}
          <Button disabled={!f.name.trim()} loading={save.isPending} onClick={() => save.mutate()}>
            {service ? "Save" : "Add service"}
          </Button>
        </div>
      </aside>
    </div>
  );
}

function ImportSheet({ locationId, onClose, onDone }: { locationId: string; onClose: () => void; onDone: () => void }) {
  const { money } = useCurrency();
  const [csv, setCsv] = useState("");
  const preview = useMutation({
    mutationFn: () => salonClient.importServices(locationId, csv, true),
    onError: (e) => toast.error(apiError(e, "Couldn't read that file")),
  });
  const run = useMutation({
    mutationFn: () => salonClient.importServices(locationId, csv, false),
    onSuccess: (r) => {
      toast.success(`Imported — ${r.created} added, ${r.updated} updated`);
      onDone();
    },
    onError: (e) => toast.error(apiError(e, "Couldn't import")),
  });
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  const p = preview.data;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label="Import price list">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 cursor-default bg-zinc-950/50" />
      <div className="relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900">Import price list</h2>
            <p className="text-xs text-zinc-500">From Fresha, Booksy, Treatwell, Square or your own spreadsheet — export services as CSV.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-10 w-10 place-items-center rounded-full text-zinc-400 hover:bg-zinc-100">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <label className="block">
            <span className="text-sm font-medium text-zinc-800">CSV file</span>
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                // Read as text so codes with leading zeros survive.
                setCsv(await f.text());
                preview.reset();
              }}
              className="mt-1 block w-full text-sm file:mr-3 file:h-9 file:rounded-lg file:border-0 file:bg-zinc-100 file:px-3 file:text-sm file:font-medium"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-zinc-800">…or paste it</span>
            <textarea
              value={csv}
              onChange={(e) => {
                setCsv(e.target.value);
                preview.reset();
              }}
              rows={5}
              placeholder={"Service name,Category,Duration,Price\nSkin fade,Haircuts,30min,£22"}
              className={`${inputCls} mt-1 h-auto py-2 font-mono text-xs`}
            />
          </label>
          {p && (
            <section className="space-y-2">
              <p className="text-sm text-zinc-700">
                {p.plan.filter((x) => x.action === "create").length} new, {p.plan.filter((x) => x.action === "update").length} already on your list (price and length will be updated).
                {p.skipped.length > 0 && ` ${p.skipped.length} row${p.skipped.length === 1 ? "" : "s"} skipped.`}
              </p>
              <div className="max-h-64 overflow-y-auto rounded-xl border border-zinc-200">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-zinc-50 text-left text-xs text-zinc-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">Service</th>
                      <th className="px-3 py-2 font-medium">Group</th>
                      <th className="px-3 py-2 text-right font-medium">Length</th>
                      <th className="px-3 py-2 text-right font-medium">Price</th>
                      <th className="px-3 py-2 font-medium" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100">
                    {p.plan.map((x) => (
                      <tr key={x.name}>
                        <td className="px-3 py-1.5">{x.name}</td>
                        <td className="px-3 py-1.5 text-zinc-500">{x.category}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{minutesLabel(x.durationMins)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {x.priceFrom ? "from " : ""}
                          {money(x.price)}
                        </td>
                        <td className="px-3 py-1.5 text-xs text-zinc-500">{x.action === "create" ? "New" : "Update"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {p.skipped.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-5 text-xs text-amber-700">
                  {p.skipped.slice(0, 8).map((x) => (
                    <li key={x.row}>
                      Row {x.row}: {x.reason}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-zinc-100 px-5 py-4">
          {!p ? (
            <Button disabled={!csv.trim()} loading={preview.isPending} onClick={() => preview.mutate()}>
              Check the file
            </Button>
          ) : (
            <Button disabled={p.plan.length === 0} loading={run.isPending} onClick={() => run.mutate()}>
              Import {p.plan.length} service{p.plan.length === 1 ? "" : "s"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
