import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { ContractsService } from "./contracts.service";
import { Public } from "../../common/decorators/public.decorator";

// The counterparty's surface. Every route is @Public() and keyed ONLY by the
// contract's token — the person signing has no account here, and never will.
// Kept in its own controller so this public surface is obvious at a glance and
// can't inherit a staff route from ContractsController.
//
// IP and user-agent are captured on every call: they are the evidence that
// makes the signature stand up, not decoration.

@ApiTags("contracts-public")
@Controller({ path: "sign", version: "1" })
export class ContractsPublicController {
  constructor(private readonly contracts: ContractsService) {}

  /**
   * The REAL client IP, resolved exactly as UserThrottlerGuard does.
   *
   * `trust proxy` is 1, which trusts a single hop — but in production there
   * are two (Cloudflare, then Render), so req.ip can be Cloudflare's edge
   * rather than the signer. That is merely annoying for a rate-limit bucket
   * and actively wrong here: this IP is the evidence that a specific person
   * signed, and recording Cloudflare's address for every signature would make
   * the whole audit trail worthless in a dispute.
   *
   * cf-connecting-ip is set by Cloudflare itself and cannot be spoofed by a
   * client behind it; the x-forwarded-for and req.ip fallbacks cover local
   * dev and any path that doesn't go through the edge.
   */
  private ctxOf(req: Request) {
    const headers = req.headers as Record<string, string | string[] | undefined>;
    const cf = headers["cf-connecting-ip"];
    const cfIp = typeof cf === "string" ? cf : undefined;
    const xffRaw = headers["x-forwarded-for"];
    const xff =
      typeof xffRaw === "string" ? xffRaw.split(",")[0]?.trim() : undefined;
    return {
      ip: cfIp ?? xff ?? req.ip ?? req.socket?.remoteAddress ?? undefined,
      userAgent: req.get("user-agent") ?? undefined,
    };
  }

  @Get(":token")
  @Public()
  // The token is 32 random bytes, so this is not really brute-forceable;
  // the limit is here to stop a leaked link being hammered into a
  // thousand OPENED rows that bury the real evidence.
  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @ApiOperation({ summary: "Load a contract for signing" })
  get(@Param("token") token: string, @Req() req: Request) {
    return this.contracts.getByToken(token, this.ctxOf(req));
  }

  @Post(":token/sign")
  @Public()
  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: "Sign the contract" })
  sign(
    @Param("token") token: string,
    @Body()
    body: {
      signerName: string;
      signerEmail?: string;
      signatureImageUrl?: string;
    },
    @Req() req: Request,
  ) {
    return this.contracts.sign(token, body, this.ctxOf(req));
  }

  @Get(":token/pdf")
  @Public()
  @Throttle({ medium: { limit: 20, ttl: 60000 } })
  @ApiOperation({ summary: "Download your signed copy" })
  async pdf(@Param("token") token: string, @Res() res: Response) {
    const { buffer, filename } = await this.contracts.pdfForToken(token);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  @Post(":token/subscribe")
  @Public()
  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @ApiOperation({
    summary: "Start the subscription this signed contract offers",
  })
  subscribe(@Param("token") token: string, @Req() req: Request) {
    return this.contracts.startSubscription(token, this.ctxOf(req));
  }
}
