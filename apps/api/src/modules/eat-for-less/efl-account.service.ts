// Eat For Less — what the app keeps for a signed-in customer: their profile
// flags, saved addresses, favourite shops and push devices. All of it hangs
// off the global CustomerAccount, never a shop or a brand.

import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";

export interface AddressInput {
  label?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  postcode: string;
  latitude?: number | null;
  longitude?: number | null;
  instructions?: string | null;
  isDefault?: boolean;
}

const MAX_ADDRESSES = 10;

/** An ExponentPushToken[…] — the only kind the app registers. */
export function isExpoPushToken(token: string): boolean {
  return /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/.test(token);
}

@Injectable()
export class EflAccountService {
  constructor(private readonly prisma: PrismaService) {}

  /** Public settings the app needs before anyone signs in. */
  appConfig() {
    return {
      // The publishable key is meant to be public; serving it here keeps it
      // out of the binary so test and live builds can't get crossed.
      stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? null,
    };
  }

  async me(customer: { id: string }) {
    const a = await this.prisma.customerAccount.findUnique({
      where: { id: customer.id },
      select: { phone: true, phoneVerifiedAt: true, eflMarketingOptIn: true },
    });
    if (!a) throw new NotFoundException("Account not found");
    return {
      phone: a.phone,
      phoneVerified: !!a.phoneVerifiedAt && !!a.phone,
      marketingOptIn: a.eflMarketingOptIn,
    };
  }

  // ── Addresses ──────────────────────────────────────────────────────────

  addresses(customer: { id: string }) {
    return this.prisma.eflSavedAddress.findMany({
      where: { customerAccountId: customer.id },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
    });
  }

  async addAddress(customer: { id: string }, input: AddressInput) {
    const count = await this.prisma.eflSavedAddress.count({ where: { customerAccountId: customer.id } });
    if (count >= MAX_ADDRESSES) {
      throw new BadRequestException(`You can save up to ${MAX_ADDRESSES} addresses. Remove one first.`);
    }
    const isDefault = input.isDefault ?? count === 0;
    return this.prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.eflSavedAddress.updateMany({ where: { customerAccountId: customer.id }, data: { isDefault: false } });
      }
      return tx.eflSavedAddress.create({ data: { ...clean(input), isDefault, customerAccountId: customer.id } });
    });
  }

  async updateAddress(customer: { id: string }, id: string, input: Partial<AddressInput>) {
    await this.ownAddress(customer, id);
    return this.prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.eflSavedAddress.updateMany({ where: { customerAccountId: customer.id }, data: { isDefault: false } });
      }
      return tx.eflSavedAddress.update({ where: { id }, data: clean(input) });
    });
  }

  async removeAddress(customer: { id: string }, id: string) {
    const existing = await this.ownAddress(customer, id);
    await this.prisma.eflSavedAddress.delete({ where: { id } });
    // Keep one default while any address is left.
    if (existing.isDefault) {
      const next = await this.prisma.eflSavedAddress.findFirst({
        where: { customerAccountId: customer.id },
        orderBy: { updatedAt: "desc" },
      });
      if (next) await this.prisma.eflSavedAddress.update({ where: { id: next.id }, data: { isDefault: true } });
    }
    return { ok: true };
  }

  private async ownAddress(customer: { id: string }, id: string) {
    const row = await this.prisma.eflSavedAddress.findFirst({ where: { id, customerAccountId: customer.id } });
    if (!row) throw new NotFoundException("Address not found");
    return row;
  }

  // ── Favourites ─────────────────────────────────────────────────────────

  async favourites(customer: { id: string }) {
    const rows = await this.prisma.eflFavourite.findMany({
      where: { customerAccountId: customer.id },
      orderBy: { createdAt: "desc" },
      select: { listingId: true },
    });
    return rows.map((r) => r.listingId);
  }

  async addFavourite(customer: { id: string }, listingId: string) {
    const listing = await this.prisma.eflListing.findUnique({ where: { id: listingId }, select: { id: true } });
    if (!listing) throw new NotFoundException("Shop not found");
    await this.prisma.eflFavourite.upsert({
      where: { customerAccountId_listingId: { customerAccountId: customer.id, listingId } },
      create: { customerAccountId: customer.id, listingId },
      update: {},
    });
    return { ok: true };
  }

  async removeFavourite(customer: { id: string }, listingId: string) {
    await this.prisma.eflFavourite.deleteMany({ where: { customerAccountId: customer.id, listingId } });
    return { ok: true };
  }

  // ── Push ──────────────────────────────────────────────────────────────

  /** The app calls this on every launch; it moves a token to whoever is
   *  signed in on that phone now. */
  async registerPush(customer: { id: string }, input: { token: string; platform?: string; marketingOptIn?: boolean }) {
    if (!isExpoPushToken(input.token)) throw new BadRequestException("Not an Expo push token");
    const platform = input.platform === "ios" || input.platform === "android" ? input.platform : null;
    await this.prisma.eflPushDevice.upsert({
      where: { token: input.token },
      create: {
        customerAccountId: customer.id,
        token: input.token,
        platform,
        marketingOptIn: !!input.marketingOptIn,
      },
      update: {
        customerAccountId: customer.id,
        platform,
        isActive: true,
        revokedAt: null,
        ...(input.marketingOptIn === undefined ? {} : { marketingOptIn: !!input.marketingOptIn }),
      },
    });
    return { ok: true };
  }

  /** Signing out stops this phone getting the account's notifications. */
  async unregisterPush(customer: { id: string }, token: string) {
    await this.prisma.eflPushDevice.updateMany({
      where: { token, customerAccountId: customer.id },
      data: { isActive: false, revokedAt: new Date() },
    });
    return { ok: true };
  }
}

function clean<T extends Partial<AddressInput>>(input: T) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    out[k] = typeof v === "string" ? v.trim() || (k === "line1" || k === "city" || k === "postcode" ? v : null) : v;
  }
  if (typeof out.postcode === "string") out.postcode = out.postcode.toUpperCase();
  return out as any;
}
