// Phase BJ — JET Go config + dispatch endpoints.

import { Body, Controller, Get, Param, Post, Put } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { Roles } from "../../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../auth/interfaces/jwt-payload.interface";
import { JetGoConfigService } from "./jet-go-config.service";
import { JetGoDispatchService } from "./jet-go-dispatch.service";
import { JetGoClientService } from "./jet-go-client.service";

const SIMULATE_STEPS = [
  "ASSIGNED",
  "IN_TRANSIT_TO_COLLECT",
  "ARRIVED_TO_COLLECT",
  "COLLECTED",
  "IN_TRANSIT_TO_DELIVER",
  "ARRIVED_TO_DELIVER",
  "DELIVERED",
  "CANCELLED",
  "RETURN_INITIATED",
  "IN_TRANSIT_TO_RETURN",
  "RETURNED",
];

class UpsertJetGoDto {
  @IsString() clientId!: string;
  @IsString() clientSecret!: string;
  @IsOptional() @IsIn(["UK", "CA", "AU", "EU"]) market?: string;
  @IsOptional() @IsIn(["sandbox", "production"]) environment?: string;
}
class ToggleJetGoDto {
  @IsBoolean() active!: boolean;
}
class CollectPointDto {
  @IsString() collectPointId!: string;
  @IsOptional() @IsString() collectPointName?: string;
}
class SimulateDto {
  @IsOptional() @IsIn(SIMULATE_STEPS) deliveryStep?: string;
  // JET's own bounds: 0–300000ms between steps.
  @IsOptional() @IsInt() @Min(0) @Max(300_000) stepWaitDuration?: number;
}

@ApiTags("jet-go")
@ApiBearerAuth()
@Controller({ path: "jet-go", version: "1" })
export class JetGoController {
  constructor(
    private readonly config: JetGoConfigService,
    private readonly dispatch: JetGoDispatchService,
    private readonly client: JetGoClientService,
    private readonly cfg: ConfigService,
  ) {}

  private apiBase(): string {
    return (
      this.cfg.get<string>("app.apiUrl") ?? "https://orderhub-api-0re6.onrender.com"
    ).replace(/\/$/, "");
  }

  @Get("locations/:locationId/config")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "JET Go config for a location (masked; no secret)" })
  getConfig(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.config.getPublicConfig(locationId, user.tenantId, this.apiBase());
  }

  @Put("locations/:locationId/config")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Set the location's JET Go credentials" })
  upsert(
    @Param("locationId") locationId: string,
    @Body() dto: UpsertJetGoDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.config.upsert(locationId, user.tenantId, dto);
  }

  /** The collect points JET has onboarded for these credentials. The operator
   *  picks which one this shop is — there is no pickup address in JET Go. */
  @Get("locations/:locationId/collect-points")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "List the JET Go collect points these credentials can use" })
  async collectPoints(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // getPublicConfig does the tenant check; getDecrypted alone would not.
    await this.config.getPublicConfig(locationId, user.tenantId, this.apiBase());
    const creds = await this.config.getDecrypted(locationId);
    if (!creds) {
      return { ok: false, collectPoints: [], message: "Add your JET Go credentials first." };
    }
    const points = await this.client.collectPoints(creds);
    return {
      ok: true,
      collectPoints: points.map((p) => ({
        id: p.id,
        name: p.name ?? p.shortName ?? p.id,
        address: [p.address, p.city, p.postalCode].filter(Boolean).join(", "),
        countryCode: p.countryCode ?? null,
      })),
    };
  }

  @Put("locations/:locationId/collect-point")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Choose which JET Go collect point this location is" })
  setCollectPoint(
    @Param("locationId") locationId: string,
    @Body() dto: CollectPointDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.config.setCollectPoint(
      locationId,
      user.tenantId,
      dto.collectPointId,
      dto.collectPointName,
    );
  }

  /** Register our webhook URL with JET. JET stores one config per credential, so
   *  posting again simply replaces whatever was there. */
  @Post("locations/:locationId/register-webhook")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Register the OrderHub webhook URL with JET Go" })
  async registerWebhook(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const pub = await this.config.getPublicConfig(locationId, user.tenantId, this.apiBase());
    const creds = await this.config.getDecrypted(locationId);
    if (!creds || !pub.webhookUrl) {
      return { ok: false, message: "Add your JET Go credentials first." };
    }
    await this.client.createNotificationConfig(creds, {
      // JET uses this only to contact us if our endpoint starts failing. It is
      // not the operator's address: AuthenticatedUser doesn't carry one, and a
      // restaurant manager is the wrong person to page about a webhook outage.
      email: process.env.JET_GO_CONTACT_EMAIL ?? "support@orderhubsolutions.com",
      endpoint: pub.webhookUrl,
      // The secret, not the path token — see the webhook controller's note.
      secret: creds.webhookSecret,
      // TOKEN makes JET send `x-api-key: <secret>`, which is simpler to verify
      // than Basic — though the receiver accepts either.
      type: "TOKEN",
      subscriptions: ["ALL"],
    });
    return { ok: true, endpoint: pub.webhookUrl };
  }

  @Get("locations/:locationId/webhook-status")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "What JET Go currently has registered for these credentials" })
  async webhookStatus(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const pub = await this.config.getPublicConfig(locationId, user.tenantId, this.apiBase());
    const creds = await this.config.getDecrypted(locationId);
    if (!creds) return { ok: false, registered: false };
    try {
      const res = await this.client.getNotificationConfig(creds);
      const endpoint = res?.endpoint ?? res?.config?.endpoint ?? null;
      return {
        ok: true,
        registered: Boolean(endpoint),
        endpoint,
        // A mismatch is the failure mode worth naming: JET is posting somewhere
        // else, so courier updates never arrive and nothing looks broken here.
        matchesOurs: Boolean(endpoint && pub.webhookUrl && endpoint === pub.webhookUrl),
        expected: pub.webhookUrl,
      };
    } catch (err: any) {
      return { ok: false, registered: false, message: err?.message ?? "Couldn't read it." };
    }
  }

  @Post("locations/:locationId/toggle")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Activate/deactivate JET Go for a location" })
  toggle(
    @Param("locationId") locationId: string,
    @Body() dto: ToggleJetGoDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.config.setActive(locationId, user.tenantId, !!dto.active);
  }

  @Post("orders/:orderId/quote")
  @Roles("MANAGER", "OWNER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Quote a JET Go delivery for an order (no charge)" })
  quote(@Param("orderId") orderId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.dispatch.quote({ orderId, tenantId: user.tenantId });
  }

  @Post("orders/:orderId/dispatch")
  @Roles("MANAGER", "OWNER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary:
      "Dispatch an order to a JET Go courier (debits the location wallet; admin bypasses)",
  })
  dispatchOrder(@Param("orderId") orderId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.dispatch.dispatch({
      orderId,
      tenantId: user.tenantId,
      userId: user.userId,
      isAdmin: user.role === "PLATFORM_ADMIN",
    });
  }

  @Post("orders/:orderId/cancel")
  @Roles("MANAGER", "OWNER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Ask JET Go to cancel the courier (confirmed by webhook)" })
  cancel(@Param("orderId") orderId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.dispatch.cancel({ orderId, tenantId: user.tenantId });
  }

  @Post("orders/:orderId/refresh-status")
  @Roles("MANAGER", "OWNER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Poll JET Go for this delivery's status (missed-webhook recovery)" })
  refreshStatus(@Param("orderId") orderId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.dispatch.refreshStatus({ orderId, tenantId: user.tenantId });
  }

  /** Sandbox only — drives the real webhook sequence for certification. */
  @Post("orders/:orderId/simulate")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER")
  @ApiOperation({ summary: "Simulate the JET Go delivery lifecycle (sandbox only)" })
  simulate(
    @Param("orderId") orderId: string,
    @Body() dto: SimulateDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.dispatch.simulate({
      orderId,
      tenantId: user.tenantId,
      deliveryStep: dto.deliveryStep,
      stepWaitDuration: dto.stepWaitDuration,
    });
  }
}
