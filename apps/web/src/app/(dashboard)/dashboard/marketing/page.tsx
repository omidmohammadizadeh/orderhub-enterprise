"use client";

// Phase AW-19 — Marketing landing page.
//
// Operator lands here, sees their existing campaigns (DRAFT / ACTIVE /
// PAUSED / ENDED), and clicks "New campaign" to open the 7-tile type
// picker. The Percentage-off tile launches the form modal; the other
// six save the operator's intent as a DRAFT row with the picked type
// and route them straight into a "coming soon" stub for now.

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Megaphone,
  Plus,
  Loader2,
  Pause,
  Play,
  Trash2,
  Pencil,
  Percent,
  ShoppingCart,
  Gift,
  Truck,
  Clock,
  Sparkles,
  Tag,
} from "lucide-react";
import toast from "react-hot-toast";
import {
  marketingClient,
  type MarketingCampaign,
  type CampaignType,
  type CampaignStatus,
  type CampaignMetrics,
  type CampaignMetricsMap,
} from "@/lib/api/marketing.client";
import { EditCampaignModal } from "@/components/marketing/edit-campaign-modal";
import { TopSellersPanel } from "@/components/marketing/top-sellers-panel";
import { PercentageOffCampaignForm } from "@/components/marketing/percentage-off-form";
import { AmountOffCampaignForm } from "@/components/marketing/amount-off-form";
import { PercentOffItemsCampaignForm } from "@/components/marketing/percent-off-items-form";
import { BogoCampaignForm } from "@/components/marketing/bogo-form";
import { FreeItemCampaignForm } from "@/components/marketing/free-item-form";
import { FreeDeliveryCampaignForm } from "@/components/marketing/free-delivery-form";
import { HappyHourCampaignForm } from "@/components/marketing/happy-hour-form";

interface TypeTile {
  id: CampaignType;
  title: string;
  example: string;
  icon: any;
  wired: boolean;
  badge?: string;
}

const TYPE_TILES: TypeTile[] = [
  {
    id: "PERCENTAGE_OFF",
    title: "Per cent off order",
    example: "Example: 20% off £20+",
    icon: Percent,
    wired: true,
  },
  {
    id: "BOGO",
    title: "Buy 1, get 1 free",
    example: "Example: free fries with a burger",
    icon: Gift,
    wired: true,
    badge: "Highest sales",
  },
  {
    id: "PERCENT_OFF_ITEMS",
    title: "Per cent off items",
    example: "Example: 20% off select items",
    icon: Tag,
    wired: true,
    badge: "Customer favourite",
  },
  {
    id: "AMOUNT_OFF_ORDER",
    title: "Amount off order",
    example: "Example: £5 off £20+",
    icon: ShoppingCart,
    wired: true,
  },
  {
    id: "FREE_ITEM",
    title: "Free item with purchase",
    example: "Example: Free item (spend £20)",
    icon: Sparkles,
    wired: true,
  },
  {
    id: "FREE_DELIVERY",
    title: "Free delivery",
    example: "Customer pays £0 delivery",
    icon: Truck,
    wired: true,
  },
  {
    id: "HAPPY_HOUR",
    title: "Happy hour",
    example: "Example: 20% off (14:00–17:00, Mon-Fri)",
    icon: Clock,
    wired: true,
  },
];

// Phase MK-INSIGHTS — date windows for the performance filter, mirroring
// Uber Eats Manager. `days: null` = all time (no `from`).
const DATE_RANGES: Array<{ id: string; label: string; days: number | null }> = [
  { id: "7", label: "Last 7 days", days: 7 },
  { id: "30", label: "Last 30 days", days: 30 },
  { id: "84", label: "Last 12 weeks", days: 84 },
  { id: "365", label: "Last 12 months", days: 365 },
  { id: "all", label: "All time", days: null },
];

const ALL_STATUSES: CampaignStatus[] = ["ACTIVE", "PAUSED", "DRAFT", "ENDED"];

export default function MarketingPage() {
  const qc = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [formType, setFormType] = useState<CampaignType | null>(null);
  const [editing, setEditing] = useState<MarketingCampaign | null>(null);

  // Insight filters (Uber-style): a date window drives the metrics query;
  // a status set filters the rows client-side.
  const [rangeId, setRangeId] = useState("30");
  const [statusFilter, setStatusFilter] =
    useState<CampaignStatus[]>(ALL_STATUSES);

  const { data: campaigns = [], isLoading } = useQuery({
    queryKey: ["marketing", "campaigns"],
    queryFn: () => marketingClient.list(),
  });

  // Per-campaign performance for the chosen window. Compute `from` in the
  // browser; `to` defaults to now on the server.
  const { data: metrics = {} } = useQuery<CampaignMetricsMap>({
    queryKey: ["marketing", "metrics", rangeId],
    queryFn: () => {
      const days = DATE_RANGES.find((r) => r.id === rangeId)?.days ?? null;
      const from =
        days == null
          ? undefined
          : new Date(Date.now() - days * 86_400_000).toISOString();
      return marketingClient.metrics(from ? { from } : undefined);
    },
  });

  const visibleCampaigns = useMemo(
    () => campaigns.filter((c) => statusFilter.includes(c.status)),
    [campaigns, statusFilter],
  );

  const removeMutation = useMutation({
    mutationFn: (id: string) => marketingClient.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["marketing", "campaigns"] });
      toast.success("Campaign deleted");
    },
    onError: (err: any) =>
      toast.error(
        err?.response?.data?.message ?? err?.message ?? "Failed to delete",
      ),
  });

  const togglePauseMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "ACTIVE" | "PAUSED" }) =>
      marketingClient.update(id, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["marketing", "campaigns"] });
    },
    onError: (err: any) =>
      toast.error(err?.response?.data?.message ?? "Failed to update"),
  });

  return (
    <div className="px-6 py-6">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900 flex items-center gap-2">
            <Megaphone className="h-5 w-5" /> Marketing
          </h1>
          <p className="text-sm text-zinc-500 mt-1">
            Campaigns push offers to your storefront, POS, and marketplace
            channels. Each one is brand- and channel-scoped.
          </p>
        </div>
        <button
          onClick={() => setPickerOpen(true)}
          className="inline-flex items-center gap-2 rounded-md bg-zinc-900 text-white px-4 py-2 text-sm font-semibold hover:bg-zinc-800"
        >
          <Plus className="h-4 w-4" /> New campaign
        </button>
      </div>

      {/* Top sellers sits above campaigns: it's merchandising the operator
          changes far more often than they launch an offer. */}
      <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-4">
        <TopSellersPanel />
      </div>

      {isLoading ? (
        <div className="grid place-items-center py-24 text-zinc-400">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : campaigns.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-zinc-200 px-6 py-16 text-center">
          <Megaphone className="h-10 w-10 mx-auto text-zinc-300 mb-3" />
          <p className="font-medium text-zinc-500">No campaigns yet</p>
          <p className="text-sm text-zinc-400 mt-1">
            Click "New campaign" above to launch your first offer.
          </p>
        </div>
      ) : (
        <>
          <FilterBar
            rangeId={rangeId}
            onRange={setRangeId}
            statusFilter={statusFilter}
            onStatus={setStatusFilter}
          />
          <InsightsSummary
            campaigns={visibleCampaigns}
            metrics={metrics}
            rangeLabel={
              DATE_RANGES.find((r) => r.id === rangeId)?.label ?? ""
            }
          />
          {visibleCampaigns.length === 0 ? (
            <div className="rounded-xl border border-zinc-200 bg-white px-6 py-12 text-center text-sm text-zinc-500">
              No campaigns match the selected status filter.
            </div>
          ) : (
            <CampaignsTable
              campaigns={visibleCampaigns}
              metrics={metrics}
              onEdit={(c) => setEditing(c)}
              onRemove={(id) => {
                if (
                  !window.confirm(
                    "Delete this campaign? This cannot be undone.",
                  )
                )
                  return;
                removeMutation.mutate(id);
              }}
              onTogglePause={(id, current) =>
                togglePauseMutation.mutate({
                  id,
                  status: current === "ACTIVE" ? "PAUSED" : "ACTIVE",
                })
              }
            />
          )}
        </>
      )}

      {editing && (
        <EditCampaignModal
          campaign={editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["marketing", "campaigns"] });
            qc.invalidateQueries({ queryKey: ["marketing", "metrics"] });
            setEditing(null);
          }}
        />
      )}

      {pickerOpen && (
        <TypePicker
          onPick={(type) => {
            setPickerOpen(false);
            if (TYPE_TILES.find((t) => t.id === type)?.wired) {
              setFormType(type);
            } else {
              toast(
                "This campaign type isn't wired yet. Percentage off is the only live one right now.",
                { icon: "🚧" },
              );
            }
          }}
          onCancel={() => setPickerOpen(false)}
        />
      )}

      {formType === "PERCENTAGE_OFF" && (
        <PercentageOffCampaignForm
          onCancel={() => setFormType(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["marketing", "campaigns"] });
            setFormType(null);
          }}
        />
      )}

      {formType === "AMOUNT_OFF_ORDER" && (
        <AmountOffCampaignForm
          onCancel={() => setFormType(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["marketing", "campaigns"] });
            setFormType(null);
          }}
        />
      )}

      {formType === "PERCENT_OFF_ITEMS" && (
        <PercentOffItemsCampaignForm
          onCancel={() => setFormType(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["marketing", "campaigns"] });
            setFormType(null);
          }}
        />
      )}

      {formType === "BOGO" && (
        <BogoCampaignForm
          onCancel={() => setFormType(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["marketing", "campaigns"] });
            setFormType(null);
          }}
        />
      )}

      {formType === "FREE_ITEM" && (
        <FreeItemCampaignForm
          onCancel={() => setFormType(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["marketing", "campaigns"] });
            setFormType(null);
          }}
        />
      )}

      {formType === "FREE_DELIVERY" && (
        <FreeDeliveryCampaignForm
          onCancel={() => setFormType(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["marketing", "campaigns"] });
            setFormType(null);
          }}
        />
      )}

      {formType === "HAPPY_HOUR" && (
        <HappyHourCampaignForm
          onCancel={() => setFormType(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["marketing", "campaigns"] });
            setFormType(null);
          }}
        />
      )}
    </div>
  );
}

function CampaignsTable({
  campaigns,
  metrics,
  onEdit,
  onRemove,
  onTogglePause,
}: {
  campaigns: MarketingCampaign[];
  metrics: CampaignMetricsMap;
  onEdit: (c: MarketingCampaign) => void;
  onRemove: (id: string) => void;
  onTogglePause: (id: string, status: string) => void;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 overflow-x-auto bg-white">
      <table className="w-full text-sm min-w-[900px]">
        <thead className="bg-zinc-50 text-[11px] uppercase tracking-wider text-zinc-500">
          <tr>
            <th className="text-left px-4 py-3">Campaign</th>
            <th className="text-left px-4 py-3">Audience</th>
            <th className="text-left px-4 py-3">Channels</th>
            <th className="text-left px-4 py-3">Window</th>
            <th className="text-left px-4 py-3">Status</th>
            {/* Phase MK-INSIGHTS — performance columns, like Uber's Offers */}
            <th className="text-right px-4 py-3">Sales</th>
            <th className="text-right px-4 py-3">Orders</th>
            <th className="text-right px-4 py-3">New customers</th>
            <th className="text-right px-4 py-3"></th>
          </tr>
        </thead>
        <tbody>
          {campaigns.map((c) => {
            const m = metrics[c.id];
            return (
              <tr key={c.id} className="border-t border-zinc-100">
                <td className="px-4 py-3">
                  <div className="font-medium text-zinc-900">{c.name}</div>
                  <div className="text-[11px] text-zinc-400">
                    {prettyType(c.type)}
                    {c.percentageOff != null && ` · ${Number(c.percentageOff)}%`}
                    {c.amountOff != null && ` · £${Number(c.amountOff)}`}
                  </div>
                </td>
                <td className="px-4 py-3 text-zinc-600">
                  {prettyAudience(c.audience)}
                </td>
                <td className="px-4 py-3 text-zinc-600">
                  {c.channels.length === 0 ? (
                    <span className="text-zinc-400">—</span>
                  ) : (
                    c.channels.map(prettyChannel).join(", ")
                  )}
                  <UberSyncBadge campaign={c} />
                </td>
                <td className="px-4 py-3 text-zinc-600">
                  {prettyWindow(c.startsAt, c.endsAt)}
                </td>
                <td className="px-4 py-3">
                  <StatusChip status={c.status} />
                </td>
                <td className="px-4 py-3 text-right font-medium text-zinc-900">
                  {money(m?.sales)}
                </td>
                <td className="px-4 py-3 text-right text-zinc-700">
                  {m?.orders ?? 0}
                </td>
                <td className="px-4 py-3 text-right text-zinc-700">
                  {m?.newCustomers ?? 0}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="inline-flex items-center gap-1">
                    <button
                      type="button"
                      title="Edit campaign"
                      onClick={() => onEdit(c)}
                      className="rounded p-1 text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    {(c.status === "ACTIVE" || c.status === "PAUSED") && (
                      <button
                        type="button"
                        title={
                          c.status === "ACTIVE"
                            ? "Pause campaign"
                            : "Resume campaign"
                        }
                        onClick={() => onTogglePause(c.id, c.status)}
                        className="rounded p-1 text-zinc-400 hover:text-violet-700 hover:bg-violet-50"
                      >
                        {c.status === "ACTIVE" ? (
                          <Pause className="h-3.5 w-3.5" />
                        ) : (
                          <Play className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}
                    <button
                      type="button"
                      title="Delete campaign"
                      onClick={() => onRemove(c.id)}
                      className="rounded p-1 text-zinc-400 hover:text-red-600 hover:bg-red-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Insight filters + summary ───────────────────────────────────────

function FilterBar({
  rangeId,
  onRange,
  statusFilter,
  onStatus,
}: {
  rangeId: string;
  onRange: (id: string) => void;
  statusFilter: CampaignStatus[];
  onStatus: (s: CampaignStatus[]) => void;
}) {
  const toggle = (s: CampaignStatus) =>
    onStatus(
      statusFilter.includes(s)
        ? statusFilter.filter((x) => x !== s)
        : [...statusFilter, s],
    );
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <select
        value={rangeId}
        onChange={(e) => onRange(e.target.value)}
        className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-800"
      >
        {DATE_RANGES.map((r) => (
          <option key={r.id} value={r.id}>
            {r.label}
          </option>
        ))}
      </select>
      <div className="flex flex-wrap items-center gap-1.5">
        {ALL_STATUSES.map((s) => {
          const on = statusFilter.includes(s);
          return (
            <button
              key={s}
              type="button"
              onClick={() => toggle(s)}
              className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                on
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300"
              }`}
            >
              {s}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Roll-up cards over the visible campaigns for the chosen window.
function InsightsSummary({
  campaigns,
  metrics,
  rangeLabel,
}: {
  campaigns: MarketingCampaign[];
  metrics: CampaignMetricsMap;
  rangeLabel: string;
}) {
  const totals = campaigns.reduce(
    (acc, c) => {
      const m: CampaignMetrics | undefined = metrics[c.id];
      if (m) {
        acc.sales += m.sales;
        acc.orders += m.orders;
        acc.newCustomers += m.newCustomers;
        acc.discount += m.discount;
      }
      return acc;
    },
    { sales: 0, orders: 0, newCustomers: 0, discount: 0 },
  );
  const cards = [
    { label: "Attributed sales", value: money(totals.sales) },
    { label: "Orders", value: String(totals.orders) },
    { label: "New customers", value: String(totals.newCustomers) },
    { label: "Total discounts", value: money(totals.discount) },
  ];
  return (
    <div className="mb-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
      {cards.map((c) => (
        <div
          key={c.label}
          className="rounded-xl border border-zinc-200 bg-white px-4 py-3"
        >
          <p className="text-[11px] uppercase tracking-wider text-zinc-400">
            {c.label}
          </p>
          <p className="mt-1 text-lg font-semibold text-zinc-900">{c.value}</p>
        </div>
      ))}
      <p className="col-span-2 sm:col-span-4 -mt-1 text-[11px] text-zinc-400">
        Performance over {rangeLabel.toLowerCase()}, across online-ordering
        orders that applied each offer. Tracking started when this feature
        shipped — earlier orders aren't counted.
      </p>
    </div>
  );
}

// £ formatter — whole pounds unless there are pence, matching Uber's list.
function money(n: number | undefined): string {
  const v = Number(n ?? 0);
  return `£${v.toLocaleString("en-GB", {
    minimumFractionDigits: v % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

// Campaigns with the Uber Eats channel are mirrored to Uber's Promotions
// API by the backend (created when ACTIVE, revoked on pause/delete). The
// sync outcome rides on campaign.metadata.uberEats — surface it so the
// operator can tell "live on Uber" from "Uber rejected it".
function UberSyncBadge({ campaign }: { campaign: MarketingCampaign }) {
  const uber = (campaign as any).metadata?.uberEats;
  if (!campaign.channels?.includes("UBER_EATS") || !uber) return null;
  if (uber.lastError) {
    return (
      <span
        title={String(uber.lastError)}
        className="ml-2 inline-flex items-center rounded-full bg-red-50 text-red-700 px-1.5 py-0.5 text-[10px] font-semibold"
      >
        Uber sync failed
      </span>
    );
  }
  const n = uber.promotions?.length ?? 0;
  if (n === 0) return null;
  return (
    <span className="ml-2 inline-flex items-center rounded-full bg-emerald-50 text-emerald-700 px-1.5 py-0.5 text-[10px] font-semibold">
      Live on Uber Eats{n > 1 ? ` (${n} stores)` : ""}
    </span>
  );
}

function StatusChip({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    DRAFT: ["bg-zinc-100", "text-zinc-600"],
    ACTIVE: ["bg-emerald-50", "text-emerald-700"],
    PAUSED: ["bg-amber-50", "text-amber-700"],
    ENDED: ["bg-zinc-100", "text-zinc-500"],
  };
  const [bg, fg] = map[status] ?? ["bg-zinc-100", "text-zinc-600"];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${bg} ${fg}`}
    >
      {status}
    </span>
  );
}

function TypePicker({
  onPick,
  onCancel,
}: {
  onPick: (type: CampaignType) => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 backdrop-blur-sm py-10"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl mx-4 p-6">
        <h2 className="text-base font-semibold text-zinc-900 mb-2">
          Choose a campaign type
        </h2>
        <p className="text-xs text-zinc-500 mb-5">
          Pick the offer style. You'll pick the brand, channels, and audience
          on the next screen.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {TYPE_TILES.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onPick(t.id)}
                className="relative text-left rounded-xl border border-zinc-200 hover:border-violet-300 hover:bg-violet-50/40 p-4 transition-colors"
              >
                {t.badge && (
                  <span className="absolute top-3 right-3 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-semibold px-1.5 py-0.5">
                    {t.badge}
                  </span>
                )}
                <Icon className="h-7 w-7 text-violet-600 mb-3" />
                <p className="text-sm font-semibold text-zinc-900">{t.title}</p>
                <p className="text-[11px] text-zinc-500 mt-0.5">{t.example}</p>
                {!t.wired && (
                  <p className="text-[10px] text-amber-700 mt-2">
                    Coming soon
                  </p>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Format helpers ──────────────────────────────────────────────────

function prettyType(t: CampaignType): string {
  const map: Record<CampaignType, string> = {
    PERCENTAGE_OFF: "Per cent off order",
    AMOUNT_OFF_ORDER: "Amount off order",
    PERCENT_OFF_ITEMS: "Per cent off items",
    BOGO: "Buy 1, get 1 free",
    FREE_ITEM: "Free item with purchase",
    FREE_DELIVERY: "Free delivery",
    HAPPY_HOUR: "Happy hour",
  };
  return map[t];
}

function prettyAudience(a: string): string {
  const map: Record<string, string> = {
    ALL: "All customers",
    NEW: "New customers",
    RETURNING: "Returning",
    LAPSED: "Lapsed (45d+)",
  };
  return map[a] ?? a;
}

function prettyChannel(c: string): string {
  const map: Record<string, string> = {
    ONLINE: "Online ordering",
    POS: "POS",
    JUST_EAT: "Just Eat",
    UBER_EATS: "Uber Eats",
    DELIVEROO: "Deliveroo",
    WHATSAPP: "WhatsApp",
    HUBRISE: "HubRise",
  };
  return map[c] ?? c;
}

function prettyWindow(starts: string | null, ends: string | null): string {
  const fmt = (s: string | null) =>
    s ? new Date(s).toLocaleDateString([], { day: "numeric", month: "short" }) : null;
  const s = fmt(starts);
  const e = fmt(ends);
  if (!s && !e) return "Open-ended";
  if (!e) return `From ${s}`;
  if (!s) return `Until ${e}`;
  return `${s} → ${e}`;
}
