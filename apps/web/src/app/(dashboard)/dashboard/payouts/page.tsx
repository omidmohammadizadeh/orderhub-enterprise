'use client';

// "Where's my money, and which bank does it go to?"
//
// The Payments page answers an accountant's questions — ledger, fees, daily
// reconciliation. This one answers the owner's: what has Stripe paid me, what
// is on its way, and how do I change the account it lands in. It is deliberately
// a separate page with a plain name, because that is what someone hunts for.
//
// Bank details are not edited here. Our Connect accounts are Express, so the
// owner is sent to Stripe's own dashboard through a one-time link — no account
// number ever passes through OrderHub.

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  Banknote,
  Building2 as BankIcon,
  CalendarClock,
  Building2,
  ExternalLink,
  Loader2,
  AlertTriangle,
  ChevronRight,
} from 'lucide-react';
import toast from 'react-hot-toast';
import {
  payoutsClient,
  type PayoutRow,
  type PayoutSchedule,
} from '@/lib/api/payouts.client';
import { loadConnectAndInitialize } from '@stripe/connect-js';
import {
  ConnectAccountManagement,
  ConnectComponentsProvider,
  ConnectNotificationBanner,
} from '@stripe/react-connect-js';
import { cn } from '@/lib/utils';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { useSelectedLocationStore } from '@/stores/selected-location.store';

const STATUS: Record<string, { label: string; className: string }> = {
  PAID: { label: 'Paid', className: 'text-emerald-700 bg-emerald-100' },
  IN_TRANSIT: { label: 'On its way', className: 'text-blue-700 bg-blue-100' },
  PENDING: { label: 'Pending', className: 'text-amber-700 bg-amber-100' },
  FAILED: { label: 'Failed', className: 'text-red-700 bg-red-100' },
  CANCELLED: { label: 'Cancelled', className: 'text-zinc-600 bg-zinc-100' },
};

const money = (n: number, ccy = 'gbp') =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: ccy.toUpperCase(),
  }).format(n);

const day = (d: string) =>
  new Date(d).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

export default function PayoutsPage() {
  // The sidebar's shop scope. Every other tab reads this; payouts did not,
  // so an owner scoped to one shop was still shown every shop's money.
  const { selectedLocationId } = useSelectedLocationStore();
  const [accountId, setAccountId] = useState<string | undefined>();
  // Which payout is showing its breakdown. One at a time — this is a
  // "what made up THIS one" question, not a comparison.
  const [openPayout, setOpenPayout] = useState<string | null>(null);
  // Shown when the button is pressed with more than one shop in view: which
  // shop's bank details? Telling someone to "choose a shop" without giving
  // them anything to choose from is just a closed door with a label.
  const [pickingShop, setPickingShop] = useState(false);

  const listQuery = useQuery({
    queryKey: ['payouts', accountId ?? 'all', selectedLocationId ?? 'all'],
    queryFn: () => payoutsClient.list(accountId, selectedLocationId ?? undefined),
  });

  const accounts = listQuery.data?.accounts ?? [];
  // The balance is per-account, so it only means something once one is chosen
  // (or when there is only one to choose).
  const balanceAccountId = accountId ?? (accounts.length === 1 ? accounts[0]!.id : undefined);

  const balanceQuery = useQuery({
    queryKey: ['payout-balance', balanceAccountId, selectedLocationId ?? 'all'],
    queryFn: () => payoutsClient.balance(balanceAccountId, selectedLocationId ?? undefined),
    enabled: !!balanceAccountId,
  });

  const dashboard = useMutation({
    // Takes the account explicitly so the shop chooser below can name one
    // without first changing the whole page's filter.
    mutationFn: (id?: string) =>
      payoutsClient.dashboardLink(id ?? balanceAccountId, selectedLocationId ?? undefined),
    onSuccess: ({ url, kind, message }) => {
      if (kind === 'EXTERNAL') {
        // Their own Stripe account. Not a failure — don't dress it as one.
        toast(message ?? 'Opening Stripe.', { icon: '🔗', duration: 6000 });
      }
      if (kind === 'ONBOARDING') {
        // This account never finished Stripe setup, so there's no dashboard to
        // open yet. Say so before the tab appears, or the owner lands on a
        // form they weren't expecting.
        toast('Finishing Stripe setup first — add your bank details there.', {
          icon: '🏦',
        });
      } else if (kind === 'ACCOUNT_UPDATE') {
        // No Stripe dashboard on this account, so they get the hosted update
        // form. It edits bank details but has no statements, hence the
        // narrower promise than the button makes.
        toast('Opening your Stripe details form to update bank details.', {
          icon: '🏦',
        });
      }
      // Single-use link — open it straight away rather than rendering it.
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? "Couldn't open your Stripe dashboard"),
  });

  const payouts = listQuery.data?.payouts ?? [];
  const balance = balanceQuery.data;
  // A Standard account belongs to the merchant, not to us — say so plainly
  // rather than letting them find out by pressing a button that can't work.
  const ownStripe = accounts.find((a) => a.id === balanceAccountId)?.dashboardType === 'full';
  // Several shops and none picked. The backend would fall back to the first
  // account, which is the one thing we must not do here: it would open some
  // other shop's bank details.
  const mustPickShop = !balanceAccountId && accounts.length > 1;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">Payouts</h1>
          <p className="mt-0.5 text-sm text-zinc-500">
            Money Stripe has sent to your bank, and where it lands.
          </p>
        </div>
        <div className="relative flex-shrink-0">
          <button
            onClick={() => {
              // A Stripe link is per shop, and with several to choose from we
              // must not guess which bank account the owner meant. Offer the
              // choice here rather than sending them back to the filter.
              if (mustPickShop) {
                setPickingShop((v) => !v);
                return;
              }
              dashboard.mutate(undefined);
            }}
            // Only ever disabled while a link is being minted or before we know
            // of any account at all. It used to also require a SELECTED shop,
            // which greyed the button out permanently for every operator with
            // more than one — the whole page defaults to "All shops" — and left
            // them no way to reach Stripe to change their bank details.
            disabled={dashboard.isPending || accounts.length === 0}
            title={
              accounts.length === 0
                ? 'No Stripe account is connected yet.'
                : mustPickShop
                  ? 'Choose a shop — bank details are held per shop.'
                  : undefined
            }
            className="flex flex-shrink-0 items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {dashboard.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Building2 className="h-4 w-4" />
            )}
            {/* Once we know it's the merchant's own Stripe, promise less: this
              button can only send them to the sign-in page. */}
            {ownStripe ? 'Open Stripe' : 'Bank details & statements'}
          </button>

          {/* Which shop's bank account. Each row is a separate Stripe account,
            so this is a real question — but one click answers it. */}
          {pickingShop && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setPickingShop(false)} />
              <div className="absolute right-0 z-20 mt-2 w-64 overflow-hidden rounded-lg border border-zinc-200 bg-white py-1 shadow-lg">
                <p className="px-3 py-1.5 text-xs text-zinc-500">Which shop&apos;s bank details?</p>
                {accounts.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => {
                      setPickingShop(false);
                      dashboard.mutate(a.id);
                    }}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-50"
                  >
                    <span className="truncate">{a.label}</span>
                    <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-zinc-300" />
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Shop picker — only earns its space with more than one. A dozen shops
          as chips wraps over two lines and forces you to read every label;
          this stays one control and lets you type the name. */}
      {accounts.length > 1 && (
        <div className="flex items-center gap-2">
          <SearchableSelect
            className="w-64"
            allLabel="All shops"
            placeholder="All shops"
            searchPlaceholder="Search shops…"
            emptyLabel="No shop by that name"
            value={accountId}
            onChange={(v) => {
              setAccountId(v);
              // The open breakdown belongs to a payout that may not exist in
              // the new selection.
              setOpenPayout(null);
            }}
            options={accounts.map((a) => ({ value: a.id, label: a.label }))}
          />
          <span className="text-xs text-zinc-400">{accounts.length} shops</span>
        </div>
      )}

      {/* Balance. Hidden entirely on "All" — summing several shops' balances
          into one number would be a figure that matches nothing. */}
      {balanceAccountId &&
        (balance?.unavailableReason ? (
          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>
              Balance unavailable right now — {balance.unavailableReason} Your payout history below
              is unaffected.
            </span>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[
              {
                label: 'On its way to your bank',
                value: balance?.inTransit,
                hint: balance?.nextPayout?.arrivalDate
                  ? `Arrives ${day(balance.nextPayout.arrivalDate)}`
                  : undefined,
                accent: 'text-blue-700',
              },
              {
                label: 'Available',
                value: balance?.available,
                hint: 'Ready for the next payout',
                accent: 'text-emerald-700',
              },
              {
                label: 'Pending',
                value: balance?.pending,
                hint: 'Still clearing at Stripe',
                accent: 'text-zinc-900',
              },
            ].map((c) => (
              <div key={c.label} className="rounded-xl border border-zinc-200 bg-white p-4">
                <div className="text-xs text-zinc-500">{c.label}</div>
                <div className={cn('mt-1 text-2xl font-bold tabular-nums', c.accent)}>
                  {balanceQuery.isLoading || c.value == null ? (
                    <span className="text-zinc-300">—</span>
                  ) : (
                    money(c.value, balance?.currency)
                  )}
                </div>
                {c.hint && <div className="mt-0.5 text-[11px] text-zinc-400">{c.hint}</div>}
              </div>
            ))}
          </div>
        ))}

      {/* When the money lands. Hidden for a merchant on their own Stripe
          account: we don't control that account's schedule, so offering to
          change it would be a button that always fails. */}
      {!!accounts.length && !ownStripe && (
        <PayoutScheduleCard
          accountId={balanceAccountId}
          locationId={selectedLocationId ?? undefined}
          // With several shops in scope and none picked, we can show a day but
          // must not change one — it would be a shop the owner never named.
          needsShopChoice={!balanceAccountId}
        />
      )}

      {/* Bank account, edited inside Stripe's own panel. Same gates as the
          payout day: not for a merchant on their own Stripe account, and never
          for an unnamed shop. */}
      {!!accounts.length && !ownStripe && (
        <BankAccountCard
          accountId={balanceAccountId}
          locationId={selectedLocationId ?? undefined}
          needsShopChoice={!balanceAccountId}
        />
      )}

      {/* History */}
      <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
        <div className="flex items-center gap-2 border-b border-zinc-100 px-5 py-4">
          <Banknote className="h-5 w-5 text-purple-500" />
          <h2 className="font-medium text-zinc-900">Payout history</h2>
        </div>

        {listQuery.isLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
          </div>
        ) : !accounts.length ? (
          <EmptyState
            title="No payout account set up yet"
            body="Once this location finishes Stripe onboarding, payouts will appear here."
          />
        ) : !payouts.length ? (
          <EmptyState
            title="No payouts yet"
            body="Stripe pays out on a schedule once you start taking card payments. The first one will show here automatically."
          />
        ) : (
          <div className="divide-y divide-zinc-50">
            {payouts.map((p) => (
              <PayoutLine
                key={p.id}
                p={p}
                showAccount={!accountId && accounts.length > 1}
                expanded={openPayout === p.stripePayoutId}
                onToggle={() =>
                  setOpenPayout(openPayout === p.stripePayoutId ? null : p.stripePayoutId)
                }
              />
            ))}
          </div>
        )}
      </div>

      <p className="flex items-center gap-1.5 px-1 text-xs text-zinc-400">
        <ExternalLink className="h-3 w-3" />
        {ownStripe
          ? 'This location uses its own Stripe account — sign in there to change its bank details.'
          : 'Bank details are held and verified by Stripe, not by OrderHub.'}
      </p>
    </div>
  );
}

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const;

/** "friday" → "Friday". */
const titleCase = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

const ordinal = (n: number) => {
  const suffix =
    n % 100 >= 11 && n % 100 <= 13
      ? 'th'
      : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
};

/** The current schedule in the words an owner would use. */
function describeSchedule(s: PayoutSchedule | null | undefined): string {
  if (!s) return '';
  if (s.interval === 'daily') return 'Every working day';
  if (s.interval === 'weekly' && s.weeklyAnchor)
    return `Every ${titleCase(s.weeklyAnchor)}`;
  if (s.interval === 'monthly' && s.monthlyAnchor)
    return `Monthly, on the ${ordinal(s.monthlyAnchor)}`;
  if (s.interval === 'manual') return 'Held at Stripe until released by hand';
  return s.interval;
}

/**
 * "Can I be paid on a Friday instead?" — the question this page gets asked
 * most, and the one it could not answer until now.
 *
 * Only the DAY is editable. The bank account itself still lives behind the
 * Stripe button above, so no account number passes through OrderHub.
 */
function PayoutScheduleCard({
  accountId,
  locationId,
  needsShopChoice,
}: {
  accountId?: string;
  locationId?: string;
  needsShopChoice: boolean;
}) {
  const scheduleQuery = useQuery({
    queryKey: ['payout-schedule', accountId ?? 'default', locationId ?? 'all'],
    queryFn: () => payoutsClient.schedule(accountId, locationId),
  });
  const current = scheduleQuery.data;

  const [cadence, setCadence] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [weekday, setWeekday] = useState<string>('friday');
  const [monthDay, setMonthDay] = useState<number>(1);

  // Start from what Stripe actually has, so the form never proposes a change
  // the owner didn't ask for.
  useEffect(() => {
    if (!current) return;
    if (current.interval === 'weekly' || current.interval === 'monthly' || current.interval === 'daily') {
      setCadence(current.interval);
    }
    if (current.weeklyAnchor) setWeekday(current.weeklyAnchor);
    if (current.monthlyAnchor) setMonthDay(current.monthlyAnchor);
  }, [current]);

  const save = useMutation({
    mutationFn: () =>
      payoutsClient.updateSchedule({
        accountId,
        locationId,
        interval: cadence,
        weeklyAnchor: cadence === 'weekly' ? weekday : undefined,
        monthlyAnchor: cadence === 'monthly' ? monthDay : undefined,
      }),
    onSuccess: (s) => {
      toast.success(`Payouts: ${describeSchedule(s).toLowerCase()}`);
      scheduleQuery.refetch();
    },
    onError: (e: any) =>
      toast.error(
        e?.response?.data?.message ?? "Stripe wouldn't accept that payout day.",
      ),
  });

  // Nothing to show when Stripe can't tell us the current schedule — better a
  // missing card than a control that claims a day we haven't verified.
  if (scheduleQuery.isLoading || current == null) return null;

  const unchanged =
    cadence === current.interval &&
    (cadence !== 'weekly' || weekday === current.weeklyAnchor) &&
    (cadence !== 'monthly' || monthDay === current.monthlyAnchor);

  const selectClass =
    'rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-800 focus:border-zinc-400 focus:outline-none';

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-5 py-4">
        <CalendarClock className="h-5 w-5 text-purple-500" />
        <h2 className="font-medium text-zinc-900">When you get paid</h2>
        <span className="ml-auto text-xs text-zinc-500">
          {current.accountLabel} · {describeSchedule(current)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-5 py-4">
        <select
          value={cadence}
          onChange={(e) => setCadence(e.target.value as typeof cadence)}
          className={selectClass}
          aria-label="How often you are paid"
        >
          <option value="daily">Every working day</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
        </select>

        {cadence === 'weekly' && (
          <select
            value={weekday}
            onChange={(e) => setWeekday(e.target.value)}
            className={selectClass}
            aria-label="Day of the week"
          >
            {WEEKDAYS.map((d) => (
              <option key={d} value={d}>
                {titleCase(d)}
              </option>
            ))}
          </select>
        )}

        {cadence === 'monthly' && (
          <select
            value={monthDay}
            onChange={(e) => setMonthDay(Number(e.target.value))}
            className={selectClass}
            aria-label="Day of the month"
          >
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {ordinal(d)}
              </option>
            ))}
          </select>
        )}

        <button
          onClick={() => save.mutate()}
          disabled={unchanged || save.isPending || needsShopChoice}
          title={
            needsShopChoice
              ? 'Choose a shop above — payout days are set per shop.'
              : undefined
          }
          className={cn(
            'rounded-lg px-3 py-1.5 text-sm font-medium transition',
            unchanged || save.isPending || needsShopChoice
              ? 'bg-zinc-100 text-zinc-400'
              : 'bg-zinc-900 text-white hover:bg-zinc-800',
          )}
        >
          {save.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            'Save'
          )}
        </button>
      </div>

      <p className="px-5 pb-4 text-xs text-zinc-400">
        {needsShopChoice
          ? `Showing ${current.accountLabel}. Choose a shop above to change its payout day — each shop has its own.`
          : cadence === 'monthly' && monthDay > 28
            ? 'In shorter months this is paid on the last day.'
            : 'Payouts settle on working days, so a day that falls on a weekend or bank holiday lands the next working day.'}
      </p>
    </div>
  );
}

const STRIPE_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';

/**
 * Change the bank account, without leaving the dashboard.
 *
 * The panel is Stripe's own, rendered through an AccountSession. That is the
 * whole point: the sort code and account number go from the owner straight to
 * Stripe, so OrderHub never holds them — the same promise this page has always
 * made, now kept without sending anyone to another website.
 */
function BankAccountCard({
  accountId,
  locationId,
  needsShopChoice,
}: {
  accountId?: string;
  locationId?: string;
  needsShopChoice: boolean;
}) {
  const [open, setOpen] = useState(false);

  // Shares a cache key with the schedule card, so naming the shop here costs
  // no extra request.
  const scheduleQuery = useQuery({
    queryKey: ['payout-schedule', accountId ?? 'default', locationId ?? 'all'],
    queryFn: () => payoutsClient.schedule(accountId, locationId),
  });

  // Memoised: Stripe charges a round-trip for every init, and React would
  // otherwise re-init on each render.
  const connectInstance = useMemo(() => {
    if (!open || !STRIPE_PUBLISHABLE_KEY) return null;
    return loadConnectAndInitialize({
      publishableKey: STRIPE_PUBLISHABLE_KEY,
      fetchClientSecret: async () => {
        const { clientSecret } = await payoutsClient.managementSession(
          accountId,
          locationId,
        );
        return clientSecret;
      },
      appearance: {
        overlays: 'dialog',
        variables: {
          colorPrimary: '#18181b',
          colorBackground: '#ffffff',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          borderRadius: '8px',
        },
      },
    });
  }, [open, accountId, locationId]);

  if (!STRIPE_PUBLISHABLE_KEY) return null;

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-5 py-4">
        <BankIcon className="h-5 w-5 text-purple-500" />
        <h2 className="font-medium text-zinc-900">Bank account</h2>
        {scheduleQuery.data?.accountLabel && (
          <span className="text-xs text-zinc-500">
            {scheduleQuery.data.accountLabel}
          </span>
        )}
        <button
          onClick={() => setOpen((v) => !v)}
          disabled={needsShopChoice}
          title={
            needsShopChoice
              ? 'Choose a shop above — bank details are held per shop.'
              : undefined
          }
          className={cn(
            'ml-auto rounded-lg px-3 py-1.5 text-sm font-medium transition',
            needsShopChoice
              ? 'bg-zinc-100 text-zinc-400'
              : 'bg-zinc-900 text-white hover:bg-zinc-800',
          )}
        >
          {open ? 'Close' : 'Change bank details'}
        </button>
      </div>

      {open && connectInstance ? (
        <div className="px-5 py-4">
          <ConnectComponentsProvider connectInstance={connectInstance}>
            <div className="space-y-2">
              <ConnectNotificationBanner />
              <ConnectAccountManagement />
            </div>
          </ConnectComponentsProvider>
        </div>
      ) : (
        <p className="px-5 py-4 text-xs text-zinc-400">
          Your bank details are held and verified by Stripe. Editing them here
          opens Stripe&apos;s own secure panel — the account number never passes
          through OrderHub.
        </p>
      )}
    </div>
  );
}

function PayoutLine({
  p,
  showAccount,
  expanded,
  onToggle,
}: {
  p: PayoutRow;
  showAccount: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const s = STATUS[p.status] ?? {
    label: p.status,
    className: 'bg-zinc-100 text-zinc-600',
  };
  return (
    <div>
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left hover:bg-zinc-50"
      >
        <div className="flex min-w-0 items-center gap-2">
          <ChevronRight
            className={cn(
              'h-4 w-4 flex-shrink-0 text-zinc-400 transition-transform',
              expanded && 'rotate-90',
            )}
          />
          <div className="min-w-0">
            <div className="text-sm font-semibold tabular-nums text-zinc-900">
              {money(parseFloat(p.amount), p.currency)}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500">
              {showAccount && p.accountLabel && (
                <span className="font-medium text-zinc-600">{p.accountLabel}</span>
              )}
              <span>
                {p.arrivalDate
                  ? `${p.status === 'PAID' ? 'Paid' : 'Arrives'} ${day(p.arrivalDate)}`
                  : day(p.createdAt)}
              </span>
            </div>
          </div>
        </div>
        <span
          className={cn('flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-medium', s.className)}
        >
          {s.label}
        </span>
      </button>
      {expanded && <PayoutBreakdownPanel payoutId={p.stripePayoutId} accountId={p.accountId} />}
    </div>
  );
}

/**
 * What this payout was made of. Fetched on expand rather than up front —
 * it's a Stripe round-trip per payout, and most rows are never opened.
 */
function PayoutBreakdownPanel({
  payoutId,
  accountId,
}: {
  payoutId: string;
  accountId: string | null;
}) {
  // Same shop scope as the list this row came from, so the two can't drift.
  const { selectedLocationId } = useSelectedLocationStore();
  const q = useQuery({
    queryKey: ['payout-breakdown', payoutId, selectedLocationId ?? 'all'],
    queryFn: () =>
      payoutsClient.breakdown(payoutId, accountId ?? undefined, selectedLocationId ?? undefined),
  });

  if (q.isLoading) {
    return (
      <div className="flex justify-center border-t border-zinc-100 bg-zinc-50/60 py-6">
        <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="border-t border-zinc-100 bg-zinc-50/60 px-5 py-4 text-xs text-zinc-500">
        Couldn&apos;t load this payout&apos;s breakdown.
      </div>
    );
  }

  const b = q.data;
  const ccy = b.currency;
  // Deductions are already negative from Stripe, so they render with their own
  // sign and the column still adds up to the payout.
  const rows: Array<{ label: string; value: number; muted?: boolean }> = [
    { label: `Sales${b.orderCount ? ` (${b.orderCount} orders)` : ''}`, value: b.sales },
    { label: 'Refunds', value: b.refunds },
    { label: 'Card processing (Stripe)', value: b.stripeFees },
    { label: 'OrderHub commission', value: b.commission },
  ];
  if (b.other) rows.push({ label: 'Other adjustments', value: b.other, muted: true });

  const orderLines = b.lines.filter((l) => l.order);

  return (
    <div className="space-y-3 border-t border-zinc-100 bg-zinc-50/60 px-5 py-4">
      <div className="space-y-1">
        {rows
          .filter((r) => r.value !== 0)
          .map((r) => (
            <div key={r.label} className="flex justify-between text-xs">
              <span className={r.muted ? 'text-zinc-400' : 'text-zinc-600'}>{r.label}</span>
              <span className={cn('tabular-nums', r.value < 0 ? 'text-red-600' : 'text-zinc-700')}>
                {money(r.value, ccy)}
              </span>
            </div>
          ))}
        <div className="flex justify-between border-t border-zinc-200 pt-1 text-xs font-semibold">
          <span className="text-zinc-800">Paid to your bank</span>
          <span className="tabular-nums text-zinc-900">{money(b.total, ccy)}</span>
        </div>
      </div>

      {b.truncated && (
        <p className="text-[11px] text-amber-700">
          Showing the first 100 transactions — the lines below don&apos;t add up to the total above.
        </p>
      )}

      {orderLines.length > 0 && (
        <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
            Orders in this payout
          </p>
          <div className="max-h-56 space-y-0.5 overflow-y-auto">
            {orderLines.map((l) => (
              <div key={l.id} className="flex justify-between gap-2 text-xs">
                <span className="min-w-0 truncate text-zinc-600">
                  {l.order?.reference ?? 'Order'}
                  {l.order?.customerName ? ` · ${l.order.customerName}` : ''}
                </span>
                <span className="flex-shrink-0 tabular-nums text-zinc-700">
                  {money(l.gross, l.currency)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {orderLines.length === 0 && b.lines.length > 0 && (
        <p className="text-[11px] text-zinc-400">
          We couldn&apos;t match these transactions to orders in OrderHub — they may predate the
          integration.
        </p>
      )}
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-6 py-12 text-center">
      <p className="text-sm font-medium text-zinc-700">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-xs text-zinc-500">{body}</p>
    </div>
  );
}
