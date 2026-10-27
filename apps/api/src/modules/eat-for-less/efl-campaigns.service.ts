// Eat For Less — push and email campaigns from the Console.
//
// Only to people who said yes: a push goes to app installs with offers
// switched on (EflPushDevice.marketingOptIn), an email to accounts with
// eflMarketingOptIn. Every email carries a one-click unsubscribe. Shops'
// own customer lists are never touched — these are Eat For Less customers.

import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "crypto";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { EmailService, type BatchEmail } from "../../infrastructure/email/email.service";
import { CustomerPushService } from "../customer-push/customer-push.service";
import { publicApiBase } from "../../common/public-api-url";

export type CampaignInput = {
  channel: "PUSH" | "EMAIL";
  title: string;
  body: string;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
};

const PAGE = 500;

@Injectable()
export class EflCampaignsService {
  private readonly logger = new Logger(EflCampaignsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly push?: CustomerPushService,
    @Optional() private readonly email?: EmailService,
  ) {}

  list() {
    return this.prisma.eflCampaign.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
  }

  /** How many people each channel would reach right now. */
  async audience() {
    const [push, email] = await Promise.all([
      this.prisma.eflPushDevice.count({ where: { isActive: true, marketingOptIn: true } }),
      this.prisma.customerAccount.count({ where: { eflMarketingOptIn: true, email: { not: "" } } }),
    ]);
    return { push, email };
  }

  async create(input: CampaignInput, userId?: string) {
    return this.prisma.eflCampaign.create({ data: { ...clean(input), createdBy: userId ?? null } });
  }

  async update(id: string, input: CampaignInput) {
    const row = await this.get(id);
    if (row.status !== "DRAFT") throw new BadRequestException("A sent campaign can't be changed.");
    return this.prisma.eflCampaign.update({ where: { id }, data: clean(input) });
  }

  async remove(id: string) {
    const row = await this.get(id);
    if (row.status !== "DRAFT") throw new BadRequestException("A sent campaign can't be deleted.");
    await this.prisma.eflCampaign.delete({ where: { id } });
    return { ok: true };
  }

  /** An email campaign to one address first, to see it as a customer will. */
  async sendTest(id: string, to: string) {
    const c = await this.get(id);
    if (c.channel !== "EMAIL") throw new BadRequestException("Only email campaigns can be tested.");
    if (!this.email) throw new BadRequestException("Email isn't set up.");
    await this.email.send({
      to,
      subject: `[Test] ${c.title}`,
      fromAddress: fromAddress(),
      replyTo: "hello@eatforless.co.uk",
      html: campaignHtml(c, null),
    });
    return { sentTo: to };
  }

  /** Send now. Claims the row first, so a double click sends once. */
  async send(id: string) {
    const claimed = await this.prisma.eflCampaign.updateMany({
      where: { id, status: "DRAFT" },
      data: { status: "SENDING" },
    });
    if (!claimed.count) throw new BadRequestException("This campaign has already been sent.");
    const c = await this.get(id);
    void this.deliver(c).catch(async (e) => {
      this.logger.error(`EFL campaign ${id} failed: ${(e as Error).message}`);
      await this.prisma.eflCampaign.update({ where: { id }, data: { status: "FAILED" } });
    });
    return { ...c, status: "SENDING" };
  }

  private async deliver(c: Awaited<ReturnType<EflCampaignsService["get"]>>) {
    let targeted = 0;
    let delivered = 0;
    if (c.channel === "PUSH") {
      if (!this.push) throw new Error("Push isn't set up");
      let cursor: string | undefined;
      for (;;) {
        const devices = await this.prisma.eflPushDevice.findMany({
          where: { isActive: true, marketingOptIn: true },
          select: { id: true, token: true },
          orderBy: { id: "asc" },
          take: PAGE,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        });
        if (!devices.length) break;
        targeted += devices.length;
        delivered += await this.push.sendToEflDevices(devices, {
          title: c.title,
          body: c.body,
          tag: `efl-campaign-${c.id}`,
          data: { app: "eatforless", campaignId: c.id, ...(c.ctaUrl ? { url: c.ctaUrl } : {}) },
        });
        cursor = devices[devices.length - 1]!.id;
      }
    } else {
      if (!this.email) throw new Error("Email isn't set up");
      let cursor: string | undefined;
      let page = 0;
      for (;;) {
        const people = await this.prisma.customerAccount.findMany({
          where: { eflMarketingOptIn: true, email: { not: "" } },
          select: { id: true, email: true },
          orderBy: { id: "asc" },
          take: 100,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        });
        if (!people.length) break;
        targeted += people.length;
        const batch: BatchEmail[] = people
          .filter((p) => !!p.email)
          .map((p) => {
            const unsubscribe = unsubscribeUrl(p.id);
            return {
              to: p.email!,
              subject: c.title,
              html: campaignHtml(c, unsubscribe),
              fromAddress: fromAddress(),
              replyTo: "hello@eatforless.co.uk",
              headers: {
                "List-Unsubscribe": `<${unsubscribe}>`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              },
            };
          });
        try {
          await this.email.sendBatch(batch, `efl-campaign-${c.id}-${page}`);
          delivered += batch.length;
        } catch (e) {
          this.logger.warn(`EFL campaign ${c.id} page ${page} failed: ${(e as Error).message}`);
        }
        cursor = people[people.length - 1]!.id;
        page++;
      }
    }
    await this.prisma.eflCampaign.update({
      where: { id: c.id },
      data: { status: "SENT", targeted, delivered, sentAt: new Date() },
    });
    this.logger.log(`EFL campaign ${c.id} (${c.channel}) sent: ${delivered}/${targeted}`);
  }

  /** One-click unsubscribe from Eat For Less emails. */
  async unsubscribe(token: string): Promise<boolean> {
    const id = readUnsubscribe(token);
    if (!id) return false;
    await this.prisma.customerAccount.updateMany({ where: { id }, data: { eflMarketingOptIn: false } });
    return true;
  }

  private async get(id: string) {
    const row = await this.prisma.eflCampaign.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Campaign not found");
    return row;
  }
}

function clean(input: CampaignInput) {
  const title = String(input.title ?? "").trim();
  const body = String(input.body ?? "").trim();
  if (input.channel !== "PUSH" && input.channel !== "EMAIL") throw new BadRequestException("Choose push or email.");
  if (!title || !body) throw new BadRequestException("A campaign needs a title and a message.");
  if (input.channel === "PUSH" && (title.length > 60 || body.length > 180)) {
    throw new BadRequestException("A push title is at most 60 characters and its message 180.");
  }
  const ctaUrl = input.ctaUrl?.trim() || null;
  if (ctaUrl && !/^https:\/\//i.test(ctaUrl)) throw new BadRequestException("The button link must start with https://");
  return {
    channel: input.channel,
    title: title.slice(0, 140),
    body: body.slice(0, 4000),
    ctaLabel: input.ctaLabel?.trim() ? input.ctaLabel.trim().slice(0, 40) : null,
    ctaUrl,
  };
}

function fromAddress() {
  return process.env.EFL_EMAIL_FROM || "Eat For Less <hello@eatforless.co.uk>";
}

function secret() {
  return `${process.env.JWT_SECRET ?? "efl-dev"}:efl-unsubscribe`;
}

function unsubscribeUrl(accountId: string): string {
  const body = Buffer.from(accountId).toString("base64url");
  const mac = createHmac("sha256", secret()).update(body).digest("base64url").slice(0, 32);
  return `${publicApiBase()}/v1/efl/unsubscribe?t=${body}.${mac}`;
}

export function readUnsubscribe(token: string): string | null {
  const [body, mac] = String(token ?? "").split(".");
  if (!body || !mac) return null;
  const want = Buffer.from(createHmac("sha256", secret()).update(body).digest("base64url").slice(0, 32));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return Buffer.from(body, "base64url").toString("utf8") || null;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function campaignHtml(c: { title: string; body: string; ctaLabel: string | null; ctaUrl: string | null }, unsubscribe: string | null) {
  const paragraphs = c.body
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.55;color:#0B0B0B">${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const button =
    c.ctaUrl && c.ctaLabel
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px"><tr><td style="background:#0B0B0B;border-radius:999px"><a href="${esc(c.ctaUrl)}" style="display:inline-block;padding:14px 26px;font-size:16px;font-weight:800;color:#D4FF3F;text-decoration:none">${esc(c.ctaLabel)}</a></td></tr></table>`
      : "";
  return `<!doctype html><html><body style="margin:0;background:#F3F3F3;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:16px;overflow:hidden">
<tr><td style="background:#D4FF3F;padding:20px 24px;font-size:22px;font-weight:900;color:#0B0B0B">eat for less</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 14px;font-size:24px;line-height:1.25;color:#0B0B0B">${esc(c.title)}</h1>
${paragraphs}${button}
</td></tr>
<tr><td style="padding:16px 24px;background:#0B0B0B;color:#8C8C8C;font-size:11px;line-height:1.6">
You're getting this because you said yes to offers from Eat For Less.
${unsubscribe ? `<a href="${esc(unsubscribe)}" style="color:#D4FF3F">Unsubscribe</a>.` : ""}<br>
Eat For Less Ltd · Company no. 17543774 · 5 Sunningdale Drive, Washington, NE37 2LL
</td></tr></table></td></tr></table></body></html>`;
}
