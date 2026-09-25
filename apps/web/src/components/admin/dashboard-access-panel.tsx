"use client";

// Admin Dashboard → Dashboard access.
//
// Pick a location, switch off the tabs it has no use for. A dark kitchen has
// no dining room, so Tables and Reservations shouldn't be on anyone's screen
// there — and "anyone" means everyone, owner included. Role permissions keep
// narrowing on top; this only ever takes away.
//
// Shape of the screen: locations down the left (the thing you choose first),
// their tabs on the right (the thing you then change). Saving is explicit —
// a per-toggle autosave across twenty switches gives you twenty chances to
// half-apply a change to somebody's live dashboard.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import {
  ArrowLeft,
  Building2,
  Check,
  Eye,
  EyeOff,
  Info,
  LayoutList,
  Loader2,
  Copy,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import {
  DASHBOARD_TABS,
  DASHBOARD_TAB_GROUPS,
  type DashboardTabDef,
  type DashboardTabGroup,
} from "@orderhub/shared";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/api/query-keys";
import {
  dashboardAccessClient,
  type DashboardAccessRow,
} from "@/lib/api/dashboard-access.client";

const TABS_BY_GROUP: Array<[DashboardTabGroup, DashboardTabDef[]]> =
  DASHBOARD_TAB_GROUPS.map((group) => [
    group,
    DASHBOARD_TABS.filter((t) => t.group === group),
  ]);

export function DashboardAccessPanel() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  /** Working copy. null = "showing whatever the server last said". */
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const [copyingTo, setCopyingTo] = useState(false);

  const rowsQuery = useQuery({
    queryKey: queryKeys.dashboardAccess,
    queryFn: dashboardAccessClient.list,
  });
  const rows = useMemo(() => rowsQuery.data ?? [], [rowsQuery.data]);

  // Land on the first location so the right-hand panel isn't an empty prompt
  // on a single-location tenant. Only ever fires while nothing is selected.
  useEffect(() => {
    if (selectedId) return;
    const first = rows[0];
    if (first) setSelectedId(first.locationId);
  }, [rows, selectedId]);

  const selected = rows.find((r) => r.locationId === selectedId) ?? null;
  const saved = useMemo(
    () => new Set(selected?.disabledTabs ?? []),
    [selected],
  );
  const current = draft ?? saved;

  const dirty =
    draft !== null &&
    (draft.size !== saved.size || [...draft].some((k) => !saved.has(k)));

  const saveMut = useMutation({
    mutationFn: (next: string[]) =>
      dashboardAccessClient.set(selectedId!, next),
    onSuccess: (updated: DashboardAccessRow) => {
      toast.success(
        updated.disabledTabs.length
          ? `${updated.disabledTabs.length} tab${updated.disabledTabs.length === 1 ? "" : "s"} hidden at ${updated.locationName}`
          : `All tabs visible at ${updated.locationName}`,
      );
      setDraft(null);
      qc.invalidateQueries({ queryKey: queryKeys.dashboardAccess });
      // The sidebar reads these same flags off the locations list, so its
      // cache has to be told too — otherwise the admin's own screen keeps
      // showing the pre-save nav until something else happens to refetch.
      qc.invalidateQueries({ queryKey: queryKeys.locations });
    },
    onError: (err: any) =>
      toast.error(
        err?.response?.data?.message ?? "Couldn't save dashboard access",
      ),
  });

  const applyMut = useMutation({
    mutationFn: (locationIds: string[]) =>
      dashboardAccessClient.applyTo(selectedId!, locationIds),
    onSuccess: ({ applied }) => {
      toast.success(
        applied === 0
          ? "No locations were changed"
          : `Applied to ${applied} location${applied === 1 ? "" : "s"}`,
      );
      setCopyingTo(false);
      qc.invalidateQueries({ queryKey: queryKeys.dashboardAccess });
      qc.invalidateQueries({ queryKey: queryKeys.locations });
    },
    onError: (err: any) =>
      toast.error(
        err?.response?.data?.message ?? "Couldn't apply to those locations",
      ),
  });

  function toggle(tab: DashboardTabDef) {
    if (tab.locked) return;
    const next = new Set(current);
    if (next.has(tab.key)) next.delete(tab.key);
    else next.add(tab.key);
    setDraft(next);
  }

  function selectLocation(id: string) {
    if (
      dirty &&
      !confirm("You have unsaved changes for this location. Discard them?")
    ) {
      return;
    }
    setDraft(null);
    setSelectedId(id);
  }

  const q = search.trim().toLowerCase();
  const shown = q
    ? rows.filter((r) =>
        [r.locationName, r.brandName]
          .filter(Boolean)
          .some((f) => String(f).toLowerCase().includes(q)),
      )
    : rows;

  return (
    <div className="space-y-6 p-6">
      {/* ── Header ───────────────────────────────────────────── */}
      <div>
        <Link
          href="/dashboard/admin"
          className="inline-flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 rounded"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> Admin Dashboard
        </Link>
        <h1 className="mt-2 flex items-center gap-2 text-xl font-semibold text-zinc-900">
          <LayoutList className="h-5 w-5" aria-hidden="true" /> Dashboard access
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-zinc-500">
          Hide the tabs a location has no use for. A hidden tab disappears from
          the sidebar for <strong className="font-medium text-zinc-700">every
          user at that location</strong> — owners and managers included — and
          the page itself stops opening.
        </p>
      </div>

      {rowsQuery.isPending ? (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 text-sm text-zinc-500"
        >
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{" "}
          Loading locations…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 p-10 text-center">
          <Building2 className="mx-auto h-8 w-8 text-zinc-300" aria-hidden="true" />
          <p className="mt-3 text-sm text-zinc-600">
            No locations on this tenant yet.
          </p>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
          {/* ── Locations ──────────────────────────────────────── */}
          <div className="rounded-xl border border-zinc-200 bg-white shadow-sm">
            <div className="border-b border-zinc-100 p-3">
              <label htmlFor="location-search" className="sr-only">
                Search locations
              </label>
              <div className="flex items-center gap-2 rounded-lg border border-zinc-200 px-2.5 py-1.5 focus-within:ring-2 focus-within:ring-orange-500">
                <Search
                  className="h-3.5 w-3.5 flex-shrink-0 text-zinc-400"
                  aria-hidden="true"
                />
                <input
                  id="location-search"
                  type="search"
                  name="location-search"
                  autoComplete="off"
                  spellCheck={false}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search locations…"
                  className="w-full bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400"
                />
              </div>
            </div>
            <ul className="max-h-[32rem] overflow-y-auto p-1.5">
              {shown.length === 0 && (
                <li className="px-2.5 py-3 text-sm text-zinc-500">
                  No location by that name.
                </li>
              )}
              {shown.map((row) => {
                const active = row.locationId === selectedId;
                const hidden = row.disabledTabs.length;
                return (
                  <li key={row.locationId}>
                    <button
                      type="button"
                      onClick={() => selectLocation(row.locationId)}
                      aria-current={active ? "true" : undefined}
                      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
                        active ? "bg-orange-50" : "hover:bg-zinc-50"
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <p
                          className={`truncate text-sm ${
                            active
                              ? "font-semibold text-orange-900"
                              : "font-medium text-zinc-800"
                          }`}
                        >
                          {row.locationName}
                        </p>
                        <p className="truncate text-xs text-zinc-500">
                          {row.brandName ?? "—"}
                        </p>
                      </div>
                      {hidden > 0 && (
                        <span className="flex-shrink-0 rounded-full bg-zinc-900 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                          {hidden} hidden
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* ── Tabs for the selected location ─────────────────── */}
          {selected ? (
            <div className="min-w-0 space-y-4">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-zinc-900">
                    {selected.locationName}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {current.size === 0
                      ? "Every tab visible"
                      : `${current.size} tab${current.size === 1 ? "" : "s"} hidden`}
                    {dirty && " · unsaved"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDraft(new Set())}
                    disabled={current.size === 0 || saveMut.isPending}
                  >
                    <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> Show all
                  </Button>
                  {rows.length > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setCopyingTo(true)}
                      // Copying applies what this location HAS, not what's on
                      // screen. Offering it mid-edit would copy a version the
                      // admin hasn't agreed to yet.
                      disabled={dirty || saveMut.isPending}
                      title={
                        dirty ? "Save your changes first" : undefined
                      }
                    >
                      <Copy className="mr-1 h-3.5 w-3.5" aria-hidden="true" />{" "}
                      Apply to other locations
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setDraft(null)}
                    disabled={!dirty || saveMut.isPending}
                  >
                    Discard
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => saveMut.mutate([...current])}
                    disabled={!dirty}
                    loading={saveMut.isPending}
                  >
                    <Check className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> Save changes
                  </Button>
                </div>
              </div>

              <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
                <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                <span>
                  Your own platform-admin account is never restricted, so you
                  can always get back here. Kiosk and kitchen-screen devices
                  keep their one assigned page too.
                </span>
              </p>

              {copyingTo && (
                <ApplyToDialog
                  source={selected}
                  candidates={rows.filter(
                    (r) => r.locationId !== selected.locationId,
                  )}
                  pending={applyMut.isPending}
                  onCancel={() => setCopyingTo(false)}
                  onApply={(ids) => applyMut.mutate(ids)}
                />
              )}

              {TABS_BY_GROUP.map(([group, tabs]) => (
                <section
                  key={group}
                  className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm"
                >
                  <h2 className="border-b border-zinc-100 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
                    {group}
                  </h2>
                  <ul className="divide-y divide-zinc-100">
                    {tabs.map((tab) => {
                      const off = current.has(tab.key);
                      return (
                        <li
                          key={tab.key}
                          className="flex items-center gap-3 px-4 py-2.5"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-zinc-900">
                              {tab.label}
                            </p>
                            {tab.hint && (
                              <p className="mt-0.5 text-xs text-zinc-500">
                                {tab.hint}
                              </p>
                            )}
                          </div>
                          {tab.locked ? (
                            // A switch that can't be switched is a puzzle.
                            // Say what's true and leave nothing to press.
                            <span className="flex-shrink-0 rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-500">
                              Always on
                            </span>
                          ) : (
                            <TabToggle
                              label={tab.label}
                              enabled={!off}
                              onToggle={() => toggle(tab)}
                            />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <p className="text-sm text-zinc-500">
              Select a location to edit its tabs.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Copy one location's tab visibility onto others.
 *
 *  Every row shows what that location hides TODAY, because the thing being
 *  agreed to is an overwrite — an admin who can't see what they're about to
 *  replace is being asked to confirm something they don't know. */
function ApplyToDialog({
  source,
  candidates,
  pending,
  onCancel,
  onApply,
}: {
  source: DashboardAccessRow;
  candidates: DashboardAccessRow[];
  pending: boolean;
  onCancel: () => void;
  onApply: (locationIds: string[]) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const allPicked = picked.size === candidates.length && candidates.length > 0;

  // Esc closes, as every dialog in the app should.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, pending]);

  function toggleOne(id: string) {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  }

  const hiddenCount = source.disabledTabs.length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => !pending && onCancel()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="apply-to-title"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-zinc-100 p-4">
          <div className="min-w-0">
            <h2
              id="apply-to-title"
              className="text-sm font-semibold text-zinc-900"
            >
              Apply {source.locationName}&rsquo;s tabs elsewhere
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              {hiddenCount === 0
                ? "Every tab visible"
                : `${hiddenCount} tab${hiddenCount === 1 ? "" : "s"} hidden`}
              . This replaces each chosen location&rsquo;s own settings.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            aria-label="Close"
            className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="border-b border-zinc-100 px-4 py-2">
          <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-zinc-600">
            <input
              type="checkbox"
              checked={allPicked}
              onChange={() =>
                setPicked(
                  allPicked
                    ? new Set()
                    : new Set(candidates.map((c) => c.locationId)),
                )
              }
              className="h-4 w-4 rounded border-zinc-300 text-orange-500 focus-visible:ring-2 focus-visible:ring-orange-500"
            />
            Select all {candidates.length}
          </label>
        </div>

        <ul className="flex-1 divide-y divide-zinc-100 overflow-y-auto">
          {candidates.map((c) => (
            <li key={c.locationId}>
              <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-zinc-50">
                <input
                  type="checkbox"
                  checked={picked.has(c.locationId)}
                  onChange={() => toggleOne(c.locationId)}
                  className="h-4 w-4 flex-shrink-0 rounded border-zinc-300 text-orange-500 focus-visible:ring-2 focus-visible:ring-orange-500"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-zinc-900">
                    {c.locationName}
                  </span>
                  <span className="block truncate text-xs text-zinc-500">
                    {c.brandName ?? "—"} · currently{" "}
                    {c.disabledTabs.length === 0
                      ? "all visible"
                      : `${c.disabledTabs.length} hidden`}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-100 p-4">
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => onApply([...picked])}
            disabled={picked.size === 0}
            loading={pending}
          >
            {picked.size === 0
              ? "Apply"
              : `Apply to ${picked.size} location${picked.size === 1 ? "" : "s"}`}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Enabled = the tab is visible at this location. */
function TabToggle({
  label,
  enabled,
  onToggle,
}: {
  label: string;
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={`${label} — ${enabled ? "visible" : "hidden"} at this location`}
      onClick={onToggle}
      className={`group flex flex-shrink-0 items-center gap-2 rounded-lg px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 ${
        enabled
          ? "text-emerald-700 hover:bg-emerald-50"
          : "text-zinc-500 hover:bg-zinc-100"
      }`}
    >
      {enabled ? (
        <Eye className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      <span className="w-12 text-left">{enabled ? "Visible" : "Hidden"}</span>
      <span
        aria-hidden="true"
        className={`relative h-5 w-9 rounded-full transition-colors ${
          enabled ? "bg-emerald-500" : "bg-zinc-300 group-hover:bg-zinc-400"
        }`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
            enabled ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </span>
    </button>
  );
}
