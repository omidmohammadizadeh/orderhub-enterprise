import { Body, Controller, Get, Header, Param, Post, Query, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { Public } from "../../../common/decorators/public.decorator";
import { MARKETING_ROLES, Roles, TILL_ROLES } from "../../../common/decorators/roles.decorator";
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../../auth/interfaces/jwt-payload.interface";
import { CurrentCustomer, CustomerJwtGuard } from "../../customer-auth/customer.decorator";
import { fetchImage, renderIcon, renderStampStrip } from "./pass-art";
import { WalkInLoyaltyService } from "./walk-in-loyalty.service";

// Walk-in loyalty cards. Three audiences:
//  - the CUSTOMER, with no login: the join page and their own card, where the
//    long publicToken in the URL is the only credential;
//  - the TILL (cashier and up): look a card up, sign someone up;
//  - the OPERATOR (marketing roles): numbers and the join link for the poster.
@ApiTags("loyalty")
@Controller({ path: "loyalty/walk-in", version: "1" })
export class WalkInLoyaltyController {
  constructor(private readonly walkIn: WalkInLoyaltyService) {}

  // ── Customer (public) ────────────────────────────────────────────────────

  @Public()
  @Get("join/:shop")
  @ApiOperation({ summary: "What the counter QR's join page shows" })
  joinInfo(@Param("shop") shop: string) {
    return this.walkIn.joinInfo(shop);
  }

  @Public()
  @Post("join/:shop")
  @Throttle({ short: { limit: 3, ttl: 10000 }, medium: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: "Join a shop's loyalty card" })
  join(
    @Param("shop") shop: string,
    @Body() body: { firstName?: string; email?: string; phone?: string; marketingConsent?: boolean },
  ) {
    return this.walkIn.join(shop, body ?? {});
  }

  @Public()
  @Post("join/:shop/verify")
  @Throttle({ short: { limit: 5, ttl: 10000 }, medium: { limit: 15, ttl: 60000 } })
  @ApiOperation({ summary: "Open an existing card on this phone with the emailed code" })
  verify(@Param("shop") shop: string, @Body() body: { email?: string; phone?: string; code?: string }) {
    return this.walkIn.verify(shop, body ?? {});
  }

  /** The online Rewards page: this signed-in customer's wallet card here. */
  @Public()
  @UseGuards(CustomerJwtGuard)
  @Post("link-account")
  @ApiOperation({ summary: "Link my online account to this shop's wallet card" })
  linkAccount(@Body() body: { locationId?: string }, @CurrentCustomer() customer: { id: string }) {
    return this.walkIn.linkAccount(customer.id, String(body?.locationId ?? ""));
  }

  @Public()
  @Get("card/:token")
  @ApiOperation({ summary: "A customer's walk-in card" })
  card(@Param("token") token: string) {
    return this.walkIn.publicCard(token);
  }

  @Public()
  @Get("card/:token/apple")
  @ApiOperation({ summary: "The Apple Wallet pass (.pkpass)" })
  async applePass(@Param("token") token: string, @Res() res: Response) {
    const buf = await this.walkIn.applePass(token);
    res
      .status(200)
      .set({
        "Content-Type": "application/vnd.apple.pkpass",
        "Content-Disposition": 'attachment; filename="loyalty.pkpass"',
        "Cache-Control": "no-store",
      })
      .send(buf);
  }

  @Public()
  @Get("card/:token/google")
  @ApiOperation({ summary: "The Add to Google Wallet link" })
  googleSave(@Param("token") token: string) {
    return this.walkIn.googleSaveUrl(token);
  }

  // Pictures for the passes. The strip depends only on its three numbers, so
  // it carries no ids and can be cached for good.
  @Public()
  @Get("art/strip.png")
  @Header("Cache-Control", "public, max-age=31536000, immutable")
  async strip(
    @Query("s") s: string,
    @Query("of") of: string,
    @Query("c") c: string,
    @Query("i") i: string,
    @Res() res: Response,
  ) {
    const required = Math.min(20, Math.max(2, Math.round(Number(of) || 6)));
    const stamps = Math.min(required, Math.max(0, Math.round(Number(s) || 0)));
    const png = await renderStampStrip(stamps, required, `#${String(c ?? "").slice(0, 6)}`, 3, i);
    res.type("image/png").send(png);
  }

  @Public()
  @Get("art/icon/:file")
  @Header("Cache-Control", "public, max-age=86400")
  async icon(@Param("file") file: string, @Res() res: Response) {
    const { logoUrl, color, stampIcon } = await this.walkIn.iconForCard(file.replace(/\.png$/i, ""));
    const png = await renderIcon(await fetchImage(logoUrl), color, 660, stampIcon);
    res.type("image/png").send(png);
  }

  // ── Till ─────────────────────────────────────────────────────────────────

  @Get("till-status")
  @ApiBearerAuth()
  @Roles(...TILL_ROLES)
  @ApiOperation({ summary: "Is the walk-in card on at this shop (for the till)" })
  tillStatus(@Query("locationId") locationId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.walkIn.tillStatus(user.tenantId, locationId);
  }

  @Get("lookup")
  @ApiBearerAuth()
  @Roles(...TILL_ROLES)
  @ApiOperation({ summary: "Find a walk-in card by scan, card number or phone" })
  lookup(
    @Query("locationId") locationId: string,
    @Query("q") q: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.walkIn.lookup(user.tenantId, locationId, q ?? "");
  }

  @Post("enrol")
  @ApiBearerAuth()
  @Roles(...TILL_ROLES)
  @ApiOperation({ summary: "Sign a customer up at the till; the card goes by email" })
  enrol(
    @Body() body: { locationId: string; email?: string; phone?: string; firstName?: string; marketingConsent?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.walkIn.enrol(user.tenantId, body.locationId, body);
  }

  @Post("members/:memberId/card-link")
  @ApiBearerAuth()
  @Roles(...TILL_ROLES)
  @ApiOperation({ summary: "The card link, to show as a QR on the till for the customer to scan" })
  cardLink(@Param("memberId") memberId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.walkIn.cardLink(user.tenantId, memberId);
  }

  @Post("members/:memberId/resend")
  @ApiBearerAuth()
  @Roles(...TILL_ROLES)
  @ApiOperation({ summary: "Email the customer their card link again" })
  resend(@Param("memberId") memberId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.walkIn.resendLink(user.tenantId, memberId);
  }

  // ── Operator ─────────────────────────────────────────────────────────────

  @Get("overview/:locationId")
  @ApiBearerAuth()
  @Roles(...MARKETING_ROLES)
  @ApiOperation({ summary: "Walk-in card numbers, join link and wallet status" })
  overview(@Param("locationId") locationId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.walkIn.overview(user.tenantId, locationId);
  }
}
