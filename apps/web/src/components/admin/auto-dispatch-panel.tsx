"use client";

// Admin Dashboard → Auto dispatch.
//
// Three blocks, top to bottom in the order you use them:
//   1. Rules — which orders (location × brand × channel) go where (a fixed
//      provider, or the cheapest live quote) and when (accept / ready /
//      before ready). New rules start OFF and can run as a dry run first.
//   2. Live quote — pick a recent delivery and see every provider's price
//      side by side, plus what the rules would do with it. Books nothing.
//   3. Activity — every order a rule picked up and what happened to it.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FlaskConical,
  Loader2,
  Pencil,
  Plus,
  Search,
  RefreshCw,
  Trash2,
  Trophy,
  X,
  Zap,
} from "lucide-react";
import toast from "react-hot-toast";
import { formatCurrency } from "@/lib/utils";
import {
  autoDispatchClient,
  PROVIDER_LABEL,
  type AutoDispatchOptions,
  type AutoDispatchOrder,
  type AutoDispatchPreview,
  type AutoDispatchProvider,
  type AutoDispatchRule,
  type AutoDispatchRun,
  type RuleInput,
} from "@/lib/api/auto-dispatch.client";

const TRIGGER_LABEL: Record<string, string> = {
  ON_ACCEPT: "When the order is accepted",
  ON_READY: "When the order is marked ready",
  BEFORE_READY: "Before the food is due",
};

const CHANNEL_LABEL: Record<string, string> = {
  DIRECT: "Direct (storefront)",
  ONLINE: "Online",
  POS: "POS / till",
  VOICE: "AI Voice",
  WHATSAPP: "WhatsApp",
  JUST_EAT: "Just Eat",
  UBER_EATS: "Uber Eats",
  DELIVEROO: "Deliveroo",
  HUBRISE: "HubRise",
  TALABAT: "Talabat",
  CAREEM: "Careem",
  GLOVO: "Glovo",
  KEETA: "Keeta",
};

const READINESS_LABEL: Record<string, string> = {
  ready: "Ready",
  off: "Switched off",
  not_set_up: "Not set up",
  no_collect_point: "No collect point",
  estimate_only: "Estimate only",
  error: "Error",
};

const EMPTY_RULE: RuleInput = {
  name: "",
  enabled: false,
  priority: 100,
  locationId: null,
  brandIds: [],
  channels: [],
  strategy: "CHEAPEST",
  providers: [],
  fallback: true,
  trigger: "ON_ACCEPT",
  delayMinutes: 0,
  maxPriceMinor: null,
  dryRun: true,
};

function errMsg(e: any, fallback: string): string {
  const m = e?.response?.data?.message;
  return Array.isArray(m) ? m.join(", ") : m ?? fallback;
}

function money(minor: number | null | undefined, currency: string | null | undefined) {
  if (minor == null) return "—";
  return formatCurrency(minor / 100, currency || "GBP");
}

function orderRef(o: Pick<AutoDispatchOrder, "displayId" | "orderNumber" | "id">) {
  return o.displayId ?? (o.orderNumber != null ? `#${o.orderNumber}` : o.id.slice(-6));
}

function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500 ${
        checked ? "bg-emerald-500" : "bg-zinc-200"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`min-h-[32px] rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-orange-500 ${
        active
          ? "border-orange-500 bg-orange-50 text-orange-700"
          : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300"
      }`}
    >
      {children}
    </button>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-zinc-200 bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-zinc-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-zinc-800">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function AutoDispatchPanel() {
  const [options, setOptions] = useState<AutoDispatchOptions | null>(null);
  const [rules, setRules] = useState<AutoDispatchRule[] | null>(null);
  const [runs, setRuns] = useState<AutoDispatchRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; draft: RuleInput } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [o, r, x] = await Promise.all([
        autoDispatchClient.options(),
        autoDispatchClient.rules(),
        autoDispatchClient.runs(),
      ]);
      setOptions(o);
      setRules(r);
      setRuns(x);
      setError(null);
    } catch (e) {
      setError(errMsg(e, "Couldn't load auto dispatch."));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Activity is live: the engine ticks every 20s.
  useEffect(() => {
    const t = setInterval(() => {
      autoDispatchClient.runs().then(setRuns).catch(() => {});
    }, 15_000);
    return () => clearInterval(t);
  }, []);

  const locationName = useCallback(
    (id: string | null) =>
      id ? options?.locations.find((l) => l.id === id)?.name ?? "Unknown location" : "All locations",
    [options],
  );
  const brandName = useCallback(
    (id: string) => options?.brands.find((b) => b.id === id)?.name ?? "Unknown brand",
    [options],
  );

  async function save() {
    if (!editing) return;
    setBusy("save");
    try {
      const saved = editing.id
        ? await autoDispatchClient.update(editing.id, editing.draft)
        : await autoDispatchClient.create(editing.draft);
      setRules((prev) => {
        const list = prev ?? [];
        return editing.id ? list.map((r) => (r.id === saved.id ? saved : r)) : [...list, saved];
      });
      setEditing(null);
      toast.success(editing.id ? "Rule saved" : "Rule created");
    } catch (e) {
      toast.error(errMsg(e, "Couldn't save the rule."));
    } finally {
      setBusy(null);
    }
  }

  async function toggleRule(rule: AutoDispatchRule, enabled: boolean) {
    setBusy(rule.id);
    try {
      const saved = await autoDispatchClient.update(rule.id, { enabled });
      setRules((prev) => (prev ?? []).map((r) => (r.id === saved.id ? saved : r)));
      toast.success(
        enabled
          ? saved.dryRun
            ? `${rule.name} on — dry run, no couriers booked`
            : `${rule.name} on — it will book real couriers`
          : `${rule.name} off`,
      );
    } catch (e) {
      toast.error(errMsg(e, "Couldn't switch the rule."));
    } finally {
      setBusy(null);
    }
  }

  async function removeRule(rule: AutoDispatchRule) {
    if (!window.confirm(`Delete “${rule.name}”? Orders waiting on it won't be dispatched.`)) return;
    setBusy(rule.id);
    try {
      await autoDispatchClient.remove(rule.id);
      setRules((prev) => (prev ?? []).filter((r) => r.id !== rule.id));
      toast.success("Rule deleted");
    } catch (e) {
      toast.error(errMsg(e, "Couldn't delete the rule."));
    } finally {
      setBusy(null);
    }
  }

  if (!rules && !error) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading auto dispatch…
      </div>
    );
  }

  const live = (rules ?? []).filter((r) => r.enabled && !r.dryRun);

  return (
    <div className="mx-auto max-w-4xl space-y-6 py-2">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-orange-600" aria-hidden="true" />
          <h1 className="text-lg font-semibold text-zinc-900">Auto dispatch</h1>
          <span className="rounded-full bg-zinc-900 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
            Admin only
          </span>
        </div>
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-500">
          Send delivery orders to a courier network without anyone pressing Dispatch. Each rule
          picks the orders (location, brand and channel), the courier (one fixed provider, or a
          live quote from several with the cheapest booked) and the moment it fires.
        </p>
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-500">
          Bookings go through the same path as the Dispatch button, so the location&apos;s wallet
          is charged as usual. Orders already with a courier or your own driver are never touched.
        </p>
      </header>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      {live.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-900">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
          <p>
            <strong>
              {live.length} rule{live.length === 1 ? "" : "s"} booking real couriers:
            </strong>{" "}
            {live.map((r) => r.name).join(", ")}.
          </p>
        </div>
      )}

      {rules && options && (
        <Section
          title={`Rules (${rules.length})`}
          action={
            !editing && (
              <button
                type="button"
                onClick={() => setEditing({ id: null, draft: { ...EMPTY_RULE } })}
                className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-zinc-900 px-3 text-xs font-medium text-white hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" /> New rule
              </button>
            )
          }
        >
          {editing && (
            <RuleEditor
              options={options}
              draft={editing.draft}
              isNew={!editing.id}
              saving={busy === "save"}
              onChange={(draft) => setEditing({ ...editing, draft })}
              onCancel={() => setEditing(null)}
              onSave={save}
            />
          )}
          {rules.length === 0 && !editing ? (
            <p className="px-4 py-8 text-center text-sm text-zinc-400">
              No rules yet. Create one — it starts switched off, as a dry run.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {rules.map((r) => (
                <li key={r.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-zinc-900">{r.name}</span>
                      {r.dryRun && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-700">
                          <FlaskConical className="h-3 w-3" aria-hidden="true" /> Dry run
                        </span>
                      )}
                      <span className="text-[11px] text-zinc-400">Priority {r.priority}</span>
                    </div>
                    <p className="text-[13px] leading-snug text-zinc-600">
                      {r.strategy === "CHEAPEST" ? (
                        <>
                          Cheapest of{" "}
                          <strong>{r.providers.map((p) => PROVIDER_LABEL[p]).join(" / ")}</strong>
                        </>
                      ) : (
                        <>
                          Always <strong>{r.providers[0] ? PROVIDER_LABEL[r.providers[0]] : "—"}</strong>
                          {r.fallback && r.providers.length > 1 && (
                            <>
                              , then{" "}
                              {r.providers
                                .slice(1)
                                .map((p) => PROVIDER_LABEL[p])
                                .join(", then ")}
                            </>
                          )}
                        </>
                      )}
                      {" · "}
                      {triggerSummary(r)}
                      {r.maxPriceMinor != null && (
                        <> · max {money(r.maxPriceMinor, locationCurrency(options, r.locationId))}</>
                      )}
                    </p>
                    <p className="text-[11px] text-zinc-400">
                      {locationName(r.locationId)} ·{" "}
                      {r.brandIds.length ? r.brandIds.map(brandName).join(", ") : "Any brand"} ·{" "}
                      {r.channels.length
                        ? r.channels.map((c) => CHANNEL_LABEL[c] ?? c).join(", ")
                        : "Any channel"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {busy === r.id && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" aria-hidden="true" />
                    )}
                    <Toggle
                      checked={r.enabled}
                      disabled={busy !== null}
                      onChange={(v) => toggleRule(r, v)}
                      label={`Switch ${r.name} ${r.enabled ? "off" : "on"}`}
                    />
                    <button
                      type="button"
                      aria-label={`Edit ${r.name}`}
                      onClick={() => setEditing({ id: r.id, draft: toInput(r) })}
                      className="ml-1 inline-flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-500"
                    >
                      <Pencil className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${r.name}`}
                      disabled={busy !== null}
                      onClick={() => removeRule(r)}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 hover:bg-red-50 hover:text-red-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-500"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {options && <LiveQuote options={options} />}

      <Section
        title="Activity"
        action={
          <button
            type="button"
            onClick={() => autoDispatchClient.runs().then(setRuns).catch(() => {})}
            aria-label="Refresh activity"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-500"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          </button>
        }
      >
        {runs.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-zinc-400">
            Nothing yet. Orders a rule picks up show here.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {runs.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                ruleName={rules?.find((r) => r.id === run.ruleId)?.name ?? "Deleted rule"}
                locationName={locationName(run.locationId)}
                currency={locationCurrency(options, run.locationId)}
              />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function locationCurrency(options: AutoDispatchOptions | null, locationId: string | null) {
  if (!options) return "GBP";
  if (locationId) return options.locations.find((l) => l.id === locationId)?.currency ?? "GBP";
  return options.locations[0]?.currency ?? "GBP";
}

function triggerSummary(r: Pick<RuleInput, "trigger" | "delayMinutes">) {
  const m = r.delayMinutes;
  if (r.trigger === "BEFORE_READY") return `${m || 0} min before the food is due`;
  const event = r.trigger === "ON_READY" ? "ready" : "accepted";
  return m ? `${m} min after ${event}` : `as soon as it's ${event}`;
}

function toInput(r: AutoDispatchRule): RuleInput {
  const { id: _id, enabledAt: _e, createdAt: _c, ...rest } = r;
  return rest;
}

// ── Rule editor ─────────────────────────────────────────────────────────────

function RuleEditor({
  options,
  draft,
  isNew,
  saving,
  onChange,
  onCancel,
  onSave,
}: {
  options: AutoDispatchOptions;
  draft: RuleInput;
  isNew: boolean;
  saving: boolean;
  onChange: (d: RuleInput) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const set = <K extends keyof RuleInput>(k: K, v: RuleInput[K]) => onChange({ ...draft, [k]: v });
  const toggleIn = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  const currency = locationCurrency(options, draft.locationId);
  const [locQuery, setLocQuery] = useState("");
  const [brandQuery, setBrandQuery] = useState("");
  const selectedLocation = options.locations.find((l) => l.id === draft.locationId) ?? null;
  const filteredLocations = useMemo(() => {
    const q = locQuery.trim().toLowerCase();
    return q ? options.locations.filter((l) => l.name.toLowerCase().includes(q)) : options.locations;
  }, [options.locations, locQuery]);
  // One location: only the brands that trade there. All locations: every brand.
  const brandPool = useMemo(() => {
    if (!selectedLocation) return options.brands;
    const at = new Set(selectedLocation.brandIds);
    return options.brands.filter((b) => at.has(b.id));
  }, [options.brands, selectedLocation]);
  // Picked brands stay visible while searching, so a search never hides
  // what the rule is already set to.
  const visibleBrands = useMemo(() => {
    const q = brandQuery.trim().toLowerCase();
    if (!q) return brandPool;
    return brandPool.filter((b) => draft.brandIds.includes(b.id) || b.name.toLowerCase().includes(q));
  }, [brandPool, brandQuery, draft.brandIds]);
  const pickLocation = (id: string | null) => {
    const loc = options.locations.find((l) => l.id === id);
    // Drop brands that don't trade at the new location.
    const brandIds = loc ? draft.brandIds.filter((b) => loc.brandIds.includes(b)) : draft.brandIds;
    // Nothing picked yet: start from the providers that can book there, so
    // the obvious rule is one tap away instead of a greyed-out button.
    const providers =
      loc && draft.providers.length === 0
        ? options.providers.filter((p) => loc.providers[p] === "ready")
        : draft.providers;
    onChange({ ...draft, locationId: id, brandIds, providers });
  };

  // Readiness of each provider for the rule's scope: one location, or a
  // count across all of them.
  const readiness = useMemo(() => {
    const out = {} as Record<AutoDispatchProvider, string>;
    for (const p of options.providers) {
      if (draft.locationId) {
        const st = options.locations.find((l) => l.id === draft.locationId)?.providers[p] ?? "not_set_up";
        out[p] = READINESS_LABEL[st] ?? st;
      } else {
        const n = options.locations.filter((l) => l.providers[p] === "ready").length;
        out[p] = `Ready at ${n}/${options.locations.length}`;
      }
    }
    return out;
  }, [options, draft.locationId]);

  const missing = [
    !draft.name.trim() && "a name",
    draft.providers.length === 0 && "at least one courier provider",
  ].filter(Boolean) as string[];
  const canSave = missing.length === 0 && !saving;
  const field = "w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20";
  const label = "mb-1.5 block text-xs font-medium text-zinc-600";

  return (
    <form
      className="space-y-5 border-b border-zinc-100 bg-zinc-50/60 px-4 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) onSave();
      }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-800">{isNew ? "New rule" : "Edit rule"}</h3>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close editor"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-200/60"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
        <div>
          <label htmlFor="ad-name" className={label}>Name</label>
          <input
            id="ad-name"
            className={field}
            value={draft.name}
            maxLength={80}
            placeholder="e.g. Pizza Uno — cheapest courier"
            onChange={(e) => set("name", e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="ad-priority" className={label}>Priority</label>
          <input
            id="ad-priority"
            type="number"
            inputMode="numeric"
            min={0}
            className={field}
            value={draft.priority}
            onChange={(e) => set("priority", Number(e.target.value) || 0)}
          />
        </div>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Which orders</legend>
        <div>
          <label htmlFor="ad-location-search" className={label}>Location</label>
          <SearchInput
            id="ad-location-search"
            value={locQuery}
            onChange={setLocQuery}
            placeholder="Search locations by name…"
          />
          <ul
            role="listbox"
            aria-label="Location"
            className="mt-2 max-h-52 overflow-y-auto rounded-lg border border-zinc-200 bg-white"
          >
            {!locQuery.trim() && (
              <LocationOption
                selected={!draft.locationId}
                onSelect={() => pickLocation(null)}
                name="All locations"
                hint={`${options.locations.length} locations`}
              />
            )}
            {filteredLocations.map((l) => (
              <LocationOption
                key={l.id}
                selected={draft.locationId === l.id}
                onSelect={() => pickLocation(l.id)}
                name={l.name}
                hint={`${l.brandIds.length} brand${l.brandIds.length === 1 ? "" : "s"}`}
              />
            ))}
            {filteredLocations.length === 0 && locQuery.trim() && (
              <li className="px-3 py-3 text-sm text-zinc-400">No location matches “{locQuery.trim()}”.</li>
            )}
          </ul>
        </div>
        <div>
          <p id="ad-brands-label" className={label}>
            Brands{draft.locationId ? <> at {selectedLocation?.name}</> : null}{" "}
            <span className="font-normal text-zinc-400">— none picked = any brand</span>
          </p>
          {brandPool.length > 6 && (
            <div className="mb-2">
              <SearchInput
                id="ad-brand-search"
                value={brandQuery}
                onChange={setBrandQuery}
                placeholder="Search brands by name…"
                ariaLabel="Search brands by name"
              />
            </div>
          )}
          {brandPool.length === 0 ? (
            <p className="text-xs text-zinc-400">
              No brands trade at this location yet, so the rule will match any brand here.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="ad-brands-label">
              {visibleBrands.map((b) => (
                <Chip key={b.id} active={draft.brandIds.includes(b.id)} onClick={() => set("brandIds", toggleIn(draft.brandIds, b.id))}>
                  {b.name}
                </Chip>
              ))}
              {visibleBrands.length === 0 && (
                <p className="text-xs text-zinc-400">No brand matches “{brandQuery.trim()}”.</p>
              )}
            </div>
          )}
        </div>
        <div>
          <p className={label}>Channels <span className="font-normal text-zinc-400">— none picked = any channel</span></p>
          <div className="flex flex-wrap gap-1.5">
            {options.channels.map((c) => (
              <Chip key={c} active={draft.channels.includes(c)} onClick={() => set("channels", toggleIn(draft.channels, c))}>
                {CHANNEL_LABEL[c] ?? c}
              </Chip>
            ))}
          </div>
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Which courier</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {([
            ["FIXED", "Fixed provider", "Always book the provider you pick — e.g. JET Go."],
            ["CHEAPEST", "Cheapest live quote", "Price every provider below at that moment and book the cheapest."],
          ] as const).map(([value, title, blurb]) => (
            <label
              key={value}
              className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${
                draft.strategy === value ? "border-orange-500 bg-white ring-2 ring-orange-500/15" : "border-zinc-200 bg-white"
              }`}
            >
              <input
                type="radio"
                name="ad-strategy"
                className="mt-0.5 accent-orange-600"
                checked={draft.strategy === value}
                onChange={() => set("strategy", value)}
              />
              <span>
                <span className="block text-sm font-medium text-zinc-800">{title}</span>
                <span className="block text-xs text-zinc-500">{blurb}</span>
              </span>
            </label>
          ))}
        </div>
        <div>
          <p className={label}>
            {draft.strategy === "FIXED" ? "Provider (tap in order — first is used, the rest are fallbacks)" : "Providers to quote — tap each one to include it"}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {options.providers.map((p) => {
              const idx = draft.providers.indexOf(p);
              const on = idx >= 0;
              return (
                <button
                  key={p}
                  type="button"
                  aria-pressed={on}
                  onClick={() => set("providers", toggleIn(draft.providers, p) as AutoDispatchProvider[])}
                  className={`flex min-h-[44px] items-center justify-between gap-2 rounded-lg border px-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-500 ${
                    on ? "border-orange-500 bg-orange-50" : "border-zinc-200 bg-white hover:border-zinc-300"
                  }`}
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-zinc-800">
                    {draft.strategy === "CHEAPEST" && (
                      <CheckCircle2
                        className={`h-4 w-4 ${on ? "text-orange-600" : "text-zinc-300"}`}
                        aria-hidden="true"
                      />
                    )}
                    {draft.strategy === "FIXED" && on && (
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-orange-600 text-[10px] font-bold text-white">
                        {idx + 1}
                      </span>
                    )}
                    {PROVIDER_LABEL[p]}
                  </span>
                  <span className="text-[11px] text-zinc-500">{readiness[p]}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2">
            <span>
              <span className="block text-sm text-zinc-800">Fall back</span>
              <span className="block text-xs text-zinc-500">Try the next provider if one refuses</span>
            </span>
            <Toggle checked={draft.fallback} onChange={(v) => set("fallback", v)} label="Fall back to the next provider" />
          </label>
          <div>
            <label htmlFor="ad-max" className={label}>Never pay more than ({currency})</label>
            <input
              id="ad-max"
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              placeholder="No cap"
              className={field}
              value={draft.maxPriceMinor != null ? (draft.maxPriceMinor / 100).toString() : ""}
              onChange={(e) =>
                set("maxPriceMinor", e.target.value === "" ? null : Math.round(Number(e.target.value) * 100))
              }
            />
          </div>
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-xs font-semibold uppercase tracking-wide text-zinc-500">When</legend>
        <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
          <div>
            <label htmlFor="ad-trigger" className={label}>Trigger</label>
            <select
              id="ad-trigger"
              className={field}
              value={draft.trigger}
              onChange={(e) => set("trigger", e.target.value as RuleInput["trigger"])}
            >
              {Object.entries(TRIGGER_LABEL).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="ad-delay" className={label}>
              {draft.trigger === "BEFORE_READY" ? "Minutes before" : "Wait (minutes)"}
            </label>
            <input
              id="ad-delay"
              type="number"
              inputMode="numeric"
              min={0}
              max={240}
              className={field}
              value={draft.delayMinutes}
              onChange={(e) => set("delayMinutes", Math.max(0, Number(e.target.value) || 0))}
            />
          </div>
        </div>
        <p className="text-xs text-zinc-500">
          Fires {triggerSummary(draft)}. Scheduled orders are never booked before their cooking
          window, and orders taken before the rule is switched on are left alone.
        </p>
      </fieldset>

      <label className="flex items-center justify-between gap-3 rounded-lg border border-violet-200 bg-violet-50/60 px-3 py-2">
        <span>
          <span className="flex items-center gap-1.5 text-sm font-medium text-violet-900">
            <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" /> Dry run
          </span>
          <span className="block text-xs text-violet-700">
            Quote and record the choice in Activity, but book no courier and charge nothing.
          </span>
        </span>
        <Toggle checked={draft.dryRun} onChange={(v) => set("dryRun", v)} label="Dry run" />
      </label>

      {missing.length > 0 && (
        <p role="status" className="flex items-center gap-1.5 text-xs text-amber-700 sm:justify-end">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          To create the rule, add {missing.join(" and ")}.
        </p>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="min-h-[40px] rounded-lg border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSave}
          className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg bg-orange-600 px-4 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {isNew ? "Create rule" : "Save rule"}
        </button>
      </div>
    </form>
  );
}

function SearchInput({
  id,
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  ariaLabel?: string;
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden="true" />
      <input
        id={id}
        type="search"
        aria-label={ariaLabel}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm text-zinc-800 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20"
      />
    </div>
  );
}

function LocationOption({
  selected,
  onSelect,
  name,
  hint,
}: {
  selected: boolean;
  onSelect: () => void;
  name: string;
  hint: string;
}) {
  return (
    <li role="option" aria-selected={selected}>
      <button
        type="button"
        onClick={onSelect}
        className={`flex min-h-[40px] w-full items-center justify-between gap-3 px-3 text-left text-sm focus-visible:bg-orange-50 focus-visible:outline-none ${
          selected ? "bg-orange-50 font-medium text-orange-700" : "text-zinc-700 hover:bg-zinc-50"
        }`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <CheckCircle2
            className={`h-4 w-4 shrink-0 ${selected ? "text-orange-600" : "text-transparent"}`}
            aria-hidden="true"
          />
          <span className="truncate">{name}</span>
        </span>
        <span className="shrink-0 text-[11px] text-zinc-400">{hint}</span>
      </button>
    </li>
  );
}

// ── Live quote tester ───────────────────────────────────────────────────────

function LiveQuote({ options }: { options: AutoDispatchOptions }) {
  const [orders, setOrders] = useState<AutoDispatchOrder[] | null>(null);
  const [orderId, setOrderId] = useState("");
  const [preview, setPreview] = useState<AutoDispatchPreview | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    autoDispatchClient
      .orders()
      .then(setOrders)
      .catch(() => setOrders([]));
  }, []);

  async function run() {
    if (!orderId) return;
    setLoading(true);
    setPreview(null);
    try {
      setPreview(await autoDispatchClient.preview(orderId));
    } catch (e) {
      toast.error(errMsg(e, "Couldn't get quotes."));
    } finally {
      setLoading(false);
    }
  }

  const sorted = preview
    ? [...preview.quotes].sort(
        (a, b) =>
          Number(b.ok && b.canDispatch) - Number(a.ok && a.canDispatch) ||
          (a.amountMinor ?? Infinity) - (b.amountMinor ?? Infinity),
      )
    : [];
  const cheapest = sorted.find((q) => q.ok && q.canDispatch)?.provider;

  return (
    <Section title="Live quote">
      <div className="space-y-4 p-4">
        <p className="text-xs text-zinc-500">
          Price a recent delivery with every provider set up at its location, and see what your
          rules would do with it. Nothing is booked or charged.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <label htmlFor="ad-order" className="sr-only">Order</label>
          <select
            id="ad-order"
            className="min-h-[40px] w-full flex-1 rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-800 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20"
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
            disabled={!orders}
          >
            <option value="">{orders ? (orders.length ? "Pick a delivery order…" : "No delivery orders in the last 2 days") : "Loading orders…"}</option>
            {(orders ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {orderRef(o)} · {o.location?.name ?? ""} · {CHANNEL_LABEL[o.orderSource] ?? o.orderSource} · {o.status}
                {o.customerName ? ` · ${o.customerName}` : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={run}
            disabled={!orderId || loading}
            className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            Get live quotes
          </button>
        </div>

        {preview && (
          <div className="space-y-3" aria-live="polite">
            <div className="rounded-lg bg-zinc-50 px-3 py-2 text-[13px] text-zinc-700">
              {preview.rule ? (
                <>
                  Rule <strong>{preview.rule.name}</strong> takes this order
                  {preview.wouldChoose ? (
                    <> and would book <strong>{PROVIDER_LABEL[preview.wouldChoose]}</strong>.</>
                  ) : (
                    <>, but no provider could take it right now.</>
                  )}
                </>
              ) : (
                <>No enabled rule matches this order.</>
              )}
              {preview.ineligible && (
                <span className="mt-1 flex items-center gap-1.5 text-amber-700">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                  Not auto-dispatchable now: {preview.ineligible}.
                </span>
              )}
            </div>
            <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
              {sorted.map((q) => (
                <li key={q.provider} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium text-zinc-800">
                      {PROVIDER_LABEL[q.provider]}
                      {q.provider === cheapest && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                          <Trophy className="h-3 w-3" aria-hidden="true" /> Cheapest
                        </span>
                      )}
                      {q.ok && !q.canDispatch && (
                        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                          Estimate only
                        </span>
                      )}
                    </div>
                    <p className="truncate text-[11px] text-zinc-400">
                      {q.ok ? (q.deliverBy ? `Delivers by ${fmtWhen(q.deliverBy)}` : "Priced") : q.error}
                    </p>
                  </div>
                  <span className={`shrink-0 text-sm font-semibold tabular-nums ${q.ok ? "text-zinc-900" : "text-zinc-300"}`}>
                    {q.ok ? money(q.amountMinor, q.currency ?? locationCurrency(options, preview.order.locationId)) : "—"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Section>
  );
}

function fmtWhen(v: string) {
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return v;
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

// ── Activity row ────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<AutoDispatchRun["status"], string> = {
  SCHEDULED: "bg-sky-50 text-sky-700",
  RUNNING: "bg-sky-50 text-sky-700",
  DISPATCHED: "bg-emerald-50 text-emerald-700",
  DRY_RUN: "bg-violet-50 text-violet-700",
  FAILED: "bg-red-50 text-red-700",
  SKIPPED: "bg-zinc-100 text-zinc-600",
};

const STATUS_LABEL: Record<AutoDispatchRun["status"], string> = {
  SCHEDULED: "Scheduled",
  RUNNING: "Booking…",
  DISPATCHED: "Dispatched",
  DRY_RUN: "Dry run",
  FAILED: "Failed",
  SKIPPED: "Skipped",
};

function RunRow({
  run,
  ruleName,
  locationName,
  currency,
}: {
  run: AutoDispatchRun;
  ruleName: string;
  locationName: string;
  currency: string;
}) {
  const [open, setOpen] = useState(false);
  const when = run.status === "SCHEDULED" ? `due ${fmtWhen(run.dueAt)}` : fmtWhen(run.finishedAt ?? run.createdAt);
  return (
    <li className="px-4 py-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_STYLE[run.status]}`}>
              {STATUS_LABEL[run.status]}
            </span>
            <span className="truncate text-sm text-zinc-800">
              Order …{run.orderId.slice(-6)}
              {run.provider && <> → {PROVIDER_LABEL[run.provider]}</>}
            </span>
          </div>
          <p className="truncate text-[11px] text-zinc-400">
            {ruleName} · {locationName} · {when}
            {run.attempts > 1 ? ` · attempt ${run.attempts}` : ""}
          </p>
        </div>
        <span className="shrink-0 text-sm tabular-nums text-zinc-700">
          {run.priceMinor != null ? money(run.priceMinor, run.quotes?.[0]?.currency ?? currency) : ""}
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-1 rounded-lg bg-zinc-50 px-3 py-2 text-[12px] text-zinc-600">
          {run.error && <p className="text-red-600">{run.error}</p>}
          {(run.quotes ?? []).length > 0 ? (
            (run.quotes ?? []).map((q) => (
              <p key={q.provider} className="flex justify-between gap-3">
                <span>{PROVIDER_LABEL[q.provider]}</span>
                <span className="truncate text-right">
                  {q.ok ? money(q.amountMinor, q.currency ?? currency) : q.error}
                </span>
              </p>
            ))
          ) : (
            <p className="text-zinc-400">No quotes taken (fixed provider).</p>
          )}
          {run.jobId && <p className="text-zinc-400">Courier job {run.jobId}</p>}
        </div>
      )}
    </li>
  );
}
