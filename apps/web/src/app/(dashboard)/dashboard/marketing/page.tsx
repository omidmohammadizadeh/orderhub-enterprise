"use client";

// Phase AW-19 — Marketing landing page.
//
// Operator lands here, sees their existing campaigns (DRAFT / ACTIVE /
// PAUSED / ENDED), and clicks "New campaign" to open the 7-tile type
// picker. The Percentage-off tile launches the form modal; the other
// six save the operator's intent as a DRAFT row with the picked type
// and route them straight into a "coming soon" stub for now.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Megaphone,
  Plus,
  Loader2,
  Pause,
  Play,
  Trash2,
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
} from "@/lib/api/marketing.client";
import { PercentageOffCampaignForm } from "@/components/marketing/percentage-off-form";

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
    wired: false,
    badge: "Highest sales",
  },
  {
    id: "PERCENT_OFF_ITEMS",
    title: "Per cent off items",
    example: "Example: 20% off select items",
    icon: Tag,
    wired: false,
    badge: "Customer favourite",
  },
  {
    id: "AMOUNT_OFF_ORDER",
    title: "Amount off order",
    example: "Example: £5 off £20+",
    icon: ShoppingCart,
    wired: false,
  },
  {
    id: "FREE_ITEM",
    title: "Free item with purchase",
    example: "Example: Free item (spend £20)",
    icon: Sparkles,
    wired: false,
  },
  {
    id: "FREE_DELIVERY",
    title: "Free delivery",
    example: "Customer pays £0 delivery",
    icon: Truck,
    wired: false,
  },
  {
    id: "HAPPY_HOUR",
    title: "Happy hour",
    example: "Example: 20% off £20+ (14:00–17:00)",
    icon: Clock,
    wired: false,
  },
];

export default function MarketingPage() {
  const qc = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [formType, setFormType] = useState<CampaignType | null>(null);

  const { data: campaigns = [], isLoading } = useQuery({
    queryKey: ["marketing", "campaigns"],
    queryFn: () => marketingClient.list(),
  });

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
        <CampaignsTable
          campaigns={campaigns}
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
    </div>
  );
}

function CampaignsTable({
  campaigns,
  onRemove,
  onTogglePause,
}: {
  campaigns: MarketingCampaign[];
  onRemove: (id: string) => void;
  onTogglePause: (id: string, status: string) => void;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 overflow-hidden bg-white">
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-[11px] uppercase tracking-wider text-zinc-500">
          <tr>
            <th className="text-left px-4 py-3">Name</th>
            <th className="text-left px-4 py-3">Type</th>
            <th className="text-left px-4 py-3">Audience</th>
            <th className="text-left px-4 py-3">Channels</th>
            <th className="text-left px-4 py-3">Window</th>
            <th className="text-left px-4 py-3">Status</th>
            <th className="text-right px-4 py-3"></th>
          </tr>
        </thead>
        <tbody>
          {campaigns.map((c) => (
            <tr key={c.id} className="border-t border-zinc-100">
              <td className="px-4 py-3 font-medium text-zinc-900">{c.name}</td>
              <td className="px-4 py-3 text-zinc-600">
                {prettyType(c.type)}
                {c.percentageOff != null && (
                  <span className="ml-1 text-[11px] text-zinc-400">
                    ({Number(c.percentageOff)}%)
                  </span>
                )}
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
              </td>
              <td className="px-4 py-3 text-zinc-600">
                {prettyWindow(c.startsAt, c.endsAt)}
              </td>
              <td className="px-4 py-3">
                <StatusChip status={c.status} />
              </td>
              <td className="px-4 py-3 text-right">
                <div className="inline-flex items-center gap-1">
                  {(c.status === "ACTIVE" || c.status === "PAUSED") && (
                    <button
                      type="button"
                      title={
                        c.status === "ACTIVE" ? "Pause campaign" : "Resume campaign"
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
          ))}
        </tbody>
      </table>
    </div>
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
