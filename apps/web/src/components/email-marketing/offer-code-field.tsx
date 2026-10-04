"use client";

// The discount code behind an email offer. An offer promises a code in
// hundreds of inboxes, so it has to be a REAL promo code that works at
// checkout: pick an existing one, or create it right here — once per customer
// and this shop only by default. The API refuses to send an email whose code
// doesn't exist, so a sample like "WEEKEND20" can't go out by accident.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, Plus, Ticket } from "lucide-react";
import { apiErrorMessage, emailMarketingClient, type OfferCode } from "@/lib/api/email-marketing.client";
import { cn } from "@/lib/utils";

const inputCls = "w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none";

/** Read "20% OFF" / "£5 OFF" / "FREE DELIVERY" off the offer's big text, so
 *  "Create this code" starts with what the email already says. */
function guessFromTitle(title: string): { type: OfferCode["type"]; value: string } {
  const t = title ?? "";
  const pct = t.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) return { type: "PERCENTAGE", value: pct[1]! };
  const amt = t.match(/[£$€]\s*(\d+(?:\.\d+)?)/) ?? t.match(/(\d+(?:\.\d+)?)\s*(?:AED|SAR|KWD|QAR|BHD|OMR)/i);
  if (amt) return { type: "FIXED_AMOUNT", value: amt[1]! };
  if (/free\s*delivery/i.test(t)) return { type: "FREE_DELIVERY", value: "" };
  return { type: "PERCENTAGE", value: "" };
}

export function describeCode(c: OfferCode): string {
  const what =
    c.type === "PERCENTAGE" ? `${c.value}% off` : c.type === "FIXED_AMOUNT" ? `£${c.value.toFixed(2)} off` : "Free delivery";
  const bits = [what];
  if (c.minOrderValue) bits.push(`min £${c.minOrderValue.toFixed(2)}`);
  if (c.maxUsesPerCustomer === 1) bits.push("once per customer");
  if (c.expiresAt) bits.push(`until ${new Date(c.expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`);
  return bits.join(" · ");
}

/** Small print that matches the code's real rules. */
function termsFor(c: OfferCode): string {
  const parts: string[] = [];
  if (c.expiresAt) {
    parts.push(
      `Valid until ${new Date(c.expiresAt).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} when ordering online.`,
    );
  } else {
    parts.push("Valid when ordering online.");
  }
  if (c.minOrderValue) parts.push(`Minimum order £${c.minOrderValue.toFixed(2)}.`);
  if (c.maxUsesPerCustomer === 1) parts.push("One use per customer.");
  return parts.join(" ");
}

function titleFor(c: OfferCode): string {
  return c.type === "PERCENTAGE" ? `${c.value}% OFF` : c.type === "FIXED_AMOUNT" ? `£${c.value} OFF` : "FREE DELIVERY";
}

export function OfferCodeField({
  code,
  title,
  locationId,
  onPick,
}: {
  code: string;
  title: string;
  locationId: string | null;
  /** Sets code + promoCodeId, and the title/terms the code implies. */
  onPick: (patch: { code: string; promoCodeId?: string; title?: string; terms?: string }) => void;
}) {
  const qc = useQueryClient();
  const { data: codes, isLoading } = useQuery({
    queryKey: ["email-mkt", "offer-codes", locationId],
    queryFn: () => emailMarketingClient.offerCodes(locationId),
  });
  const current = useMemo(
    () => (codes ?? []).find((c) => c.code === String(code ?? "").trim().toUpperCase()) ?? null,
    [codes, code],
  );
  const [creating, setCreating] = useState(false);

  const missing = !!code?.trim() && !isLoading && !current;

  return (
    <div className="space-y-2">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-zinc-600">
        <Ticket className="h-3.5 w-3.5" /> Discount code
      </div>
      <select
        value={current?.id ?? (code?.trim() ? "__missing" : "")}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__new") return setCreating(true);
          if (!v) return onPick({ code: "", promoCodeId: undefined });
          const c = codes?.find((x) => x.id === v);
          if (c) onPick({ code: c.code, promoCodeId: c.id, title: titleFor(c), terms: termsFor(c) });
        }}
        className={inputCls}
      >
        <option value="">No code (just the offer)</option>
        {missing && <option value="__missing">{code.toUpperCase()} (not created yet)</option>}
        {(codes ?? []).map((c) => (
          <option key={c.id} value={c.id}>
            {c.code} · {describeCode(c)}
          </option>
        ))}
        <option value="__new">+ Create a new code…</option>
      </select>

      {current && (
        <p className="flex items-center gap-1.5 text-[11px] text-emerald-700">
          <CheckCircle2 className="h-3.5 w-3.5" /> Works at checkout: {describeCode(current)}
        </p>
      )}
      {missing && !creating && (
        <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <b>{code.toUpperCase()}</b> isn&apos;t a real code yet, so customers would see &ldquo;not found&rdquo; at
            checkout. The email can&apos;t be sent until it exists.{" "}
            <button onClick={() => setCreating(true)} className="font-semibold underline">
              Create it now
            </button>
          </span>
        </div>
      )}

      {creating && (
        <CreateCode
          initialCode={code?.trim() ? code.toUpperCase() : ""}
          title={title}
          locationId={locationId}
          onCancel={() => setCreating(false)}
          onCreated={(c) => {
            qc.invalidateQueries({ queryKey: ["email-mkt", "offer-codes"] });
            onPick({ code: c.code, promoCodeId: c.id, title: titleFor(c), terms: termsFor(c) });
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

function CreateCode({
  initialCode,
  title,
  locationId,
  onCancel,
  onCreated,
}: {
  initialCode: string;
  title: string;
  locationId: string | null;
  onCancel: () => void;
  onCreated: (c: OfferCode) => void;
}) {
  const guess = guessFromTitle(title);
  const inAWeek = useMemo(() => {
    const d = new Date(Date.now() + 7 * 86400_000);
    return d.toISOString().slice(0, 10);
  }, []);
  const [form, setForm] = useState({
    code: initialCode || "OFFER" + (guess.value || ""),
    type: guess.type,
    value: guess.value,
    minOrderValue: "",
    expires: inAWeek,
    oncePerCustomer: true,
    maxUses: "",
  });
  const set = (k: keyof typeof form, v: any) => setForm((f) => ({ ...f, [k]: v }));
  const create = useMutation({
    mutationFn: () =>
      emailMarketingClient.createOfferCode({
        code: form.code,
        type: form.type,
        value: form.type === "FREE_DELIVERY" ? 0 : Number(form.value),
        minOrderValue: form.minOrderValue ? Number(form.minOrderValue) : null,
        // End of the chosen day, so "until Sunday" includes Sunday evening.
        expiresAt: form.expires ? new Date(`${form.expires}T23:59:59`).toISOString() : null,
        maxUses: form.maxUses ? Number(form.maxUses) : null,
        oncePerCustomer: form.oncePerCustomer,
        locationId,
      }),
    onSuccess: onCreated,
  });

  return (
    <div className="space-y-3 rounded-xl border border-indigo-200 bg-indigo-50/40 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-indigo-900">New discount code</div>
      <div className="grid grid-cols-2 gap-2">
        <label className="col-span-2 block text-xs text-zinc-600">
          Code customers type
          <input
            value={form.code}
            onChange={(e) => set("code", e.target.value.toUpperCase().replace(/\s+/g, ""))}
            className={cn(inputCls, "mt-1 font-mono")}
            maxLength={30}
          />
        </label>
        <label className="block text-xs text-zinc-600">
          Discount
          <select value={form.type} onChange={(e) => set("type", e.target.value)} className={cn(inputCls, "mt-1")}>
            <option value="PERCENTAGE">% off the order</option>
            <option value="FIXED_AMOUNT">£ off the order</option>
            <option value="FREE_DELIVERY">Free delivery</option>
          </select>
        </label>
        {form.type !== "FREE_DELIVERY" ? (
          <label className="block text-xs text-zinc-600">
            {form.type === "PERCENTAGE" ? "Percent" : "Amount (£)"}
            <input
              type="number"
              min={0}
              step={form.type === "PERCENTAGE" ? 1 : 0.5}
              value={form.value}
              onChange={(e) => set("value", e.target.value)}
              className={cn(inputCls, "mt-1")}
            />
          </label>
        ) : (
          <div />
        )}
        <label className="block text-xs text-zinc-600">
          Expires at the end of
          <input type="date" value={form.expires} onChange={(e) => set("expires", e.target.value)} className={cn(inputCls, "mt-1")} />
        </label>
        <label className="block text-xs text-zinc-600">
          Minimum order (£, optional)
          <input
            type="number"
            min={0}
            step={0.5}
            value={form.minOrderValue}
            onChange={(e) => set("minOrderValue", e.target.value)}
            className={cn(inputCls, "mt-1")}
          />
        </label>
        <label className="col-span-2 flex items-center gap-2 text-sm text-zinc-800">
          <input type="checkbox" checked={form.oncePerCustomer} onChange={(e) => set("oncePerCustomer", e.target.checked)} />
          One use per customer
        </label>
        <label className="col-span-2 block text-xs text-zinc-600">
          Total uses across all customers (optional)
          <input
            type="number"
            min={1}
            value={form.maxUses}
            onChange={(e) => set("maxUses", e.target.value)}
            placeholder="No limit"
            className={cn(inputCls, "mt-1")}
          />
        </label>
      </div>
      <p className="text-[11px] text-zinc-500">
        Works for online orders at this shop. Customers must be signed in to use a once-per-customer code.
      </p>
      {create.isError && <p className="text-xs text-rose-600">{apiErrorMessage(create.error)}</p>}
      <div className="flex gap-2">
        <button
          onClick={() => create.mutate()}
          disabled={create.isPending || !form.code}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-indigo-600 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create code
        </button>
        <button onClick={onCancel} className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-700">
          Cancel
        </button>
      </div>
    </div>
  );
}
