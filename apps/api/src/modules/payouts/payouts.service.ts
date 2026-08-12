import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../infrastructure/database/prisma.service";

let Stripe: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Stripe = require("stripe").default ?? require("stripe");
} catch {
  Stripe = null;
}

/**
 * "Where is my money?" — the merchant-facing view of Stripe payouts.
 *
 * A restaurant owner has two questions the rest of the dashboard can't answer:
 * what has Stripe paid me, and how do I change the bank account it lands in.
 * Both are answered here.
 *
 * Two deliberate choices:
 *
 * 1. **Payouts are shown per Connect account, labelled with the shop.** A
 *    tenant can hold several accounts (per-location, per-brand, or one for the
 *    whole tenant), so a flat tenant-wide list is actively misleading to a
 *    multi-site operator — five shops' payouts interleaved with no way to tell
 *    which is which. Everything here is scoped to the locations the caller is
 *    actually assigned to, the same rule the subscriptions page uses.
 *
 * 2. **Bank details are never collected by us.** Our accounts are Express, so
 *    Stripe hosts a merchant dashboard reachable through a short-lived login
 *    link. The owner changes their bank there. No account or sort code passes
 *    through OrderHub, which keeps the identity checks — and the liability if
 *    someone tries to redirect a shop's takings — with Stripe, where they
 *    belong.
 */
/** Stripe's payout.status → the badge the merchant sees. */
const STRIPE_TO_DISPLAY_STATUS: Record<string, string> = {
  paid: "PAID",
  pending: "PENDING",
  in_transit: "IN_TRANSIT",
  canceled: "CANCELLED",
  failed: "FAILED",
};

/**
 * Ceiling on how many accounts one page load will query Stripe for. A group
 * with dozens of shops viewing "All" would otherwise fire a round-trip each.
 */
const MAX_ACCOUNTS_PER_FETCH = 12;

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);
  private readonly stripe: any | null;

  /** Roles that see every location's money without an assignment. */
  private static readonly TENANT_WIDE = ["PLATFORM_ADMIN"];

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const key = this.config.get<string>("STRIPE_SECRET_KEY");
    this.stripe =
      key && Stripe ? new Stripe(key, { apiVersion: "2024-06-20" }) : null;
  }

  // ── Access scope ──────────────────────────────────────────────────────────

  /** null = every location (platform admin); an array = the allowlist. */
  private async accessibleLocationIds(
    tenantId: string,
    userId?: string,
    role?: string,
  ): Promise<string[] | null> {
    if (role && PayoutsService.TENANT_WIDE.includes(role)) return null;

    // Fail closed. An unresolved caller getting the whole tenant's takings is
    // far worse than an empty page, and an empty page gets reported.
    if (!userId || !role) {
      this.logger.warn("Payout access requested without a resolved user — denying");
      return [];
    }

    const [locs, brands] = await Promise.all([
      (this.prisma as any).userLocation.findMany({
        where: { userId },
        select: { locationId: true },
      }),
      (this.prisma as any).userBrand.findMany({
        where: { userId },
        select: { brandId: true },
      }),
    ]);
    const ids = new Set<string>(locs.map((l: any) => l.locationId as string));
    const brandIds = brands.map((b: any) => b.brandId as string);
    if (brandIds.length) {
      const brandRows = await this.prisma.brand.findMany({
        where: { id: { in: brandIds }, tenantId },
        select: { primaryLocationId: true, locations: { select: { id: true } } },
      });
      for (const b of brandRows) {
        if (b.primaryLocationId) ids.add(b.primaryLocationId);
        for (const l of b.locations) ids.add(l.id);
      }
    }
    return Array.from(ids);
  }

  /**
   * The Connect accounts this caller may look at, each with a human label.
   *
   * A tenant-level account (no location, no brand) is the whole business's
   * money, so it is shown only to callers with tenant-wide reach. A
   * location-scoped manager seeing it would be seeing every shop's takings
   * under a name that doesn't say so.
   */
  private async visibleAccounts(
    tenantId: string,
    userId?: string,
    role?: string,
  ) {
    const allowed = await this.accessibleLocationIds(tenantId, userId, role);

    const accounts = await (this.prisma as any).stripeConnectAccount.findMany({
      where: { tenantId },
      orderBy: { createdAt: "asc" },
    });
    if (!accounts.length) return [];

    const locationIds = accounts
      .map((a: any) => a.locationId)
      .filter(Boolean) as string[];
    const brandIds = accounts.map((a: any) => a.brandId).filter(Boolean) as string[];

    const [locations, brands] = await Promise.all([
      locationIds.length
        ? this.prisma.location.findMany({
            where: { id: { in: locationIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
      brandIds.length
        ? this.prisma.brand.findMany({
            where: { id: { in: brandIds } },
            select: {
              id: true,
              name: true,
              primaryLocationId: true,
              locations: { select: { id: true } },
            },
          })
        : Promise.resolve([]),
    ]);
    const locName = new Map(locations.map((l) => [l.id, l.name]));
    const brandById = new Map(brands.map((b) => [b.id, b]));

    const out: Array<{
      id: string;
      stripeAccountId: string;
      label: string;
      locationId: string | null;
      brandId: string | null;
      scope: "LOCATION" | "BRAND" | "TENANT";
      payoutsEnabled: boolean;
      chargesEnabled: boolean;
      onboardingComplete: boolean;
    }> = [];

    for (const a of accounts) {
      let scope: "LOCATION" | "BRAND" | "TENANT" = "TENANT";
      let label = "All locations";
      // Which locations' money flows through this account — used for scoping.
      let covered: string[] | null = null;

      if (a.locationId) {
        scope = "LOCATION";
        label = locName.get(a.locationId) ?? "Location";
        covered = [a.locationId];
      } else if (a.brandId) {
        scope = "BRAND";
        const b = brandById.get(a.brandId);
        label = b?.name ?? "Brand";
        covered = [
          ...(b?.primaryLocationId ? [b.primaryLocationId] : []),
          ...(b?.locations.map((l) => l.id) ?? []),
        ];
      }

      if (allowed !== null) {
        // Tenant-level money is not shown to a location-scoped caller.
        if (covered === null) continue;
        if (!covered.some((id) => allowed.includes(id))) continue;
      }

      out.push({
        id: a.id,
        stripeAccountId: a.stripeAccountId,
        label,
        locationId: a.locationId ?? null,
        brandId: a.brandId ?? null,
        scope,
        payoutsEnabled: !!a.payoutsEnabled,
        chargesEnabled: !!a.chargesEnabled,
        onboardingComplete: !!a.onboardingComplete,
      });
    }
    return out;
  }

  /** The payout accounts the caller can see, for the page's account picker. */
  async listAccounts(tenantId: string, userId?: string, role?: string) {
    return this.visibleAccounts(tenantId, userId, role);
  }

  // ── Payout history ────────────────────────────────────────────────────────

  /**
   * Payouts, newest first, labelled with the shop they belong to and never
   * reaching past the caller's own locations.
   *
   * Read from STRIPE, not from our own table.
   *
   * The `payouts` table is filled by webhooks, so it only knows about payouts
   * that happened after we subscribed to the events. Every merchant already
   * paid out before that — which is all of them — showed an empty page saying
   * "no payouts yet" while Stripe had a year of history. Since Stripe is the
   * source of truth and we are already calling it for the balance, ask it.
   * Our table stays as the fallback for when Stripe can't be reached.
   */
  async list(
    tenantId: string,
    userId: string | undefined,
    role: string | undefined,
    opts: { accountId?: string; limit?: number } = {},
  ) {
    const accounts = await this.visibleAccounts(tenantId, userId, role);
    if (!accounts.length) return { payouts: [], accounts: [] };

    const picked = opts.accountId
      ? accounts.filter((a) => a.id === opts.accountId)
      : accounts;
    if (!picked.length) {
      // Asking for an account outside your scope reads the same as one that
      // doesn't exist — don't confirm it's there.
      throw new NotFoundException("Payout account not found");
    }

    const limit = Math.min(opts.limit ?? 50, 200);
    // Cap the fan-out: "All" on a big group would otherwise be one Stripe
    // round-trip per shop on every page load.
    const perAccount = Math.max(5, Math.ceil(limit / picked.length));

    if (picked.length > MAX_ACCOUNTS_PER_FETCH) {
      // Say so rather than quietly returning a partial list that reads like
      // the whole picture.
      this.logger.warn(
        `Payout history covering ${picked.length} accounts truncated to ${MAX_ACCOUNTS_PER_FETCH} — pick a location to see the rest`,
      );
    }

    const results = await Promise.all(
      picked
        .slice(0, MAX_ACCOUNTS_PER_FETCH)
        .map((a) => this.payoutsForAccount(tenantId, a, perAccount)),
    );

    const payouts = results
      .flat()
      .sort((x, y) => +new Date(y.createdAt) - +new Date(x.createdAt))
      .slice(0, limit);

    return { accounts, payouts };
  }

  /**
   * One account's payouts, from Stripe where possible and our mirror table
   * otherwise. A shop whose Stripe call fails still shows whatever we know
   * rather than dropping out of the list silently.
   */
  private async payoutsForAccount(
    tenantId: string,
    account: { id: string; stripeAccountId: string; label: string },
    limit: number,
  ) {
    if (this.stripe && !account.stripeAccountId.startsWith("mock_acct_")) {
      try {
        const res = await this.stripe.payouts.list(
          { limit },
          { stripeAccount: account.stripeAccountId },
        );
        return (res.data ?? []).map((p: any) => ({
          id: p.id,
          stripePayoutId: p.id,
          amount: ((p.amount ?? 0) / 100).toFixed(2),
          currency: p.currency ?? "gbp",
          status: STRIPE_TO_DISPLAY_STATUS[p.status as string] ?? "PENDING",
          arrivalDate: p.arrival_date
            ? new Date(p.arrival_date * 1000).toISOString()
            : null,
          description: p.description ?? null,
          createdAt: new Date((p.created ?? 0) * 1000).toISOString(),
          accountId: account.id,
          accountLabel: account.label,
        }));
      } catch (e: any) {
        this.logger.warn(
          `Payout list failed for ${account.stripeAccountId}: ${e?.message} — falling back to our records`,
        );
      }
    }

    const rows = await (this.prisma as any).payout.findMany({
      where: { tenantId, connectAccountId: account.id },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map((p: any) => ({
      id: p.id,
      stripePayoutId: p.stripePayoutId,
      amount: String(p.amount),
      currency: p.currency,
      status: p.status,
      arrivalDate: p.arrivalDate ? new Date(p.arrivalDate).toISOString() : null,
      description: p.description,
      createdAt: new Date(p.createdAt).toISOString(),
      accountId: account.id,
      accountLabel: account.label,
    }));
  }

  /**
   * Live balance for one account, straight from Stripe.
   *
   * Our Payout rows only exist once Stripe has told us about a payout, so they
   * can't answer "how much is waiting" or "what's on its way". That has to be
   * a live read, and it is the number the owner actually looks for.
   */
  async balance(
    tenantId: string,
    userId: string | undefined,
    role: string | undefined,
    accountId?: string,
  ) {
    const accounts = await this.visibleAccounts(tenantId, userId, role);
    const account = accountId
      ? accounts.find((a) => a.id === accountId)
      : accounts[0];
    if (!account) throw new NotFoundException("Payout account not found");

    if (!this.stripe || account.stripeAccountId.startsWith("mock_acct_")) {
      return {
        accountId: account.id,
        available: null,
        pending: null,
        inTransit: null,
        currency: "gbp",
        unavailableReason: "Stripe is not configured in this environment.",
      };
    }

    try {
      const [balance, recent] = await Promise.all([
        this.stripe.balance.retrieve({ stripeAccount: account.stripeAccountId }),
        this.stripe.payouts
          .list({ limit: 20 }, { stripeAccount: account.stripeAccountId })
          .catch(() => ({ data: [] })),
      ]);

      const sum = (rows: any[]) =>
        (rows ?? []).reduce((t, b) => t + (b.amount ?? 0), 0) / 100;

      // Money genuinely still on its way, decided HERE rather than by asking
      // Stripe for status:"in_transit".
      //
      // That filter did not do what it looks like it does: the sum came back
      // as every recent payout added together, so a shop with five settled
      // July payouts was told £1,975.94 was arriving today. Two independent
      // conditions now have to hold — the payout must still be open, AND its
      // arrival date must not already have passed — so a payout that has
      // landed cannot be counted however its status reads.
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const onItsWay = (recent.data ?? []).filter((p: any) => {
        if (p.status !== "in_transit" && p.status !== "pending") return false;
        if (!p.arrival_date) return true;
        return new Date(p.arrival_date * 1000) >= startOfToday;
      });
      // Soonest to land, not merely the most recently created.
      const next = [...onItsWay].sort(
        (a: any, b: any) => (a.arrival_date ?? 0) - (b.arrival_date ?? 0),
      )[0];

      return {
        accountId: account.id,
        currency: (balance.available?.[0]?.currency ?? "gbp") as string,
        available: sum(balance.available),
        pending: sum(balance.pending),
        inTransit: sum(onItsWay),
        nextPayout: next
          ? {
              amount: (next.amount ?? 0) / 100,
              arrivalDate: next.arrival_date
                ? new Date(next.arrival_date * 1000).toISOString()
                : null,
            }
          : null,
      };
    } catch (e: any) {
      // A balance we can't fetch must not take the whole page down — the
      // payout history below it is still perfectly readable.
      this.logger.warn(
        `Balance fetch failed for ${account.stripeAccountId}: ${e?.message}`,
      );
      return {
        accountId: account.id,
        available: null,
        pending: null,
        inTransit: null,
        currency: "gbp",
        unavailableReason: e?.message ?? "Couldn't reach Stripe.",
      };
    }
  }

  // ── Bank details ──────────────────────────────────────────────────────────

  /**
   * A one-time link into the merchant's own Stripe Express dashboard, where
   * they change their bank account, see their payout schedule and download
   * statements.
   *
   * The link is single-use and short-lived by Stripe's design, so it is minted
   * per click and never stored.
   */
  async dashboardLink(
    tenantId: string,
    userId: string | undefined,
    role: string | undefined,
    accountId?: string,
  ): Promise<{ url: string; kind: "DASHBOARD" | "ONBOARDING" }> {
    const accounts = await this.visibleAccounts(tenantId, userId, role);
    const account = accountId
      ? accounts.find((a) => a.id === accountId)
      : accounts[0];
    if (!account) throw new NotFoundException("Payout account not found");

    if (!this.stripe || account.stripeAccountId.startsWith("mock_acct_")) {
      throw new BadRequestException(
        "Stripe isn't configured in this environment.",
      );
    }

    // Ask Stripe, don't trust our own flag.
    //
    // `onboardingComplete` is only written by the account.updated webhook and
    // the brand-connect status call, so an account onboarded before either
    // existed — or a per-location account from the older flow — can be live
    // and taking money while our row still says false. Gating the button on
    // that flag told owners to "finish onboarding" they finished months ago.
    // The account's real state is one API call away, so use it.
    let detailsSubmitted = account.onboardingComplete;
    try {
      const fresh = await this.stripe.accounts.retrieve(account.stripeAccountId);
      detailsSubmitted = !!fresh.details_submitted;
      // Self-heal the row while we have the truth in hand — this flag is read
      // by the payments and locations screens too, and they were all wrong in
      // the same way.
      await (this.prisma as any).stripeConnectAccount
        .update({
          where: { id: account.id },
          data: {
            chargesEnabled: !!fresh.charges_enabled,
            payoutsEnabled: !!fresh.payouts_enabled,
            onboardingComplete: detailsSubmitted,
          },
        })
        .catch(() => {});
    } catch (e: any) {
      // Couldn't reach Stripe, or it isn't an account we can read. Fall
      // through and let the link attempt below produce the real error.
      this.logger.warn(
        `Account retrieve failed for ${account.stripeAccountId}: ${e?.message}`,
      );
    }

    // Genuinely unfinished → send them somewhere useful instead of refusing.
    // A dead end here is the worst outcome: the owner wants to add a bank
    // account and we would be telling them to go and do the very thing this
    // link does.
    if (!detailsSubmitted) {
      const webBase = (
        this.config.get<string>("WEB_URL") ?? "https://www.orderhubsolutions.com"
      ).replace(/\/+$/, "");
      const link = await this.stripe.accountLinks.create({
        account: account.stripeAccountId,
        refresh_url: `${webBase}/dashboard/payouts`,
        return_url: `${webBase}/dashboard/payouts`,
        type: "account_onboarding",
      });
      return { url: link.url, kind: "ONBOARDING" };
    }

    try {
      const link = await this.stripe.accounts.createLoginLink(
        account.stripeAccountId,
      );
      return { url: link.url, kind: "DASHBOARD" };
    } catch (e: any) {
      // The commonest cause by far: the account was pasted in as a raw acct_…
      // (someone's existing Standard account) rather than created by us as
      // Express. Login links only work for accounts where we control the
      // dashboard, and the merchant already has their own Stripe login.
      this.logger.warn(
        `Login link failed for ${account.stripeAccountId}: ${e?.message}`,
      );
      throw new BadRequestException(
        "This location's payouts go to a Stripe account we don't manage. " +
          "Sign in at dashboard.stripe.com to change its bank details.",
      );
    }
  }
}
