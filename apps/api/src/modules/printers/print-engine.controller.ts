// Phase AS-1 — REST surface for the print engine.
//
// Splits into three logical groups:
//
//   /v1/printer-stations/*   — operator CRUD for stations + routing rules
//   /v1/print-agents/*       — register, list, rotate-token, revoke
//   /v1/print-jobs/*         — internal lifecycle (claim/start/done/fail)
//                              + operator reprint + test-print
//
// Auth note: agent-protocol routes (claim/start/complete/fail/heartbeat)
// use a bearer X-Agent-Token rather than the user JWT — they're called
// by a bridge binary or Flutter app, not by a browser session. The
// PrintAgentsService.verifyToken() helper does the lookup.

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import {
  PrinterStationsService,
  type CreateStationDto,
  type UpdateStationDto,
} from "./printer-stations.service";
import {
  PrintAgentsService,
  type HeartbeatDto,
  type PairAgentDto,
  type RegisterAgentDto,
} from "./print-agents.service";
import {
  PrintJobsService,
  type PrintReportDto,
  type ReprintDto,
} from "./print-jobs.service";

// Printer setup is an operational device task — every role EXCEPT DRIVER
// can configure printers, stations, agents and routing. (Drivers only use
// the driver app; they have no reason to touch the print engine.)
export const MANAGE_PRINT_ROLES = [
  "PLATFORM_ADMIN",
  "TENANT_OWNER",
  "OWNER",
  "DARK_KITCHEN_MANAGER",
  "MANAGER",
  "STAFF",
  "CASHIER",
  "KITCHEN_STAFF",
  "VIEWER",
] as const;

// ──────────────────────────────────────────────────────────────────────
// Stations
// ──────────────────────────────────────────────────────────────────────

@ApiTags("printer-stations")
@ApiBearerAuth()
@Controller({ path: "printer-stations", version: "1" })
export class PrinterStationsController {
  constructor(private readonly stations: PrinterStationsService) {}

  @Get()
  @Roles(...MANAGE_PRINT_ROLES)
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
  ) {
    return this.stations.list(user.tenantId, locationId);
  }

  @Post()
  @Roles(...MANAGE_PRINT_ROLES)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateStationDto,
  ) {
    return this.stations.create(user.tenantId, dto);
  }

  @Patch(":id")
  @Roles(...MANAGE_PRINT_ROLES)
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() dto: UpdateStationDto,
  ) {
    return this.stations.update(user.tenantId, id, dto);
  }

  @Delete(":id")
  @Roles(...MANAGE_PRINT_ROLES)
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.stations.remove(user.tenantId, id);
  }

  @Put("menu-items/:menuItemId/routes")
  @Roles(...MANAGE_PRINT_ROLES)
  setMenuItemRoutes(
    @CurrentUser() user: AuthenticatedUser,
    @Param("menuItemId") menuItemId: string,
    @Body() body: { stationIds: string[] },
  ) {
    return this.stations.setMenuItemRoutes(
      user.tenantId,
      menuItemId,
      body.stationIds,
    );
  }

  @Put("categories/:categoryId/routes")
  @Roles(...MANAGE_PRINT_ROLES)
  setCategoryRoutes(
    @CurrentUser() user: AuthenticatedUser,
    @Param("categoryId") categoryId: string,
    @Body() body: { stationIds: string[] },
  ) {
    return this.stations.setCategoryRoutes(
      user.tenantId,
      categoryId,
      body.stationIds,
    );
  }

  @Put("modifier-groups/:groupId/routes")
  @Roles(...MANAGE_PRINT_ROLES)
  setModifierGroupRoutes(
    @CurrentUser() user: AuthenticatedUser,
    @Param("groupId") groupId: string,
    @Body() body: { stationIds: string[] },
  ) {
    return this.stations.setModifierGroupRoutes(
      user.tenantId,
      groupId,
      body.stationIds,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────
// Agents
// ──────────────────────────────────────────────────────────────────────

@ApiTags("print-agents")
@Controller({ path: "print-agents", version: "1" })
export class PrintAgentsController {
  constructor(private readonly agents: PrintAgentsService) {}

  @Post()
  @ApiBearerAuth()
  @Roles(...MANAGE_PRINT_ROLES)
  @ApiOperation({ summary: "Register a new agent — returns token (once)." })
  register(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterAgentDto,
  ) {
    return this.agents.register(user.tenantId, dto);
  }

  @Get()
  @ApiBearerAuth()
  @Roles(...MANAGE_PRINT_ROLES)
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
  ) {
    return this.agents.list(user.tenantId, locationId);
  }

  @Post(":id/rotate-token")
  @ApiBearerAuth()
  @Roles(...MANAGE_PRINT_ROLES)
  rotate(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.agents.rotateToken(user.tenantId, id);
  }

  @Delete(":id")
  @ApiBearerAuth()
  @Roles(...MANAGE_PRINT_ROLES)
  revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.agents.revoke(user.tenantId, id);
  }

  // ── Pairing ────────────────────────────────────────────────────────

  @Post("pair-codes")
  @ApiBearerAuth()
  @Roles(...MANAGE_PRINT_ROLES)
  @ApiOperation({ summary: "Generate a 6-char pair code + QR string" })
  createPairCode(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { locationId: string },
  ) {
    return this.agents.createPairCode(
      user.tenantId,
      user.userId,
      body.locationId,
    );
  }

  @Public()
  @Post("pair")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Agent redeems a pair code (public)" })
  pair(@Body() dto: PairAgentDto) {
    return this.agents.redeemPairCode(dto);
  }

  // ── Agent protocol — public + X-Agent-Token header auth ────────────

  @Public()
  @Post(":id/heartbeat")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Agent heartbeat (X-Agent-Token)" })
  async heartbeat(
    @Param("id") id: string,
    @Headers("x-agent-token") token: string,
    @Body() dto: HeartbeatDto,
  ) {
    if (!token) throw new UnauthorizedException("Missing X-Agent-Token");
    await this.agents.verifyToken(id, token);
    return this.agents.heartbeat(id, dto);
  }

  // ── Self-service printer binding ───────────────────────────────────
  //
  // Lets the Print Bridge see + claim printers without operators
  // having to use the dashboard. The bridge knows its own agentId and
  // apiToken; it asks the API "what printers are at my location" and
  // posts back "bind this one to me." Before this, the only way to
  // attach Printer.agentId was a dashboard form that didn't exist yet.

  @Public()
  @Get(":id/printers")
  @ApiOperation({ summary: "List printers at the agent's location (X-Agent-Token)" })
  async listMyPrinters(
    @Param("id") id: string,
    @Headers("x-agent-token") token: string,
  ) {
    if (!token) throw new UnauthorizedException("Missing X-Agent-Token");
    const agent = await this.agents.verifyToken(id, token);
    return this.agents.listLocationPrinters(agent.locationId);
  }

  @Public()
  @Post(":id/bind")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Bind a printer to this agent (X-Agent-Token)" })
  async bindPrinter(
    @Param("id") id: string,
    @Headers("x-agent-token") token: string,
    @Body() body: { printerId: string },
  ) {
    if (!token) throw new UnauthorizedException("Missing X-Agent-Token");
    const agent = await this.agents.verifyToken(id, token);
    return this.agents.bindPrinter(agent.id, agent.locationId, body.printerId);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Jobs
// ──────────────────────────────────────────────────────────────────────

@ApiTags("print-jobs")
@Controller({ path: "print-jobs", version: "1" })
export class PrintJobsController {
  constructor(
    private readonly jobs: PrintJobsService,
    private readonly agents: PrintAgentsService,
  ) {}

  // ── Operator-facing ────────────────────────────────────────────────

  @Post("reprint")
  @ApiBearerAuth()
  @Roles(...MANAGE_PRINT_ROLES, "STAFF")
  reprint(@Body() dto: ReprintDto) {
    return this.jobs.reprint(dto);
  }

  // Phase AS-4 — dashboard widget counters.
  @Get("widgets")
  @ApiBearerAuth()
  @Roles(...MANAGE_PRINT_ROLES)
  widgets(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
  ) {
    return this.jobs.widgets(user.tenantId, locationId);
  }

  @Get()
  @ApiBearerAuth()
  @Roles(...MANAGE_PRINT_ROLES)
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
    @Query("status") status?: string,
    @Query("limit") limit?: string,
  ) {
    return this.jobs.list({
      tenantId: user.tenantId,
      locationId,
      status,
      limit: limit ? parseInt(limit, 10) : 50,
    });
  }

  // Bridge polling fallback — the tablet WebView polls this for QUEUED
  // jobs to print over Bluetooth when the socket event is missed.
  // Returns recent jobs with their render payload + copies.
  @Get("pending-bridge")
  @ApiBearerAuth()
  @Roles(...MANAGE_PRINT_ROLES, "STAFF")
  pendingBridge(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
  ) {
    return this.jobs.pendingBridgeJobs(user.tenantId, locationId);
  }

  // Wipe the queue — cancel every pending/stuck job (optionally scoped
  // to one location). Backs the "Clear queue" button.
  @Post("clear-queue")
  @ApiBearerAuth()
  @Roles(...MANAGE_PRINT_ROLES)
  @HttpCode(HttpStatus.OK)
  clearQueue(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
  ) {
    return this.jobs.clearQueue(user.tenantId, locationId);
  }

  // The tablet prints receipts client-side, then calls this so the
  // server-created job(s) for the order leave the queue and "last print"
  // updates. Authed with the operator's normal session.
  @Post("order/:orderId/printed")
  @ApiBearerAuth()
  @Roles(...MANAGE_PRINT_ROLES, "STAFF")
  @HttpCode(HttpStatus.OK)
  markOrderPrinted(
    @CurrentUser() user: AuthenticatedUser,
    @Param("orderId") orderId: string,
    @Body() body?: { qr?: Record<string, unknown> },
  ) {
    // The QR decision is made entirely in the browser — printer defaults,
    // then the marketplace check, then the render. The server never saw any
    // of it, so "why was there no QR?" could only ever be answered by
    // guessing. The tablet now says which gate it took.
    if (body?.qr) {
      this.jobs.logQrDecision(orderId, body.qr);
    }
    return this.jobs.markOrderPrinted(orderId, user.tenantId);
  }

  @Post("test-print")
  @ApiBearerAuth()
  @Roles(...MANAGE_PRINT_ROLES)
  testPrint(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { printerId: string },
  ) {
    return this.jobs.createTestPrint({
      tenantId: user.tenantId,
      printerId: body.printerId,
    });
  }

  // Client-reported print outcome for the Logs feed. The tablet prints
  // client-side (Bluetooth/LAN bridge), so the server can't see failures or
  // test prints — the web app posts them here so they appear in Logs.
  @Post("report")
  @ApiBearerAuth()
  @Roles(...MANAGE_PRINT_ROLES, "STAFF")
  @HttpCode(HttpStatus.OK)
  reportPrint(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PrintReportDto,
  ) {
    return this.jobs.recordPrintReport(dto, user.tenantId);
  }

  // ── Agent protocol ─────────────────────────────────────────────────

  @Public()
  @Post("claim")
  @HttpCode(HttpStatus.OK)
  async claim(
    @Headers("x-agent-id") agentId: string,
    @Headers("x-agent-token") token: string,
    @Body()
    body: { printerIds?: string[]; locationId?: string; limit?: number },
  ) {
    if (!agentId || !token) {
      throw new UnauthorizedException(
        "Agent endpoints require X-Agent-Id + X-Agent-Token",
      );
    }
    await this.agents.verifyToken(agentId, token);
    return this.jobs.claim({ agentId, ...body });
  }

  @Public()
  @Post(":id/start")
  @HttpCode(HttpStatus.OK)
  async start(
    @Headers("x-agent-id") agentId: string,
    @Headers("x-agent-token") token: string,
    @Param("id") id: string,
  ) {
    if (!agentId || !token) throw new UnauthorizedException();
    await this.agents.verifyToken(agentId, token);
    return this.jobs.markStarted(id, agentId);
  }

  @Public()
  @Post(":id/complete")
  @HttpCode(HttpStatus.OK)
  async complete(
    @Headers("x-agent-id") agentId: string,
    @Headers("x-agent-token") token: string,
    @Param("id") id: string,
  ) {
    if (!agentId || !token) throw new UnauthorizedException();
    await this.agents.verifyToken(agentId, token);
    return this.jobs.markPrinted(id, agentId);
  }

  // Bridge-mode completion. The tablet's WebView prints over Bluetooth
  // directly (no agent claim/poll), so it marks jobs done off its normal
  // dashboard JWT session rather than agent creds. Without this, every
  // bridge-printed job sat in QUEUED forever and the Printers page filled
  // up with a growing queue.
  @Post(":id/bridge-printed")
  @ApiBearerAuth()
  @Roles(...MANAGE_PRINT_ROLES, "STAFF")
  @HttpCode(HttpStatus.OK)
  bridgePrinted(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.jobs.markPrintedByBridge(id, user.tenantId);
  }

  @Public()
  @Post(":id/fail")
  @HttpCode(HttpStatus.OK)
  async fail(
    @Headers("x-agent-id") agentId: string,
    @Headers("x-agent-token") token: string,
    @Param("id") id: string,
    @Body() body: { failureReason: string; lastError: string; retryable: boolean },
  ) {
    if (!agentId || !token) throw new UnauthorizedException();
    await this.agents.verifyToken(agentId, token);
    return this.jobs.markFailed(id, agentId, body);
  }
}
