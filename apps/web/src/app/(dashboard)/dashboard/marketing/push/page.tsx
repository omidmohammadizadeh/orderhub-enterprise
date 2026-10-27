"use client";

// Marketing → Push notifications. Two jobs on one page:
//   - Order updates: the push a customer gets at each stage (Preparing, Ready,
//     Out for delivery, Completed…) plus the "how was it?" review ask — on/off
//     and the wording, per account.
//   - Campaigns: a one-off message to everyone who said yes to offers, now or
//     at a set time.
// The audience is browsers that turned notifications on at the storefront and
// installs of the restaurant's own app; the page treats them as one list.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  CalendarClock,
  Check,
  Globe,
  Loader2,
  MapPin,
  Pencil,
  Plus,
  Send,
  Smartphone,
  Star,
  Trash2,
  TriangleAlert,
  Users,
  X,
} from "lucide-react";
import {
  PUSH_BODY_MAX,
  PUSH_TITLE_MAX,
  pushNotificationsClient,
  type LocationReview,
  type LocationReviewSetting,
  type PushAutomation,
  type PushCampaign,
  type PushCampaignStatus,
  type PushTrigger,
} from "@/lib/api/push-notifications.client";
import { apiErrorMessage } from "@/lib/api/email-marketing.client";
import { cn } from "@/lib/utils";

type Tab = "campaigns" | "automations";

const TRIGGER_LABEL: Record<PushTrigger, { label: string; hint: string }> = {
  ACCEPTED: { label: "Order accepted", hint: "When you accept the order" },
  PREPARING: { label: "Preparing", hint: "When the kitchen starts on it" },
  READY: { label: "Ready", hint: "Ready to collect, or waiting for a driver" },
  OUT_FOR_DELIVERY: { label: "Out for delivery", hint: "When the driver leaves" },
  RIDER_ARRIVED: { label: "Driver arrived", hint: "When the driver is outside" },
  COMPLETED: { label: "Completed", hint: "When the order is finished" },
  CANCELLED: { label: "Cancelled", hint: "If the order is cancelled" },
  REVIEW_REQUEST: { label: "Leave a review", hint: "A while after the order completes" },
};

const STATUS: Record<PushCampaignStatus, { label: string; cls: string }> = {
  DRAFT: { label: "Draft", cls: "bg-zinc-100 text-zinc-700" },
  SCHEDULED: { label: "Scheduled", cls: "bg-sky-100 text-sky-800" },
  SENDING: { label: "Sending", cls: "bg-amber-100 text-amber-800" },
  SENT: { label: "Sent", cls: "bg-emerald-100 text-emerald-800" },
  FAILED: { label: "Failed", cls: "bg-red-100 text-red-700" },
  CANCELLED: { label: "Cancelled", cls: "bg-zinc-100 text-zinc-500" },
};

const REVIEW_DELAYS = [
  { value: 20, label: "20 minutes" },
  { value: 45, label: "45 minutes" },
  { value: 60, label: "1 hour" },
  { value: 120, label: "2 hours" },
  { value: 24 * 60, label: "Next day (24 hours)" },
];

export default function PushNotificationsPage() {
  const [tab, setTab] = useState<Tab>("campaigns");
  const overview = useQuery({
    queryKey: ["push-overview"],
    queryFn: pushNotificationsClient.overview,
  });
  const o = overview.data;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-100 text-indigo-700">
          <Bell className="h-6 w-6" aria-hidden />
        </div>
        <div>
          <h1 className="text-xl font-bold text-zinc-900">Push notifications</h1>
          <p className="text-sm text-zinc-500">
            Order updates and offers, straight to your customers&rsquo; phones. Free to send.
          </p>
        </div>
      </div>

      {o && !o.webConfigured && (
        <div className="mt-5 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Browser notifications aren&rsquo;t set up on this server yet, so only app installs will receive pushes.
        </div>
      )}

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={Globe} label="Browsers" value={o?.subscribers.browsers} hint="Turned on at your online shop" />
        <Stat icon={Smartphone} label="App installs" value={o?.subscribers.apps} hint="Your own iPhone & Android app" />
        <Stat icon={Users} label="Said yes to offers" value={o?.subscribers.offers} hint="Who campaigns reach" />
        <Stat icon={Star} label="Review asks sent" value={o?.reviewsAskedLast30Days} hint="Last 30 days" />
      </div>

      <div className="mt-6 flex gap-1 border-b border-zinc-200" role="tablist">
        {(
          [
            ["campaigns", "Campaigns"],
            ["automations", "Order updates"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              "-mb-px border-b-2 px-4 py-2 text-sm font-medium",
              tab === key
                ? "border-indigo-600 text-indigo-700"
                : "border-transparent text-zinc-500 hover:text-zinc-800",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {tab === "campaigns" ? (
          <CampaignsTab brands={o?.brands ?? []} locations={o?.locations ?? []} />
        ) : (
          <AutomationsTab />
        )}
      </div>
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Bell;
  label: string;
  value: number | undefined;
  hint: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3">
      <div className="flex items-center gap-1.5 text-xs text-zinc-500">
        <Icon className="h-3.5 w-3.5" aria-hidden /> {label}
      </div>
      <div className="mt-1 text-xl font-bold tabular-nums text-zinc-900">
        {value === undefined ? "—" : value.toLocaleString()}
      </div>
      <div className="mt-0.5 text-[11px] text-zinc-400">{hint}</div>
    </div>
  );
}

// ── Campaigns ───────────────────────────────────────────────────────────────

function CampaignsTab({
  brands,
  locations,
}: {
  brands: { id: string; name: string }[];
  locations: { id: string; name: string }[];
}) {
  const [editing, setEditing] = useState<PushCampaign | "new" | null>(null);
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["push-campaigns"],
    queryFn: pushNotificationsClient.campaigns,
    // Watch a send progress without a reload.
    refetchInterval: (q) =>
      q.state.data?.some((c) => c.status === "SENDING" || c.status === "SCHEDULED") ? 10_000 : false,
  });
  const nameOf = (c: PushCampaign) =>
    (c.locationId && locations.find((l) => l.id === c.locationId)?.name) ||
    (c.brandId && brands.find((b) => b.id === c.brandId)?.name) ||
    "All shops";

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["push-campaigns"] });
    qc.invalidateQueries({ queryKey: ["push-overview"] });
  };
  const cancel = useMutation({ mutationFn: pushNotificationsClient.cancelCampaign, onSuccess: refresh });
  const remove = useMutation({ mutationFn: pushNotificationsClient.deleteCampaign, onSuccess: refresh });

  if (editing) {
    return (
      <CampaignEditor
        campaign={editing === "new" ? null : editing}
        brands={brands}
        locations={locations}
        onDone={() => {
          setEditing(null);
          refresh();
        }}
      />
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-zinc-500">
          A message to everyone who said yes to offers. Keep it to the odd one a week — too many and people turn
          notifications off.
        </p>
        <button
          onClick={() => setEditing("new")}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700"
        >
          <Plus className="h-4 w-4" aria-hidden /> New campaign
        </button>
      </div>

      {(cancel.error || remove.error) && (
        <p className="mt-3 text-sm text-red-600">{apiErrorMessage(cancel.error ?? remove.error)}</p>
      )}

      <div className="mt-4 overflow-hidden rounded-xl border border-zinc-200 bg-white">
        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-zinc-400">
            <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading" />
          </div>
        ) : error ? (
          <p className="px-4 py-10 text-center text-sm text-red-600">{apiErrorMessage(error)}</p>
        ) : !data?.length ? (
          <div className="px-4 py-12 text-center">
            <Send className="mx-auto h-8 w-8 text-zinc-300" aria-hidden />
            <p className="mt-2 text-sm font-medium text-zinc-700">No campaigns yet</p>
            <p className="text-sm text-zinc-500">Tell your regulars about a new dish or tonight&rsquo;s offer.</p>
          </div>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {data.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-semibold text-zinc-900">{c.title}</span>
                    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", STATUS[c.status].cls)}>
                      {STATUS[c.status].label}
                    </span>
                  </div>
                  <p className="truncate text-sm text-zinc-500">{c.body}</p>
                  <p className="mt-0.5 text-xs text-zinc-400">
                    {nameOf(c)}
                    {c.status === "SCHEDULED" && c.scheduledFor && ` · goes out ${formatWhen(c.scheduledFor)}`}
                    {c.sentAt && ` · sent ${formatWhen(c.sentAt)}`}
                  </p>
                </div>
                {(c.status === "SENT" || c.status === "SENDING" || c.status === "FAILED") && (
                  <div className="text-right text-sm tabular-nums">
                    <div className="font-semibold text-zinc-900">
                      {c.delivered.toLocaleString()} / {c.targeted.toLocaleString()}
                    </div>
                    <div className="text-xs text-zinc-400">delivered</div>
                  </div>
                )}
                <div className="flex items-center gap-1">
                  {(c.status === "DRAFT" || c.status === "SCHEDULED") && (
                    <IconButton label="Edit" onClick={() => setEditing(c)}>
                      <Pencil className="h-4 w-4" />
                    </IconButton>
                  )}
                  {c.status === "SCHEDULED" && (
                    <IconButton label="Cancel schedule" onClick={() => cancel.mutate(c.id)}>
                      <X className="h-4 w-4" />
                    </IconButton>
                  )}
                  {c.status === "DRAFT" && (
                    <IconButton label="Delete draft" onClick={() => remove.mutate(c.id)}>
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500"
    >
      {children}
    </button>
  );
}

function CampaignEditor({
  campaign,
  brands,
  locations,
  onDone,
}: {
  campaign: PushCampaign | null;
  brands: { id: string; name: string }[];
  locations: { id: string; name: string }[];
  onDone: () => void;
}) {
  const [title, setTitle] = useState(campaign?.title ?? "");
  const [body, setBody] = useState(campaign?.body ?? "");
  // One picker for "who": everyone, one brand, or one shop.
  const [target, setTarget] = useState(
    campaign?.locationId ? `l:${campaign.locationId}` : campaign?.brandId ? `b:${campaign.brandId}` : "",
  );
  const [when, setWhen] = useState<"now" | "later">(campaign?.scheduledFor ? "later" : "now");
  const [at, setAt] = useState(campaign?.scheduledFor ? toLocalInput(campaign.scheduledFor) : defaultLater());
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const locationId = target.startsWith("l:") ? target.slice(2) : null;
  const brandId = target.startsWith("b:") ? target.slice(2) : null;

  const audience = useQuery({
    queryKey: ["push-audience", locationId, brandId],
    queryFn: () => pushNotificationsClient.audience({ locationId, brandId }),
  });
  const reach = audience.data?.total ?? 0;

  // Any edit means the confirm the operator saw is out of date.
  useEffect(() => setConfirming(false), [title, body, target, when, at]);

  const save = useMutation({
    mutationFn: async (mode: "draft" | "send") => {
      const input = { title: title.trim(), body: body.trim(), locationId, brandId };
      const saved = campaign
        ? await pushNotificationsClient.updateCampaign(campaign.id, input)
        : await pushNotificationsClient.createCampaign(input);
      if (mode === "send") {
        await pushNotificationsClient.sendCampaign(
          saved.id,
          when === "later" ? new Date(at).toISOString() : null,
        );
      }
    },
    onSuccess: onDone,
    onError: (e) => {
      setConfirming(false);
      setErr(apiErrorMessage(e, "Couldn't save the campaign"));
    },
  });

  const valid = title.trim().length > 0 && body.trim().length > 0;
  const shopLabel =
    (locationId && locations.find((l) => l.id === locationId)?.name) ||
    (brandId && brands.find((b) => b.id === brandId)?.name) ||
    "Your shop";

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <form
        className="space-y-5 rounded-xl border border-zinc-200 bg-white p-5"
        onSubmit={(e) => {
          e.preventDefault();
          setErr(null);
          if (!confirming) setConfirming(true);
          else save.mutate("send");
        }}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-zinc-900">{campaign ? "Edit campaign" : "New campaign"}</h2>
          <button type="button" onClick={onDone} className="text-sm text-zinc-500 hover:text-zinc-800">
            Back
          </button>
        </div>

        <Field label="Title" count={title.length} max={PUSH_TITLE_MAX}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={PUSH_TITLE_MAX}
            placeholder="2 for 1 pizzas tonight 🍕"
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
          />
        </Field>

        <Field label="Message" count={body.length} max={PUSH_BODY_MAX}>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={PUSH_BODY_MAX}
            rows={3}
            placeholder="Order any large pizza before 9pm and get a second one free."
            className="w-full resize-none rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
          />
        </Field>

        <label className="block">
          <span className="text-sm font-medium text-zinc-800">Send to</span>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
          >
            <option value="">Customers of all my shops</option>
            {brands.length > 1 && (
              <optgroup label="One brand">
                {brands.map((b) => (
                  <option key={b.id} value={`b:${b.id}`}>
                    {b.name}
                  </option>
                ))}
              </optgroup>
            )}
            {locations.length > 1 && (
              <optgroup label="One shop">
                {locations.map((l) => (
                  <option key={l.id} value={`l:${l.id}`}>
                    {l.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <span className="mt-1 block text-xs text-zinc-500" aria-live="polite">
            {audience.isLoading
              ? "Counting…"
              : `${reach.toLocaleString()} ${reach === 1 ? "phone" : "phones"} said yes to offers (${(audience.data?.browsers ?? 0).toLocaleString()} browser, ${(audience.data?.apps ?? 0).toLocaleString()} app)`}
          </span>
        </label>

        <fieldset>
          <legend className="text-sm font-medium text-zinc-800">When</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {(
              [
                ["now", "Send now", Send],
                ["later", "Schedule", CalendarClock],
              ] as const
            ).map(([value, label, Icon]) => (
              <label
                key={value}
                className={cn(
                  "flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-2 text-sm",
                  when === value ? "border-indigo-500 bg-indigo-50 text-indigo-800" : "border-zinc-300 text-zinc-700",
                )}
              >
                <input
                  type="radio"
                  name="when"
                  value={value}
                  checked={when === value}
                  onChange={() => setWhen(value)}
                  className="sr-only"
                />
                <Icon className="h-4 w-4" aria-hidden /> {label}
              </label>
            ))}
            {when === "later" && (
              <input
                type="datetime-local"
                value={at}
                onChange={(e) => setAt(e.target.value)}
                aria-label="Send at"
                className="rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
              />
            )}
          </div>
        </fieldset>

        {err && <p className="text-sm text-red-600">{err}</p>}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-100 pt-4">
          <button
            type="button"
            disabled={!valid || save.isPending}
            onClick={() => {
              setErr(null);
              save.mutate("draft");
            }}
            className="rounded-lg border border-zinc-300 px-3.5 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            Save draft
          </button>
          <button
            type="submit"
            disabled={!valid || save.isPending || reach === 0}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold text-white shadow-sm disabled:opacity-50",
              confirming ? "bg-emerald-600 hover:bg-emerald-700" : "bg-indigo-600 hover:bg-indigo-700",
            )}
          >
            {save.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : confirming ? (
              <Check className="h-4 w-4" aria-hidden />
            ) : (
              <Send className="h-4 w-4" aria-hidden />
            )}
            {confirming
              ? when === "now"
                ? `Yes, send to ${reach.toLocaleString()}`
                : `Yes, schedule for ${reach.toLocaleString()}`
              : when === "now"
                ? "Send"
                : "Schedule"}
          </button>
        </div>
        {confirming && (
          <p className="text-right text-xs text-zinc-500">
            Pushes can&rsquo;t be taken back once sent. Press again to confirm.
          </p>
        )}
      </form>

      <PhonePreview shop={shopLabel} title={title || "Your title"} body={body || "Your message"} />
    </div>
  );
}

function Field({
  label,
  count,
  max,
  children,
}: {
  label: string;
  count: number;
  max: number;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="flex items-center justify-between text-sm font-medium text-zinc-800">
        {label}
        <span className={cn("text-xs tabular-nums", count > max * 0.9 ? "text-amber-600" : "text-zinc-400")}>
          {count}/{max}
        </span>
      </span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

/** Roughly what the lock screen shows, so the operator sees where the title
 *  gets cut off before a thousand customers do. */
function PhonePreview({ shop, title, body }: { shop: string; title: string; body: string }) {
  return (
    <div className="self-start rounded-[2rem] border border-zinc-200 bg-gradient-to-b from-indigo-900 to-zinc-900 p-4 shadow-sm">
      <p className="text-center text-4xl font-light tabular-nums text-white/90">9:41</p>
      <p className="mb-5 text-center text-xs text-white/60">Lock screen preview</p>
      <div className="rounded-2xl bg-white/85 p-3 backdrop-blur">
        <div className="flex items-center gap-2 text-[11px] text-zinc-500">
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-indigo-600 text-white">
            <Bell className="h-3 w-3" aria-hidden />
          </span>
          <span className="truncate font-medium uppercase tracking-wide">{shop}</span>
          <span className="ml-auto">now</span>
        </div>
        <p className="mt-1.5 line-clamp-1 text-sm font-semibold text-zinc-900">{title}</p>
        <p className="line-clamp-4 text-sm text-zinc-700">{body}</p>
      </div>
    </div>
  );
}

// ── Order updates ───────────────────────────────────────────────────────────

function AutomationsTab() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["push-automations"],
    queryFn: pushNotificationsClient.automations,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-zinc-400">
        <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading" />
      </div>
    );
  }
  if (error) return <p className="py-10 text-center text-sm text-red-600">{apiErrorMessage(error)}</p>;

  return (
    <div>
      <p className="text-sm text-zinc-500">
        Sent automatically to customers who turned on notifications for their order. Use{" "}
        <code className="rounded bg-zinc-100 px-1">{"{order}"}</code> for the order number and{" "}
        <code className="rounded bg-zinc-100 px-1">{"{shop}"}</code> for your shop&rsquo;s name. Leave a box empty to
        use our wording.
      </p>
      <ul className="mt-4 space-y-3">
        {data?.map((a) => <AutomationRow key={a.trigger} automation={a} />)}
      </ul>
      <LocationReviews business={data?.find((a) => a.trigger === "REVIEW_REQUEST") ?? null} />
    </div>
  );
}

// ── Review ask, per shop ────────────────────────────────────────────────────

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

function delayLabel(minutes: number): string {
  return REVIEW_DELAYS.find((d) => d.value === minutes)?.label ?? `${minutes} minutes`;
}

/** "45 minutes after · 11:00–21:00" — what a shop's setting does, in one line. */
function describeReview(own: LocationReviewSetting | null, business: PushAutomation | null): string {
  if (!own) {
    if (!business?.enabled) return "Follows your business setting · off";
    return `Follows your business setting · ${delayLabel(business.delayMinutes ?? 45)} after`;
  }
  if (!own.enabled) return "Off for this shop";
  const delay = own.delayMinutes ?? business?.delayMinutes ?? 45;
  const hours =
    own.sendFromHour != null && own.sendUntilHour != null
      ? ` · only ${hourLabel(own.sendFromHour)}–${hourLabel(own.sendUntilHour)}`
      : "";
  return `${delayLabel(delay)} after${hours}`;
}

function LocationReviews({ business }: { business: PushAutomation | null }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["push-location-reviews"],
    queryFn: pushNotificationsClient.locationReviews,
  });
  if (error) return <p className="mt-6 text-sm text-red-600">{apiErrorMessage(error)}</p>;
  if (isLoading || !data?.length) return null;

  return (
    <section className="mt-8" aria-labelledby="review-by-shop">
      <h2 id="review-by-shop" className="flex items-center gap-2 text-base font-semibold text-zinc-900">
        <Star className="h-4 w-4 text-amber-500" aria-hidden /> Review ask by shop
      </h2>
      <p className="mt-1 text-sm text-zinc-500">
        Give a shop its own timing, sending hours and wording for &ldquo;Leave a review&rdquo;. Asks that fall outside
        a shop&rsquo;s sending hours wait until they open, in the shop&rsquo;s own time.
      </p>
      <ul className="mt-3 space-y-2">
        {data.map((l) => (
          <LocationReviewRow key={l.locationId} location={l} business={business} />
        ))}
      </ul>
    </section>
  );
}

function LocationReviewRow({ location, business }: { location: LocationReview; business: PushAutomation | null }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const own = location.own;
  const [enabled, setEnabled] = useState(own?.enabled ?? true);
  const [delay, setDelay] = useState(own?.delayMinutes ?? business?.delayMinutes ?? 45);
  const [limitHours, setLimitHours] = useState(own?.sendFromHour != null);
  const [from, setFrom] = useState(own?.sendFromHour ?? 11);
  const [until, setUntil] = useState(own?.sendUntilHour ?? 21);
  const [title, setTitle] = useState(own?.title ?? "");
  const [body, setBody] = useState(own?.body ?? "");

  const done = (rows: LocationReview[]) => {
    qc.setQueryData(["push-location-reviews"], rows);
    setOpen(false);
  };
  const save = useMutation({
    mutationFn: () =>
      pushNotificationsClient.saveLocationReview(location.locationId, {
        enabled,
        delayMinutes: delay,
        title: title.trim() || null,
        body: body.trim() || null,
        sendFromHour: limitHours ? from : null,
        sendUntilHour: limitHours ? until : null,
      }),
    onSuccess: done,
  });
  const reset = useMutation({
    mutationFn: () => pushNotificationsClient.clearLocationReview(location.locationId),
    onSuccess: done,
  });
  const busy = save.isPending || reset.isPending;
  const delayOptions = REVIEW_DELAYS.some((d) => d.value === delay)
    ? REVIEW_DELAYS
    : [...REVIEW_DELAYS, { value: delay, label: `${delay} minutes` }];
  const selectCls =
    "mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200";

  return (
    <li className="rounded-xl border border-zinc-200 bg-white">
      <div className="flex items-center gap-3 px-4 py-3">
        <MapPin className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-zinc-900">{location.name}</span>
            {location.appInstalls > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">
                <Smartphone className="h-3 w-3" aria-hidden />
                {location.appInstalls} app {location.appInstalls === 1 ? "install" : "installs"}
              </span>
            )}
            {own && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                Own setting
              </span>
            )}
          </div>
          <p className="truncate text-sm text-zinc-500">{describeReview(own, business)}</p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-50"
        >
          {open ? "Close" : "Edit"}
        </button>
      </div>

      {open && (
        <div className="space-y-4 border-t border-zinc-100 px-4 py-4">
          <label className="flex items-center gap-2 text-sm font-medium text-zinc-800">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500"
            />
            Ask this shop&rsquo;s customers for a review
          </label>
          <div className={cn("space-y-4", !enabled && "pointer-events-none opacity-50")}>
            <label className="block">
              <span className="text-sm font-medium text-zinc-800">Send it</span>
              <select value={delay} onChange={(e) => setDelay(Number(e.target.value))} className={cn(selectCls, "sm:w-72")}>
                {delayOptions.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label} after the order completes
                  </option>
                ))}
              </select>
            </label>
            <div>
              <label className="flex items-center gap-2 text-sm font-medium text-zinc-800">
                <input
                  type="checkbox"
                  checked={limitHours}
                  onChange={(e) => setLimitHours(e.target.checked)}
                  className="h-4 w-4 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500"
                />
                Only send between certain hours
              </label>
              {limitHours && (
                <div className="mt-2 flex flex-wrap items-end gap-3">
                  <label className="block">
                    <span className="text-xs text-zinc-500">From</span>
                    <select value={from} onChange={(e) => setFrom(Number(e.target.value))} className={selectCls}>
                      {HOURS.map((h) => (
                        <option key={h} value={h}>
                          {hourLabel(h)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs text-zinc-500">Until</span>
                    <select value={until} onChange={(e) => setUntil(Number(e.target.value))} className={selectCls}>
                      {HOURS.map((h) => (
                        <option key={h} value={h}>
                          {hourLabel(h)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <span className="pb-2 text-xs text-zinc-500">{location.timezone} time</span>
                </div>
              )}
            </div>
            <Field label="Title" count={title.length} max={PUSH_TITLE_MAX}>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={PUSH_TITLE_MAX}
                placeholder={business?.title || business?.defaultTitle || ""}
                className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
              />
            </Field>
            <Field label="Message" count={body.length} max={PUSH_BODY_MAX}>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={PUSH_BODY_MAX}
                rows={2}
                placeholder={business?.body || business?.defaultBody || ""}
                className="w-full resize-none rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
              />
            </Field>
          </div>
          {(save.error || reset.error) && (
            <p className="text-sm text-red-600">{apiErrorMessage(save.error ?? reset.error)}</p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {own && (
              <button
                type="button"
                disabled={busy}
                onClick={() => reset.mutate()}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
              >
                Follow business setting
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => save.mutate()}
              className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {save.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              Save for this shop
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function AutomationRow({ automation }: { automation: PushAutomation }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(automation.title ?? "");
  const [body, setBody] = useState(automation.body ?? "");
  const [delay, setDelay] = useState(automation.delayMinutes ?? 45);
  const isReview = automation.trigger === "REVIEW_REQUEST";
  const meta = TRIGGER_LABEL[automation.trigger];

  const save = useMutation({
    mutationFn: (enabled: boolean) =>
      pushNotificationsClient.saveAutomation(automation.trigger, {
        enabled,
        title: title.trim() || null,
        body: body.trim() || null,
        delayMinutes: isReview ? delay : null,
      }),
    onSuccess: (rows) => {
      qc.setQueryData(["push-automations"], rows);
      setOpen(false);
    },
  });

  const delayOptions = useMemo(
    () =>
      REVIEW_DELAYS.some((d) => d.value === delay)
        ? REVIEW_DELAYS
        : [...REVIEW_DELAYS, { value: delay, label: `${delay} minutes` }],
    [delay],
  );

  return (
    <li className="rounded-xl border border-zinc-200 bg-white">
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          role="switch"
          aria-checked={automation.enabled}
          aria-label={`${meta.label} notification`}
          disabled={save.isPending}
          onClick={() => save.mutate(!automation.enabled)}
          className={cn(
            "relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500",
            automation.enabled ? "bg-indigo-600" : "bg-zinc-300",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform",
              automation.enabled ? "translate-x-[22px]" : "translate-x-0.5",
            )}
          />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-zinc-900">{meta.label}</span>
            {isReview && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                {automation.delayMinutes} min after
              </span>
            )}
          </div>
          <p className="truncate text-sm text-zinc-500">
            {automation.preview ? (
              <>
                <span className="font-medium text-zinc-700">{automation.preview.title}</span> —{" "}
                {automation.preview.body}
              </>
            ) : (
              meta.hint
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-50"
        >
          {open ? "Close" : "Edit"}
        </button>
      </div>

      {open && (
        <div className="space-y-4 border-t border-zinc-100 px-4 py-4">
          <Field label="Title" count={title.length} max={PUSH_TITLE_MAX}>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={PUSH_TITLE_MAX}
              placeholder={automation.defaultTitle}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
            />
          </Field>
          <Field label="Message" count={body.length} max={PUSH_BODY_MAX}>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={PUSH_BODY_MAX}
              rows={2}
              placeholder={automation.defaultBody}
              className="w-full resize-none rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
            />
          </Field>
          {isReview && (
            <label className="block">
              <span className="text-sm font-medium text-zinc-800">Send it</span>
              <select
                value={delay}
                onChange={(e) => setDelay(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 sm:w-64"
              >
                {delayOptions.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label} after the order completes
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-zinc-500">
                Tapping it opens their order with a star rating. Customers who already left a review aren&rsquo;t
                asked.
              </span>
            </label>
          )}
          {save.error && <p className="text-sm text-red-600">{apiErrorMessage(save.error)}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setTitle("");
                setBody("");
              }}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
            >
              Use our wording
            </button>
            <button
              type="button"
              disabled={save.isPending}
              onClick={() => save.mutate(isReview && !automation.enabled ? true : automation.enabled)}
              className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {save.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {isReview && !automation.enabled ? "Save and turn on" : "Save"}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

// ── Dates ───────────────────────────────────────────────────────────────────

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** <input type="datetime-local"> wants local time without a zone. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Tomorrow at 5pm — the slot most takeaway offers go out in. */
function defaultLater(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(17, 0, 0, 0);
  return toLocalInput(d.toISOString());
}
