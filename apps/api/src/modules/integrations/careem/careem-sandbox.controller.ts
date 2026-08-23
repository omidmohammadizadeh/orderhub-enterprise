import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { Roles } from "../../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../auth/interfaces/jwt-payload.interface";
import { CareemSandboxService } from "./careem-sandbox.service";
import { CareemMenuPublishService } from "./careem-menu-publish.service";
import { CareemOrderService } from "./careem-order.service";
import { CareemStoreService } from "./careem-store.service";

// Driving the Careem integration with no Careem.
//
// Two halves, and they are usefully independent:
//
//   OUTBOUND — point CAREEM_API_BASE at /api/v1/careem-mock and every call we
//   make runs for real against a stand-in that enforces their documented
//   rules. `calls` reads back exactly what we sent.
//
//   INBOUND — `simulate-order` builds an ORDER_CREATED in their documented
//   shape from a real menu and hands it to the same code path a genuine
//   webhook takes. An order appears on the board, and accepting it pushes back
//   out through the mock. That half needs no credentials at all and is the
//   larger half of the integration.
//
// `dry-run` sends nothing anywhere: it returns the catalog we would push, so
// prices, ids and their group rules can be read before anything leaves.
@ApiTags("integrations")
@ApiBearerAuth()
@Controller({ path: "integrations/careem/sandbox", version: "1" })
export class CareemSandboxController {
  private readonly logger = new Logger(CareemSandboxController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sandbox: CareemSandboxService,
    private readonly menu: CareemMenuPublishService,
    private readonly orders: CareemOrderService,
    private readonly store: CareemStoreService,
  ) {}

  @Get("status")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Is the Careem sandbox on, and what does it hold?" })
  status() {
    return {
      enabled: this.sandbox.enabled,
      howToEnable:
        "Set CAREEM_SANDBOX=true and CAREEM_API_BASE=<this API>/api/v1/careem-mock. " +
        "It refuses to run while CAREEM_ENV=production — a mock answering there " +
        "would look exactly like a working integration.",
      ...this.sandbox.snapshot(),
    };
  }

  @Get("calls")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Every request we sent the mock, newest first" })
  calls(@Query("limit") limit?: string) {
    return {
      calls: this.sandbox.recent(Math.min(200, Math.max(1, Number(limit) || 50))),
    };
  }

  @Post("reset")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Empty the sandbox and start again" })
  reset() {
    this.assertEnabled();
    this.sandbox.reset();
    return { ok: true };
  }

  /**
   * The step Careem's operations team does by hand.
   *
   * Worth doing in two goes: publish the menu BEFORE calling this and watch it
   * fail with "branch_id is not mapped", because that is the error the real
   * integration will meet first and it is better met here.
   */
  @Post("locations/:locationId/map")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Map the branch, as Careem operations would" })
  map(@Param("locationId") locationId: string) {
    this.assertEnabled();
    return this.sandbox.mapBranch(locationId);
  }

  @Get("locations/:locationId/menu/dry-run")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary: "The exact catalog we would send Careem. Sends nothing.",
  })
  async dryRun(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.menu.dryRun(locationId, user.tenantId);
    return {
      ...result,
      priceUnit: process.env.CAREEM_PRICE_UNIT === "minor" ? "minor" : "major",
      readThis:
        "Careem's schema types catalog prices as an integer and never says of " +
        "what. Check a price here against what the item really costs before " +
        "the first real push — 11.50 sent as 11 or as 1150 both look plausible " +
        "in isolation.",
    };
  }

  /**
   * An order, as Careem would send one.
   *
   * Built from the location's real menu so item and option ids resolve to real
   * names, which is the half of the transformer a hand-written fixture cannot
   * test. Their worked pricing example is followed exactly, so the totals on
   * the board can be checked against arithmetic they published.
   */
  @Post("locations/:locationId/simulate-order")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Push a Careem-shaped order through the real intake" })
  async simulateOrder(
    @Param("locationId") locationId: string,
    @Body()
    body: {
      selfDelivery?: boolean;
      scheduled?: boolean;
      itemCount?: number;
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    this.assertEnabled();

    const location = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null, brand: { tenantId: user.tenantId } },
      select: { id: true, name: true, brandId: true },
    });
    if (!location) throw new NotFoundException("Location not found");

    const dry = await this.menu.dryRun(locationId, user.tenantId);
    const catalogItems = (dry.payload?.items ?? []) as Array<{
      id: string;
      name: string;
      price: number;
    }>;
    if (!catalogItems.length) {
      throw new BadRequestException(
        "This location's menu produced no publishable items — fix the problems " +
          "listed by dry-run first, or there is nothing for an order to contain.",
      );
    }

    const wanted = Math.min(Math.max(1, body?.itemCount ?? 2), catalogItems.length);
    const chosen = catalogItems.slice(0, wanted);
    // The catalog carries prices in whatever unit we publish; orders come back
    // in major units, so undo it here rather than inventing figures.
    const minor = process.env.CAREEM_PRICE_UNIT === "minor";
    const major = (n: number) => (minor ? n / 100 : n);

    const originalTotal = chosen.reduce((sum, i) => sum + major(i.price), 0);
    const deliveryFee = 7;
    const serviceFee = 1;
    const selfDelivery = !!body?.selfDelivery;

    const order = {
      id: Number(`99${Date.now() % 100000}`),
      status: "pending",
      delivery_type: selfDelivery ? "merchant" : "careem",
      merchant_pay_type: "prepaid",
      branch: { id: location.id, name: location.name, brand_id: location.brandId },
      notes: "Sandbox order — no doorbell",
      created_at: new Date().toISOString(),
      is_scheduled: !!body?.scheduled,
      ...(body?.scheduled
        ? {
            delivery: {
              schedule_detail: {
                time_slot: {
                  start: new Date(Date.now() + 3_600_000).toISOString(),
                  end: new Date(Date.now() + 5_400_000).toISOString(),
                },
              },
            },
          }
        : {}),
      price: {
        original_total_price: round(originalTotal),
        // Their formula: sub-total (no tax, no discounts here) plus both fees.
        total_taxable_price: round(originalTotal + deliveryFee + serviceFee),
        tax_percentage: 0,
        delivery_fee: deliveryFee,
        service_fee: serviceFee,
        careem_discount_amount: 0,
        merchant_discount_amount: 0,
        careem_promo_amount: 0,
        merchant_promo_amount: 0,
      },
      // Careem send customer details ONLY for self-delivery. A Careem-delivered
      // order with an address here would be wrong, and this is where that gets
      // noticed.
      ...(selfDelivery
        ? {
            customer: {
              name: "Sandbox Customer",
              phone_number: "971500000000",
              payment_type: "card",
              address: {
                building: "Marina Gate 2",
                street: "Al Marsa Street",
                area: "Dubai Marina",
                city: "Dubai",
                note: "Concierge desk",
                location: { lat: "25.0805", lng: "55.1403" },
              },
            },
            cash_in: 0,
          }
        : { cash_in: 0 }),
      items: chosen.map((item) => ({
        id: item.id,
        quantity: 1,
        price: major(item.price),
        total_price: major(item.price),
        groups: [],
      })),
    };

    const created = await this.orders.ingest(order as never);
    return {
      ok: true,
      orderId: created?.orderId ?? null,
      careemOrderId: order.id,
      sentPayload: order,
      nextSteps: [
        "Open the orders board — it should be there as a Careem order",
        "Accept it, then check sandbox/calls for the PUT /orders/{id} we sent",
        selfDelivery
          ? "Self-delivery: the address should be on the ticket"
          : "Careem delivery: there should be NO address, and no driver of ours",
      ],
    };
  }

  private assertEnabled() {
    if (!this.sandbox.enabled) {
      throw new BadRequestException(
        "Careem sandbox is off. Set CAREEM_SANDBOX=true (and CAREEM_ENV must " +
          "not be production).",
      );
    }
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
