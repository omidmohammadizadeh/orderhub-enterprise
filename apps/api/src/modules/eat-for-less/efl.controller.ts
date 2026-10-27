import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { Public } from "../../common/decorators/public.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import { CurrentCustomer, CustomerJwtGuard } from "../customer-auth/customer.decorator";
import type { CheckoutDto } from "../ordering/ordering.service";
import { EflService } from "./efl.service";
import { EflApplicationsService } from "./efl-applications.service";
import { EflHygieneService } from "./efl-hygiene.service";
import { EflAccountService } from "./efl-account.service";
import { EflAdsService } from "./efl-ads.service";
import { EflStatementsService } from "./efl-statements.service";
import { EflCampaignsService } from "./efl-campaigns.service";
import { londonDateKey, londonWeekStart, weekStartFromKey } from "./efl-ads-rules";


/** The anonymous viewer an app request comes from, for sponsored places:
 *  its install id (x-efl-viewer), else its IP and browser. Always hashed. */
function viewerFrom(req: Request): string {
  return EflAdsService.viewerKey({
    installId: (req.headers["x-efl-viewer"] as string | undefined) ?? null,
    ip: req.ip ?? null,
    ua: (req.headers["user-agent"] as string | undefined) ?? null,
  });
}

class AdTapDto {
  @IsString() @MaxLength(2000) token!: string;
}

class AdCampaignDto {
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsNumber() @Min(0) @Max(1000) weeklyBudget?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(5) maxBid?: number;
}

class EmailStatementDto {
  @IsOptional() @IsEmail() to?: string;
}

class SendWeekDto {
  @IsString() @MaxLength(10) week!: string;
}

function sendPdf(res: Response, bytes: Uint8Array, filename: string) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.end(Buffer.from(bytes));
}

class CampaignDto {
  @IsIn(["PUSH", "EMAIL"]) channel!: "PUSH" | "EMAIL";
  @IsString() @MaxLength(140) title!: string;
  @IsString() @MaxLength(4000) body!: string;
  @IsOptional() @IsString() @MaxLength(40) ctaLabel?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) ctaUrl?: string | null;
}

class CampaignTestDto {
  @IsEmail() to!: string;
}

class AdminAdPauseDto {
  @IsBoolean() paused!: boolean;
}

class StartPhoneDto {
  @IsString() @MaxLength(32) phone!: string;
}

class VerifyPhoneDto {
  @IsString() @MaxLength(12) code!: string;
}

class MarketingDto {
  @IsBoolean() optIn!: boolean;
}

class UpdateListingDto {
  @IsOptional() @IsBoolean() listed?: boolean;
  @IsOptional() @IsString() brandId?: string | null;
  @IsOptional() @IsIn(["OWN_DRIVERS", "COURIER", "OWN_THEN_COURIER"])
  deliveryMode?: "OWN_DRIVERS" | "COURIER" | "OWN_THEN_COURIER";
  @IsOptional() @IsBoolean() acceptsDelivery?: boolean;
  @IsOptional() @IsBoolean() acceptsCollection?: boolean;
  @IsOptional() @IsString() @MaxLength(400) description?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) heroImageUrl?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) logoUrl?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(8) @IsString({ each: true }) cuisines?: string[];
  // Empty string clears it back to the account's own email.
  @IsOptional() @IsString() @MaxLength(254) statementEmail?: string | null;
}

class AdminUpdateListingDto {
  @IsOptional() @IsIn(["PENDING", "APPROVED", "SUSPENDED"]) status?: "PENDING" | "APPROVED" | "SUSPENDED";
  @IsOptional() @IsNumber() @Min(0) @Max(40) commissionPercent?: number | null;
  @IsOptional() @IsString() @MaxLength(40) hiddenReason?: string | null;
}

class UpdateConfigDto {
  @IsOptional() @IsNumber() @Min(0) @Max(40) defaultCommissionPercent?: number;
  @IsOptional() @IsNumber() @Min(0) pinMinOrderTotal?: number;
  @IsOptional() @IsBoolean() pinForNewCustomers?: boolean;
  @IsOptional() @IsNumber() @Min(0) firstOrderMaxTotal?: number;
  @IsOptional() @IsInt() @Min(1) @Max(50) maxOrdersPerHour?: number;
  @IsOptional() @IsInt() @Min(0) @Max(5) minHygieneRating?: number;
}

class ApplicationDto {
  @IsString() @MaxLength(120) businessName!: string;
  @IsOptional() @IsString() @MaxLength(12) companyNumber?: string;
  @IsOptional() @IsString() @MaxLength(40) cuisine?: string;
  @IsString() @MaxLength(160) addressLine1!: string;
  @IsString() @MaxLength(80) city!: string;
  @IsString() @MaxLength(12) postcode!: string;
  @IsString() @MaxLength(60) firstName!: string;
  @IsString() @MaxLength(60) lastName!: string;
  @IsString() @MaxLength(32) phone!: string;
  @IsEmail() @MaxLength(160) email!: string;
  @IsOptional() @IsString() @MaxLength(500) menuUrl?: string;
  @IsOptional() @IsString() @MaxLength(500) hygieneUrl?: string;
  // data: URLs; size is checked after decoding.
  @IsOptional() @IsString() @MaxLength(5_000_000) idDocument?: string;
  @IsOptional() @IsString() @MaxLength(5_000_000) bankStatement?: string;
}

class AddressDto {
  @IsOptional() @IsString() @MaxLength(40) label?: string | null;
  @IsString() @MaxLength(160) line1!: string;
  @IsOptional() @IsString() @MaxLength(160) line2?: string | null;
  @IsString() @MaxLength(80) city!: string;
  @IsString() @MaxLength(12) postcode!: string;
  @IsOptional() @IsNumber() latitude?: number | null;
  @IsOptional() @IsNumber() longitude?: number | null;
  @IsOptional() @IsString() @MaxLength(300) instructions?: string | null;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

class UpdateAddressDto {
  @IsOptional() @IsString() @MaxLength(40) label?: string | null;
  @IsOptional() @IsString() @MaxLength(160) line1?: string;
  @IsOptional() @IsString() @MaxLength(160) line2?: string | null;
  @IsOptional() @IsString() @MaxLength(80) city?: string;
  @IsOptional() @IsString() @MaxLength(12) postcode?: string;
  @IsOptional() @IsNumber() latitude?: number | null;
  @IsOptional() @IsNumber() longitude?: number | null;
  @IsOptional() @IsString() @MaxLength(300) instructions?: string | null;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

class PushDto {
  @IsString() @MaxLength(200) token!: string;
  @IsOptional() @IsIn(["ios", "android"]) platform?: "ios" | "android";
  @IsOptional() @IsBoolean() marketingOptIn?: boolean;
}

class PushUnregisterDto {
  @IsString() @MaxLength(200) token!: string;
}

class DecideApplicationDto {
  @IsIn(["APPROVED", "DECLINED", "WAITING_INFO"]) status!: "APPROVED" | "DECLINED" | "WAITING_INFO";
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

class LinkHygieneDto {
  @IsOptional() @IsString() @MaxLength(500) url?: string;
}

// Roles that may change a shop's own listing — the same people who can edit
// the location's settings.
const LISTING_WRITE = ["PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "MANAGER", "DARK_KITCHEN_MANAGER"] as const;

/** The Eat For Less app — browsing is public, ordering needs a customer. */
@ApiTags("eat-for-less")
@Controller({ path: "efl", version: "1" })
export class EflAppController {
  constructor(
    private readonly efl: EflService,
    private readonly applications: EflApplicationsService,
    private readonly account: EflAccountService,
    private readonly ads: EflAdsService,
    private readonly campaigns: EflCampaignsService,
  ) {}

  // One-click unsubscribe from Eat For Less emails: the link in every email
  // (GET), and the List-Unsubscribe-Post header mail apps use (POST).
  @Public()
  @Get("unsubscribe")
  async unsubscribePage(@Query("t") token: string, @Res() res: Response) {
    const ok = await this.campaigns.unsubscribe(token);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Eat For Less</title>` +
        `<body style="margin:0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#D4FF3F;color:#0B0B0B;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box">` +
        `<div style="max-width:420px;text-align:center"><div style="font-size:28px;font-weight:900">eat for less</div>` +
        `<p style="font-size:18px">${ok ? "You won't get offers by email from us any more." : "That link has expired. Turn offers off in the app under Account."}</p></div></body>`,
    );
  }

  @Public()
  @Post("unsubscribe")
  async unsubscribeOneClick(@Query("t") token: string) {
    return { ok: await this.campaigns.unsubscribe(token) };
  }

  @Public()
  @Get("config")
  @ApiOperation({ summary: "Public app settings (Stripe publishable key)" })
  config() {
    return this.account.appConfig();
  }

  @Public()
  @UseGuards(CustomerJwtGuard)
  @Get("me")
  @ApiOperation({ summary: "The signed-in customer's Eat For Less flags" })
  me(@CurrentCustomer() customer: { id: string }) {
    return this.account.me(customer);
  }

  @Public()
  @UseGuards(CustomerJwtGuard)
  @Get("me/addresses")
  addresses(@CurrentCustomer() customer: { id: string }) {
    return this.account.addresses(customer);
  }

  @Public()
  @UseGuards(CustomerJwtGuard)
  @Post("me/addresses")
  addAddress(@CurrentCustomer() customer: { id: string }, @Body() dto: AddressDto) {
    return this.account.addAddress(customer, dto);
  }

  @Public()
  @UseGuards(CustomerJwtGuard)
  @Patch("me/addresses/:id")
  updateAddress(@CurrentCustomer() customer: { id: string }, @Param("id") id: string, @Body() dto: UpdateAddressDto) {
    return this.account.updateAddress(customer, id, dto);
  }

  @Public()
  @UseGuards(CustomerJwtGuard)
  @Delete("me/addresses/:id")
  removeAddress(@CurrentCustomer() customer: { id: string }, @Param("id") id: string) {
    return this.account.removeAddress(customer, id);
  }

  @Public()
  @UseGuards(CustomerJwtGuard)
  @Get("me/favourites")
  favourites(@CurrentCustomer() customer: { id: string }) {
    return this.account.favourites(customer);
  }

  @Public()
  @UseGuards(CustomerJwtGuard)
  @Put("me/favourites/:listingId")
  addFavourite(@CurrentCustomer() customer: { id: string }, @Param("listingId") listingId: string) {
    return this.account.addFavourite(customer, listingId);
  }

  @Public()
  @UseGuards(CustomerJwtGuard)
  @Delete("me/favourites/:listingId")
  removeFavourite(@CurrentCustomer() customer: { id: string }, @Param("listingId") listingId: string) {
    return this.account.removeFavourite(customer, listingId);
  }

  @Public()
  @UseGuards(CustomerJwtGuard)
  @Post("me/push")
  @ApiOperation({ summary: "Register this phone for the customer's order updates" })
  registerPush(@CurrentCustomer() customer: { id: string }, @Body() dto: PushDto) {
    return this.account.registerPush(customer, dto);
  }

  @Public()
  @UseGuards(CustomerJwtGuard)
  @Post("me/push/unregister")
  unregisterPush(@CurrentCustomer() customer: { id: string }, @Body() dto: PushUnregisterDto) {
    return this.account.unregisterPush(customer, dto.token);
  }

  @Public()
  @Get("shops")
  @ApiOperation({ summary: "Eat For Less shops near a point, open ones first" })
  shops(
    @Req() req: Request,
    @Query("lat") lat: string,
    @Query("lng") lng: string,
    @Query("postcode") postcode?: string,
  ) {
    return this.efl.discover({ lat: Number(lat), lng: Number(lng), postcode }, viewerFrom(req));
  }

  @Public()
  @Post("ads/tap")
  @Throttle({ short: { limit: 10, ttl: 10000 } })
  @ApiOperation({ summary: "A tap on a sponsored shop (charged once, at the auction's price)" })
  adTap(@Req() req: Request, @Body() dto: AdTapDto) {
    return this.ads.tap(dto.token, viewerFrom(req));
  }

  @Public()
  @Get("shops/:listingId/menu")
  @ApiOperation({ summary: "A shop's menu at Eat For Less prices" })
  menu(@Param("listingId") listingId: string) {
    return this.efl.menu(listingId);
  }

  // @Public() opts out of the staff guard; the customer guard then decides.
  @Public()
  @UseGuards(CustomerJwtGuard)
  @Post("shops/:listingId/checkout")
  @Throttle({ short: { limit: 3, ttl: 10000 }, medium: { limit: 20, ttl: 60000 } })
  @ApiOperation({ summary: "Place an Eat For Less order (card)" })
  checkout(
    @CurrentCustomer() customer: { id: string },
    @Param("listingId") listingId: string,
    @Body() dto: CheckoutDto,
    @Req() req: Request,
  ) {
    // Either key may have tapped the sponsored place that brought this order.
    const keys = [viewerFrom(req), EflAdsService.viewerKey({ customerId: customer.id })];
    return this.efl.checkout(customer, listingId, dto, keys);
  }

  @Public()
  @Post("applications")
  @Throttle({ short: { limit: 2, ttl: 60000 }, medium: { limit: 5, ttl: 3600000 } })
  @ApiOperation({ summary: "Partner with Eat For Less: a shop applies to join" })
  apply(@Body() dto: ApplicationDto) {
    return this.applications.submit(dto);
  }

  @Public()
  @UseGuards(CustomerJwtGuard)
  @Get("me/orders")
  myOrders(@CurrentCustomer() customer: { id: string }) {
    return this.efl.myOrders(customer);
  }

  @Public()
  @UseGuards(CustomerJwtGuard)
  @Get("me/orders/:orderId")
  myOrder(@CurrentCustomer() customer: { id: string }, @Param("orderId") orderId: string) {
    return this.efl.myOrder(customer, orderId);
  }

  @Public()
  @UseGuards(CustomerJwtGuard)
  @Get("me/orders/:orderId/messages")
  @ApiOperation({ summary: "Messages with the driver on this order (marks them read)" })
  myOrderMessages(@CurrentCustomer() customer: { id: string }, @Param("orderId") orderId: string) {
    return this.efl.myOrderMessages(customer, orderId);
  }

  @Public()
  @UseGuards(CustomerJwtGuard)
  @Post("me/orders/:orderId/messages")
  @ApiOperation({ summary: "Message the driver on this order" })
  sendMyOrderMessage(
    @CurrentCustomer() customer: { id: string },
    @Param("orderId") orderId: string,
    @Body() body: { body?: string },
  ) {
    return this.efl.sendMyOrderMessage(customer, orderId, String(body?.body ?? ""));
  }

  @Public()
  @UseGuards(CustomerJwtGuard)
  @Post("me/phone/start")
  @Throttle({ short: { limit: 2, ttl: 30000 } })
  @ApiOperation({ summary: "Text a 6-digit code to the customer's mobile" })
  startPhone(@CurrentCustomer() customer: { id: string }, @Body() dto: StartPhoneDto) {
    return this.efl.startPhoneVerification(customer, dto.phone);
  }

  @Public()
  @UseGuards(CustomerJwtGuard)
  @Post("me/phone/verify")
  @Throttle({ short: { limit: 5, ttl: 60000 } })
  verifyPhone(@CurrentCustomer() customer: { id: string }, @Body() dto: VerifyPhoneDto) {
    return this.efl.verifyPhone(customer, dto.code);
  }

  @Public()
  @UseGuards(CustomerJwtGuard)
  @Patch("me/marketing")
  marketing(@CurrentCustomer() customer: { id: string }, @Body() dto: MarketingDto) {
    return this.efl.setMarketing(customer, dto.optIn);
  }
}

/** OrderHub → Platforms → Eat For Less: a shop's own listing. */
@ApiTags("eat-for-less")
@ApiBearerAuth()
@Controller({ path: "efl/listing", version: "1" })
export class EflListingController {
  constructor(
    private readonly efl: EflService,
    private readonly ads: EflAdsService,
    private readonly statements: EflStatementsService,
  ) {}

  @Get(":locationId/statements")
  async listStatements(@CurrentUser() user: AuthenticatedUser, @Param("locationId") locationId: string) {
    await this.efl.assertLocation(user.tenantId, locationId);
    return {
      recipient: await this.statements.recipientFor(locationId),
      weeks: await this.statements.list(locationId),
    };
  }

  @Get(":locationId/statements/:week")
  async statement(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
    @Param("week") week: string,
  ) {
    await this.efl.assertLocation(user.tenantId, locationId);
    return this.statements.build(locationId, week);
  }

  @Get(":locationId/statements/:week/pdf")
  async statementPdf(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
    @Param("week") week: string,
    @Res() res: Response,
  ) {
    await this.efl.assertLocation(user.tenantId, locationId);
    const statement = await this.statements.build(locationId, week);
    sendPdf(res, await this.statements.pdf(statement), `eat-for-less-${week}.pdf`);
  }

  @Post(":locationId/statements/:week/email")
  @Roles(...LISTING_WRITE)
  async emailStatement(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
    @Param("week") week: string,
    @Body() dto: EmailStatementDto,
  ) {
    await this.efl.assertLocation(user.tenantId, locationId);
    return this.statements.emailStatement(locationId, week, dto.to);
  }

  @Get(":locationId/ads")
  async getAds(@CurrentUser() user: AuthenticatedUser, @Param("locationId") locationId: string) {
    await this.efl.assertLocation(user.tenantId, locationId);
    return this.ads.campaignForLocation(locationId);
  }

  @Put(":locationId/ads")
  @Roles(...LISTING_WRITE)
  async saveAds(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
    @Body() dto: AdCampaignDto,
  ) {
    await this.efl.assertLocation(user.tenantId, locationId);
    return this.ads.saveCampaign(locationId, dto);
  }

  @Get(":locationId")
  get(@CurrentUser() user: AuthenticatedUser, @Param("locationId") locationId: string) {
    return this.efl.getListing(user.tenantId, locationId);
  }

  @Put(":locationId")
  @Roles(...LISTING_WRITE)
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
    @Body() dto: UpdateListingDto,
  ) {
    return this.efl.updateListing(user.tenantId, locationId, dto);
  }
}

/** The Eat For Less Console's API. PLATFORM_ADMIN only: commission, approval
 *  and the platform rules are ours, never a shop's. */
@ApiTags("Admin")
@ApiBearerAuth()
@Roles("PLATFORM_ADMIN")
@Controller({ path: "admin/efl", version: "1" })
export class EflAdminController {
  constructor(
    private readonly efl: EflService,
    private readonly applications: EflApplicationsService,
    private readonly hygiene: EflHygieneService,
    private readonly ads: EflAdsService,
    private readonly statements: EflStatementsService,
    private readonly campaigns: EflCampaignsService,
  ) {}

  @Get("campaigns")
  async listCampaigns() {
    const [campaigns, audience] = await Promise.all([this.campaigns.list(), this.campaigns.audience()]);
    return { campaigns, audience };
  }

  @Post("campaigns")
  createCampaign(@Body() dto: CampaignDto, @CurrentUser() user: AuthenticatedUser) {
    return this.campaigns.create(dto, user.userId);
  }

  @Put("campaigns/:id")
  updateCampaign(@Param("id") id: string, @Body() dto: CampaignDto) {
    return this.campaigns.update(id, dto);
  }

  @Delete("campaigns/:id")
  deleteCampaign(@Param("id") id: string) {
    return this.campaigns.remove(id);
  }

  @Post("campaigns/:id/test")
  testCampaign(@Param("id") id: string, @Body() dto: CampaignTestDto) {
    return this.campaigns.sendTest(id, dto.to);
  }

  @Post("campaigns/:id/send")
  sendCampaign(@Param("id") id: string) {
    return this.campaigns.send(id);
  }

  @Get("statements")
  @ApiOperation({ summary: "Every shop's statement for a week (default: last week)" })
  statementsWeek(@Query("week") week?: string) {
    const lastWeek = londonDateKey(londonWeekStart(new Date(londonWeekStart(new Date()).getTime() - 86_400_000)));
    return this.statements.adminWeek(week || lastWeek);
  }

  @Get("statements/:locationId/:week/pdf")
  async adminStatementPdf(@Param("locationId") locationId: string, @Param("week") week: string, @Res() res: Response) {
    const statement = await this.statements.build(locationId, week);
    sendPdf(res, await this.statements.pdf(statement), `eat-for-less-${week}.pdf`);
  }

  @Post("statements/send")
  @ApiOperation({ summary: "Email a week's statements to every shop not yet sent one" })
  async sendStatements(@Body() dto: SendWeekDto) {
    const start = weekStartFromKey(dto.week);
    if (!start) return { sent: 0 };
    return { sent: await this.statements.sendWeek(start) };
  }

  @Get("ads")
  adCampaigns() {
    return this.ads.adminCampaigns();
  }

  @Patch("ads/:listingId")
  pauseAds(@Param("listingId") listingId: string, @Body() dto: AdminAdPauseDto) {
    return this.ads.adminPause(listingId, dto.paused);
  }

  @Get("applications")
  listApplications() {
    return this.applications.list();
  }

  @Get("applications/:id")
  getApplication(@Param("id") id: string) {
    return this.applications.get(id);
  }

  @Post("applications/:id/recheck")
  recheckApplication(@Param("id") id: string) {
    return this.applications.runChecks(id);
  }

  @Patch("applications/:id")
  decideApplication(
    @Param("id") id: string,
    @Body() dto: DecideApplicationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.applications.decide(id, dto, user.userId);
  }

  @Get("hygiene")
  hygieneList() {
    return this.hygiene.list();
  }

  @Post("hygiene/check-now")
  hygieneCheckNow() {
    return this.hygiene.checkAll();
  }

  @Post("hygiene/:listingId/link")
  @ApiOperation({ summary: "Link a listing to its FSA record (by link, or found by name and postcode)" })
  hygieneLink(@Param("listingId") listingId: string, @Body() dto: LinkHygieneDto) {
    return this.hygiene.link(listingId, dto.url);
  }

  @Get("summary")
  summary() {
    return this.efl.adminSummary();
  }

  @Get("listings")
  listings() {
    return this.efl.adminListings();
  }

  @Patch("listings/:id")
  updateListing(@Param("id") id: string, @Body() dto: AdminUpdateListingDto) {
    return this.efl.adminUpdateListing(id, dto);
  }

  @Post("listings/place-on-map")
  @ApiOperation({ summary: "Geocode every listed shop that has no coordinates yet" })
  placeOnMap() {
    return this.efl.adminPlaceShopsOnMap();
  }

  @Get("config")
  config() {
    return this.efl.getConfig();
  }

  @Put("config")
  updateConfig(@Body() dto: UpdateConfigDto) {
    return this.efl.updateConfig(dto);
  }
}
