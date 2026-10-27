// Eat For Less — is anyone at the shop to take the order?
//
// Every 30 seconds each listed shop is checked for one of its own OrderHub
// devices (OrdersGateway tags them). No device for OFFLINE_AFTER_MS hides
// the shop from the app; a device coming back shows it again. Taking an
// order nobody will see is worse than not showing the shop: the customer
// pays, waits, and gets a refund an hour later.

import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SocketService } from "../../infrastructure/socket/socket.service";
import { isCurrentlyOpen } from "../../common/opening-hours.util";
import { defaultSmsFrom, isSmsConfigured, sendSmsViaProvider } from "../sms/sms-provider";
import { toE164 } from "../sms/phone";

export const OFFLINE_REASON = "OFFLINE";
export const OFFLINE_AFTER_MS = 2 * 60 * 1000;

export type PresenceChange = "GO_OFFLINE" | "COME_BACK" | "NONE";

/** What should happen to one listing on this tick. Only a hide this check
 *  made is undone by it, and it never hides over another reason. */
export function presenceChange(input: {
  hiddenReason: string | null;
  lastDeviceSeenAt: Date | null;
  online: boolean;
  now: Date;
}): PresenceChange {
  if (input.online) return input.hiddenReason === OFFLINE_REASON ? "COME_BACK" : "NONE";
  if (input.hiddenReason) return "NONE";
  const quietFor = input.lastDeviceSeenAt ? input.now.getTime() - input.lastDeviceSeenAt.getTime() : Infinity;
  return quietFor >= OFFLINE_AFTER_MS ? "GO_OFFLINE" : "NONE";
}

@Injectable()
export class EflPresenceService {
  private readonly logger = new Logger(EflPresenceService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly socket: SocketService,
  ) {}

  @Cron("*/30 * * * * *")
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.check(new Date());
    } catch (err) {
      this.logger.warn(`Presence check failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async check(now: Date) {
    const online = await this.socket.locationsWithShopDevices();
    const listings = await this.prisma.eflListing.findMany({
      where: { listed: true, status: "APPROVED" },
      select: {
        id: true,
        locationId: true,
        hiddenReason: true,
        lastDeviceSeenAt: true,
        location: { select: { name: true, phone: true, openingHours: true, timezone: true, brand: { select: { name: true } } } },
      },
    });

    const seen = listings.filter((l) => online.has(l.locationId)).map((l) => l.id);
    if (seen.length) {
      await this.prisma.eflListing.updateMany({ where: { id: { in: seen } }, data: { lastDeviceSeenAt: now } });
    }

    for (const l of listings) {
      const change = presenceChange({
        hiddenReason: l.hiddenReason,
        lastDeviceSeenAt: l.lastDeviceSeenAt,
        online: online.has(l.locationId),
        now,
      });
      if (change === "COME_BACK") {
        await this.prisma.eflListing.update({ where: { id: l.id }, data: { hiddenReason: null, offlineSince: null } });
        this.logger.log(`EFL ${l.locationId} back online`);
      } else if (change === "GO_OFFLINE") {
        await this.prisma.eflListing.update({
          where: { id: l.id },
          data: { hiddenReason: OFFLINE_REASON, offlineSince: now },
        });
        this.logger.warn(`EFL ${l.locationId} hidden — no shop device for 2 minutes`);
        // A shut shop's tablet is meant to be off; only text when it should
        // be trading.
        const open = isCurrentlyOpen(l.location?.openingHours as any, l.location?.timezone ?? "Europe/London", now);
        if (open && l.location?.phone) void this.alert(l.location.phone, l.location.brand?.name ?? l.location.name);
      }
    }
  }

  private async alert(rawPhone: string, shopName: string) {
    // Shop numbers are often landlines, which can't take a text.
    const phone = toE164(rawPhone);
    if (!isSmsConfigured() || !phone || !phone.startsWith("+447")) return;
    try {
      // Our own sender, unbilled: this is the platform telling the shop, not
      // the shop texting a customer.
      await sendSmsViaProvider({
        to: phone,
        from: defaultSmsFrom(),
        body: `Eat For Less: ${shopName} is hidden from the app because no OrderHub tablet has been online for 2 minutes. Open OrderHub on your tablet and you'll be back automatically.`,
      });
    } catch (err) {
      this.logger.warn(`Offline alert to ${shopName} failed: ${(err as Error).message}`);
    }
  }
}
