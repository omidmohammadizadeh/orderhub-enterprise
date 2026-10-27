import { Body, Controller, HttpCode, HttpStatus, Logger, Post, Req } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Request } from "express";
import { Public } from "../../common/decorators/public.decorator";
import { EflCallsService } from "./efl-calls.service";

/**
 * Telnyx webhook for the Eat For Less private line. The number sits on its
 * OWN Call Control application pointing here, never on the AI phone line's —
 * that controller answers every call it is sent as a shop's ordering line.
 */
@ApiExcludeController()
@Controller({ path: "efl/calls", version: "1" })
export class EflCallsController {
  private readonly logger = new Logger(EflCallsController.name);

  constructor(private readonly calls: EflCallsService) {}

  @Public()
  @Post("webhook")
  @HttpCode(HttpStatus.OK)
  async webhook(@Req() req: Request & { rawBody?: Buffer }, @Body() body: any) {
    const raw = req.rawBody?.toString("utf8") ?? JSON.stringify(body ?? {});
    const ok = this.calls.telnyx.verifySignature(
      raw,
      req.headers["telnyx-signature-ed25519"] as string | undefined,
      req.headers["telnyx-timestamp"] as string | undefined,
    );
    // Always 200: a refusal Telnyx retries is only noise.
    if (!ok) return { ok: false, reason: "bad_signature" };

    const type: string = body?.data?.event_type ?? "";
    const payload = body?.data?.payload ?? {};
    const ccid = String(payload?.call_control_id ?? "");
    // Never the digits: they are someone's code.
    this.logger.log(`EFL call ${ccid.slice(-8)} ${type} ${payload?.direction ?? ""}`.trim());
    try {
      await this.calls.onEvent(type, payload);
    } catch (e) {
      this.logger.error(`EFL call ${ccid.slice(-8)} ${type} failed: ${(e as Error).message}`);
    }
    return { ok: true };
  }
}
