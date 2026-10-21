import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { EmailService } from "../../infrastructure/email/email.service";
import { reservationEmail, type ReservationEmailKind } from "./reservation-emails";

// Sends the guest's booking emails.
//
// NEVER in the booking's way: every send is fire-and-forget and every
// failure is logged and swallowed. A booking that saved must stay saved
// whether or not Resend is having a good minute — the guest still has their
// table, and the diary still shows it.
//
// The reservation is re-read here rather than passed in, so the email always
// describes what is in the database (the table the floor moved it to, the
// time after an edit), and so the location + brand come with it.

@Injectable()
export class ReservationEmailService {
  private readonly logger = new Logger(ReservationEmailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  /** Fire-and-forget. Resolves to whether an email was handed to Resend. */
  send(kind: ReservationEmailKind, reservationId: string): Promise<boolean> {
    return this.sendNow(kind, reservationId).catch((err) => {
      this.logger.warn(
        `Reservation ${kind} email for ${reservationId} failed: ${err?.message ?? err}`,
      );
      return false;
    });
  }

  private async sendNow(kind: ReservationEmailKind, id: string): Promise<boolean> {
    const r = await this.prisma.tableReservation.findUnique({
      where: { id },
      include: {
        location: {
          select: {
            id: true,
            name: true,
            phone: true,
            timezone: true,
            logoUrl: true,
            addressLine1: true,
            addressLine2: true,
            city: true,
            postcode: true,
            brand: { select: { name: true, logoUrl: true } },
          },
        },
      },
    });
    const to = r?.customerEmail?.trim();
    if (!r || !to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return false;

    const loc = r.location;
    const address =
      [loc.addressLine1, loc.addressLine2, loc.city, loc.postcode]
        .map((p) => (p ?? "").trim())
        .filter(Boolean)
        .join(", ") || null;
    const webUrl = (
      this.config.get<string>("WEB_URL") ?? "https://www.orderhubsolutions.com"
    ).replace(/\/$/, "");
    const shopName = loc.name || loc.brand?.name || "the restaurant";

    const mail = reservationEmail({
      kind,
      shopName,
      logoUrl: loc.logoUrl ?? loc.brand?.logoUrl ?? null,
      address,
      shopPhone: loc.phone ?? null,
      timezone: loc.timezone || "Europe/London",
      customerName: r.customerName,
      partySize: r.partySize,
      startsAt: r.startsAt,
      durationMins: r.durationMins,
      reference: r.reference,
      notes: r.notes,
      bookUrl: `${webUrl}/book/${loc.id}`,
    });
    await this.email.send({
      to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      fromName: shopName,
    });
    return true;
  }
}
