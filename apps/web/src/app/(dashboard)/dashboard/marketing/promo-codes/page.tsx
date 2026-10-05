"use client";

// Marketing → Promo codes. Every discount code in one place: what it gives,
// who can use it and how often, whether it's live, what it has sold — and
// which emails promise it, so pausing or deleting one is never a surprise.

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  Loader2,
  Mail,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  ShoppingBag,
  Store,
  Ticket,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import {
  promoCodesPageClient,
  type PromoInput,
  type PromoOverview,
  type PromoStatus,
  type PromoType,
} from "@/lib/api/promo-codes.client";
import { apiErrorMessage } from "@/lib/api/email-marketing.client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { useAuthStore } from "@/stores/auth.store";
import { useCurrency } from "@/hooks/use-currency";
import { cn } from "@/lib/utils";

const STATUS: Record<PromoStatus, { label: string; cls: string }> = {
  ACTIVE: { label: "Active", cls: "bg-emerald-100 text-emerald-800" },
  SCHEDULED: { label: "Starts later", cls: "bg-sky-100 text-sky-800" },
  PAUSED: { label: "Paused", cls: "bg-zinc-100 text-zinc-600" },
  EXPIRED: { label: "Expired", cls: "bg-amber-100 text-amber-800" },
  USED_UP: { label: "Used up", cls: "bg-amber-100 text-amber-800" },
};

type Filter = "ALL" | "LIVE" | "PAUSED" | "ENDED";
const TENANT_WIDE = ["PLATFORM_ADMIN", "TENANT_OWNER"];

export default function PromoCodesPage() {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const { moneyLong } = useCurrency();
  const [filter, setFilter] = useState<Filter>("ALL");
  const [editing, setEditing] = useState<PromoOverview | "new" | null>(null);
  const [viewing, setViewing] = useState<PromoOverview | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ["promo-codes-page", locationId],
    queryFn: () => promoCodesPageClient.overview(locationId),
  });

  const codes = data ?? [];
  const shown = codes.filter((c) =>
    filter === "ALL"
      ? true
      : filter === "LIVE"
        ? c.status === "ACTIVE" || c.status === "SCHEDULED"
        : filter === "PAUSED"
          ? c.status === "PAUSED"
          : c.status === "EXPIRED" || c.status === "USED_UP",
  );
  const totals = useMemo(
    () =>
      codes.reduce(
        (t, c) => ({
          live: t.live + (c.status === "ACTIVE" ? 1 : 0),
          orders: t.orders + c.results.orders,
          revenue: t.revenue + c.results.revenue,
          discount: t.discount + c.results.discount,
        }),
        { live: 0, orders: 0, revenue: 0, discount: 0 },
      ),
    [codes],
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-100 text-indigo-700">
            <Ticket className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-zinc-900">Promo codes</h1>
            <p className="text-sm text-zinc-500">Discount codes for the till, online ordering and your emails</p>
          </div>
        </div>
        <button
          onClick={() => setEditing("new")}
          className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700"
        >
          <Plus className="h-4 w-4" /> New code
        </button>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ["Live codes", totals.live.toLocaleString()],
          ["Orders with a code", totals.orders.toLocaleString()],
          ["Sales from those orders", moneyLong(totals.revenue)],
          ["Discount given", moneyLong(totals.discount)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-zinc-200 bg-white px-4 py-3">
            <div className="text-xs text-zinc-500">{label}</div>
            <div className="mt-1 text-xl font-bold tabular-nums text-zinc-900">{value}</div>
          </div>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap gap-1 border-b border-zinc-200">
        {(
          [
            ["ALL", "All"],
            ["LIVE", "Live"],
            ["PAUSED", "Paused"],
            ["ENDED", "Expired / used up"],
          ] as [Filter, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={cn(
              "border-b-2 px-4 py-2.5 text-sm font-medium transition",
              filter === key ? "border-indigo-600 text-indigo-700" : "border-transparent text-zinc-500 hover:text-zinc-800",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {isLoading ? (
          <div className="flex justify-center py-12 text-zinc-400">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : error && !codes.length ? (
          // A failed refresh keeps showing the codes it already has.
          <p className="text-sm text-rose-600">{apiErrorMessage(error)}</p>
        ) : !codes.length ? (
          <div className="rounded-2xl border border-dashed border-zinc-300 bg-white px-6 py-12 text-center">
            <Ticket className="mx-auto h-9 w-9 text-indigo-400" />
            <h3 className="mt-3 text-base font-semibold text-zinc-900">No promo codes yet</h3>
            <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500">
              Create a code customers type at checkout, like WEEKEND20 for 20% off. You can also make one straight from
              an email&apos;s offer section.
            </p>
            <button
              onClick={() => setEditing("new")}
              className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white"
            >
              <Plus className="h-4 w-4" /> Create a code
            </button>
          </div>
        ) : !shown.length ? (
          <p className="py-10 text-center text-sm text-zinc-500">No codes in this view.</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
            <div className="hidden grid-cols-[1.4fr_1.2fr_0.9fr_1fr_110px] gap-3 border-b border-zinc-100 bg-zinc-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 md:grid">
              <span>Code</span>
              <span>Discount</span>
              <span>Uses</span>
              <span>Results</span>
              <span>Status</span>
            </div>
            {shown.map((c) => (
              <PromoRow key={c.id} c={c} onOpen={() => setViewing(c)} />
            ))}
          </div>
        )}
      </div>

      {editing && (
        <PromoForm
          existing={editing === "new" ? null : editing}
          locationId={locationId}
          onClose={() => setEditing(null)}
        />
      )}
      {viewing && (
        <PromoDrawer
          c={codes.find((x) => x.id === viewing.id) ?? viewing}
          onClose={() => setViewing(null)}
          onEdit={(c) => {
            setViewing(null);
            setEditing(c);
          }}
        />
      )}
    </div>
  );
}

function describe(c: Pick<PromoOverview, "type" | "value" | "minOrderValue">, money: (n: number) => string): string {
  const what = c.type === "PERCENTAGE" ? `${c.value}% off` : c.type === "FIXED_AMOUNT" ? `${money(c.value)} off` : "Free delivery";
  return c.minOrderValue ? `${what} · min ${money(c.minOrderValue)}` : what;
}

const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null;

function PromoRow({ c, onOpen }: { c: PromoOverview; onOpen: () => void }) {
  const { money } = useCurrency();
  const [copied, setCopied] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      className="grid cursor-pointer grid-cols-[1fr_auto] items-center gap-3 border-b border-zinc-100 px-4 py-3 last:border-0 hover:bg-zinc-50 md:grid-cols-[1.4fr_1.2fr_0.9fr_1fr_110px]"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-bold tracking-wide text-zinc-900">{c.code}</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigator.clipboard?.writeText(c.code).catch(() => undefined);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
            aria-label={`Copy ${c.code}`}
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
        <div className="text-xs font-medium text-zinc-700 md:hidden">
          {describe(c, money)} · {c.results.orders} order{c.results.orders === 1 ? "" : "s"}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-zinc-500">
          {c.locationIds.length === 0 ? "All shops" : c.locationIds.length === 1 ? "This shop" : `${c.locationIds.length} shops`}
          {c.showOnPos && <span>· till button</span>}
          {c.usedIn.length > 0 && (
            <span className="inline-flex items-center gap-0.5 text-indigo-700">
              · <Mail className="h-3 w-3" /> in {c.usedIn.length} email{c.usedIn.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </div>
      <div className="hidden text-sm text-zinc-700 md:block">
        {describe(c, money)}
        {c.expiresAt && <div className="text-xs text-zinc-500">until {fmtDate(c.expiresAt)}</div>}
      </div>
      <div className="hidden text-sm tabular-nums text-zinc-700 md:block">
        {c.usedCount.toLocaleString()}
        {c.maxUses != null ? ` / ${c.maxUses.toLocaleString()}` : ""}
        <div className="text-xs text-zinc-500">
          {c.maxUsesPerCustomer === 1
            ? "once per customer"
            : c.maxUsesPerCustomer
              ? `${c.maxUsesPerCustomer}× per customer`
              : "no per-customer limit"}
        </div>
      </div>
      <div className="hidden text-sm tabular-nums text-zinc-700 md:block">
        {c.results.orders.toLocaleString()} order{c.results.orders === 1 ? "" : "s"}
        <div className="text-xs text-zinc-500">{money(c.results.revenue)} sales</div>
      </div>
      <div>
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", STATUS[c.status].cls)}>
          {STATUS[c.status].label}
        </span>
      </div>
    </div>
  );
}

const inputCls = "w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none";

function randomCode(): string {
  const words = ["TREAT", "SAVE", "YUM", "HELLO", "BITE", "FEAST", "SNACK", "THANKS"];
  const w = words[Math.floor(Math.random() * words.length)]!;
  return `${w}${Math.floor(100 + Math.random() * 900)}`;
}

const toDateInput = (d: string | null) => (d ? new Date(d).toISOString().slice(0, 10) : "");

function PromoForm({
  existing,
  locationId,
  onClose,
}: {
  existing: PromoOverview | null;
  locationId: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { symbol } = useCurrency();
  const role = useAuthStore((s) => s.user?.role);
  const tenantWide = !!role && TENANT_WIDE.includes(role);
  const [f, setF] = useState({
    code: existing?.code ?? "",
    type: (existing?.type ?? "PERCENTAGE") as PromoType,
    value: existing ? String(existing.value) : "",
    minOrderValue: existing?.minOrderValue != null ? String(existing.minOrderValue) : "",
    startAt: toDateInput(existing?.startAt ?? null),
    expiresAt: toDateInput(existing?.expiresAt ?? null),
    maxUses: existing?.maxUses != null ? String(existing.maxUses) : "",
    perCustomer: existing ? (existing.maxUsesPerCustomer == null ? "none" : String(existing.maxUsesPerCustomer)) : "1",
    allShops: existing ? existing.locationIds.length === 0 : !locationId,
    showOnPos: existing?.showOnPos ?? false,
    description: existing?.description ?? "",
  });
  const set = (k: keyof typeof f, v: any) => setF((x) => ({ ...x, [k]: v }));

  const save = useMutation({
    mutationFn: () => {
      const body: PromoInput = {
        code: f.code.trim().toUpperCase(),
        type: f.type,
        value: f.type === "FREE_DELIVERY" ? 0 : Number(f.value),
        description: f.description.trim() || null,
        minOrderValue: f.minOrderValue ? Number(f.minOrderValue) : null,
        maxUses: f.maxUses ? Number(f.maxUses) : null,
        maxUsesPerCustomer: f.perCustomer === "none" ? null : Number(f.perCustomer),
        startAt: f.startAt ? new Date(`${f.startAt}T00:00:00`).toISOString() : null,
        expiresAt: f.expiresAt ? new Date(`${f.expiresAt}T23:59:59`).toISOString() : null,
        locationIds: f.allShops ? [] : existing && existing.locationIds.length ? existing.locationIds : locationId ? [locationId] : [],
        showOnPos: f.showOnPos,
      };
      if (!/^[A-Z0-9_-]{3,30}$/.test(body.code)) throw new Error("Codes are 3–30 letters or numbers, e.g. WEEKEND20.");
      if (body.type !== "FREE_DELIVERY" && !(body.value > 0)) throw new Error("Enter the discount amount.");
      if (!f.allShops && !body.locationIds.length) throw new Error("Pick a shop in the sidebar first, or make it valid at all shops.");
      return existing ? promoCodesPageClient.update(existing.id, body) : promoCodesPageClient.create(body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["promo-codes-page"] });
      qc.invalidateQueries({ queryKey: ["email-mkt", "offer-codes"] });
      qc.invalidateQueries({ queryKey: ["pos-cart-promos"] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <h2 className="text-base font-bold text-zinc-900">{existing ? `Edit ${existing.code}` : "New promo code"}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-4 p-5">
          <label className="block text-xs font-medium text-zinc-600">
            Code customers type
            <div className="mt-1 flex gap-2">
              <input
                value={f.code}
                onChange={(e) => set("code", e.target.value.toUpperCase().replace(/\s+/g, ""))}
                placeholder="WEEKEND20"
                maxLength={30}
                className={cn(inputCls, "font-mono")}
              />
              <button
                type="button"
                onClick={() => set("code", randomCode())}
                className="flex shrink-0 items-center gap-1 rounded-lg border border-zinc-200 px-3 text-xs font-medium text-zinc-600 hover:bg-zinc-50"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Generate
              </button>
            </div>
            {existing && existing.results.orders > 0 && f.code !== existing.code && (
              <span className="mt-1 block text-[11px] text-amber-700">
                Customers who saw {existing.code} in an email would get &ldquo;not found&rdquo; after a rename.
              </span>
            )}
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs font-medium text-zinc-600">
              Discount
              <select value={f.type} onChange={(e) => set("type", e.target.value)} className={cn(inputCls, "mt-1")}>
                <option value="PERCENTAGE">% off the order</option>
                <option value="FIXED_AMOUNT">{symbol} off the order</option>
                <option value="FREE_DELIVERY">Free delivery</option>
              </select>
            </label>
            {f.type !== "FREE_DELIVERY" ? (
              <label className="block text-xs font-medium text-zinc-600">
                {f.type === "PERCENTAGE" ? "Percent" : `Amount (${symbol})`}
                <input type="number" min={0} step={f.type === "PERCENTAGE" ? 1 : 0.5} value={f.value} onChange={(e) => set("value", e.target.value)} className={cn(inputCls, "mt-1")} />
              </label>
            ) : (
              <div />
            )}
            <label className="block text-xs font-medium text-zinc-600">
              Minimum order ({symbol}, optional)
              <input type="number" min={0} step={0.5} value={f.minOrderValue} onChange={(e) => set("minOrderValue", e.target.value)} className={cn(inputCls, "mt-1")} />
            </label>
            <label className="block text-xs font-medium text-zinc-600">
              Per customer
              <select value={f.perCustomer} onChange={(e) => set("perCustomer", e.target.value)} className={cn(inputCls, "mt-1")}>
                <option value="1">Once each</option>
                <option value="2">Twice each</option>
                <option value="3">3 times each</option>
                <option value="none">No limit</option>
              </select>
            </label>
            <label className="block text-xs font-medium text-zinc-600">
              Starts (optional)
              <input type="date" value={f.startAt} onChange={(e) => set("startAt", e.target.value)} className={cn(inputCls, "mt-1")} />
            </label>
            <label className="block text-xs font-medium text-zinc-600">
              Ends at the end of (optional)
              <input type="date" value={f.expiresAt} onChange={(e) => set("expiresAt", e.target.value)} className={cn(inputCls, "mt-1")} />
            </label>
            <label className="col-span-2 block text-xs font-medium text-zinc-600">
              Total uses across all customers (optional)
              <input type="number" min={1} value={f.maxUses} onChange={(e) => set("maxUses", e.target.value)} placeholder="No limit" className={cn(inputCls, "mt-1")} />
            </label>
          </div>

          <div className="space-y-2 rounded-xl bg-zinc-50 p-3 text-sm text-zinc-800">
            <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Where it works</div>
            <label className="flex items-center gap-2">
              <input type="radio" checked={!f.allShops} onChange={() => set("allShops", false)} disabled={!locationId && !existing?.locationIds.length} />
              <Store className="h-4 w-4 text-zinc-400" />
              {existing && existing.locationIds.length > 1 ? `Its ${existing.locationIds.length} shops` : "This shop only"}
            </label>
            <label className={cn("flex items-center gap-2", !tenantWide && "opacity-50")}>
              <input type="radio" checked={f.allShops} onChange={() => set("allShops", true)} disabled={!tenantWide} />
              Every shop
              {!tenantWide && <span className="text-xs text-zinc-500">(account owners only)</span>}
            </label>
            <label className="mt-1 flex items-start gap-2 border-t border-zinc-200 pt-2">
              <input type="checkbox" className="mt-0.5" checked={f.showOnPos} onChange={(e) => set("showOnPos", e.target.checked)} />
              <span>
                Show as a quick button on the till
                <span className="block text-xs text-zinc-500">
                  Leave off for codes you send to customers — they type it themselves at checkout.
                </span>
              </span>
            </label>
          </div>

          <label className="block text-xs font-medium text-zinc-600">
            Note for your team (optional)
            <input value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="e.g. Summer leaflet" className={cn(inputCls, "mt-1")} />
          </label>

          {save.isError && <p className="text-sm text-rose-600">{apiErrorMessage(save.error)}</p>}
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending || !f.code}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />} {existing ? "Save changes" : "Create code"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PromoDrawer({
  c,
  onClose,
  onEdit,
}: {
  c: PromoOverview;
  onClose: () => void;
  onEdit: (c: PromoOverview) => void;
}) {
  const qc = useQueryClient();
  const { money, moneyLong } = useCurrency();
  const { data: orders, isLoading } = useQuery({
    queryKey: ["promo-codes-page", "orders", c.id],
    queryFn: () => promoCodesPageClient.orders(c.id),
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["promo-codes-page"] });
    qc.invalidateQueries({ queryKey: ["email-mkt", "offer-codes"] });
    qc.invalidateQueries({ queryKey: ["pos-cart-promos"] });
  };
  const toggle = useMutation({
    mutationFn: () => promoCodesPageClient.update(c.id, { isActive: !c.isActive }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => promoCodesPageClient.remove(c.id),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const liveEmails = c.usedIn.filter((u) => u.kind === "automation" ? u.status === "ON" : ["DRAFT", "SCHEDULED", "SENDING"].includes(u.status));

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-y-auto bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between border-b border-zinc-100 px-5 py-4">
          <div>
            <div className="font-mono text-lg font-bold tracking-wide text-zinc-900">{c.code}</div>
            <div className="text-sm text-zinc-500">{describe(c, money)}</div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", STATUS[c.status].cls)}>
              {STATUS[c.status].label}
            </span>
            {c.canManage ? (
              <>
                <button onClick={() => onEdit(c)} className="ml-auto flex items-center gap-1 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50">
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </button>
                <button
                  onClick={() => {
                    if (c.isActive && liveEmails.length && !confirm(`${liveEmails.length} email(s) still promise ${c.code}. Pause it anyway? Customers will see "inactive" at checkout.`)) return;
                    toggle.mutate();
                  }}
                  disabled={toggle.isPending}
                  className="flex items-center gap-1 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                >
                  {c.isActive ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                  {c.isActive ? "Pause" : "Resume"}
                </button>
                <button
                  onClick={() => {
                    const warn = liveEmails.length
                      ? `${liveEmails.length} email(s) still promise ${c.code}; customers would get "not found". `
                      : "";
                    if (confirm(`${warn}Delete ${c.code}? Past orders keep their discount.`)) remove.mutate();
                  }}
                  disabled={remove.isPending}
                  className="flex items-center gap-1 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 hover:text-rose-600"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </button>
              </>
            ) : (
              <span className="ml-auto text-xs text-zinc-500">Valid at every shop — managed by the account owner</span>
            )}
          </div>
          {(toggle.isError || remove.isError) && (
            <p className="text-sm text-rose-600">{apiErrorMessage(toggle.error ?? remove.error)}</p>
          )}

          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              ["Orders", c.results.orders.toLocaleString()],
              ["Sales", moneyLong(c.results.revenue)],
              ["Discount", moneyLong(c.results.discount)],
            ].map(([l, v]) => (
              <div key={l} className="rounded-lg bg-zinc-50 px-2 py-2">
                <div className="text-sm font-bold tabular-nums text-zinc-900">{v}</div>
                <div className="text-[11px] text-zinc-500">{l}</div>
              </div>
            ))}
          </div>

          <dl className="space-y-1.5 text-sm">
            {[
              ["Uses", `${c.usedCount}${c.maxUses != null ? ` of ${c.maxUses}` : ""}`],
              ["Per customer", c.maxUsesPerCustomer === 1 ? "Once each" : c.maxUsesPerCustomer ? `${c.maxUsesPerCustomer} times each` : "No limit"],
              ["Starts", fmtDate(c.startAt) ?? "Straight away"],
              ["Ends", fmtDate(c.expiresAt) ?? "Never"],
              ["Works at", c.locationIds.length === 0 ? "Every shop" : c.locationIds.length === 1 ? "This shop" : `${c.locationIds.length} shops`],
              ["Till button", c.showOnPos ? "Yes" : "No"],
              ...(c.description ? [["Note", c.description]] : []),
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4">
                <dt className="text-zinc-500">{k}</dt>
                <dd className="text-right text-zinc-900">{v}</dd>
              </div>
            ))}
          </dl>

          {c.usedIn.length > 0 && (
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Used in emails</h3>
              <ul className="space-y-1.5">
                {c.usedIn.map((u) => (
                  <li key={`${u.kind}-${u.id}`}>
                    <Link
                      href={u.kind === "automation" ? `/dashboard/marketing/email/automations/${u.id}` : `/dashboard/marketing/email/${u.id}`}
                      className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm hover:bg-zinc-50"
                    >
                      {u.kind === "automation" ? <Zap className="h-4 w-4 text-indigo-600" /> : <Mail className="h-4 w-4 text-indigo-600" />}
                      <span className="flex-1 truncate">
                        {u.kind === "automation" ? (u.name === "WELCOME" ? "Welcome email (automatic)" : "Win-back email (automatic)") : u.name}
                      </span>
                      <span className="text-[11px] uppercase text-zinc-500">{u.status.toLowerCase()}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Recent orders</h3>
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
            ) : !orders?.length ? (
              <p className="text-sm text-zinc-500">Not used yet.</p>
            ) : (
              <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
                {orders.map((o) => (
                  <li key={o.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <ShoppingBag className="h-4 w-4 shrink-0 text-zinc-400" />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-zinc-900">
                        {o.reference}
                        {o.customer ? ` · ${o.customer}` : ""}
                      </div>
                      <div className="text-xs text-zinc-500">
                        {new Date(o.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
                        {" · "}
                        {o.source === "POS" ? "Till" : o.source === "ONLINE" ? "Online" : o.source}
                        {["CANCELLED", "REJECTED", "FAILED"].includes(o.status) && " · cancelled"}
                      </div>
                    </div>
                    <div className="text-right tabular-nums">
                      <div className="text-zinc-900">{money(o.total)}</div>
                      {o.discount > 0 && <div className="text-xs text-emerald-700">−{money(o.discount)}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
