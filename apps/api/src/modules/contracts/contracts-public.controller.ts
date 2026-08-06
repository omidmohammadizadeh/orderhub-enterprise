import { Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
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
   * Behind Express `trust proxy`, req.ip is already the real client rather
   * than Render's load balancer — the same setting the rate limiter depends
   * on. Falling back to the socket address keeps this honest in local dev.
   */
  private ctxOf(req: Request) {
    return {
      ip: req.ip ?? req.socket?.remoteAddress ?? undefined,
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
