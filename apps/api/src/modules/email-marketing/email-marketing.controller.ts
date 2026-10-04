import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { BillingExempt } from "../../common/guards/billing.guard";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import { EmailMarketingService, type Actor, type EmailImportRow } from "./email-marketing.service";
import { verifySvixSignature } from "./email-tokens";

// Same audience as SMS marketing: it spends wallet money and mails the
// restaurant's customers, so owners / admins / finance only.
const MARKETING_ROLES = ["PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT"] as const;

const actorOf = (u: AuthenticatedUser): Actor => ({ tenantId: u.tenantId, userId: u.userId, role: u.role });

@ApiTags("email-marketing")
@ApiBearerAuth()
@Controller({ path: "email-marketing", version: "1" })
export class EmailMarketingController {
  constructor(private readonly svc: EmailMarketingService) {}

  @Get("context")
  @Roles(...MARKETING_ROLES)
  context(@CurrentUser() user: AuthenticatedUser) {
    return this.svc.context(actorOf(user));
  }

  // ── Contacts ──────────────────────────────────────────────────────────────

  @Get("contacts")
  @Roles(...MARKETING_ROLES)
  contacts(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
    @Query("status") status?: string,
    @Query("search") search?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    return this.svc.listContacts(actorOf(user), {
      locationId: locationId || null,
      status: status || undefined,
      search,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @Get("contacts/sources")
  @Roles(...MARKETING_ROLES)
  sources(@CurrentUser() user: AuthenticatedUser, @Query("locationId") locationId?: string) {
    return this.svc.orderSourceCounts(actorOf(user), locationId || null);
  }

  @Post("contacts")
  @Roles(...MARKETING_ROLES)
  add(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { email: string; firstName?: string; lastName?: string; locationId?: string | null },
  ) {
    return this.svc.addManual(actorOf(user), body ?? ({} as any));
  }

  @Post("contacts/import-rows")
  @Roles(...MARKETING_ROLES)
  importRows(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { rows: EmailImportRow[]; locationId?: string | null; assertConsent?: boolean },
  ) {
    return this.svc.importRows(actorOf(user), body?.rows ?? [], {
      locationId: body?.locationId ?? null,
      assertConsent: body?.assertConsent === true,
    });
  }

  @Post("contacts/import-from-orders")
  @Roles(...MARKETING_ROLES)
  importFromOrders(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { sources: string[]; locationId?: string | null; assertConsent?: boolean },
  ) {
    return this.svc.importFromOrders(actorOf(user), {
      sources: body?.sources ?? [],
      locationId: body?.locationId ?? null,
      assertConsent: body?.assertConsent === true,
    });
  }

  @Post("contacts/:id/unsubscribe")
  @Roles(...MARKETING_ROLES)
  unsubscribeContact(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.svc.unsubscribeContact(actorOf(user), id);
  }

  // ── Campaigns ─────────────────────────────────────────────────────────────

  @Get("campaigns")
  @Roles(...MARKETING_ROLES)
  campaigns(@CurrentUser() user: AuthenticatedUser, @Query("locationId") locationId?: string) {
    return this.svc.listCampaigns(actorOf(user), locationId || null);
  }

  @Post("campaigns")
  @Roles(...MARKETING_ROLES)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { templateId?: string; brandId?: string | null; locationId?: string | null; name?: string },
  ) {
    return this.svc.createCampaign(actorOf(user), body ?? {});
  }

  @Get("campaigns/:id")
  @Roles(...MARKETING_ROLES)
  get(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.svc.getCampaign(actorOf(user), id);
  }

  @Patch("campaigns/:id")
  @Roles(...MARKETING_ROLES)
  update(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() body: any) {
    return this.svc.updateCampaign(actorOf(user), id, body ?? {});
  }

  @Post("campaigns/:id/duplicate")
  @Roles(...MARKETING_ROLES)
  duplicate(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.svc.duplicateCampaign(actorOf(user), id);
  }

  @Delete("campaigns/:id")
  @Roles(...MARKETING_ROLES)
  remove(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.svc.deleteCampaign(actorOf(user), id);
  }

  @Post("campaigns/:id/test")
  @Roles(...MARKETING_ROLES)
  test(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() body: { to: string[] | string }) {
    const to = Array.isArray(body?.to) ? body.to : String(body?.to ?? "").split(/[,\s]+/);
    return this.svc.testSend(actorOf(user), id, to);
  }

  @Post("campaigns/:id/send")
  @Roles(...MARKETING_ROLES)
  @ApiOperation({ summary: "Charge the wallet and queue the campaign for sending now" })
  send(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.svc.sendNow(actorOf(user), id);
  }

  @Post("campaigns/:id/schedule")
  @Roles(...MARKETING_ROLES)
  schedule(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() body: { at: string }) {
    return this.svc.schedule(actorOf(user), id, body?.at);
  }

  @Post("campaigns/:id/cancel")
  @Roles(...MARKETING_ROLES)
  cancel(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.svc.cancel(actorOf(user), id);
  }

  @Post("estimate")
  @Roles(...MARKETING_ROLES)
  @ApiOperation({ summary: "Audience size, free allowance and wallet cost" })
  estimate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { campaignId?: string; audience?: any; locationId?: string | null },
  ) {
    return this.svc.estimate(actorOf(user), body ?? {});
  }

  @Get("products")
  @Roles(...MARKETING_ROLES)
  products(
    @CurrentUser() user: AuthenticatedUser,
    @Query("brandId") brandId?: string,
    @Query("locationId") locationId?: string,
    @Query("search") search?: string,
  ) {
    return this.svc.products(actorOf(user), { brandId, locationId: locationId || null, search });
  }
}

// ── Public endpoints: what customers' inboxes and Resend call ─────────────────

const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

@ApiTags("email-marketing")
@SkipThrottle({ short: true, medium: true, webhook: true, login: true })
@BillingExempt()
@Controller({ path: "email-marketing", version: "1" })
export class EmailMarketingPublicController {
  constructor(
    private readonly svc: EmailMarketingService,
    private readonly config: ConfigService,
  ) {}

  @Get("o/:rid")
  @Public()
  async open(@Param("rid") rid: string, @Res() res: Response) {
    await this.svc.recordOpen(rid);
    res.set({
      "Content-Type": "image/gif",
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      "Content-Length": String(PIXEL.length),
    });
    res.end(PIXEL);
  }

  @Get("c/:rid/:idx")
  @Public()
  async click(@Param("rid") rid: string, @Param("idx") idx: string, @Res() res: Response) {
    const url = await this.svc.recordClick(rid, parseInt(idx, 10));
    res.redirect(302, url);
  }

  @Get("unsubscribe/info")
  @Public()
  info(@Query("t") t: string) {
    return this.svc.unsubscribeInfo(t);
  }

  /** The page's button AND the mailbox's RFC 8058 one-click POST
   *  (form-encoded `List-Unsubscribe=One-Click`, token in the query). */
  @Post("unsubscribe")
  @Public()
  @HttpCode(HttpStatus.OK)
  unsubscribe(@Query("t") qt: string, @Body() body: any) {
    return this.svc.unsubscribe(String(qt || body?.t || ""));
  }

  @Post("resubscribe")
  @Public()
  @HttpCode(HttpStatus.OK)
  resubscribe(@Body() body: { t: string }) {
    return this.svc.resubscribe(String(body?.t ?? ""));
  }

  @Post("webhooks/resend")
  @Public()
  @HttpCode(HttpStatus.OK)
  async resendWebhook(@Req() req: Request) {
    const secret = String(this.config.get<string>("app.emailMarketing.webhookSecret") ?? "");
    const raw = (req as any).rawBody?.toString("utf8") ?? JSON.stringify(req.body ?? {});
    const ok = verifySvixSignature({
      secret,
      id: req.headers["svix-id"] as string | undefined,
      timestamp: req.headers["svix-timestamp"] as string | undefined,
      signature: req.headers["svix-signature"] as string | undefined,
      body: raw,
    });
    // 200 either way: a forged payload is not something to make Resend retry.
    if (!ok) return { ok: false };
    try {
      await this.svc.handleResendEvent(req.body ?? {});
    } catch {
      /* never fail the webhook */
    }
    return { ok: true };
  }
}
