// Eat For Less — getting a shop paid.
//
// Customers pay Eat For Less Ltd; each order's share goes to the shop's
// Express account on Eat For Less's own Stripe platform and is paid out
// weekly, on Mondays. This service owns that account: it creates it, hands
// the shop Stripe's own form to finish (bank details, ID — Stripe collects
// them, we never see them) and keeps stripePayoutsEnabled in step with what
// Stripe says, so an order can't be taken for a shop Stripe can't pay.

import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { PaymentsService } from "../payments/payments.service";
import { pinnedBrands, shopFace } from "./efl-shop-face";

export type PayoutSetup = {
  /** Eat For Less's Stripe keys are in, so this flow is live. */
  configured: boolean;
  status: "NOT_STARTED" | "IN_PROGRESS" | "READY";
  /** What Stripe still wants, in its words, when IN_PROGRESS. */
  due: string[];
};

/** Ready = Stripe can move money to the shop's bank. */
export function payoutStatusOf(account: any): { ready: boolean; due: string[] } {
  const transfers = account?.capabilities?.transfers;
  const ready = !!account?.payouts_enabled && transfers === "active";
  const due = [
    ...(account?.requirements?.currently_due ?? []),
    ...(account?.requirements?.past_due ?? []),
  ];
  return { ready, due: [...new Set<string>(due)] };
}

@Injectable()
export class EflPayoutsService {
  private readonly logger = new Logger(EflPayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
  ) {}

  private stripe() {
    return this.payments.eflStripeClient();
  }

  async status(locationId: string): Promise<PayoutSetup> {
    const listing = await this.listing(locationId);
    const stripe = this.stripe();
    if (!stripe) return { configured: false, status: "NOT_STARTED", due: [] };
    if (!listing.stripeAccountId) return { configured: true, status: "NOT_STARTED", due: [] };
    // Ask Stripe rather than trust the flag: the shop may have just come
    // back from the form, before account.updated has landed.
    const account = await stripe.accounts.retrieve(listing.stripeAccountId);
    const { ready, due } = payoutStatusOf(account);
    if (ready !== listing.stripePayoutsEnabled) {
      await this.prisma.eflListing.update({ where: { id: listing.id }, data: { stripePayoutsEnabled: ready } });
    }
    return { configured: true, status: ready ? "READY" : "IN_PROGRESS", due };
  }

  /**
   * A link to Stripe's form for this shop, creating its account first if it
   * has none. Stripe sends the shop back to its Eat For Less settings.
   */
  async start(locationId: string): Promise<{ url: string }> {
    const stripe = this.stripe();
    if (!stripe) throw new BadRequestException("Eat For Less payouts aren't switched on yet.");
    const origin = (process.env.WEB_URL ?? "https://www.orderhubsolutions.com").replace(/\/+$/, "");
    const returnUrl = `${origin}/dashboard/locations/${encodeURIComponent(locationId)}/brands?efl=payouts`;
    const listing = await this.listing(locationId);

    let accountId = listing.stripeAccountId;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        country: "GB",
        // Only transfers: Eat For Less takes the card payment, the shop
        // receives its share. The shop can't change the schedule (set off
        // in the Connect settings), so every shop is paid the same Monday.
        capabilities: { transfers: { requested: true } },
        business_type: "company",
        business_profile: {
          name: shopFace(listing, await pinnedBrands(this.prisma, [listing])).name ?? listing.location.name,
          mcc: "5814",
          product_description: "Takeaway food sold through the Eat For Less app",
        },
        settings: { payouts: { schedule: { interval: "weekly", weekly_anchor: "monday" } } },
        metadata: { locationId, listingId: listing.id },
      });
      accountId = account.id as string;
      // Claim it only if nobody else did in the meantime, so a double
      // click can't leave the shop with two accounts and money in the
      // one we forgot.
      const claimed = await this.prisma.eflListing.updateMany({
        where: { id: listing.id, stripeAccountId: null },
        data: { stripeAccountId: accountId },
      });
      if (!claimed.count) {
        await stripe.accounts.del(accountId).catch(() => undefined);
        accountId = (await this.listing(locationId)).stripeAccountId!;
      }
    }

    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: returnUrl,
      return_url: returnUrl,
      type: "account_onboarding",
    });
    return { url: link.url as string };
  }

  /** The shop's own Stripe Express dashboard: payouts, bank, statements. */
  async dashboardLink(locationId: string): Promise<{ url: string }> {
    const stripe = this.stripe();
    const listing = await this.listing(locationId);
    if (!stripe || !listing.stripeAccountId) throw new BadRequestException("Payouts aren't set up for this shop yet.");
    const link = await stripe.accounts.createLoginLink(listing.stripeAccountId);
    return { url: link.url as string };
  }

  /** account.updated from Eat For Less's webhook. */
  @OnEvent("efl.stripe_account.updated")
  async onAccountUpdated(account: any) {
    if (!account?.id) return;
    const { ready } = payoutStatusOf(account);
    const updated = await this.prisma.eflListing.updateMany({
      where: { stripeAccountId: account.id },
      data: { stripePayoutsEnabled: ready },
    });
    if (updated.count) this.logger.log(`EFL payouts ${ready ? "ready" : "not ready"} for ${account.id}`);
  }

  private async listing(locationId: string) {
    const listing = await this.prisma.eflListing.findUnique({
      where: { locationId },
      select: {
        id: true,
        stripeAccountId: true,
        stripePayoutsEnabled: true,
        brandId: true,
        location: { select: { name: true, brand: { select: { name: true } } } },
      },
    });
    if (!listing) throw new NotFoundException("This shop isn't on Eat For Less yet.");
    return listing;
  }
}
