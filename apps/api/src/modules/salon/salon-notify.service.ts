import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { lineBlock } from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { EmailService } from "../../infrastructure/email/email.service";
import { SmsService } from "../sms/sms.service";
import { salonEmail, salonReminderSms, type SalonEmailKind } from "./salon-emails";
import { readSalonSettings } from "./salon-settings";
import { storedLines, summariseLines } from "./salon-lines";

// Every message a salon client gets, in one place.
//
// NEVER in a booking's way: sends are fire-and-forget and failures are
// logged and swallowed — an appointment that saved stays saved whatever
// Resend or the SMS provider are doing. The appointment is re-read here so
// the message always says what's in the database.

@Injectable()
export class SalonNotifyService {
  private readonly logger = new Logger(SalonNotifyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly sms: SmsService,
    private readonly config: ConfigService,
  ) {}

  webUrl(): string {
    return (this.config.get<string>("WEB_URL") ?? "https://www.orderhubsolutions.com").replace(/\/+$/, "");
  }

  /** Fire-and-forget. */
  appointment(kind: SalonEmailKind, appointmentId: string): void {
    void this.appointmentNow(kind, appointmentId).catch((err) =>
      this.logger.warn(`Salon ${kind} email for ${appointmentId} failed: ${err?.message ?? err}`),
    );
  }

  /** Resolves to whether an email was handed to Resend. */
  async appointmentNow(kind: SalonEmailKind, appointmentId: string): Promise<boolean> {
    const a = await this.prisma.salonAppointment.findUnique({
      where: { id: appointmentId },
      include: {
        staff: { select: { name: true } },
        location: {
          select: {
            id: true,
            name: true,
            phone: true,
            timezone: true,
            currency: true,
            logoUrl: true,
            settings: true,
            addressLine1: true,
            addressLine2: true,
            city: true,
            postcode: true,
            brand: { select: { name: true, logoUrl: true } },
          },
        },
      },
    });
    const to = a?.customerEmail?.trim();
    if (!a || !to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return false;
    const loc = a.location;
    const settings = readSalonSettings(loc.settings);
    const lines = storedLines(a.services);
    const shopName = loc.name || loc.brand?.name || "the salon";
    const web = this.webUrl();
    const mail = salonEmail({
      kind,
      shopName,
      logoUrl: loc.logoUrl ?? loc.brand?.logoUrl ?? null,
      address:
        [loc.addressLine1, loc.addressLine2, loc.city, loc.postcode]
          .map((p) => (p ?? "").trim())
          .filter(Boolean)
          .join(", ") || null,
      shopPhone: loc.phone ?? null,
      timezone: loc.timezone || "Europe/London",
      currency: loc.currency || "GBP",
      customerName: a.customerName,
      staffName: a.staff?.name ?? null,
      summary: summariseLines(lines),
      startsAt: a.startsAt,
      durationMins: lines.reduce((s, l) => s + lineBlock(l).durationMins, 0),
      totalPrice: Number(a.totalPrice),
      priceFrom: lines.some((l) => l.priceFrom),
      depositAmount: Number(a.depositAmount),
      depositStatus: a.depositStatus,
      reference: a.reference,
      patchTest: lines.some((l) => l.requiresPatchTest),
      manageUrl: `${web}/salon/booking/${a.manageToken}`,
      bookUrl: settings.onlineBookingEnabled ? `${web}/salon/${loc.id}` : null,
      cancellationWindowHours: settings.allowGuestChanges ? settings.cancellationWindowHours : 0,
    });
    await this.email.send({ to, subject: mail.subject, html: mail.html, text: mail.text, fromName: shopName });
    return true;
  }

  /** Reminder text (billed to the shop's SMS wallet). Resolves to sent or not. */
  async reminderSms(appointmentId: string): Promise<boolean> {
    if (!this.sms.isConfigured()) return false;
    const a = await this.prisma.salonAppointment.findUnique({
      where: { id: appointmentId },
      include: {
        staff: { select: { name: true } },
        location: { select: { id: true, name: true, timezone: true } },
      },
    });
    if (!a?.customerPhone) return false;
    try {
      await this.sms.send({
        tenantId: a.tenantId,
        locationId: a.locationId,
        to: a.customerPhone,
        purpose: "OTHER",
        body: salonReminderSms({
          shopName: a.location.name,
          startsAt: a.startsAt,
          timezone: a.location.timezone || "Europe/London",
          staffName: a.staff?.name ?? null,
          manageUrl: `${this.webUrl()}/salon/booking/${a.manageToken}`,
        }),
      });
      return true;
    } catch (e: any) {
      this.logger.warn(`Salon reminder SMS for ${appointmentId} failed: ${e?.message}`);
      return false;
    }
  }

  /** "Jay is ready for you" — the walk-in queue calling someone up. */
  async queueCalled(entryId: string): Promise<boolean> {
    if (!this.sms.isConfigured()) return false;
    const e = await this.prisma.salonQueueEntry.findUnique({
      where: { id: entryId },
      include: { location: { select: { name: true } } },
    });
    if (!e?.customerPhone) return false;
    const staff = e.staffId ? await this.prisma.salonStaff.findUnique({ where: { id: e.staffId }, select: { name: true } }) : null;
    try {
      await this.sms.send({
        tenantId: e.tenantId,
        locationId: e.locationId,
        to: e.customerPhone,
        purpose: "OTHER",
        body: `${e.location.name}: you're up! ${staff?.name ? `${staff.name} is` : "We're"} ready for you now.`,
      });
      return true;
    } catch (err: any) {
      this.logger.warn(`Queue call SMS for ${entryId} failed: ${err?.message}`);
      return false;
    }
  }
}
