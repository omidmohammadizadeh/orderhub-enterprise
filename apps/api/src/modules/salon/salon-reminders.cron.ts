import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { wallTime } from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SalonNotifyService } from "./salon-notify.service";
import { readSalonSettings, type SalonSettings } from "./salon-settings";

// Reminders before an appointment, and the "time for your next visit?" nudge
// after one.
//
// Each send is claimed first (reminderSentAt / rebookNudgeSentAt set by a
// conditional update) so two API instances, or a slow run overlapping the
// next, can never send the same message twice.

@Injectable()
export class SalonRemindersCron {
  private readonly logger = new Logger(SalonRemindersCron.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: SalonNotifyService,
  ) {}

  @Cron("0 */5 * * * *")
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.reminders();
      await this.rebookNudges();
      await this.reviewRequests();
    } catch (e: any) {
      this.logger.warn(`Salon reminders failed: ${e?.message}`);
    } finally {
      this.running = false;
    }
  }

  private settingsCache = new Map<string, { at: number; s: SalonSettings; tz: string }>();
  private async settingsFor(locationId: string) {
    const hit = this.settingsCache.get(locationId);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit;
    const loc = await this.prisma.location.findUnique({
      where: { id: locationId },
      select: { settings: true, timezone: true },
    });
    const v = { at: Date.now(), s: readSalonSettings(loc?.settings), tz: loc?.timezone || "Europe/London" };
    this.settingsCache.set(locationId, v);
    return v;
  }

  /** Due when it's within the shop's reminder window and not booked moments ago. */
  async reminders(now: number = Date.now()) {
    const due = await this.prisma.salonAppointment.findMany({
      where: {
        status: "CONFIRMED",
        reminderSentAt: null,
        startsAt: { gt: new Date(now + 60 * 60_000), lt: new Date(now + 73 * 3600_000) },
        OR: [{ customerEmail: { not: null } }, { customerPhone: { not: null } }],
      },
      select: { id: true, locationId: true, startsAt: true, createdAt: true, customerEmail: true, customerPhone: true },
      // Soonest first, so the ones due now are never pushed out of the batch
      // by bookings further ahead.
      orderBy: { startsAt: "asc" },
      take: 500,
    });
    let sent = 0;
    for (const a of due) {
      const { s } = await this.settingsFor(a.locationId);
      if (!s.reminderEnabled) {
        // Reminders off at this shop: mark it so it stops being re-read.
        await this.prisma.salonAppointment.updateMany({
          where: { id: a.id, reminderSentAt: null },
          data: { reminderSentAt: new Date(now) },
        });
        continue;
      }
      const windowMs = s.reminderHoursBefore * 3600_000;
      if (a.startsAt.getTime() - now > windowMs) continue;
      // Booked inside the window: the confirmation they just got is enough.
      if (a.startsAt.getTime() - a.createdAt.getTime() < windowMs) {
        await this.prisma.salonAppointment.updateMany({
          where: { id: a.id, reminderSentAt: null },
          data: { reminderSentAt: new Date(now) },
        });
        continue;
      }
      const { count } = await this.prisma.salonAppointment.updateMany({
        where: { id: a.id, reminderSentAt: null },
        data: { reminderSentAt: new Date(now) },
      });
      if (count === 0) continue;
      if (a.customerEmail) await this.notify.appointmentNow("reminder", a.id).catch(() => false);
      if (s.reminderSms && a.customerPhone) await this.notify.reminderSms(a.id);
      sent++;
    }
    if (sent) this.logger.log(`Sent ${sent} salon reminder(s)`);
    return sent;
  }

  /**
   * A few hours after a paid visit, "thanks — leave us a review", when the
   * shop has a Google review link. Daytime only; anything older than a day
   * is marked and skipped rather than sent late.
   */
  async reviewRequests(now: number = Date.now()) {
    const done = await this.prisma.salonAppointment.findMany({
      where: {
        status: "COMPLETED",
        reviewRequestSentAt: null,
        customerEmail: { not: null },
        completedAt: { lt: new Date(now - 2 * 3600_000), gt: new Date(now - 7 * 86_400_000) },
      },
      select: { id: true, locationId: true, completedAt: true },
      orderBy: { completedAt: "asc" },
      take: 500,
    });
    let sent = 0;
    for (const a of done) {
      const { s, tz } = await this.settingsFor(a.locationId);
      const reviewUrl = await this.reviewUrlFor(a.locationId);
      const stale = now - a.completedAt!.getTime() > 26 * 3600_000;
      const hour = Number(wallTime(now, tz).slice(0, 2));
      if (!stale && (hour < 10 || hour >= 20)) continue;
      const { count } = await this.prisma.salonAppointment.updateMany({
        where: { id: a.id, reviewRequestSentAt: null },
        data: { reviewRequestSentAt: new Date(now) },
      });
      if (count === 0 || stale || !s.reviewRequestEnabled || !reviewUrl) continue;
      await this.notify.appointmentNow("review", a.id).catch(() => false);
      sent++;
    }
    if (sent) this.logger.log(`Sent ${sent} salon review request(s)`);
    return sent;
  }

  private reviewCache = new Map<string, { at: number; url: string | null }>();
  private async reviewUrlFor(locationId: string): Promise<string | null> {
    const hit = this.reviewCache.get(locationId);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.url;
    const loc = await this.prisma.location.findUnique({ where: { id: locationId }, select: { googleReviewUrl: true } });
    const url = loc?.googleReviewUrl?.trim() || null;
    this.reviewCache.set(locationId, { at: Date.now(), url });
    return url;
  }

  /**
   * N days after a finished visit, if they haven't booked again, a friendly
   * "time for your next one?". Sent only in the shop's daytime.
   */
  async rebookNudges(now: number = Date.now()) {
    const candidates = await this.prisma.salonAppointment.findMany({
      where: {
        status: "COMPLETED",
        rebookNudgeSentAt: null,
        customerEmail: { not: null },
        completedAt: { lt: new Date(now - 7 * 86_400_000), gt: new Date(now - 400 * 86_400_000) },
      },
      // Oldest first: the ones due now come before ones not due yet.
      orderBy: { completedAt: "asc" },
      select: { id: true, locationId: true, tenantId: true, completedAt: true, customerEmail: true },
      take: 500,
    });
    let sent = 0;
    for (const a of candidates) {
      const { s, tz } = await this.settingsFor(a.locationId);
      if (!s.rebookAfterDays || !s.onlineBookingEnabled) {
        // Nudges off at this shop: mark it so it stops being re-read.
        await this.prisma.salonAppointment.updateMany({
          where: { id: a.id, rebookNudgeSentAt: null },
          data: { rebookNudgeSentAt: new Date(now) },
        });
        continue;
      }
      const dueAt = a.completedAt!.getTime() + s.rebookAfterDays * 86_400_000;
      if (now < dueAt) continue;
      // Too late to be useful — mark it so it isn't looked at again.
      const stale = now > dueAt + 7 * 86_400_000;
      const hour = Number(wallTime(now, tz).slice(0, 2));
      if (!stale && (hour < 10 || hour >= 19)) continue;
      // Already coming back, or been back since? Then no nudge.
      const later = await this.prisma.salonAppointment.count({
        where: {
          locationId: a.locationId,
          customerEmail: a.customerEmail,
          id: { not: a.id },
          OR: [
            { status: { in: ["PENDING_PAYMENT", "CONFIRMED", "CHECKED_IN", "IN_SERVICE"] } },
            { status: "COMPLETED", completedAt: { gt: a.completedAt! } },
          ],
        },
      });
      const { count } = await this.prisma.salonAppointment.updateMany({
        where: { id: a.id, rebookNudgeSentAt: null },
        data: { rebookNudgeSentAt: new Date(now) },
      });
      if (count === 0 || later > 0 || stale) continue;
      // One nudge per client per shop per fortnight, whatever the visit count.
      const recent = await this.prisma.salonAppointment.count({
        where: {
          locationId: a.locationId,
          customerEmail: a.customerEmail,
          id: { not: a.id },
          rebookNudgeSentAt: { gt: new Date(now - 14 * 86_400_000) },
        },
      });
      if (recent > 0) continue;
      await this.notify.appointmentNow("rebook", a.id).catch(() => false);
      sent++;
    }
    if (sent) this.logger.log(`Sent ${sent} salon rebook nudge(s)`);
    return sent;
  }
}
