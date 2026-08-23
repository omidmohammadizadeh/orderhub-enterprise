import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
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
import { CareemApiError } from "./careem-client.service";
import { CareemMenuPublishService } from "./careem-menu-publish.service";
import { CareemOrderService } from "./careem-order.service";
import { CareemStoreService } from "./careem-store.service";
import { CareemItemAvailabilityService } from "./careem-item-availability.service";

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
    private readonly availability: CareemItemAvailabilityService,
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
    // This is a debugging tool, so an unexpected failure has to say what it
    // was. A bare 500 sends the reader to the server logs, which on Render
    // means leaving the page that was meant to answer the question.
    const result = await this.explain("dry-run", () =>
      this.menu.dryRun(locationId, user.tenantId),
    );
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
      /** Send a bare order instead — the shape we were testing before. */
      withoutModifiers?: boolean;
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    this.assertEnabled();

    const location = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null, brand: { tenantId: user.tenantId } },
      select: { id: true, name: true, brandId: true },
    });
    if (!location) throw new NotFoundException("Location not found");

    const dry = await this.explain("build the catalog", () =>
      this.menu.dryRun(locationId, user.tenantId),
    );
    const catalogItems = (dry.payload?.items ?? []) as Array<{
      id: string;
      name: string;
      price: number;
      groups?: string[];
    }>;
    const catalogGroups = (dry.payload?.groups ?? []) as Array<{
      id: string;
      name: string;
      options: string[];
    }>;
    const catalogOptions = (dry.payload?.options ?? []) as Array<{
      id: string;
      name: string;
      price: number;
      groups?: string[];
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

    // Careem's own arithmetic: the basket is items PLUS their options.
    // Leaving options out of the total would have made every simulated order
    // internally inconsistent, and the transformer cross-checks it.
    const preview = chosen.map((item, index) =>
      index === 0 && !(body?.withoutModifiers ?? false)
        ? this.pickGroups(item, catalogGroups, catalogOptions, major)
        : [],
    );
    const optionsTotal = preview
      .flat()
      .flatMap((g) => g.options)
      .reduce((sum, o) => sum + o.total_price, 0);
    const originalTotal = round(
      chosen.reduce((sum, i) => sum + major(i.price), 0) + optionsTotal,
    );
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
      items: chosen.map((item, index) => {
        // Modifiers on the FIRST item only, and only when the menu has some.
        // Two items both carrying options would test the same code twice; one
        // with and one without covers the branch that matters.
        const groups =
          index === 0 && !(body?.withoutModifiers ?? false)
            ? this.pickGroups(item, catalogGroups, catalogOptions, major)
            : [];
        const optionsTotal = groups
          .flatMap((g) => g.options)
          .reduce((sum, o) => sum + o.total_price, 0);
        return {
          id: item.id,
          quantity: 1,
          price: major(item.price),
          total_price: round(major(item.price) + optionsTotal),
          groups,
        };
      }),
    };

    const created = await this.explain("ingest the order", () =>
      this.orders.ingest(order as never),
    );
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

  /**
   * Let a genuine crash through with its cause attached.
   *
   * Nest turns anything that isn't an HttpException into "Internal server
   * error" with nothing else, which is the right default for a public API and
   * the wrong one here.
   */
  private async explain<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpException) throw err;
      // Careem's own rejection, with their status kept. A 400 from them is a
      // 400 from us — turning it into a 500 would say the fault was ours.
      if (err instanceof CareemApiError) {
        throw new HttpException(
          { step: what, status: err.status, careemSaid: err.message },
          err.status >= 400 && err.status < 600 ? err.status : 502,
        );
      }
      const message = (err as Error).message;
      this.logger.error(`Careem sandbox ${what} failed: ${message}`);
      throw new InternalServerErrorException({
        step: what,
        message,
        // The top of the stack is where it actually broke; the rest is Nest.
        where: (err as Error).stack?.split("\n")[1]?.trim() ?? null,
      });
    }
  }

  /**
   * Real modifier groups for an item, in Careem's inbound shape.
   *
   * The point is the NESTED case: an option that carries groups of its own —
   * "choose a sauce for the side you chose". Careem support that natively,
   * and it is the part of the order transformer with the most branching and
   * the least real-world exposure. If the menu has a nested group, this uses
   * it; if not, a flat one still exercises the lookup.
   */
  private pickGroups(
    item: { groups?: string[] },
    groups: Array<{ id: string; name: string; options: string[] }>,
    options: Array<{ id: string; name: string; price: number; groups?: string[] }>,
    major: (n: number) => number,
  ) {
    const byId = new Map(options.map((o) => [o.id, o]));
    const groupById = new Map(groups.map((g) => [g.id, g]));

    const attached = (item.groups ?? [])
      .map((id) => groupById.get(id))
      .filter(Boolean) as Array<{ id: string; options: string[] }>;
    if (!attached.length) return [];

    // Prefer a group whose first option has nested groups of its own.
    const nesting = attached.find((g) =>
      g.options.some((oid) => (byId.get(oid)?.groups ?? []).length > 0),
    );
    const group = nesting ?? attached[0]!;
    const optionId = group.options.find(
      (oid) => (byId.get(oid)?.groups ?? []).length > 0,
    ) ?? group.options[0];
    const option = optionId ? byId.get(optionId) : undefined;
    if (!option) return [];

    const nested = (option.groups ?? [])
      .map((id) => groupById.get(id))
      .filter(Boolean)
      .slice(0, 1)
      .map((g) => {
        const childId = g!.options[0];
        const child = childId ? byId.get(childId) : undefined;
        return child
          ? {
              id: g!.id,
              options: [
                {
                  id: child.id,
                  quantity: 1,
                  total_price: round(major(child.price)),
                },
              ],
            }
          : null;
      })
      .filter(Boolean) as Array<{
      id: string;
      options: Array<{ id: string; quantity: number; total_price: number }>;
    }>;

    return [
      {
        id: group.id,
        options: [
          {
            id: option.id,
            quantity: 1,
            total_price: round(major(option.price)),
            ...(nested.length ? { groups: nested } : {}),
          },
        ],
      },
    ];
  }

  /**
   * Take the first publishable item off, then put it back.
   *
   * The 86 path is separate from publishing on purpose: Careem allow one
   * catalog sync per branch every two minutes and it takes five to appear, so
   * republishing a whole menu to hide one pizza is neither fast enough nor
   * allowed often enough. This is the endpoint that exists for it.
   */
  @Post("locations/:locationId/eighty-six")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Push an item off, then back on, via Careem's 86 endpoint" })
  async eightySix(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    this.assertEnabled();
    const dry = await this.explain("build the catalog", () =>
      this.menu.dryRun(locationId, user.tenantId),
    );
    const first = (dry.payload?.items ?? [])[0] as
      | { id: string; name: string }
      | undefined;
    if (!first) throw new BadRequestException("This menu has no items to 86.");

    await this.availability.pushItemAvailability({
      tenantId: user.tenantId,
      itemId: first.id,
      locationId,
      available: false,
    });
    await this.availability.pushItemAvailability({
      tenantId: user.tenantId,
      itemId: first.id,
      locationId,
      available: true,
    });

    return {
      ok: true,
      item: { id: first.id, name: first.name },
      note:
        "Sent inactive then active. Check the call log for two PATCH " +
        "/catalogs/{id}/items — Careem have no 'until', so a timed snooze is " +
        "restored by our own expiry sweep rather than by them.",
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
