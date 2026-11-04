"use client";

// What a shop pays its marketplaces, and what moving some of that to direct
// orders would be worth. All the sums happen on the server (commission-report.ts).

import { useMemo, useState, type FormEvent } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import toast from "react-hot-toast";
import {
  prospectsClient,
  type CommissionReport,
  type ManualStatement,
  type Prospect,
  type ReportAssumptions,
  type StatementPlatform,
} from "@/lib/api/prospects.client";
import { DropZone, errorMessage, toUploadFile } from "./prospect-upload";

const PLATFORM_NAMES: Record<StatementPlatform, string> = {
  just_eat: "Just Eat",
  uber_eats: "Uber Eats",
  deliveroo: "Deliveroo",
  other: "Other",
};

const STATEMENT_ACCEPT = ".pdf,.csv,.txt,.html,.htm,.png,.jpg,.jpeg,.webp";
const fieldClass =
  "min-h-10 w-full rounded-lg border border-zinc-300 px-3 text-sm tabular-nums focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-500";

const shortDate = (s: string | null) =>
  s ? new Date(`${s}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "?";

function useMoney(currency: string) {
  return useMemo(() => {
    const whole = new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 0 });
    return (n: number) => whole.format(n);
  }, [currency]);
}

function Assumption({
  label,
  value,
  step,
  onCommit,
}: {
  label: string;
  value: number;
  step: number;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="block text-xs font-medium text-zinc-600">
      {label}
      <input
        type="number"
        inputMode="decimal"
        min={0}
        step={step}
        value={draft ?? value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const n = Number(draft);
          if (draft !== null && draft !== "" && Number.isFinite(n) && n >= 0 && n !== value) onCommit(n);
          setDraft(null);
        }}
        className={`${fieldClass} mt-1`}
      />
    </label>
  );
}

function Report({
  report,
  onAssumptions,
}: {
  report: CommissionReport;
  onAssumptions: (a: Partial<ReportAssumptions>) => void;
}) {
  const money = useMoney(report.currency);
  const a = report.assumptions;
  const headline = report.year ? report.year.commission : report.commission;
  const thin = report.shortestPeriodDays !== null && report.shortestPeriodDays < 28;

  return (
    <div className="mt-5 overflow-hidden rounded-xl border border-zinc-200">
      <div className="bg-zinc-900 px-5 py-6 text-white">
        <p className="text-sm text-zinc-300">
          {report.year ? "Commission in a year, at this rate" : "Commission on these statements"}
        </p>
        <p className="mt-1 text-4xl font-bold tabular-nums tracking-tight">
          {thin && "About "}
          {money(headline)}
        </p>
        <p className="mt-1 text-sm text-zinc-300">
          {report.commissionRatePct}% of sales, excluding VAT
          {(report.year?.otherFees ?? report.otherFees) > 0 &&
            `, plus ${money(report.year?.otherFees ?? report.otherFees)} in other fees`}
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">What the statements show, by marketplace</caption>
          <thead className="bg-zinc-50 text-left text-xs text-zinc-500">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">From the statements</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Sales</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Commission</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Rate</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 tabular-nums">
            {report.platforms.map((p) => (
              <tr key={p.platform}>
                <th scope="row" className="px-4 py-2 text-left font-medium text-zinc-800">
                  {PLATFORM_NAMES[p.platform]}
                  {p.daysCovered !== null && <span className="ml-1 font-normal text-zinc-500">({p.daysCovered} days)</span>}
                </th>
                <td className="px-4 py-2 text-right">{money(p.sales)}</td>
                <td className="px-4 py-2 text-right">{money(p.commission)}</td>
                <td className="px-4 py-2 text-right">{p.commissionRatePct}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {report.scenario && (
        <div className="border-t border-zinc-200 px-5 py-5">
          <h3 className="font-semibold text-zinc-900">If {a.movedSharePct}% of those sales moved to their own OrderHub ordering</h3>
          <dl className="mt-3 space-y-1.5 text-sm tabular-nums">
            <div className="flex justify-between gap-4">
              <dt className="text-zinc-600">Commission no longer paid</dt>
              <dd className="font-medium text-emerald-700">+{money(report.scenario.commissionSaved)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-zinc-600">Card fees on those orders</dt>
              <dd>−{money(report.scenario.cardFees)}</dd>
            </div>
            {report.scenario.deliveryCosts > 0 && (
              <div className="flex justify-between gap-4">
                <dt className="text-zinc-600">Delivering those orders</dt>
                <dd>−{money(report.scenario.deliveryCosts)}</dd>
              </div>
            )}
            <div className="flex justify-between gap-4">
              <dt className="text-zinc-600">OrderHub subscription</dt>
              <dd>−{money(report.scenario.subscription)}</dd>
            </div>
            <div className="flex justify-between gap-4 border-t border-zinc-200 pt-2 text-base font-bold">
              <dt>{report.scenario.netPerYear >= 0 ? "Better off, per year" : "Worse off, per year"}</dt>
              <dd className={report.scenario.netPerYear >= 0 ? "text-emerald-700" : "text-red-700"}>
                {money(Math.abs(report.scenario.netPerYear))}
              </dd>
            </div>
          </dl>
          {report.scenario.breakEvenSharePct !== null && (
            <p className="mt-3 text-sm text-zinc-700">
              OrderHub pays for itself once about <strong>{Math.ceil(report.scenario.breakEvenSharePct)}%</strong> of these sales move across.
            </p>
          )}
          {report.scenario.breakEvenSharePct === null && (
            <p className="mt-3 text-sm text-zinc-700">
              On these costs, moving orders across doesn&apos;t pay for the subscription. Check the delivery cost below before quoting this.
            </p>
          )}

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Assumption label="Sales moved (%)" value={a.movedSharePct} step={5} onCommit={(n) => onAssumptions({ movedSharePct: Math.min(n, 100) })} />
            <Assumption label="Card fee (%)" value={a.cardPct} step={0.1} onCommit={(n) => onAssumptions({ cardPct: n })} />
            <Assumption label="Card fee (pence)" value={a.cardFixedPence} step={1} onCommit={(n) => onAssumptions({ cardFixedPence: n })} />
            <Assumption label="Plan (per week)" value={a.subscriptionPerWeek} step={1} onCommit={(n) => onAssumptions({ subscriptionPerWeek: n })} />
            <Assumption label="Delivery (per order)" value={a.deliveryCostPerOrder} step={0.5} onCommit={(n) => onAssumptions({ deliveryCostPerOrder: n })} />
          </div>
        </div>
      )}

      {report.notes.length > 0 && (
        <ul className="space-y-1 border-t border-zinc-200 bg-amber-50 px-5 py-3 text-xs text-amber-900">
          {report.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}
    </div>
  );
}

function ByHandForm({ onAdd }: { onAdd: (s: ManualStatement) => Promise<boolean> }) {
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const value = (name: string) => String(data.get(name) ?? "").trim();
    const fees = Number(value("fees"));
    setSaving(true);
    const added = await onAdd({
      platform: value("platform") as StatementPlatform,
      sales: Number(value("sales")),
      commission: Number(value("commission")),
      ...(value("periodStart") && { periodStart: value("periodStart") }),
      ...(value("periodEnd") && { periodEnd: value("periodEnd") }),
      ...(value("orders") && { orders: Math.round(Number(value("orders"))) }),
      ...(fees > 0 && { otherFees: [{ label: "Other fees", amount: fees }] }),
    });
    setSaving(false);
    if (added) form.reset();
  }

  return (
    <details className="mt-3 rounded-lg border border-zinc-200">
      <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium text-zinc-700">
        No statement to hand? Add the figures by hand
      </summary>
      <form onSubmit={submit} className="grid grid-cols-2 gap-3 border-t border-zinc-200 p-3 sm:grid-cols-4">
        <label className="block text-xs font-medium text-zinc-600">
          Marketplace
          <select name="platform" defaultValue="just_eat" className={`${fieldClass} mt-1 bg-white`}>
            {Object.entries(PLATFORM_NAMES).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
          </select>
        </label>
        <label className="block text-xs font-medium text-zinc-600">
          From
          <input type="date" name="periodStart" required className={`${fieldClass} mt-1`} />
        </label>
        <label className="block text-xs font-medium text-zinc-600">
          To
          <input type="date" name="periodEnd" required className={`${fieldClass} mt-1`} />
        </label>
        <label className="block text-xs font-medium text-zinc-600">
          Orders
          <input type="number" name="orders" min={0} step={1} inputMode="numeric" className={`${fieldClass} mt-1`} />
        </label>
        <label className="block text-xs font-medium text-zinc-600">
          Sales
          <input type="number" name="sales" min={0.01} step="0.01" inputMode="decimal" required className={`${fieldClass} mt-1`} />
        </label>
        <label className="block text-xs font-medium text-zinc-600">
          Commission, excl. VAT
          <input type="number" name="commission" min={0} step="0.01" inputMode="decimal" required className={`${fieldClass} mt-1`} />
        </label>
        <label className="block text-xs font-medium text-zinc-600">
          Other fees
          <input type="number" name="fees" min={0} step="0.01" inputMode="decimal" className={`${fieldClass} mt-1`} />
        </label>
        <div className="flex items-end">
          <button
            type="submit"
            disabled={saving}
            className="min-h-10 w-full rounded-lg bg-zinc-900 px-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-60"
          >
            Add
          </button>
        </div>
      </form>
    </details>
  );
}

export function CommissionSection({
  prospect,
  onChange,
}: {
  prospect: Prospect;
  onChange: (p: Prospect) => void;
}) {
  const [busy, setBusy] = useState(false);
  const reading = busy || prospect.statementStatus === "READING";
  const money2 = useMemo(() => {
    const format = new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: prospect.report?.currency ?? "GBP",
    });
    return (n: number) => format.format(n);
  }, [prospect.report?.currency]);

  async function handleFiles(files: File[]) {
    setBusy(true);
    try {
      onChange(await prospectsClient.readStatements(prospect.id, await Promise.all(files.map(toUploadFile))));
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't read this statement."));
    } finally {
      setBusy(false);
    }
  }

  async function addByHand(statement: ManualStatement): Promise<boolean> {
    try {
      onChange(await prospectsClient.addStatement(prospect.id, statement));
      return true;
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't add those figures."));
      return false;
    }
  }

  async function removeStatement(statementId: string) {
    try {
      onChange(await prospectsClient.removeStatement(prospect.id, statementId));
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't remove this statement."));
    }
  }

  async function changeAssumptions(next: Partial<ReportAssumptions>) {
    try {
      onChange(await prospectsClient.setAssumptions(prospect.id, next));
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't update the report."));
    }
  }

  return (
    <section aria-labelledby="commission-heading" className="rounded-xl border border-zinc-200 bg-white p-5">
      <h2 id="commission-heading" className="text-lg font-semibold text-zinc-900">What they pay</h2>
      <p className="mt-1 text-sm text-zinc-600">
        Upload their marketplace statements. Only the figures are kept, never the file.
      </p>

      <div className="mt-4">
        <DropZone
          label="Choose statements"
          hint="PDF, CSV or a clear photo. Several at once is fine, up to about 5 MB in total."
          accept={STATEMENT_ACCEPT}
          busy={reading}
          onFiles={handleFiles}
        />
      </div>

      {prospect.statementStatus === "FAILED" && (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{prospect.statementError}</p>
      )}

      <ByHandForm onAdd={addByHand} />

      {prospect.statements.length > 0 && (
        <ul className="mt-4 divide-y divide-zinc-100 rounded-lg border border-zinc-200">
          {prospect.statements.map((s) => (
            <li key={s.id} className="px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 text-sm">
                  <p className="font-medium text-zinc-800">
                    {PLATFORM_NAMES[s.platform]}{" "}
                    <span className="font-normal text-zinc-500">
                      {shortDate(s.periodStart)} to {shortDate(s.periodEnd)}
                      {s.source === "manual" && " · by hand"}
                    </span>
                  </p>
                  <p className="tabular-nums text-zinc-600">
                    {money2(s.sales)} sales · {money2(s.commission)} commission
                    {s.orders !== null && ` · ${s.orders} orders`}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label={`Remove the ${PLATFORM_NAMES[s.platform]} statement`}
                  onClick={() => removeStatement(s.id)}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-red-50 hover:text-red-600"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              {s.warnings.map((warning) => (
                <p key={warning} className="mt-1 flex gap-1.5 text-xs text-amber-800">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {warning}
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}

      {prospect.report && <Report report={prospect.report} onAssumptions={changeAssumptions} />}
    </section>
  );
}
