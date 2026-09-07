import { Controller, Headers, HttpCode, HttpStatus, Logger, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { DeliverooClientService } from './deliveroo-client.service';
import { DeliverooOrderService } from './deliveroo-order.service';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { Public } from '../../../common/decorators/public.decorator';

// Phase BA-3 — Deliveroo inbound webhook receiver.
//
// Deliveroo posts here for order + menu events. We ALWAYS return 200 (never
// error back to Deliveroo), verify the HMAC (X-Deliveroo-Hmac-Sha256 over
// `${sequenceGuid} ${rawBody}`, legacy new_order/cancel_order use ` \n `), and
// record the event idempotently. On the FIRST valid delivery of an event we
// route it (BA-3b): order.new → ingestCanonical, order.status_update →
// updateStatus, rider.status_update → courier columns. Routing is best-effort
// and fully swallowed — a handler failure never turns into a non-200.
//
// The 200 goes back BEFORE routing runs. Deliveroo's own dashboard showed 330
// of 6,220 callbacks (5.3%) coming back `-1` — no HTTP response at all —
// because we made them wait for the whole ingest: menu resolution, order
// write, customer backfill, print jobs. Node does not abort a handler when the
// client disconnects, so those orders did land and the retry was deduped; the
// cost was a permanent 5% failure band on the dashboard, no headroom before
// retries start missing too, and real faults hidden inside the noise.
//
// This weakens nothing: routing errors were ALREADY swallowed into a 200, so
// Deliveroo never retried on a handler failure. What changes is only that it
// stops waiting for work whose outcome it was never told.
@ApiTags('deliveroo')
@Controller({ path: 'integrations/deliveroo', version: '1' })
export class DeliverooWebhookController {
  private readonly logger = new Logger(DeliverooWebhookController.name);

  /**
   * One event at a time per order.
   *
   * Answering in milliseconds instead of seconds means Deliveroo's next event
   * for the same order can arrive while the previous one is still being
   * processed — and a status_update that overtakes its own order.new finds no
   * order to update and is dropped as unhandled. These were previously spaced
   * apart by the very latency being removed, so the ordering was luck rather
   * than design.
   *
   * Keyed by order id: different orders still run concurrently.
   */
  private readonly lanes = new Map<string, Promise<unknown>>();

  private inOrder<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prev = this.lanes.get(key) ?? Promise.resolve();
    const run = prev.then(work, work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.lanes.set(key, tail);
    void tail.then(() => {
      if (this.lanes.get(key) === tail) this.lanes.delete(key);
    });
    return run;
  }

  constructor(
    private readonly client: DeliverooClientService,
    private readonly prisma: PrismaService,
    private readonly orderRouter: DeliverooOrderService,
  ) {}

  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-deliveroo-sequence-guid') sequenceGuid: string,
    @Headers('x-deliveroo-hmac-sha256') signature: string,
  ) {
    const raw: Buffer = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));

    let body: any = {};
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      /* keep {} */
    }
    const event: string = body?.event ?? body?.event_name ?? 'unknown';
    const legacy = event === 'new_order' || event === 'cancel_order';

    // Try the expected separator first, then the other, so a mislabelled
    // legacy/standard event still verifies.
    const valid =
      this.client.verifyWebhookSignature(sequenceGuid, raw, signature, legacy) ||
      this.client.verifyWebhookSignature(sequenceGuid, raw, signature, !legacy);

    // Record the event. create-catch-P2002 gives us a clean "first time we've
    // seen this sequence guid" signal — Deliveroo retries reuse the same guid,
    // so a duplicate must NOT re-run the handler (ingest is idempotent anyway,
    // but rider timestamps + status echoes shouldn't be reprocessed).
    let firstSeen = false;
    if (sequenceGuid) {
      try {
        await this.prisma.webhookEvent.create({
          data: {
            platform: 'DELIVEROO',
            externalEventId: sequenceGuid,
            signature: signature ?? null,
            rawPayload: body,
            metadata: { event, valid },
          },
        });
        firstSeen = true;
      } catch (e: any) {
        if (e?.code !== 'P2002') {
          this.logger.warn(`Deliveroo webhook persist failed: ${e?.message}`);
        }
        // P2002 → duplicate delivery, already recorded. firstSeen stays false.
      }
    }

    // Whether we're going to ACT on this, and why not when we aren't.
    //
    // Routing used to require `firstSeen`, which is only ever true when a
    // sequence guid is present — so an event delivered without that header
    // was dropped in silence, and the log line was indistinguishable from a
    // legitimate retry (`first=false` either way). A rider's final
    // "delivered" arriving that way leaves the order on the board for the
    // rest of the night with nothing to show for it.
    //
    // No guid means we can't dedupe, so route anyway: ingestCanonical is
    // idempotent, rider timestamps are first-value-wins, and updateStatus
    // refuses to regress a terminal order. Reprocessing is cheap; dropping
    // the only completion signal is not.
    const skipReason = !valid
      ? 'invalid_signature'
      : sequenceGuid && !firstSeen
        ? 'duplicate'
        : null;
    const willRoute = skipReason === null;

    this.logger.log(
      `Deliveroo webhook event=${event} valid=${valid} first=${firstSeen} ` +
        `seq=${sequenceGuid || 'MISSING'} routed=${willRoute}` +
        (skipReason ? ` skipped=${skipReason}` : '') +
        (!sequenceGuid ? ' (no guid — routed without dedupe)' : ''),
    );

    // Diagnose signature failures: distinguish "secret not set" from "secret
    // set but wrong" (our signing format is verified against Deliveroo's spec,
    // so a configured-but-mismatched secret means the wrong DELIVEROO_WEBHOOK_
    // SECRET is deployed). Logs HMAC prefixes only — safe, they're not secrets.
    if (!valid && sequenceGuid && signature) {
      const diag = this.client.signatureDiagnostics(sequenceGuid, raw);
      if (!diag.configured) {
        this.logger.error(
          `Deliveroo webhook REJECTED: DELIVEROO_WEBHOOK_SECRET is not set on the API — set it (the webhook secret from the Deliveroo portal, distinct from the client secret) and redeploy.`,
        );
      } else {
        // Definitive test: does ANY plausible signing scheme match Deliveroo's
        // signature with the deployed secret? A named match → secret is RIGHT,
        // only our format is off (code fix). "no_match" → the secret VALUE is
        // wrong (env fix).
        const variant = this.client.diagnoseSignatureVariant(sequenceGuid, raw, signature);
        this.logger.error(
          `Deliveroo webhook REJECTED: signature did not verify. variantMatch=${variant} ` +
            `(a named scheme ⇒ secret is correct, format needs fixing; "no_match" ⇒ wrong DELIVEROO_WEBHOOK_SECRET). ` +
            `received=${signature.slice(0, 16)}… seq=${sequenceGuid} rawLen=${raw.length}`,
        );
      }
    }

    // Route the first valid delivery of a guid, and every valid delivery
    // without one. Best-effort: any handler error is swallowed + logged so
    // Deliveroo still gets its 200 (and retries the same guid, which we'll
    // then treat as a duplicate — the underlying ingest/updateStatus paths
    // are themselves idempotent).
    if (willRoute) {
      // Not awaited. Everything below happens after Deliveroo has its 200.
      const lane =
        String(
          body?.body?.order?.id ??
            body?.order?.id ??
            body?.order_id ??
            body?.body?.order_id ??
            sequenceGuid ??
            'unkeyed',
        ) || 'unkeyed';
      void this.inOrder(lane, async () => {
        const startedAt = Date.now();
        try {
          const result = await this.orderRouter.route(event, body);
          // How long Deliveroo WOULD have been waiting. The number that made
          // this change necessary, kept so it can be watched.
          this.logger.log(
            `Deliveroo webhook ${event} routed in ${Date.now() - startedAt}ms ` +
              `(handled=${result.handled}${result.orderId ? ` order=${result.orderId}` : ''})`,
          );
          // What the router DID with it. An unrouted event name or an order we
          // can't find is the difference between "Deliveroo never told us" and
          // "Deliveroo told us and we ignored it", and only one of those is
          // ours to fix.
          if (!result.handled) {
            this.logger.warn(
              `Deliveroo webhook ${event} not handled: ${result.reason ?? 'unknown'}`,
            );
          }
          // Only bookkeeping — there's no row to update when no guid arrived.
          if (sequenceGuid)
            await this.prisma.webhookEvent
              .update({
                where: {
                  platform_externalEventId: {
                    platform: 'DELIVEROO',
                    externalEventId: sequenceGuid,
                  },
                },
                data: {
                  orderId: result.orderId ?? null,
                  processedAt: new Date(),
                  metadata: { event, valid, ...result },
                },
              })
              .catch(() => {
                /* best-effort bookkeeping */
              });
        } catch (err: any) {
          this.logger.error(
            `Deliveroo webhook routing failed for ${event}/${sequenceGuid} ` +
              `after ${Date.now() - startedAt}ms: ${err?.message}`,
          );
          if (sequenceGuid) {
            await this.prisma.webhookEvent
              .update({
                where: {
                  platform_externalEventId: {
                    platform: 'DELIVEROO',
                    externalEventId: sequenceGuid,
                  },
                },
                data: { processingError: String(err) },
              })
              .catch(() => {
                /* best-effort */
              });
          }
        }
      });
    }

    // Deliveroo is done waiting. Routing continues behind this line.
    return { ok: true };
  }
}
