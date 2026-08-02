import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { VoiceService } from "./voice.service";

// Operator + test surface for the AI phone line. The telephony webhooks
// (Telnyx call-control + the media WebSocket) land in a separate controller
// once the account exists — these are the endpoints that let us build and
// verify the conversation without a phone.

@ApiTags("voice")
@ApiBearerAuth()
@Controller({ path: "voice", version: "1" })
export class VoiceController {
  constructor(
    private readonly voice: VoiceService,
    private readonly prisma: PrismaService,
  ) {}

  private db(): any {
    return this.prisma as any;
  }

  /**
   * Drive a whole call from typed text — the same code path a real call takes,
   * minus the audio. This is how the conversation gets tuned before a single
   * minute of telephony is paid for, and how a regression in the ordering flow
   * gets caught without ringing anyone.
   */
  @Post("simulate")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "MANAGER")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Run a call as text — no telephony required" })
  async simulate(
    @CurrentUser() user: AuthenticatedUser,
    @Body()
    body: {
      /** The shop's AI number (Location.settings.voiceNumber). */
      to: string;
      /** Pretend caller id, so caller-name lookup and order status work. */
      from?: string;
      /** Existing call to continue; omit to start a new one. */
      callId?: string;
      /** What the caller just said. Omit on the first request to get the greeting. */
      text?: string;
    },
  ) {
    if (!body?.callId) {
      const started = await this.voice.onIncomingCall({
        providerCallId: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        from: body?.from ?? null,
        to: body.to,
        provider: "SIMULATOR",
      });
      return started;
    }
    if (!body.text) {
      return { say: "Say something." };
    }
    return this.voice.onCallerSaid({ callId: body.callId, text: body.text });
  }

  /** End a simulated call — exercises the same billing path a real hang-up does. */
  @Post("simulate/:callId/end")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "MANAGER")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "End a simulated call (and bill it)" })
  async endSimulated(
    @Param("callId") callId: string,
    @Body() body: { durationSeconds?: number },
  ) {
    await this.voice.onCallEnded({
      callId,
      durationSeconds: Number(body?.durationSeconds ?? 60),
    });
    return this.db().voiceCall.findUnique({ where: { id: callId } });
  }

  /** The call log. */
  @Get("calls")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "MANAGER")
  @ApiOperation({ summary: "Recent AI phone calls" })
  async calls(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
    @Query("limit") limit?: string,
  ) {
    const where: any = { tenantId: user.tenantId };
    if (locationId) where.locationId = locationId;
    return this.db().voiceCall.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(parseInt(limit ?? "50", 10) || 50, 1), 200),
    });
  }

  /**
   * The number that justifies the price: calls the AI answered that would
   * otherwise have rung out, and what they turned into.
   *
   * "Recovered" is deliberately the honest definition — only calls that
   * arrived because the shop's own line went unanswered. Counting every call
   * would inflate it, and an operator who works that out stops trusting the
   * whole dashboard.
   */
  @Get("stats")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "MANAGER")
  @ApiOperation({ summary: "Answered / recovered / converted call stats" })
  async stats(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
    @Query("days") days?: string,
  ) {
    const since = new Date();
    since.setDate(since.getDate() - Math.min(Math.max(parseInt(days ?? "30", 10) || 30, 1), 365));

    const where: any = { tenantId: user.tenantId, createdAt: { gte: since } };
    if (locationId) where.locationId = locationId;

    const calls = await this.db().voiceCall.findMany({
      where,
      select: {
        status: true,
        outcome: true,
        orderId: true,
        wasOverflow: true,
        billedMinor: true,
        notAnsweredReason: true,
      },
    });

    const answered = calls.filter((c: any) => c.status !== "NOT_ANSWERED");
    const recovered = answered.filter((c: any) => c.wasOverflow);
    const orderIds = answered.map((c: any) => c.orderId).filter(Boolean);
    const orders = orderIds.length
      ? await this.db().order.findMany({
          where: { id: { in: orderIds } },
          select: { total: true },
        })
      : [];
    const revenue = orders.reduce((s: number, o: any) => s + Number(o.total ?? 0), 0);

    return {
      sinceDays: parseInt(days ?? "30", 10) || 30,
      answered: answered.length,
      recovered: recovered.length,
      orders: orderIds.length,
      revenue: Math.round(revenue * 100) / 100,
      transferred: answered.filter((c: any) => c.outcome === "TRANSFERRED").length,
      abandoned: answered.filter((c: any) => c.outcome === "ABANDONED").length,
      spendMinor: calls.reduce((s: number, c: any) => s + (c.billedMinor ?? 0), 0),
      // Calls we turned away. Any number here other than zero is something the
      // operator needs to see and act on.
      notAnswered: calls.filter((c: any) => c.status === "NOT_ANSWERED").length,
      notAnsweredNoFunds: calls.filter((c: any) => c.notAnsweredReason === "NO_FUNDS").length,
    };
  }
}
