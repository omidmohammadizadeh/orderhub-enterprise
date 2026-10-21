import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { MARKETING_ROLES, Roles, TILL_ROLES } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import { SalonCatalogService, type SalonServiceInput, type SalonStaffInput } from "./salon-catalog.service";
import { SalonBookingService, type BookInput } from "./salon-booking.service";
import { SalonCheckoutService, type CheckoutInput } from "./salon-checkout.service";
import { SalonQueueService } from "./salon-queue.service";
import { SalonReportsService } from "./salon-reports.service";
import { SalonDepositService } from "./salon-deposit.service";

// The salon dashboard: set-up (managers), the diary and the queue (anyone on
// the till). Role lists spread the shared constants so the legacy and Team
// Roles generations can't drift apart.
const MANAGE = MARKETING_ROLES;
const OPERATE = TILL_ROLES;

function parseServices(raw?: string): Array<{ serviceId: string; addonIds?: string[] }> {
  // ?services=svc1:addonA,addonB;svc2
  return String(raw ?? "")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [serviceId = "", addons = ""] = p.split(":");
      return { serviceId, addonIds: addons ? addons.split(",").filter(Boolean) : [] };
    });
}

@ApiTags("salon")
@ApiBearerAuth()
@Controller({ path: "salon", version: "1" })
export class SalonController {
  constructor(
    private readonly catalog: SalonCatalogService,
    private readonly booking: SalonBookingService,
    private readonly checkoutSvc: SalonCheckoutService,
    private readonly queue: SalonQueueService,
    private readonly reports: SalonReportsService,
    private readonly deposits: SalonDepositService,
  ) {}

  // ── Settings ────────────────────────────────────────────────────────

  @Get("settings")
  @Roles(...OPERATE)
  getSettings(@CurrentUser() u: AuthenticatedUser, @Query("locationId") locationId: string) {
    return this.catalog.getSettings(u.tenantId, locationId);
  }

  @Put("settings")
  @Roles(...MANAGE)
  updateSettings(
    @CurrentUser() u: AuthenticatedUser,
    @Query("locationId") locationId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.catalog.updateSettings(u.tenantId, locationId, body);
  }

  @Post("enable")
  @Roles(...MANAGE)
  @ApiOperation({ summary: "Make this location a salon (optionally with a starter price list)" })
  enable(
    @CurrentUser() u: AuthenticatedUser,
    @Body() body: { locationId: string; trade?: string; starterServices?: boolean; firstStaffName?: string },
  ) {
    return this.catalog.enable(u.tenantId, body.locationId, body);
  }

  // ── Services ────────────────────────────────────────────────────────

  @Get("services")
  @Roles(...OPERATE)
  listServices(@CurrentUser() u: AuthenticatedUser, @Query("locationId") locationId: string) {
    return this.catalog.listServices(u.tenantId, locationId);
  }

  @Post("services")
  @Roles(...MANAGE)
  createService(
    @CurrentUser() u: AuthenticatedUser,
    @Query("locationId") locationId: string,
    @Body() body: SalonServiceInput,
  ) {
    return this.catalog.createService(u.tenantId, locationId, body);
  }

  @Put("services/order")
  @Roles(...MANAGE)
  reorderServices(
    @CurrentUser() u: AuthenticatedUser,
    @Query("locationId") locationId: string,
    @Body() body: { ids: string[] },
  ) {
    return this.catalog.reorderServices(u.tenantId, locationId, body?.ids);
  }

  @Post("services/import")
  @Roles(...MANAGE)
  @ApiOperation({ summary: "Import a price list from a CSV export (Fresha, Booksy, Treatwell, a spreadsheet)" })
  importServices(
    @CurrentUser() u: AuthenticatedUser,
    @Query("locationId") locationId: string,
    @Body() body: { csv: string; preview?: boolean },
  ) {
    return this.catalog.importServices(u.tenantId, locationId, body?.csv, { preview: body?.preview !== false });
  }

  @Patch("services/:id")
  @Roles(...MANAGE)
  updateService(@CurrentUser() u: AuthenticatedUser, @Param("id") id: string, @Body() body: SalonServiceInput) {
    return this.catalog.updateService(u.tenantId, id, body);
  }

  @Delete("services/:id")
  @Roles(...MANAGE)
  deleteService(@CurrentUser() u: AuthenticatedUser, @Param("id") id: string) {
    return this.catalog.deleteService(u.tenantId, id);
  }

  // ── Team ────────────────────────────────────────────────────────────

  @Get("staff")
  @Roles(...OPERATE)
  listStaff(
    @CurrentUser() u: AuthenticatedUser,
    @Query("locationId") locationId: string,
    @Query("archived") archived?: string,
  ) {
    return this.catalog.listStaff(u.tenantId, locationId, { includeArchived: archived === "1" });
  }

  @Post("staff")
  @Roles(...MANAGE)
  createStaff(
    @CurrentUser() u: AuthenticatedUser,
    @Query("locationId") locationId: string,
    @Body() body: SalonStaffInput,
  ) {
    return this.catalog.createStaff(u.tenantId, locationId, body);
  }

  @Patch("staff/:id")
  @Roles(...MANAGE)
  updateStaff(@CurrentUser() u: AuthenticatedUser, @Param("id") id: string, @Body() body: SalonStaffInput) {
    return this.catalog.updateStaff(u.tenantId, id, body);
  }

  @Delete("staff/:id")
  @Roles(...MANAGE)
  archiveStaff(@CurrentUser() u: AuthenticatedUser, @Param("id") id: string) {
    return this.catalog.archiveStaff(u.tenantId, id);
  }

  @Get("time-off")
  @Roles(...OPERATE)
  listTimeOff(
    @CurrentUser() u: AuthenticatedUser,
    @Query("locationId") locationId: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.catalog.listTimeOff(u.tenantId, locationId, from, to);
  }

  @Post("time-off")
  @Roles(...MANAGE)
  addTimeOff(
    @CurrentUser() u: AuthenticatedUser,
    @Body() body: { staffId: string; startsAt: string; endsAt: string; reason?: string; force?: boolean },
  ) {
    return this.catalog.addTimeOff(u.tenantId, body, { allowClash: body?.force === true });
  }

  @Delete("time-off/:id")
  @Roles(...MANAGE)
  removeTimeOff(@CurrentUser() u: AuthenticatedUser, @Param("id") id: string) {
    return this.catalog.removeTimeOff(u.tenantId, id);
  }

  // ── Diary ───────────────────────────────────────────────────────────

  @Get("appointments")
  @Roles(...OPERATE)
  list(
    @CurrentUser() u: AuthenticatedUser,
    @Query("locationId") locationId: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("staffId") staffId?: string,
  ) {
    return this.booking.list(u.tenantId, { locationId, from, to, staffId });
  }

  @Get("availability")
  @Roles(...OPERATE)
  @ApiOperation({ summary: "Free starts for services on a day (staff view: no lead time)" })
  async availability(
    @CurrentUser() u: AuthenticatedUser,
    @Query("locationId") locationId: string,
    @Query("date") date: string,
    @Query("services") services: string,
    @Query("staffId") staffId?: string,
    @Query("ignore") ignore?: string,
  ) {
    await this.catalog.assertLocation(u.tenantId, locationId);
    return this.booking.availability({
      locationId,
      date,
      services: parseServices(services),
      staffId: staffId || "any",
      online: false,
      ignoreAppointmentId: ignore || undefined,
    });
  }

  @Get("clients")
  @Roles(...OPERATE)
  searchClients(
    @CurrentUser() u: AuthenticatedUser,
    @Query("locationId") locationId: string,
    @Query("q") q: string,
  ) {
    return this.booking.searchClients(u.tenantId, locationId, q);
  }

  @Post("clients/import")
  @Roles(...MANAGE)
  @ApiOperation({ summary: "Import a client list from a CSV export" })
  importClients(
    @CurrentUser() u: AuthenticatedUser,
    @Query("locationId") locationId: string,
    @Body() body: { csv: string; preview?: boolean },
  ) {
    return this.catalog.importClients(u.tenantId, locationId, body?.csv, { preview: body?.preview !== false });
  }

  @Post("appointments")
  @Roles(...OPERATE)
  create(@CurrentUser() u: AuthenticatedUser, @Body() body: BookInput) {
    return this.booking.book(body, { tenantId: u.tenantId, online: false, actorUserId: u.userId });
  }

  @Get("appointments/:id")
  @Roles(...OPERATE)
  get(@CurrentUser() u: AuthenticatedUser, @Param("id") id: string) {
    return this.booking.get(u.tenantId, id);
  }

  @Patch("appointments/:id")
  @Roles(...OPERATE)
  update(@CurrentUser() u: AuthenticatedUser, @Param("id") id: string, @Body() body: any) {
    return this.booking.update(u.tenantId, id, body ?? {});
  }

  @Post("appointments/:id/status")
  @Roles(...OPERATE)
  setStatus(
    @CurrentUser() u: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: { status: string; reason?: string; refundDeposit?: boolean; notifyGuest?: boolean },
  ) {
    return this.booking.setStatus(u.tenantId, id, body);
  }

  @Post("appointments/:id/resend")
  @Roles(...OPERATE)
  resend(@CurrentUser() u: AuthenticatedUser, @Param("id") id: string) {
    return this.booking.resend(u.tenantId, id);
  }

  @Get("appointments/:id/checkout")
  @Roles(...OPERATE)
  checkoutPreview(@CurrentUser() u: AuthenticatedUser, @Param("id") id: string) {
    return this.checkoutSvc.preview(u.tenantId, id);
  }

  @Post("appointments/:id/checkout")
  @Roles(...OPERATE)
  checkout(@CurrentUser() u: AuthenticatedUser, @Param("id") id: string, @Body() body: CheckoutInput) {
    return this.checkoutSvc.checkout(u.tenantId, id, body, u.userId);
  }

  /** After a payment screen closes: pull the appointment level with its order. */
  @Post("appointments/:id/sync")
  @Roles(...OPERATE)
  async sync(@CurrentUser() u: AuthenticatedUser, @Param("id") id: string) {
    await this.booking.get(u.tenantId, id);
    await this.deposits.sync(id);
    return this.booking.get(u.tenantId, id);
  }

  @Post("quick-sale")
  @Roles(...OPERATE)
  quickSale(@CurrentUser() u: AuthenticatedUser, @Body() body: any) {
    return this.checkoutSvc.quickSale(u.tenantId, body, u.userId);
  }

  // ── Walk-in queue ───────────────────────────────────────────────────

  @Get("queue")
  @Roles(...OPERATE)
  async queueBoard(@CurrentUser() u: AuthenticatedUser, @Query("locationId") locationId: string) {
    await this.catalog.assertLocation(u.tenantId, locationId);
    return this.queue.board(locationId);
  }

  @Post("queue")
  @Roles(...OPERATE)
  async queueJoin(
    @CurrentUser() u: AuthenticatedUser,
    @Body()
    body: { locationId: string; customerName: string; customerPhone?: string; serviceIds?: string[]; preferredStaffId?: string },
  ) {
    await this.queue.join(body, { tenantId: u.tenantId, source: "STAFF" });
    return this.queue.board(body.locationId);
  }

  @Post("queue/:id/call")
  @Roles(...OPERATE)
  queueCall(@CurrentUser() u: AuthenticatedUser, @Param("id") id: string, @Body() body: { staffId?: string }) {
    return this.queue.call(u.tenantId, id, body?.staffId);
  }

  @Post("queue/:id/start")
  @Roles(...OPERATE)
  queueStart(
    @CurrentUser() u: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: { staffId: string; serviceIds?: string[]; services?: Array<{ serviceId: string; addonIds?: string[] }> },
  ) {
    return this.queue.start(u.tenantId, id, body);
  }

  @Post("queue/:id/requeue")
  @Roles(...OPERATE)
  queueRequeue(@CurrentUser() u: AuthenticatedUser, @Param("id") id: string) {
    return this.queue.requeue(u.tenantId, id);
  }

  @Post("queue/:id/done")
  @Roles(...OPERATE)
  queueDone(@CurrentUser() u: AuthenticatedUser, @Param("id") id: string) {
    return this.queue.finish(u.tenantId, id, "DONE");
  }

  @Post("queue/:id/left")
  @Roles(...OPERATE)
  queueLeft(@CurrentUser() u: AuthenticatedUser, @Param("id") id: string) {
    return this.queue.finish(u.tenantId, id, "LEFT");
  }

  // ── Reports ─────────────────────────────────────────────────────────

  @Get("reports")
  @Roles(...MANAGE)
  report(
    @CurrentUser() u: AuthenticatedUser,
    @Query("locationId") locationId: string,
    @Query("from") from: string,
    @Query("to") to: string,
  ) {
    return this.reports.summary(u.tenantId, { locationId, from, to });
  }
}

export { parseServices };
