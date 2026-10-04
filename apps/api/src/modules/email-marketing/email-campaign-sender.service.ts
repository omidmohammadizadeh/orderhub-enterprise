import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { personalise, renderEmail, type EmailDesign } from "@orderhub/shared";
import { EmailService, ResendError } from "../../infrastructure/email/email.service";
import { WalletService } from "../wallet/wallet.service";
import { emailCostMinor } from "./email-audience";
import { EmailMarketingService } from "./email-marketing.service";

// Delivers queued campaigns, 100 emails per Resend call.
//
// WHY A SWEEP AND NOT A LOOP STARTED BY THE REQUEST
//
// The SMS broadcaster runs in a setImmediate loop, which a redeploy kills
// halfway through a list. Here every recipient is a row with a status, and a
// cron picks up whatever is PENDING — so a restart resumes where it stopped.
//
// "NOBODY GETS IT TWICE" is three things together:
//   - recipients are claimed PENDING → SENDING with a batch key in one update,
//     so two ticks can't take the same rows;
//   - the batch key is sent to Resend as its Idempotency-Key, so a batch that
//     reached Resend before we crashed is answered from Resend's record when we
//     retry it, not sent again;
//   - a stuck batch is retried with exactly the rows it was claimed with,
//     because Resend refuses a reused key with a different payload.

/** Emails per Resend call (Resend's maximum). */
const BATCH = 100;
/** Batches per campaign per tick: ~1,000 emails every 15 seconds. */
const BATCHES_PER_TICK = 10;
/** Resend allows a couple of requests a second; leave room for order emails. */
const GAP_MS = 600;
/** A SENDING row older than this was claimed by a tick that died. */
const STUCK_MS = 3 * 60_000;

@Injectable()
export class EmailCampaignSenderService {
  private readonly logger = new Logger(EmailCampaignSenderService.name);
  private running = false;

  constructor(
    private readonly svc: EmailMarketingService,
    private readonly wallet: WalletService,
    @Optional() private readonly email?: EmailService,
  ) {}

  private db() {
    return this.svc.db();
  }

  @Cron("*/15 * * * * *")
  async tick(): Promise<void> {
    if (this.running || !this.email || !this.svc.isEnabled()) return;
    this.running = true;
    try {
      await this.startDueScheduled();
      const sending = await this.db().emailCampaign.findMany({
        where: { status: { in: ["SENDING", "CANCELLED"] }, completedAt: null },
        orderBy: { startedAt: "asc" },
        take: 5,
      });
      for (const c of sending) await this.work(c);
    } catch (e: any) {
      this.logger.warn(`Email campaign sweep failed: ${e?.message ?? e}`);
    } finally {
      this.running = false;
    }
  }

  private async startDueScheduled(): Promise<void> {
    const due = await this.db().emailCampaign.findMany({
      where: { status: "SCHEDULED", scheduledAt: { lte: new Date() } },
      orderBy: { scheduledAt: "asc" },
      take: 5,
      select: { id: true, createdBy: true },
    });
    for (const c of due) {
      try {
        await this.svc.materialize(c.id, c.createdBy ?? null, { throwOnError: false });
      } catch (e: any) {
        this.logger.warn(`Scheduled campaign ${c.id} did not start: ${e?.message ?? e}`);
      }
    }
  }

  /** Send some of one campaign, then finish it if nothing is left. */
  async work(c: any): Promise<void> {
    const ctx = await this.svc.renderContext(c);
    for (let i = 0; i < BATCHES_PER_TICK; i++) {
      const batch = c.status === "CANCELLED" ? await this.stuckBatch(c.id) : await this.nextBatch(c.id);
      if (!batch) break;
      const ok = await this.sendBatch(c, ctx, batch.key, batch.retry);
      if (!ok) return; // Resend is pushing back — try again next tick
      await sleep(GAP_MS);
    }
    await this.finishIfDone(c);
  }

  /** A batch to send: a stuck one first (same rows, same key), else a fresh claim. */
  private async nextBatch(campaignId: string): Promise<{ key: string; retry: boolean } | null> {
    const stuck = await this.stuckBatch(campaignId);
    if (stuck) return stuck;
    const ids: { id: string }[] = await this.db().emailCampaignRecipient.findMany({
      where: { campaignId, status: "PENDING" },
      orderBy: { id: "asc" },
      take: BATCH,
      select: { id: true },
    });
    if (!ids.length) return null;
    const key = `ec-${campaignId}-${ids[0]!.id}-${ids.length}`;
    const claimed = await this.db().emailCampaignRecipient.updateMany({
      where: { id: { in: ids.map((r) => r.id) }, status: "PENDING" },
      data: { status: "SENDING", batchKey: key, claimedAt: new Date() },
    });
    if (!claimed.count) return null;
    return { key, retry: false };
  }

  private async stuckBatch(campaignId: string): Promise<{ key: string; retry: boolean } | null> {
    const stuck = await this.db().emailCampaignRecipient.findFirst({
      where: { campaignId, status: "SENDING", claimedAt: { lt: new Date(Date.now() - STUCK_MS) } },
      select: { batchKey: true },
    });
    return stuck?.batchKey ? { key: stuck.batchKey, retry: true } : null;
  }

  /** @returns false when Resend asked us to back off. */
  private async sendBatch(
    c: any,
    ctx: Awaited<ReturnType<EmailMarketingService["renderContext"]>>,
    key: string,
    retry: boolean,
  ): Promise<boolean> {
    let rows: any[] = await this.db().emailCampaignRecipient.findMany({
      where: { campaignId: c.id, batchKey: key, status: "SENDING" },
      orderBy: { id: "asc" },
    });
    if (!rows.length) return true;

    // Someone may have unsubscribed (or bounced on another campaign) since the
    // list was made. Only on a FIRST attempt: a retry must carry the exact rows
    // the key was first used with.
    if (!retry) {
      const ok = await this.db().emailContact.findMany({
        where: { id: { in: rows.map((r) => r.contactId) }, status: "SUBSCRIBED" },
        select: { id: true },
      });
      const okIds = new Set(ok.map((x: any) => x.id));
      const gone = rows.filter((r) => !okIds.has(r.contactId));
      if (gone.length) {
        await this.db().emailCampaignRecipient.updateMany({
          where: { id: { in: gone.map((r) => r.id) } },
          data: { status: "SKIPPED", error: "no_longer_subscribed" },
        });
        rows = rows.filter((r) => okIds.has(r.contactId));
        if (!rows.length) return true;
      }
    } else {
      // Refresh the claim so another tick doesn't also pick this batch up.
      await this.db().emailCampaignRecipient.updateMany({
        where: { batchKey: key, status: "SENDING" },
        data: { claimedAt: new Date() },
      });
    }

    const from = this.svc.fromAddress();
    const api = this.svc.apiBase();
    const emails = rows.map((r) => {
      const token = this.svc.makeRecipientToken(r.id);
      const rendered = renderEmail(c.design as unknown as EmailDesign, {
        ...ctx,
        firstName: r.firstName,
        preheader: c.preheader,
        unsubscribeUrl: this.svc.unsubscribeUrl(token),
        trackLink: (_link, index) => `${api}/c/${r.id}/${index}`,
        openPixelUrl: `${api}/o/${r.id}`,
      });
      const oneClick = `${api}/unsubscribe?t=${encodeURIComponent(token)}`;
      return {
        to: r.email,
        subject: personalise(c.subject, { firstName: r.firstName, brandName: ctx.brandName }),
        html: rendered.html,
        text: rendered.text,
        fromName: ctx.brandName,
        fromAddress: from,
        replyTo: c.replyTo ?? undefined,
        headers: {
          // Gmail and Yahoo require one-click unsubscribe from bulk senders;
          // without it the whole sending domain is marked down.
          "List-Unsubscribe": `<${oneClick}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      };
    });

    try {
      const { ids } = await this.email!.sendBatch(emails, key);
      const now = new Date();
      for (let i = 0; i < rows.length; i++) {
        await this.db().emailCampaignRecipient.update({
          where: { id: rows[i].id },
          data: { status: "SENT", resendId: ids[i] ?? null, sentAt: now, error: null },
        });
      }
      await this.db().emailContact.updateMany({
        where: { id: { in: rows.map((r) => r.contactId) } },
        data: { lastEmailedAt: now },
      });
      await this.db().emailCampaign.update({
        where: { id: c.id },
        data: { sentCount: { increment: rows.length } },
      });
      return true;
    } catch (e: any) {
      if (e instanceof ResendError && e.retryable) {
        // Leave the rows SENDING; the stuck-batch path retries them with the
        // same key once the claim is old enough.
        this.logger.warn(`Resend pushed back on campaign ${c.id} (${e.status}); retrying later`);
        return false;
      }
      const message = String(e?.message ?? e).slice(0, 300);
      if (!(e instanceof ResendError)) {
        // A network error: we don't know whether Resend got it. Treat it like
        // a push-back — the idempotency key makes the retry safe either way.
        this.logger.warn(`Campaign ${c.id} batch ${key} failed in transit: ${message}`);
        return false;
      }
      this.logger.error(`Campaign ${c.id} batch ${key} rejected: ${message}`);
      await this.db().emailCampaignRecipient.updateMany({
        where: { batchKey: key, status: "SENDING" },
        data: { status: "FAILED", error: message },
      });
      await this.db().emailCampaign.update({
        where: { id: c.id },
        data: { failedCount: { increment: rows.length }, lastError: message },
      });
      return true;
    }
  }

  /** Close the campaign when no row is waiting, and refund what didn't go. */
  async finishIfDone(c: any): Promise<void> {
    const open = await this.db().emailCampaignRecipient.count({
      where: { campaignId: c.id, status: { in: ["PENDING", "SENDING"] } },
    });
    if (open > 0) return;
    const count = (status: string) =>
      this.db().emailCampaignRecipient.count({ where: { campaignId: c.id, status } });
    const [sent, failed, skipped] = await Promise.all([count("SENT"), count("FAILED"), count("SKIPPED")]);

    // Charged for (recipientCount - freeUsed) up front. Keep the price of the
    // paid emails that actually went; hand back the rest.
    const fresh = await this.db().emailCampaign.findUnique({ where: { id: c.id } });
    const paidSent = Math.max(0, sent - (fresh?.freeUsed ?? 0));
    const keep = Math.min(fresh?.chargedMinor ?? 0, emailCostMinor(paidSent, this.svc.pricePer1000Minor()));
    const refund = Math.max(0, (fresh?.chargedMinor ?? 0) - keep - (fresh?.refundedMinor ?? 0));

    // Close first (completedAt is the guard), refund second: a crash between
    // the two loses a refund we can see in the log, never pays it out twice.
    const closed = await this.db().emailCampaign.updateMany({
      where: { id: c.id, completedAt: null },
      data: {
        status: c.status === "CANCELLED" ? "CANCELLED" : sent === 0 && failed > 0 ? "FAILED" : "SENT",
        completedAt: new Date(),
        sentCount: sent,
        failedCount: failed,
        skippedCount: skipped,
        refundedMinor: { increment: refund },
      },
    });
    if (!closed.count) return;
    if (refund > 0) {
      const ok = await this.wallet.refundEmailMarketing({
        tenantId: c.tenantId,
        locationId: c.locationId,
        campaignId: c.id,
        amountMinor: refund,
        reason: `${failed + skipped} not sent`,
      });
      if (!ok) this.logger.error(`REFUND OWED: campaign ${c.id} owes ${refund} to its wallet`);
    }
    this.logger.log(`Email campaign ${c.id} finished: sent=${sent} failed=${failed} skipped=${skipped} refund=${refund}`);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
