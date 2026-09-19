import { Controller, Headers, HttpCode, Logger, Post, Req, Res } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request, Response } from "express";
import { ApiTags } from "@nestjs/swagger";
import { Public } from "../../../common/decorators/public.decorator";
import { GlovoClientService } from "./glovo-client.service";
import { GlovoOrderService, type GlovoWebhookKind } from "./glovo-order.service";
import { glovoOrderIdFrom } from "./glovo-order.mappers";

// Phase GL-2 — Glovo's three order webhooks.
//
// These are the URLs we give Glovo's integrations team (they register them by
// hand — there is no subscription API). Once sent, NEVER rename them: whatever
// Glovo has on file is the contract. tests/glovo-routes.spec.ts pins them.
//
//   POST /api/v1/integrations/glovo/orders/dispatched   (mandatory)
//   POST /api/v1/integrations/glovo/orders/picked-up
//   POST /api/v1/integrations/glovo/orders/cancelled
//
// Auth: the shared token in `Authorization`, nothing else (no HMAC).
//
// ── Shape verification ──────────────────────────────────────────────────
// The full raw envelope is logged and persisted to WebhookEvent.rawPayload on
// every delivery before anything interprets it. The transformer is written
// from the spec; the first real order is the verification step.
@ApiTags("glovo")
@Controller({ path: "integrations/glovo/orders", version: "1" })
export class GlovoWebhookController {
  private readonly logger = new Logger(GlovoWebhookController.name);

  constructor(
    private readonly client: GlovoClientService,
    private readonly orders: GlovoOrderService,
  ) {}

  @Public()
  @Post("dispatched")
  @HttpCode(200)
  dispatched(
    @Req() req: RawBodyRequest<Request>,
    @Res({ passthrough: true }) res: Response,
    @Headers("authorization") authorization?: string,
  ) {
    return this.handle("dispatched", req, res, authorization);
  }

  // Both spellings: Glovo's own example URL is `/glovo/orders/picked_up`.
  @Public()
  @Post(["picked-up", "picked_up"])
  @HttpCode(200)
  pickedUp(
    @Req() req: RawBodyRequest<Request>,
    @Res({ passthrough: true }) res: Response,
    @Headers("authorization") authorization?: string,
  ) {
    return this.handle("picked_up", req, res, authorization);
  }

  @Public()
  @Post("cancelled")
  @HttpCode(200)
  cancelled(
    @Req() req: RawBodyRequest<Request>,
    @Res({ passthrough: true }) res: Response,
    @Headers("authorization") authorization?: string,
  ) {
    return this.handle("cancelled", req, res, authorization);
  }

  async handle(
    kind: GlovoWebhookKind,
    req: RawBodyRequest<Request>,
    res: Response,
    authorization: string | undefined,
  ): Promise<Record<string, unknown>> {
    const raw: Buffer = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    let payload: any = {};
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch (e: any) {
      this.logger.error(`Glovo ${kind} webhook body was not valid JSON: ${e?.message}`);
      // A malformed body will be malformed on every retry too.
      return { received: false };
    }

    const tokenOk = this.client.verifyInboundToken(authorization);
    if (!this.client.inboundTokenConfigured) {
      this.logger.warn(
        "Glovo webhook accepted WITHOUT authentication — GLOVO_API_TOKEN is not set. " +
          "Set it before going live; until then anyone can post orders.",
      );
    }

    const glovoOrderId = glovoOrderIdFrom(payload);
    const { alreadyProcessed } = glovoOrderId
      ? await this.orders.recordDelivery({ kind, glovoOrderId, payload, tokenOk })
      : { alreadyProcessed: false };

    // The whole envelope, every time — "the docs said X" vs "the wire says Y".
    this.logger.log(
      `Glovo ${kind} webhook envelope (order=${glovoOrderId ?? "MISSING"} tokenOk=${tokenOk} ` +
        `alreadyProcessed=${alreadyProcessed}): ${raw.toString("utf8").slice(0, 16000)}`,
    );

    if (!tokenOk) {
      this.logger.error(
        `Glovo ${kind} webhook REJECTED: Authorization did not match the Glovo token ` +
          `(presented=${authorization ? "yes" : "no"}).`,
      );
      res.status(401);
      return { received: false };
    }

    if (alreadyProcessed) {
      this.logger.log(`Glovo ${kind} ${glovoOrderId} is a redelivery of a processed event — skipping`);
      return { received: true, duplicate: true };
    }

    const result =
      kind === "dispatched"
        ? await this.orders.ingestOrder(payload)
        : kind === "picked_up"
          ? await this.orders.handlePickedUp(payload)
          : await this.orders.handleCancellation(payload);

    res.status(result.httpStatus);
    return { received: result.httpStatus === 200, ...(result.reason ? { reason: result.reason } : {}) };
  }
}
