import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
  HttpException,
  HttpStatus,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { EventEmitter2, OnEvent } from "@nestjs/event-emitter";
import type { Prisma, Order, OrderStatus, OrderStatusActorType } from "@orderhub/database";
import { QUEUES, ORDER_JOBS, usesTap } from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import { SocketService } from "../../infrastructure/socket/socket.service";
import { computeServiceCharge, readServiceCharge } from "./service-charge";
import { AuditLogService } from "../auth/services/audit-log.service";
import { OutboxService } from "../outbox/outbox.service";
import { PrintQueueService } from "../printers/print-queue.service";
import { PrintJobsService } from "../printers/print-jobs.service";
import { HubRiseOrderSyncService } from "../integrations/hubrise/hubrise-order-sync.service";
import { CustomerPushService } from "../customer-push/customer-push.service";
import { HubRiseDeliverySyncService } from "../integrations/hubrise/hubrise-delivery-sync.service";
import { PaymentsService } from "../payments/payments.service";
import { TapService } from "../payments/tap.service";
import { PromoCodesService } from "../promo-codes/promo-codes.service";
import {
  assertTransition,
  assertWebhookTransition,
  getTimestampField,
} from "./order-state-machine";
import {
  resolveOrderScope as resolveOrderScopePure,
  ORDER_ADMIN_ROLES,
  type OrderScope,
} from "./order-access";
import type { CreateOrderDto } from "./dto/create-order.dto";
import type { UpdateOrderStatusDto } from "./dto/update-order-status.dto";
import type { CanonicalOrder } from "@orderhub/shared";

// Phase AM — if the operator scheduled this order more than this many seconds
// into the future, we suppress the immediate PrinterJob and surface a
// "Start preparing now" action on the Orders board instead.
const SCHEDULED_FUTURE_THRESHOLD_SECONDS = 60 * 10; // 10 min

const ORDER_INCLUDE = {
  items: true,
  statusHistory: { orderBy: { createdAt: "asc" as const } },
  // Phase AW — include the location's primary brand too so the
  // dashboard board + receipt renderer have a brand-name fallback
  // when Order.brandId is null (POS walk-in, manual order, anything
  // that didn't come through a brand-pinned storefront URL).
  location: {
    select: {
      id: true,
      name: true,
      brandId: true,
      address: true,
      phone: true,
      // Currency travels with the ORDER's own location, not the one the
      // operator happens to have selected. The board can be showing "All
      // locations", and once a Dubai shop exists that view holds AED and GBP
      // orders side by side — formatting them all in the selected location's
      // currency would misprice half the screen.
      currency: true,
      brand: { select: { id: true, name: true, logoUrl: true, phone: true, addressLine1: true, city: true, postcode: true } },
    },
  },
  // Surface the order's brand to the dashboard so the board can render
  // a per-brand badge. Order.brandId is nullable (set when the cart
  // resolves to a specific virtual brand, null for unattached orders),
  // and onDelete: SetNull on the relation means the column may
  // legitimately be present-but-null after a brand is deleted.
  brand: { select: { id: true, name: true, logoUrl: true } },
  // The shop's OWN driver, for the board's Riders column. Platform couriers
  // arrive as flat courierName/courierPhone columns on the order itself; an
  // in-house rider is a real person with a Driver row, so the two have to be
  // read from different places and shown as one thing.
  driverAssignment: {
    select: {
      status: true,
      assignedAt: true,
      driver: {
        select: { id: true, firstName: true, lastName: true, phone: true },
      },
    },
  },
} satisfies Prisma.OrderInclude;

type OrderWithRelations = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

export interface OrderFilters {
  locationId?: string;
  status?: OrderStatus | OrderStatus[];
  platform?: string;
  orderSource?: string;
  from?: Date;
  to?: Date;
  page?: number;
  limit?: number;
}

/** Whether an order's money has moved enough to block amending it.
 *
 *  CASH is always amendable: it's collected at handover, so re-quoting is
 *  just a different number to ask for. Other methods are amendable only
 *  while unpaid — an unpaid card order has no captured amount either. A PAID
 *  card order is not: changing the total would need a top-up or a partial
 *  refund, which is a separate feature.
 *
 *  Pure so the rule is testable without standing up the service; it guards
 *  money, so it should not only be reachable through a full edit call. */
export function canAmendOrderPayment(input: {
  paymentMethod: string | null | undefined;
  paymentStatus: string;
}): boolean {
  if ((input.paymentMethod ?? "").toUpperCase() === "CASH") return true;
  return input.paymentStatus !== "PAID";
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly socket: SocketService,
    private readonly audit: AuditLogService,
    private readonly outbox: OutboxService,
    private readonly printQueue: PrintQueueService, // Phase AM
    private readonly printJobs: PrintJobsService, // Phase AS-2
    private readonly promoCodes: PromoCodesService, // Phase AM
    private readonly payments: PaymentsService, // Phase AP-8 — Stripe manual-capture lifecycle hooks
    private readonly tap: TapService, // Gulf refunds — Tap has no auth-then-capture step
    // Phase AU — push status back to HubRise. forwardRef needed because
    // HubRiseModule transitively imports OrdersModule (via WebhooksModule).
    @Inject(forwardRef(() => HubRiseOrderSyncService))
    private readonly hubriseSync: HubRiseOrderSyncService,
    // Inbound courier/driver updates from HubRise delivery webhooks.
    // forwardRef mirrors hubriseSync — same OrdersModule ↔ HubRiseModule
    // cycle. The webhook ingestion service calls handleHubriseDelivery()
    // (below) rather than importing HubRiseModule itself, which would add a
    // WebhooksModule → HubRiseModule edge and a fresh boot-time cycle.
    @Inject(forwardRef(() => HubRiseDeliverySyncService))
    private readonly hubriseDelivery: HubRiseDeliverySyncService,
    private readonly events: EventEmitter2,
    // Phase AX — order updates to the customer's browser via Web Push.
    private readonly customerPush: CustomerPushService,
  ) {}

  /**
   * Apply a HubRise courier/delivery webhook (driver name/phone/PIN +
   * stage) to the matching order. Thin passthrough so WebhookIngestionService
   * can reach HubRiseDeliverySyncService without WebhooksModule importing
   * HubRiseModule (that edge would create a boot-time module cycle).
   */
  handleHubriseDelivery(
    args: Parameters<HubRiseDeliverySyncService["handleDeliveryWebhook"]>[0],
  ) {
    return this.hubriseDelivery.handleDeliveryWebhook(args);
  }

  /**
   * Phase AW-30 — short, customer-friendly order code.
   * 5 characters, mixed upper-case letters + digits. Picked from a 33-
   * char alphabet that excludes the look-alikes 0/O, 1/I/L so counter
   * staff don't misread "1L0OB" off a thermal print. Collisions are
   * checked per-tenant; 33^5 ≈ 39M values so a 10k-order tenant has
   * ~0.0003 collision probability per attempt — we retry up to 8 times
   * before giving up and letting the order ship without a short code
   * (orderNumber still uniquely identifies it for ops).
   */
  private async generateShortDisplayCode(
    tenantId: string,
  ): Promise<string | null> {
    const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 30 unambiguous chars
    const pick = () => {
      let s = "";
      for (let i = 0; i < 5; i++) {
        s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
      }
      return s;
    };
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = pick();
      const clash = await this.prisma.order.findFirst({
        where: { tenantId, displayId: code },
        select: { id: true },
      });
      if (!clash) return code;
    }
    return null;
  }

  /**
   * Phase AM — claim the next sequential order number for a tenant.
   * Uses upsert + atomic increment so concurrent POS submits never
   * collide. The first call for a tenant seeds nextValue=1, returns 1,
   * and bumps nextValue to 2.
   */
  private async allocateOrderNumber(tenantId: string): Promise<number> {
    // Upsert ensures the row exists, then update with increment claims
    // the value. Two-step rather than a single upsert with increment
    // because Prisma doesn't allow combining increment with create.
    await this.prisma.orderNumberSequence.upsert({
      where: { tenantId },
      create: { tenantId, nextValue: 1 },
      update: {},
    });
    const seq = await this.prisma.orderNumberSequence.update({
      where: { tenantId },
      data: { nextValue: { increment: 1 } },
    });
    // We just incremented to N+1; the value we want is N (the pre-increment one).
    return seq.nextValue - 1;
  }

  /**
   * True if the order should NOT trigger an immediate print at creation time.
   * The cut-off is 10 minutes — anything inside that window is treated as
   * "for now" because the kitchen lead time absorbs it.
   */
  private isFutureScheduled(scheduledFor?: Date | null): boolean {
    if (!scheduledFor) return false;
    const secondsAhead = (scheduledFor.getTime() - Date.now()) / 1000;
    return secondsAhead > SCHEDULED_FUTURE_THRESHOLD_SECONDS;
  }

  /**
   * Phase AS-5 — flip a freshly-ingested order from PENDING → ACCEPTED
   * when the location has `settings.autoAcceptOrders` set. Runs in the
   * background so a slow accept never blocks the ingest path. Failures
   * are logged and swallowed; the operator can still tap Accept manually.
   */
  /**
   * Phase AY — once a card payment is authorised (Stripe webhook →
   * PaymentsService.markAuthorized emits "payment.authorized"), run the
   * location's auto-accept toggle. Card orders skip auto-accept at ingest
   * (they wait for our Stripe authorisation), so this is the point where an
   * auto-accept location captures + prints + accepts the order. Covers both
   * the online storefront and WhatsApp card orders.
   */
  @OnEvent("payment.authorized")
  async onPaymentAuthorized(ev: {
    orderId: string;
    tenantId: string;
    locationId: string;
  }): Promise<void> {
    await this.maybeAutoAccept(ev.orderId, ev.tenantId, ev.locationId);
  }

  /**
   * The last part of a split bill landed on a card reader and the
   * payments module has just marked the order PAID. Close the tab the
   * same way the cash split path does — this service owns the
   * forward-only status ladder, so the completion has to happen here
   * rather than being duplicated inside PaymentsService.
   */
  @OnEvent("order.settled_in_full")
  async onOrderSettledInFull(ev: {
    orderId: string;
    tenantId: string;
  }): Promise<void> {
    await this.completeAndFreeTable(ev.orderId, ev.tenantId, "terminal").catch(
      (e) =>
        this.logger.warn(
          `Split-card settle: complete/free failed for ${ev.orderId}: ${e?.message}`,
        ),
    );
  }

  private async maybeAutoAccept(
    orderId: string,
    tenantId: string,
    locationId: string,
  ): Promise<void> {
    try {
      const location = await this.prisma.location.findUnique({
        where: { id: locationId },
        select: { settings: true },
      });
      const settings = (location?.settings ?? {}) as Record<string, unknown>;
      if (settings.autoAcceptOrders !== true) {
        this.logger.log(
          `Auto-accept OFF for location ${locationId} — order ${orderId} left PENDING`,
        );
        return;
      }
      // Only act on a still-PENDING order. If a near-simultaneous webhook
      // already advanced it (common with marketplace order.update bursts),
      // re-issuing ACCEPTED would throw an invalid-transition error and
      // the swallowed catch made it look like auto-accept "didn't work".
      const fresh = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: {
          status: true,
          platform: true,
          orderSource: true,
          metadata: true,
          paymentMethod: true,
          paymentStatus: true,
          isWalkIn: true,
          locationId: true,
        },
      });
      if (!fresh) return;
      if (fresh.status !== "PENDING") {
        this.logger.log(
          `Auto-accept skipped order ${orderId} — already ${fresh.status}`,
        );
        return;
      }
      // Never auto-accept an order we haven't been paid for yet when WE
      // collect the payment (POS "Payment link" + direct/storefront/WhatsApp
      // card). These belong in "Waiting for payment" until the Stripe webhook
      // flips them to PAID/AUTHORIZED, at which point confirmPayment/
      // markAuthorized re-fires this via the payment.authorized event. This is
      // the single chokepoint that guards EVERY caller — the ingest path, the
      // payment.authorized listener, AND the P2002 repeat-ingest safety net
      // (a POS double-submit used to slip through the last one and accept +
      // print a ticket the customer hadn't paid for). paymentMethod/Status may
      // sit top-level or in metadata depending on the create path — check both.
      const fmeta: any = (fresh.metadata as any) ?? {};
      const payMethod = (fresh as any).paymentMethod ?? fmeta.paymentMethod;
      const payStatus = (fresh as any).paymentStatus ?? fmeta.paymentStatus;
      const isDirectSource =
        fresh.orderSource === "POS" ||
        fresh.orderSource === "DIRECT" ||
        fresh.orderSource === "ONLINE" ||
        fresh.orderSource === "WHATSAPP";
      const unpaidPaymentLink =
        (payMethod === "PAYMENT_LINK" || payMethod === "QR_CODE") &&
        payStatus !== "PAID";
      // Card-terminal (S700 / WisePad 3) is our own collect-payment-now flow:
      // the ticket must NOT accept or print until the reader charge succeeds,
      // exactly like a payment link. settleTerminalPi re-fires this once PAID.
      const unpaidCardTerminal =
        payMethod === "CARD_TERMINAL" && payStatus !== "PAID";
      const unpaidDirectCard =
        isDirectSource &&
        payMethod === "CARD" &&
        payStatus !== "PAID" &&
        payStatus !== "AUTHORIZED";
      // Walk-in cash: the customer is AT THE COUNTER, so the money is taken
      // before the ticket is worth printing. Accepting at placement printed
      // "CASH NOT PAID" the instant the operator hit Place order, which is
      // both wrong and unhelpful — the kitchen copy then contradicts the till.
      // The POS opens the cash keypad instead and setPaymentStatus re-fires
      // this once the cash is in, so the ticket prints "CASH PAID" first time.
      //
      // Scoped to isWalkIn deliberately: a phone COLLECTION order is also
      // cash-and-unpaid, but the customer is not in the shop yet, so it must
      // keep printing immediately for the kitchen to start cooking.
      const unpaidWalkInCash =
        (fresh as any).isWalkIn === true &&
        payMethod === "CASH" &&
        payStatus !== "PAID";
      if (
        unpaidPaymentLink ||
        unpaidCardTerminal ||
        unpaidDirectCard ||
        unpaidWalkInCash
      ) {
        this.logger.log(
          `Auto-accept skipped order ${orderId} — awaiting payment (${payMethod}/${payStatus})`,
        );
        return;
      }
      // POS "scheduled for later" orders (metadata.isScheduled, set at
      // creation — see create() below) must stay PENDING until the operator
      // clicks "Start preparing now"; that's the entire point of the
      // Scheduled Orders strip. This check was documented above the emit
      // call further down but never actually implemented, so a location
      // with auto-accept ON would silently accept a scheduled order early —
      // which then vanished from BOTH the scheduled strip (no longer
      // PENDING) and the live board (scheduledAt still in the future).
      if ((fresh.metadata as any)?.isScheduled === true) {
        this.logger.log(
          `Auto-accept skipped order ${orderId} — scheduled for later`,
        );
        return;
      }
      await this.updateStatus(
        orderId,
        tenantId,
        { status: "ACCEPTED" } as UpdateOrderStatusDto,
        "system:auto-accept",
        "SYSTEM" as OrderStatusActorType,
      );
      this.logger.log(
        `Auto-accepted order ${orderId} (${fresh.platform}/${fresh.orderSource})`,
      );
    } catch (err: any) {
      this.logger.warn(
        `Auto-accept failed for order ${orderId}: ${err?.message ?? err}`,
      );
    }
  }

  // ── Ingest from adapter (webhook / public ordering) ───

  async ingestCanonical(
    canonical: CanonicalOrder,
    tenantId: string,
    locationId: string,
    options: { isSandbox?: boolean; isWalkIn?: boolean } = {},
  ): Promise<Order> {
    // Marketplace multi-brand (HubRise etc.): when the order didn't
    // arrive pre-pinned to a brand, match the payload's brand-name hint
    // to one of the tenant's brands so the ticket + board show the right
    // brand instead of the location default. Best-effort + logged.
    if (!(canonical as any).brandId) {
      const hint = String(
        ((canonical.metadata as any) ?? {}).hubriseBrandName ?? "",
      ).trim();
      if (hint) {
        try {
          // The same brand name can exist as multiple records across
          // locations (e.g. a "-test" duplicate). Prefer the one that
          // actually operates at THIS order's location — first by its
          // primary location, then by a platform connection here — so we
          // land on the record that carries the logo + storefront, not a
          // stray namesake. Fall back to any name match.
          const nameWhere = {
            tenantId,
            deletedAt: null,
            name: { equals: hint, mode: "insensitive" as const },
          };
          const sel = { id: true, name: true, primaryLocationId: true };
          const byPrimaryLocation = await this.prisma.brand.findFirst({
            where: { ...nameWhere, primaryLocationId: locationId },
            select: sel,
          });
          const byConnectionHere =
            byPrimaryLocation ??
            (await this.prisma.brand.findFirst({
              where: {
                ...nameWhere,
                platformConnections: { some: { locationId } },
              },
              select: sel,
            }));
          // The first two tiers both confirm the brand actually operates AT
          // this webhook's location (primary site, or a platform connection
          // here) — trusting the webhook's locationId is correct there. This
          // last tier is a BARE NAME MATCH with zero location signal at all —
          // it only fires when the brand has no presence at this location
          // whatsoever, which means the brand's real home is elsewhere and
          // this webhook simply isn't where it's supposed to be routed.
          const match =
            byConnectionHere ??
            (await this.prisma.brand.findFirst({
              where: nameWhere,
              select: sel,
            }));
          if (match) {
            (canonical as any).brandId = match.id;
            this.logger.log(
              `Matched ${canonical.platform} order to brand "${match.name}" (${match.id}) from hint "${hint}"`,
            );
            // Re-route to the brand's real home location — but NEVER for a
            // HubRise order. A HubRise order arrives at the webhook of the
            // location whose HubRise connection RECEIVED it (here, Clifton's
            // account w7nq4), and that connection location IS the kitchen that
            // fulfils it — authoritative regardless of the brand's stored
            // primaryLocationId. Rerouting on primaryLocationId sent Clifton's
            // "monster burgerz" orders to a stale/other location ("Order Hub
            // Test Account") the brand no longer operates from. The brand match
            // above still sets the brand badge; it must not relocate the order.
            //
            // The reroute stays for non-HubRise paths where the webhook's
            // location genuinely carries no connection for the brand.
            const viaHubrise =
              (canonical as any).viaHubrise === true ||
              canonical.platform === "HUBRISE";
            if (
              !viaHubrise &&
              !byConnectionHere &&
              match.primaryLocationId &&
              match.primaryLocationId !== locationId
            ) {
              this.logger.warn(
                `Brand "${match.name}" has no presence at location ${locationId} — rerouting ${canonical.platform} order to its home location ${match.primaryLocationId}`,
              );
              locationId = match.primaryLocationId;
            }
          } else {
            this.logger.warn(
              `No brand named "${hint}" for tenant ${tenantId} — ${canonical.platform} order stays on location default`,
            );
          }
        } catch (e: any) {
          this.logger.warn(`Brand hint resolve failed: ${e?.message ?? e}`);
        }
      }
    }

    // Order creation and outbox event insertion are atomic. If the process dies
    // between DB commit and queue enqueue, the OutboxDispatcherCron picks up the
    // pending outbox event on its next tick and enqueues the job safely.
    try {
      const order = await this.prisma.$transaction(async (tx) => {
        const created = await tx.order.create({
          data: {
            tenantId,
            locationId,
            // Phase AW — pin the order to a specific virtual brand
            // when the storefront resolved one (?brand=<id> on the
            // public URL). The Orders board, receipt header, and
            // Stripe Connect resolution all key off this.
            ...(((canonical as any).brandId) && {
              brandId: (canonical as any).brandId as string,
            }),
            externalId: canonical.externalId,
            platform: canonical.platform,
            displayId: canonical.displayId,
            orderSource: canonical.orderSource,
            integrationSource: canonical.integrationSource,
            viaHubrise: canonical.viaHubrise,
            fulfillmentType: canonical.fulfillmentType,
            status: "PENDING",
            isSandbox: options.isSandbox ?? false,
            // Written HERE, not in create()'s follow-up posUpdate.
            //
            // ingestCanonical fires maybeAutoAccept before it returns, and
            // maybeAutoAccept refuses to accept an unpaid walk-in cash order.
            // Setting isWalkIn afterwards lost that race every time: the gate
            // read the row while the column was still its `false` default, let
            // the order through, and printed "CASH NOT PAID" before anyone had
            // touched the till. Same class of bug as any other column added to
            // the update instead of the ingest write.
            isWalkIn: options.isWalkIn ?? false,
            customerName: canonical.customerInfo.name ?? null,
            customerPhone: canonical.customerInfo.phone ?? null,
            customerInfo: canonical.customerInfo as Prisma.InputJsonValue,
            // Phase AP-5 — link signed-in storefront customers to their
            // CustomerAccount so the "My Orders" page can list this
            // order. Undefined for non-storefront sources (POS, platform
            // webhooks) and for guest checkouts.
            customerAccountId: (canonical as any).customerAccountId ?? undefined,
            deliveryAddress: canonical.deliveryAddress
              ? (canonical.deliveryAddress as Prisma.InputJsonValue)
              : undefined,
            subtotal: canonical.subtotal,
            taxAmount: canonical.taxAmount,
            deliveryFee: canonical.deliveryFee,
            serviceCharge: (canonical as any).serviceCharge ?? 0,
            // Every online order lands here, not in create() — the storefront
            // ingests rather than creates. The tip was reaching the total and
            // stopping, so the shop was charged-for-and-paid a gratuity it
            // could not see on the card or the ticket.
            tipAmount: (canonical as any).tipAmount ?? 0,
            discount: canonical.discount,
            total: canonical.total,
            specialInstructions: canonical.specialInstructions,
            scheduledFor: canonical.scheduledFor,
            idempotencyKey: canonical.idempotencyKey,
            metadata: canonical.metadata as Prisma.InputJsonValue,
            // Phase AU — HubRise (and earlier webhook flows) carry the
            // payment method + status inside `metadata` rather than on
            // the canonical envelope. Promote them onto the Order row
            // so the dashboard payment chip reads "CARD / PAID" instead
            // of "UNPAID" and the receipt formatter doesn't print
            // "*** UNPAID ***" on a card-prepaid Uber Eats order.
            paymentMethod:
              (canonical as any).paymentMethod ??
              (canonical.metadata as any)?.paymentMethod ??
              undefined,
            paymentStatus:
              (canonical as any).paymentStatus ??
              (canonical.metadata as any)?.paymentStatus ??
              undefined,
            // The courier, when the marketplace names one at order time.
            //
            // Deliveroo and Just Eat name their rider later, on a rider event,
            // and write these columns directly. Uber sends the courier on the
            // order itself, and without promoting it here the mapper's work
            // was dropped on the floor — the Rider column stayed empty for the
            // one platform that supplies it up front.
            //
            // Only written when present: a later rider webhook must be able to
            // fill in a courier this order did not have yet, and an undefined
            // here leaves the column alone rather than blanking it.
            ...((canonical as any).courierName
              ? { courierName: (canonical as any).courierName as string }
              : {}),
            ...((canonical as any).courierPhone
              ? { courierPhone: (canonical as any).courierPhone as string }
              : {}),
            ...((canonical as any).courierPhoneAccessCode
              ? {
                  courierPhoneAccessCode: (canonical as any)
                    .courierPhoneAccessCode as string,
                }
              : {}),
            // Just Eat names the collection time on the order itself rather
            // than waiting for a rider event, so the board can show an ETA
            // before a driver is even assigned.
            ...((canonical as any).courierPickupEtaAt
              ? {
                  courierPickupEtaAt: (canonical as any)
                    .courierPickupEtaAt as Date,
                }
              : {}),
            // Phase AV — promote deliveryType from canonical metadata
            // onto the Order row so the dashboard can render the
            // MERCHANT/PLATFORM badge + gate post-READY transitions
            // for PLATFORM orders without re-parsing JSON on every
            // render.
            // `as any` until prisma generate picks up the new column
            // (workspace builds in CI regen the client; locally the
            // type lags by one push).
            ...(((canonical as any).deliveryType ??
              (canonical.metadata as any)?.deliveryType) && {
              deliveryType:
                ((canonical as any).deliveryType ??
                  (canonical.metadata as any)?.deliveryType) as any,
            }),
            statusHistory: {
              create: {
                tenantId,
                toStatus: "PENDING",
                actorType: (canonical.integrationSource !== "DIRECT"
                  ? "WEBHOOK"
                  : "SYSTEM") as OrderStatusActorType,
                changedBy:
                  canonical.integrationSource !== "DIRECT"
                    ? `webhook:${canonical.integrationSource}`
                    : "system",
              },
            },
            items: {
              create: canonical.items.map((item) => ({
                name: item.name,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
                totalPrice: item.totalPrice,
                modifiers: item.modifiers as Prisma.InputJsonValue,
                notes: item.notes,
                // POS sends the MenuItem id so KDS category/item routing
                // rules can match; marketplace items omit it (null).
                menuItemId: (item as any).menuItemId ?? null,
              })),
            },
          },
        });

        // Outbox event is written in the same transaction — either both commit or neither does.
        await tx.outboxEvent.create({
          data: this.outbox.forOrderReceived(
            tenantId,
            locationId,
            created.id,
            canonical.platform,
            canonical.externalId ?? created.id,
          ),
        });

        return created;
      });

      this.logger.log(
        `Order ingested: ${order.id} (${canonical.platform}/${canonical.externalId}) items=${canonical.items?.length ?? 0} pay=${(canonical as any).paymentMethod ?? (canonical.metadata as any)?.paymentMethod ?? "null"}/${(canonical as any).paymentStatus ?? (canonical.metadata as any)?.paymentStatus ?? "null"}`,
      );

      void this.audit.log({
        tenantId,
        event: "order.received",
        resource: "order",
        resourceId: order.id,
        meta: {
          platform: canonical.platform,
          externalId: canonical.externalId,
          locationId,
          total: canonical.total,
        },
      });

      // Phase LG — operator-facing activity feed (dashboard Logs page).
      // Central emit covers every channel this ingest serves.
      this.events.emit("activity.log", {
        tenantId,
        locationId,
        brandId: (order as any).brandId ?? null,
        category: "ORDERS",
        channel: canonical.platform ?? "DIRECT",
        action: "order.received",
        status: "SUCCESS",
        message: `Order #${(order as any).orderNumber ?? order.id} received from ${canonical.platform ?? "storefront"} (£${Number(canonical.total ?? 0).toFixed(2)})`,
        details: {
          orderId: order.id,
          externalId: canonical.externalId,
          items: canonical.items?.length ?? 0,
        },
      });

      // Phase AP-8 — suppress the realtime "new order" broadcast for
      // unpaid CARD orders. We persist the row early so Stripe Checkout
      // can attach to a real orderId, but the restaurant must NOT see it
      // until payment_intent.amount_capturable_updated lands and we flip
      // paymentStatus to AUTHORIZED. The live-board DB query already
      // filters these out; the socket is the side channel we have to
      // gate manually. markAuthorized() emits the new-order event when
      // the customer actually pays.
      const meta: any = (canonical as any).metadata ?? {};
      const isUnpaidCard =
        meta.paymentMethod === "CARD" && meta.paymentStatus === "PENDING";
      // POS "Payment link" orders are placed unpaid — they belong in the
      // "Waiting for payment" tab, NOT in New, and must not print until the
      // customer pays. Suppress the new-order broadcast + auto-accept until
      // the Stripe webhook confirms payment (PaymentsService.confirmPayment
      // re-emits new-order + payment.authorized then). Unlike unpaid CARD
      // orders they are NOT hidden from the board query, so they still appear
      // in the Waiting-for-payment column.
      // paymentMethod/paymentStatus may arrive top-level on the canonical
      // envelope OR inside metadata (POS vs storefront) — check both, same as
      // the Order-row mapping above.
      const resolvedPayMethod =
        (canonical as any).paymentMethod ?? meta.paymentMethod;
      const resolvedPayStatus =
        (canonical as any).paymentStatus ?? meta.paymentStatus;
      const isUnpaidPaymentLink =
        (resolvedPayMethod === "PAYMENT_LINK" ||
          resolvedPayMethod === "QR_CODE" ||
          // Card-terminal (S700 / WisePad 3): collect-now flow, holds in
          // "Waiting for payment" until the reader charge settles — same as
          // a payment link. settleTerminalPi re-emits new-order + accept.
          resolvedPayMethod === "CARD_TERMINAL") &&
        resolvedPayStatus !== "PAID";

      // Socket emit is best-effort and immediate — it does NOT affect downstream
      // processing which is guaranteed by the outbox.
      // Phase AS-5 — location-level auto-accept. If the operator has
      // ticked the toggle on the Printers → Automation tab, every
      // incoming order skips PENDING and goes straight to ACCEPTED, which
      // triggers the existing print pipeline + accepted-event socket.
      // Skipped for:
      //   - scheduled orders (operator decides when to start prep)
      //   - unpaid CARD orders (must wait for Stripe authorization)
      // Errors are swallowed deliberately — auto-accept is a convenience,
      // never a hard requirement for ingest to succeed.
      // The unpaid-card hold only applies to DIRECT orders we collect
      // payment for ourselves (storefront card orders awaiting our Stripe
      // authorization). Marketplace / HubRise / any future channel are
      // settled platform-side, so they must auto-accept regardless of
      // payment status — anything not flagged DIRECT is a platform order.
      const isPlatformOrder =
        (canonical as any).viaHubrise === true ||
        ((canonical as any).integrationSource &&
          (canonical as any).integrationSource !== "DIRECT");
      const waitForOurAuth =
        !isPlatformOrder && (isUnpaidCard || isUnpaidPaymentLink);
      // POS "scheduled for later" orders (metadata.isScheduled) are the one
      // exception maybeAutoAccept itself enforces — they stay PENDING
      // regardless of the location's auto-accept setting. A marketplace
      // order's own future delivery slot (scheduledFor with no
      // metadata.isScheduled) auto-accepts immediately as normal — the
      // kitchen sees it straight away with the scheduled time on the ticket.
      if (!waitForOurAuth) {
        void this.maybeAutoAccept(order.id, tenantId, locationId);
      }

      // Same "parked until the operator starts it" rule applies to the
      // realtime board: a POS scheduled order must not flash onto the live
      // "happening now" board via the socket push only to vanish once a
      // page refresh re-syncs with /orders/live, which correctly excludes
      // it. It's still visible immediately via the Scheduled Orders strip's
      // own poll of /orders/scheduled.
      const isScheduledForLater = meta.isScheduled === true;
      if (!isUnpaidCard && !isUnpaidPaymentLink && !isScheduledForLater) this.socket.emitNewOrder(locationId, {
        orderId: order.id,
        tenantId,
        locationId,
        platform: order.platform,
        orderSource: order.orderSource,
        fulfillmentType: order.fulfillmentType,
        displayId: order.displayId,
        status: order.status,
        total: Number(order.total),
        itemCount: canonical.items.reduce((sum, i) => sum + i.quantity, 0),
        customerName: canonical.customerInfo.name,
        scheduledFor: order.scheduledFor?.toISOString() ?? null,
        createdAt: order.createdAt.toISOString(),
      });

      return order;
    } catch (err: any) {
      // P2002 = unique constraint violation — concurrent ingest already created this order.
      // The matching outbox event was also not created (transaction rolled back), which is correct.
      if (err?.code === "P2002") {
        this.logger.warn(
          `Concurrent ingest detected for ${canonical.platform}/${canonical.externalId} — returning existing order`,
        );
        const existing = await this.prisma.order.findFirst({
          where: canonical.externalId
            ? {
                externalId: canonical.externalId,
                platform: canonical.platform,
              }
            : {
                idempotencyKey: canonical.idempotencyKey,
              },
        });
        if (existing) {
          // Safety net: if the order is still PENDING (e.g. the original
          // create event failed to auto-accept), try again on this repeat
          // event so it never gets stuck waiting for a manual tap.
          if (existing.status === "PENDING") {
            void this.maybeAutoAccept(existing.id, tenantId, locationId);
          }
          return existing;
        }
      }
      throw err;
    }
  }

  /**
   * A marketplace customer changed a live order (e.g. Uber fulfillment issue
   * resolved — they picked a replacement / removed an item). ingestCanonical
   * is create-only (returns the existing order untouched on repeat), so this
   * path REPLACES the existing order's items + totals in place and refreshes
   * the board + KDS, exactly like a staff edit. No-op for terminal orders.
   */
  async resyncMarketplaceItems(
    externalId: string,
    platform: string,
    tenantId: string,
    canonical: CanonicalOrder,
    opts: { reOffered?: boolean } = {},
  ): Promise<Order | null> {
    const order = await this.prisma.order.findFirst({
      where: { externalId, platform: platform as any, tenantId },
      include: { items: true },
    });
    if (!order) return null;
    if (["COMPLETED", "CANCELLED", "REJECTED", "FAILED"].includes(order.status)) {
      return order; // too late to change a finished order
    }
    // The marketplace re-offered the order for the merchant to re-accept (Uber
    // sends state=OFFERED after a customer resolves a fulfillment issue). Put
    // it back to PENDING so it alerts + shows Accept/Cancel like a new order,
    // flagged as a customer update so the card labels it correctly.
    const reOffer = opts.reOffered === true && order.status !== "PENDING";
    const nextStatus = reOffer ? "PENDING" : order.status;
    const nextSourceMeta = reOffer
      ? {
          ...((order as any).sourceMetadata ?? {}),
          customerUpdated: true,
          customerUpdatedAt: new Date().toISOString(),
        }
      : ((order as any).sourceMetadata ?? undefined);
    const items = canonical.items ?? [];
    if (items.length === 0) return order; // never blank out a live order

    const subtotal =
      canonical.subtotal ??
      items.reduce((sum: number, i) => sum + i.totalPrice, 0);
    const total = canonical.total ?? subtotal;
    const taxAmount = canonical.taxAmount ?? 0;

    const beforeCount = (((order as any).items ?? []) as Array<{
      quantity: number;
    }>).reduce((s: number, i) => s + i.quantity, 0);
    const afterCount = items.reduce((s: number, i) => s + i.quantity, 0);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.orderItem.deleteMany({ where: { orderId: order.id } });
      const u = await tx.order.update({
        where: { id: order.id },
        data: {
          subtotal,
          taxAmount,
          total,
          status: nextStatus as any,
          ...(nextSourceMeta !== undefined
            ? { sourceMetadata: nextSourceMeta as Prisma.InputJsonValue }
            : {}),
          items: {
            create: items.map((item) => ({
              name: item.name,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              totalPrice: item.totalPrice,
              modifiers: item.modifiers as Prisma.InputJsonValue,
              notes: item.notes,
            })),
          },
          updatedAt: new Date(),
        },
      });
      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          tenantId,
          fromStatus: order.status,
          toStatus: nextStatus,
          actorType: "WEBHOOK",
          changedBy: `webhook:${platform}`,
          note: `Customer updated order: ${beforeCount} → ${afterCount} item(s), total £${Number(order.total).toFixed(2)} → £${total.toFixed(2)}${reOffer ? " — re-offered for acceptance" : ""}`,
        },
      });
      return u;
    });

    // Refresh the board (reprint + in-place line update) and the KDS tickets,
    // same signals as a staff edit.
    const socketPayload = {
      orderId: updated.id,
      tenantId,
      locationId: updated.locationId,
      platform: updated.platform,
      orderSource: updated.orderSource,
      fulfillmentType: updated.fulfillmentType,
      displayId: updated.displayId,
      status: updated.status,
      total: Number(updated.total),
      itemCount: afterCount,
      customerName: updated.customerName ?? "",
      scheduledFor: updated.scheduledFor?.toISOString() ?? null,
      createdAt: updated.createdAt.toISOString(),
    };
    // A re-offered order alerts like a NEW order (sound + New tab); a plain
    // in-place edit stays silent (isEdit).
    this.socket.emitNewOrder(updated.locationId, {
      ...socketPayload,
      ...(reOffer ? { customerUpdated: true } : { isEdit: true }),
    } as any);
    this.socket.emitOrderUpdated(updated.locationId, {
      ...socketPayload,
      ...(reOffer ? { customerUpdated: true } : {}),
    } as any);
    this.events.emit("order.items_edited", {
      orderId: updated.id,
      locationId: updated.locationId,
    });
    return updated;
  }

  // ── Direct order creation (POS / staff) ──────────────

  async create(dto: CreateOrderDto, tenantId: string): Promise<Order> {
    const location = await this.prisma.location.findFirst({
      where: { id: dto.locationId, brand: { tenantId } },
    });
    if (!location) throw new NotFoundException("Location not found");

    const scheduledFor = dto.scheduledFor ? new Date(dto.scheduledFor) : undefined;
    const isScheduled = dto.isScheduled === true || this.isFutureScheduled(scheduledFor);

    // Both POS and the storefront share this create path, but the
    // Orders dashboard renders the "channel" pill from `platform`.
    // Hard-coding platform=DIRECT here meant a POS order showed up as
    // "Direct Online Ordering". Mirror the resolved orderSource into
    // platform + externalId so POS, DIRECT, and any future PHONE
    // source each get their own label and traceable ID prefix.
    const resolvedSource = (dto.orderSource ?? "DIRECT") as
      | "POS"
      | "DIRECT"
      | "PHONE";
    const idPrefix = resolvedSource.toLowerCase();

    // POS display brand: a location can pin a "POS display name" brand in its
    // settings (Location settings → POS display name), so counter and phone
    // orders show that name whichever menu built the cart.
    //
    // It must NEVER overwrite a brand the caller pinned. A customer who opened
    // the Monster Burgerz storefront and ordered from it has told us which
    // brand this is; the location's POS default is a fallback for orders that
    // arrived without one, not a correction.
    //
    // This guard used to read `resolvedSource !== "DIRECT"`, and the storefront
    // sends "ONLINE" — so every online order at a location with a POS display
    // brand had the customer's own choice replaced by it, and Monster Burgerz
    // orders landed on the board as Pizza Uno.
    let effectiveBrandId = (dto as any).brandId as string | undefined;
    // Also carries the service-charge config — one fetch, two uses.
    let locationSettings: unknown = null;
    if (dto.locationId) {
      const loc = await this.prisma.location.findFirst({
        where: { id: dto.locationId },
        select: { settings: true },
      });
      locationSettings = loc?.settings ?? null;
      const posBrandId = (loc?.settings as any)?.posBrandId as
        | string
        | undefined;
      const countertop = resolvedSource === "POS" || resolvedSource === "PHONE";
      if (!effectiveBrandId && countertop && posBrandId) {
        effectiveBrandId = posBrandId;
      }
    }

    // Service charge is decided HERE, not by the till. A client-computed
    // charge could be edited, omitted, or drift from the
    // location's settings — and the storefront overcharge bug already
    // showed what trusting client money maths costs.
    const svc = computeServiceCharge({
      settings: locationSettings,
      fulfillmentType: dto.fulfillmentType ?? "DELIVERY",
      subtotal: Number(dto.subtotal ?? 0),
      discount: Number(dto.discount ?? 0),
    });

    const canonical = {
      externalId: `${idPrefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      platform: resolvedSource as any,
      orderSource: resolvedSource as any,
      integrationSource: "DIRECT" as const,
      viaHubrise: false,
      fulfillmentType: dto.fulfillmentType ?? ("DELIVERY" as const),
      displayId: undefined,
      customerInfo: dto.customerInfo,
      // Country falls back to the SHOP's, not to a constant. A Dubai POS order
      // was being stamped "GB" on the canonical record the receipt, the
      // dispatch map and every marketplace export all read from.
      deliveryAddress: dto.deliveryAddress
        ? {
            ...dto.deliveryAddress,
            country: dto.deliveryAddress.country ?? location?.country ?? "GB",
          }
        : undefined,
      items: dto.items.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        totalPrice: i.totalPrice,
        notes: i.notes,
        sku: i.sku,
        // Carried through to OrderItem.menuItemId so KDS station rules
        // (category/item routing) can match POS lines.
        menuItemId: i.menuItemId,
        modifiers: (i.modifiers ?? []).map((m) => ({
          name: m.name,
          price: m.price,
          quantity: m.quantity ?? 1,
        })),
      })),
      subtotal: dto.subtotal,
      taxAmount: dto.taxAmount ?? 0,
      deliveryFee: dto.deliveryFee ?? 0,
      // The gratuity. It is already inside `total`, so failing to store it
      // here doesn't lose money — it loses the ability to SEE the money,
      // which is how a tip reaches a shop that never learns it was tipped.
      tipAmount: dto.tipAmount ?? 0,
      serviceCharge: svc.amount,
      discount: dto.discount ?? 0,
      // The charge is added on top of whatever the till totalled.
      total: round2(Number(dto.total ?? 0) + svc.amount),
      specialInstructions: dto.specialInstructions,
      scheduledFor,
      idempotencyKey: dto.idempotencyKey,
      metadata: {
        callerId: dto.callerId,
        discountType: dto.discountType,
        promoCode: dto.promoCode,
        paymentMethod: dto.paymentMethod,
        paymentProvider: dto.paymentProvider,
        paymentStatus: dto.paymentStatus,
        preparationMinutes: dto.preparationMinutes,
        isScheduled,
      },
      // Phase AP-5 — thread the storefront customerAccountId through
      // to persistOrder so the Order row gets attributed and the
      // customer's "My Orders" page can find it. CanonicalOrder
      // doesn't have a typed slot for this yet (marketplace adapters
      // don't need it) so we ride along on the (canonical as any)
      // cast at the persist site. Undefined for guest checkouts.
      customerAccountId: (dto as any).customerAccountId,
      // Phase AW — brand pin from the storefront. ingestCanonical
      // reads this off the canonical envelope and writes it onto the
      // Order row so receipts, board, and payouts pick up the brand.
      // For POS/phone this is the location's POS display brand when set.
      brandId: effectiveBrandId,
    };

    const order = await this.ingestCanonical(
      canonical as any,
      tenantId,
      dto.locationId,
      // Must reach the row BEFORE the accept gate runs — see the note on the
      // create above.
      { isWalkIn: (dto as any).isWalkIn === true },
    );

    // Persist the POS-specific structured columns + payment fields. We do
    // this in a follow-up update rather than threading every field through
    // CanonicalOrder so the webhook adapters stay unchanged.
    const posUpdate: Prisma.OrderUpdateInput = {};
    if (dto.deliveryAddress) {
      posUpdate.addressLine1 = dto.deliveryAddress.line1;
      posUpdate.addressLine2 = dto.deliveryAddress.line2 ?? null;
      posUpdate.city = dto.deliveryAddress.city;
      posUpdate.postcode = dto.deliveryAddress.postcode ?? null;
    }
    if (dto.customerInfo?.name) posUpdate.customerName = dto.customerInfo.name;
    if (dto.customerInfo?.phone) posUpdate.customerPhone = dto.customerInfo.phone;
    if (dto.callerId !== undefined) posUpdate.callerId = dto.callerId;
    if (dto.preparationMinutes !== undefined) {
      posUpdate.preparationMinutes = dto.preparationMinutes;
      if (dto.preparationMinutes > 0 && !isScheduled) {
        posUpdate.estimatedReadyAt = new Date(
          Date.now() + dto.preparationMinutes * 60_000,
        );
      }
    }
    if (scheduledFor) posUpdate.scheduledAt = scheduledFor;
    if (dto.discountType !== undefined) posUpdate.discountType = dto.discountType;
    if (dto.promoCode !== undefined) posUpdate.promoCode = dto.promoCode;
    if (dto.discount !== undefined && dto.discount > 0) {
      posUpdate.promoDiscount = dto.discount;
    }
    if (dto.paymentMethod !== undefined) posUpdate.paymentMethod = dto.paymentMethod;
    if (dto.paymentProvider !== undefined) {
      posUpdate.paymentProvider = dto.paymentProvider;
    }
    // Table Tabs — persist the table link so addRound() can append to the tab.
    if (dto.tableId !== undefined) posUpdate.tableId = dto.tableId;
    // isWalkIn is deliberately NOT set here — it goes in via the ingest
    // options above so it exists before the accept gate reads it. Writing it
    // in both places would reintroduce the race the moment someone edited one.
    if (dto.paymentStatus !== undefined) {
      posUpdate.paymentStatus = dto.paymentStatus as any;
    }

    // Phase AM (+ AP fix) — allocate sequential per-tenant order number
    // for orders we own ourselves: POS, DIRECT, and ONLINE storefront.
    // Marketplace orders (Just Eat / Uber Eats / Deliveroo / HubRise)
    // arrive with their own platform-issued displayId so they keep
    // that and skip the counter — the operator wants the marketplace's
    // number on the card so the customer service ticket lookups still
    // work both ways.
    const isInternal =
      (canonical.orderSource as string) === "POS" ||
      (canonical.orderSource as string) === "DIRECT" ||
      (canonical.orderSource as string) === "ONLINE";
    if (isInternal) {
      const orderNumber = await this.allocateOrderNumber(tenantId);
      posUpdate.orderNumber = orderNumber;
      // Phase AW-30 — also mint a 5-char customer-facing code. Falls
      // back to "#<orderNumber>" downstream if generation fails.
      const shortCode = await this.generateShortDisplayCode(tenantId);
      if (shortCode) posUpdate.displayId = shortCode;
    }

    if (Object.keys(posUpdate).length > 0) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: posUpdate,
      });
    }

    // Promo code: bump usage AFTER persistence so we don't burn a use on a
    // failed write.
    if (dto.promoCode) {
      void this.promoCodes.incrementUsage(tenantId, dto.promoCode);
    }

    // SMS-marketing consent from the POS "Send me offers by SMS" box. Only when
    // the operator actually asked (undefined = untouched). Fire-and-forget via
    // the event bus so MarketingSmsService captures it without coupling here.
    if (
      dto.marketingConsent !== undefined &&
      dto.customerInfo?.phone
    ) {
      this.events.emit("marketing.consent", {
        tenantId,
        locationId: dto.locationId,
        phone: dto.customerInfo.phone,
        firstName: dto.customerInfo.name ?? null,
        source: (order as any).orderSource ?? "POS",
        consent: dto.marketingConsent === true,
      });
    }

    return order;
  }

  // ── Manual test order (Phase AJ) ──────────────────────
  // Creates a single sample order at the given location with isSandbox=true,
  // routed through the full canonical ingest pipeline. Unlike the bulk
  // sandbox.generateOrders helper this is intentionally available in
  // production — operators use it to verify printer/board wiring without
  // having to ask a delivery platform to send a real test order.
  //
  // The order goes in at status=PENDING. Moving it to ACCEPTED via the
  // normal status endpoint triggers the standard print-job pipeline.
  async createTest(
    tenantId: string,
    locationId: string,
    userId: string,
    overrides: {
      customerName?: string;
      fulfillmentType?: "PICKUP" | "DELIVERY";
      /**
       * Pretend the order came from a marketplace.
       *
       * The receipt QR is only baked for marketplace channels — the whole
       * point of it is winning back a customer who ordered through someone
       * else — so a DIRECT test order can never exercise that path. Passing a
       * platform here is what makes the QR print.
       */
      platform?: "DELIVEROO" | "UBER_EATS" | "JUST_EAT";
    } = {},
  ): Promise<Order> {
    // Verify the user can touch this location.
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
      select: { id: true, brandId: true, name: true },
    });
    if (!location) throw new NotFoundException("Location not found");

    // Deterministic-but-unique external id so the @@unique([externalId, platform])
    // constraint prevents accidental double-clicks from producing dupes.
    const externalId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const customerName = overrides.customerName ?? "Test Order";
    const fulfillmentType = overrides.fulfillmentType ?? "DELIVERY";

    const items = [
      { name: "Sample Burger", quantity: 1, unitPrice: 9.5, totalPrice: 9.5, modifiers: [] },
      { name: "Fries", quantity: 1, unitPrice: 3.5, totalPrice: 3.5, modifiers: [] },
      { name: "Soft Drink", quantity: 1, unitPrice: 2.0, totalPrice: 2.0, modifiers: [] },
    ];
    const subtotal = items.reduce((sum, i) => sum + i.totalPrice, 0);
    const taxAmount = 0;
    const deliveryFee = fulfillmentType === "DELIVERY" ? 2.5 : 0;
    const total = subtotal + taxAmount + deliveryFee;

    // A simulated marketplace order carries that marketplace's identity all
    // the way through, because everything downstream keys off these three:
    // the board's channel badge, the QR decision, station routing and
    // reporting. Half-dressing it as DIRECT would test the wrong path.
    const simulated = overrides.platform;
    const canonical = {
      externalId,
      platform: (simulated ?? "DIRECT") as any,
      orderSource: (simulated ?? "POS") as any,
      integrationSource: (simulated ?? "DIRECT") as any,
      viaHubrise: false,
      fulfillmentType,
      displayId: `${simulated ? "SIM" : "TEST"}-${externalId.slice(-4).toUpperCase()}`,
      customerInfo: { name: customerName, phone: "+440000000000" },
      deliveryAddress:
        fulfillmentType === "DELIVERY"
          ? {
              line1: "1 Test Street",
              city: "Sandbox",
              postcode: "TE5 7ER",
              country: "GB",
            }
          : undefined,
      items,
      subtotal,
      taxAmount,
      deliveryFee,
      discount: 0,
      total,
      specialInstructions: simulated
        ? `Simulated ${simulated} order — not real, safe to discard`
        : "Phase AJ manual test order — safe to discard",
      metadata: {
        isTestOrder: true,
        createdByUserId: userId,
        ...(simulated ? { simulatedPlatform: simulated } : {}),
      },
    };

    const order = await this.ingestCanonical(
      canonical as any,
      tenantId,
      locationId,
      { isSandbox: true },
    );

    void this.audit.log({
      tenantId,
      userId,
      event: "order.test.created",
      resource: "order",
      resourceId: order.id,
      meta: { locationId, externalId, fulfillmentType },
    });

    return order;
  }

  // ── Edit order (Phase AW-22) ──────────────────────────
  //
  // Manager-driven amendment for POS orders the customer rang back
  // about. Constraints (enforced here, not just at controller):
  //   - status must be PENDING / ACCEPTED / PREPARING (anything up
  //     to READY); past READY the kitchen has it and editing the
  //     items will trail behind reality.
  //   - the money must not already have moved. CASH stays editable as it
  //     always was (it's collected at handover, so a re-quote is just a
  //     different number to ask for). Other methods are editable only while
  //     paymentStatus is not PAID — an unpaid card order has no captured
  //     amount either, so amending it is exactly as safe as amending cash.
  //     A PAID card order still isn't: changing the total would need a
  //     top-up or partial refund, which is a different feature.
  //   - orderSource must be POS. Online + marketplace orders have
  //     their own correction flows.
  //
  // The implementation replaces the OrderItems array wholesale —
  // operator gets a clean delete + reinsert rather than per-line
  // diff. An OrderStatusHistory row records the edit so the audit
  // trail shows what changed and who did it. After the transaction
  // commits we re-emit emitNewOrder so the existing printer
  // pipeline reprints the full updated ticket (the printer worker
  // can't tell the difference from a brand-new order, which is
  // exactly what we want for a clean reprint).
  async editOrder(
    orderId: string,
    tenantId: string,
    dto: {
      items: Array<{
        name: string;
        quantity: number;
        unitPrice: number;
        totalPrice: number;
        notes?: string;
        sku?: string;
        modifiers?: Array<{
          name: string;
          price: number;
          quantity?: number;
        }>;
      }>;
      subtotal: number;
      taxAmount?: number;
      deliveryFee?: number;
      tipAmount?: number;
      discount?: number;
      total: number;
      customerInfo?: { name: string; phone?: string; email?: string };
      deliveryAddress?: {
        line1: string;
        line2?: string;
        city: string;
        /** Optional — the Gulf has no everyday postal code. */
        postcode?: string;
        /** The named community, e.g. "Dubai Marina". */
        area?: string;
        country?: string;
      };
      specialInstructions?: string;
    },
    userId: string,
  ): Promise<Order> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException("Order not found");

    const EDITABLE = new Set<OrderStatus>(["PENDING", "ACCEPTED", "PREPARING"]);
    if (!EDITABLE.has(order.status)) {
      throw new BadRequestException(
        "Order can only be edited before it's marked Ready",
      );
    }
    // Additive on purpose: every order that was editable before still is.
    // Operators rang in about the gap — a customer adds a item to an unpaid
    // card order, or rings back before paying — and refusing those was
    // stricter than the money actually requires.
    if (
      !canAmendOrderPayment({
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
      })
    ) {
      throw new BadRequestException(
        "This order has already been paid by card. Refund it or take a separate payment for the difference.",
      );
    }
    if (order.orderSource !== "POS") {
      throw new BadRequestException(
        "Only POS orders are editable from this flow",
      );
    }
    if (!dto.items.length) {
      throw new BadRequestException("Order must have at least one item");
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.orderItem.deleteMany({ where: { orderId: order.id } });
      await tx.orderItem.createMany({
        data: dto.items.map((it) => ({
          orderId: order.id,
          name: it.name,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          totalPrice: it.totalPrice,
          modifiers: (it.modifiers ?? []) as any,
          notes: it.notes ?? null,
        })),
      });

      const customerInfoUpdate =
        dto.customerInfo !== undefined
          ? (dto.customerInfo as any)
          : (order.customerInfo as any);

      const customerNameUpdate =
        dto.customerInfo?.name ?? order.customerName ?? null;
      const customerPhoneUpdate =
        dto.customerInfo?.phone ?? order.customerPhone ?? null;

      const u = await tx.order.update({
        where: { id: order.id },
        data: {
          subtotal: dto.subtotal,
          taxAmount: dto.taxAmount ?? 0,
          deliveryFee: dto.deliveryFee ?? 0,
          discount: dto.discount ?? 0,
          total: dto.total,
          customerInfo: customerInfoUpdate,
          customerName: customerNameUpdate,
          customerPhone: customerPhoneUpdate,
          deliveryAddress: dto.deliveryAddress
            ? (dto.deliveryAddress as any)
            : order.deliveryAddress ?? undefined,
          specialInstructions:
            dto.specialInstructions ?? order.specialInstructions,
          updatedAt: new Date(),
        },
      });

      const beforeTotal = Number(order.total);
      const afterTotal = dto.total;
      const beforeCount = order.items.reduce((s, i) => s + i.quantity, 0);
      const afterCount = dto.items.reduce((s, i) => s + i.quantity, 0);
      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          tenantId,
          fromStatus: order.status,
          toStatus: order.status,
          actorType: "STAFF",
          changedBy: userId,
          note: `Order edited: ${beforeCount} → ${afterCount} item(s), total £${beforeTotal.toFixed(2)} → £${afterTotal.toFixed(2)}`,
        },
      });

      return u;
    });

    // Re-emit so the printer pipeline reprints the full updated
    // ticket. emitOrderUpdated also fires so the staff board
    // refreshes the line items in-place.
    this.socket.emitNewOrder(updated.locationId, {
      orderId: updated.id,
      tenantId,
      locationId: updated.locationId,
      platform: updated.platform,
      orderSource: updated.orderSource,
      fulfillmentType: updated.fulfillmentType,
      displayId: updated.displayId,
      status: updated.status,
      total: Number(updated.total),
      itemCount: dto.items.reduce((s, i) => s + i.quantity, 0),
      customerName: updated.customerName ?? "",
      scheduledFor: updated.scheduledFor?.toISOString() ?? null,
      createdAt: updated.createdAt.toISOString(),
      isEdit: true,
    } as any);
    this.socket.emitOrderUpdated(updated.locationId, {
      orderId: updated.id,
      tenantId,
      locationId: updated.locationId,
      platform: updated.platform,
      orderSource: updated.orderSource,
      fulfillmentType: updated.fulfillmentType,
      displayId: updated.displayId,
      status: updated.status,
      total: Number(updated.total),
      itemCount: dto.items.reduce((s, i) => s + i.quantity, 0),
      customerName: updated.customerName ?? "",
      scheduledFor: updated.scheduledFor?.toISOString() ?? null,
      createdAt: updated.createdAt.toISOString(),
    });

    // Re-sync kitchen tickets: the edit replaced OrderItems (new ids), so the
    // KDS must refresh routed items + tick states and flag the card updated.
    // Decoupled via the event bus (KDS listens) to keep OrdersModule from
    // importing KdsModule.
    this.events.emit("order.items_edited", {
      orderId: updated.id,
      locationId: updated.locationId,
    });

    return updated;
  }

  // ── Table Tabs: add a round (dine-in) ─────────────────────────────────────
  // APPENDS new items to an open tab order and fires ONLY the new items to the
  // kitchen — unlike editOrder (which deletes + recreates every item and
  // reprints the whole ticket). Prior items keep their ids, so their KDS
  // tick-states survive; the new items surface on the station screens via the
  // same `order.items_edited` → KDS-resync wiring editOrder uses. (Paper
  // "round chit" printing is a fast follow — the print router has no subset API
  // yet; KDS is the primary dine-in kitchen surface.)
  async addRound(
    orderId: string,
    tenantId: string,
    items: Array<{
      name: string;
      quantity: number;
      unitPrice: number;
      totalPrice: number;
      modifiers?: { name: string; price: number; quantity?: number }[];
      notes?: string | null;
      menuItemId?: string | null;
    }>,
    userId: string,
  ): Promise<Order> {
    if (!items.length) throw new BadRequestException("No items to add");
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (!order.tableId) {
      throw new BadRequestException("This order is not a table tab");
    }
    // READY is included: a dine-in tab has no stage ladder (KDS bumps no
    // longer READY tabs), but a tab that reached READY under the old rules —
    // or via a manual board action — must still accept more rounds. Only a
    // truly closed/cancelled tab refuses.
    const EDITABLE = new Set<OrderStatus>([
      "PENDING",
      "ACCEPTED",
      "PREPARING",
      "READY",
    ]);
    if (!EDITABLE.has(order.status)) {
      throw new BadRequestException(
        "Can't add to this tab — it's already closed",
      );
    }
    if (order.paymentStatus === "PAID") {
      throw new BadRequestException("This tab is already settled");
    }

    const addedTotal = items.reduce((s, i) => s + Number(i.totalPrice), 0);
    // A service charge is a percentage, so every round moves it. Recompute
    // from the location's live config instead of scaling the old figure —
    // the operator may have changed the rate mid-service.
    const newSubtotal = round2(Number(order.subtotal) + addedTotal);
    const roundLoc = order.locationId
      ? await this.prisma.location.findUnique({
          where: { id: order.locationId },
          select: { settings: true },
        })
      : null;
    const newServiceCharge = computeServiceCharge({
      settings: roundLoc?.settings ?? null,
      fulfillmentType: order.fulfillmentType,
      subtotal: newSubtotal,
      discount: Number(order.discount ?? 0),
    }).amount;
    const addedCount = items.reduce((s, i) => s + i.quantity, 0);

    // Round number for the paper chit: round 1 was the initial send, each
    // prior "Tab round added" history row is one appended round since.
    const priorRounds = await this.prisma.orderStatusHistory.count({
      where: { orderId: order.id, note: { startsWith: "Tab round added" } },
    });
    const roundNumber = priorRounds + 2;

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.orderItem.createMany({
        data: items.map((it) => ({
          orderId: order.id,
          name: it.name,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          totalPrice: it.totalPrice,
          modifiers: (it.modifiers ?? []) as any,
          notes: it.notes ?? null,
          // Round lines must route to stations like round-1 lines do.
          menuItemId: it.menuItemId ?? null,
        })),
      });
      const u = await tx.order.update({
        where: { id: order.id },
        // Adding items lifts subtotal + total by the same amount (fees/discount
        // unchanged), so no need to re-derive the whole bill.
        data: {
          subtotal: newSubtotal,
          serviceCharge: newServiceCharge,
          // Rebuild from parts rather than adding to the old total, or the
          // previous round's service charge would be counted twice.
          total: round2(
            newSubtotal -
              Number(order.discount ?? 0) +
              Number(order.deliveryFee ?? 0) +
              Number(order.taxAmount ?? 0) +
              newServiceCharge,
          ),
          updatedAt: new Date(),
        },
      });
      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          tenantId,
          fromStatus: order.status,
          toStatus: order.status,
          actorType: "STAFF",
          changedBy: userId,
          note: `Tab round added: +${addedCount} item(s), +£${addedTotal.toFixed(2)}`,
        },
      });
      return u;
    });

    // Refresh the staff board and surface the new items on the KDS stations —
    // but NOT emitNewOrder (that would reprint the whole ticket on paper).
    this.socket.emitOrderUpdated(updated.locationId, {
      orderId: updated.id,
      tenantId,
      locationId: updated.locationId,
      platform: updated.platform,
      orderSource: updated.orderSource,
      fulfillmentType: updated.fulfillmentType,
      displayId: updated.displayId,
      status: updated.status,
      total: Number(updated.total),
      itemCount:
        order.items.reduce((s, i) => s + i.quantity, 0) + addedCount,
      customerName: updated.customerName ?? "",
      scheduledFor: updated.scheduledFor?.toISOString() ?? null,
      createdAt: updated.createdAt.toISOString(),
    });
    this.events.emit("order.items_edited", {
      orderId: updated.id,
      locationId: updated.locationId,
    });

    // Paper round chit — ONLY the new items, routed per station, with a
    // "ROUND N" banner. Best-effort: a printer problem must never fail
    // the round itself (the KDS resync above already has the items).
    void this.printJobs
      .createRoundChit({
        orderId: updated.id,
        roundNumber,
        items: items.map((it) => ({
          name: it.name,
          quantity: it.quantity,
          modifiers: it.modifiers ?? [],
          notes: it.notes ?? null,
        })),
      })
      .catch((err: any) =>
        this.logger.warn(
          `Round chit failed for ${updated.id} (round ${roundNumber}): ${err?.message}`,
        ),
      );

    return updated;
  }

  /** Table Tabs — print the bill (unpaid check) for a tab. */
  async printBill(orderId: string, tenantId: string): Promise<string[]> {
    return this.printJobs.printBill(orderId, tenantId);
  }

  // ── Split the bill ────────────────────────────────────────────────────
  //
  // A tab can be settled in several parts ("we'll pay £20 cash, the rest on
  // card", "split 4 ways"). Each part is a Payment row against the SAME
  // order — reusing the existing model, so no new table and refunds/ledger
  // keep working. When the parts cover the total the order flips to PAID and
  // (for a dine-in tab) completes and frees the table automatically.

  /** Payments taken so far + what's still owed. */
  async paymentSummary(orderId: string, tenantId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      select: { id: true, total: true, paymentStatus: true, tableId: true },
    });
    if (!order) throw new NotFoundException("Order not found");
    const payments = await this.prisma.payment.findMany({
      where: { orderId, status: "SUCCEEDED" },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        amount: true,
        method: true,
        createdAt: true,
        metadata: true,
      },
    });
    const total = Number(order.total);
    const paid = payments.reduce((s, p) => s + Number(p.amount), 0);
    // Which lines have already been paid for. "Pay for specific items"
    // records the ids it covered, so the till can cross them off and stop
    // them being charged twice — two staff settling the same table from
    // two tablets is a real scenario, not a hypothetical.
    const paidItemIds = Array.from(
      new Set(
        payments.flatMap((p) => {
          const ids = (p.metadata as any)?.itemIds;
          return Array.isArray(ids) ? ids.map(String) : [];
        }),
      ),
    );
    return {
      total,
      paid: round2(paid),
      remaining: round2(Math.max(0, total - paid)),
      settled: order.paymentStatus === "PAID",
      paidItemIds,
      payments,
    };
  }

  /** Record one part-payment against the tab. */
  async addPayment(
    orderId: string,
    tenantId: string,
    dto: {
      amount: number;
      method: "CASH" | "CARD";
      note?: string;
      /** Lines this part covers, when paying by item. */
      itemIds?: string[];
    },
    userId: string,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      select: {
        id: true,
        total: true,
        paymentStatus: true,
        tableId: true,
        locationId: true,
        status: true,
      },
    });
    if (!order) throw new NotFoundException("Order not found");
    const amount = round2(Number(dto.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException("Amount must be greater than zero");
    }

    const before = await this.paymentSummary(orderId, tenantId);
    if (before.remaining <= 0) {
      throw new BadRequestException("This bill is already fully paid");
    }

    // Reject lines that someone has already settled. Without this the
    // same item could be charged twice from two tills, and the paid-item
    // strike-through would silently disagree with the money taken.
    const itemIds = Array.from(new Set((dto.itemIds ?? []).map(String)));
    if (itemIds.length) {
      const alreadyPaid = itemIds.filter((id) =>
        before.paidItemIds.includes(id),
      );
      if (alreadyPaid.length) {
        throw new BadRequestException(
          "Some of those items have already been paid for — reopen the split to see what's left.",
        );
      }
      const owned = await this.prisma.orderItem.findMany({
        where: { orderId, id: { in: itemIds } },
        select: { id: true },
      });
      if (owned.length !== itemIds.length) {
        throw new BadRequestException("Those items aren't on this bill");
      }
    }
    // Guard against fat-finger overpayment beyond a rounding penny.
    if (amount > before.remaining + 0.01) {
      throw new BadRequestException(
        `That's more than the £${before.remaining.toFixed(2)} still owed`,
      );
    }

    await this.prisma.payment.create({
      data: {
        tenantId,
        orderId,
        amount,
        currency: "gbp",
        status: "SUCCEEDED",
        method: dto.method,
        netAmount: amount,
        metadata: {
          source: "SPLIT_BILL",
          takenBy: userId,
          note: dto.note ?? null,
          ...(itemIds.length ? { itemIds } : {}),
        } as Prisma.InputJsonValue,
      },
    });

    const after = await this.paymentSummary(orderId, tenantId);
    let settled = false;
    if (after.remaining <= 0.01) {
      settled = true;
      await this.prisma.order.update({
        where: { id: orderId },
        data: { paymentStatus: "PAID" },
      });
      // Dine-in tabs finish the moment the money's in: complete the order
      // and free the table so the floor plan is accurate without a second
      // trip to the POS. Best-effort — the payment is what matters.
      if (order.tableId) {
        await this.completeAndFreeTable(orderId, tenantId, userId).catch((e) =>
          this.logger.warn(
            `Split-bill settle: complete/free failed for ${orderId}: ${e?.message}`,
          ),
        );
      }
    }
    this.logger.log(
      `Split payment £${amount.toFixed(2)} ${dto.method} on ${orderId} — ` +
        `paid £${after.paid.toFixed(2)}/${after.total.toFixed(2)}${settled ? " (SETTLED)" : ""}`,
    );
    return { ...after, settled };
  }

  /**
   * Close out a settled dine-in tab: force the order to COMPLETED and free
   * its table. Uses a direct write rather than updateStatus because a tab
   * legitimately sits in ACCEPTED/PREPARING when the money arrives, and the
   * forward-only ladder would reject PREPARING → COMPLETED.
   */
  async completeAndFreeTable(
    orderId: string,
    tenantId: string,
    userId: string,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      select: { id: true, status: true, tableId: true },
    });
    if (!order) return;
    if (order.status !== "COMPLETED" && order.status !== "CANCELLED") {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { status: "COMPLETED" },
      });
      await this.prisma.orderStatusHistory.create({
        data: {
          orderId,
          tenantId,
          fromStatus: order.status,
          toStatus: "COMPLETED",
          actorType: "STAFF",
          changedBy: userId,
          note: "Tab settled — bill paid in full",
        },
      });
    }
    if (order.tableId) {
      await this.prisma.table.updateMany({
        where: { id: order.tableId },
        data: {
          status: "FREE",
          currentOrderId: null,
          openedAt: null,
          // A freed table is a NEW sitting — never inherit the last
          // party's guest count or server.
          covers: null,
          serverId: null,
          serverName: null,
        },
      });
    }

    // Tell the board. This writes COMPLETED straight to the database to
    // bypass the forward-only ladder, which means nothing else emits for
    // it — without this the settled tab sat on the Orders board as
    // Accepted until someone refreshed the page.
    const settled = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: { select: { quantity: true } } },
    });
    if (settled?.locationId) {
      this.socket.emitOrderUpdated(settled.locationId, {
        orderId: settled.id,
        tenantId: settled.tenantId,
        locationId: settled.locationId,
        platform: settled.platform,
        orderSource: settled.orderSource,
        fulfillmentType: settled.fulfillmentType,
        displayId: settled.displayId,
        status: settled.status,
        total: Number(settled.total),
        itemCount: settled.items.reduce((s, i) => s + (i.quantity ?? 0), 0),
        customerName: (settled as any).customerName ?? "",
        scheduledFor: settled.scheduledFor?.toISOString() ?? null,
        createdAt: settled.createdAt.toISOString(),
      } as any);
    }
  }

  // ── Status transitions ────────────────────────────────

  async updateStatus(
    orderId: string,
    tenantId: string,
    dto: UpdateOrderStatusDto,
    changedBy: string,
    actorType: OrderStatusActorType = "STAFF",
  ): Promise<Order> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
    });
    if (!order) throw new NotFoundException("Order not found");

    const newStatus = dto.status as OrderStatus;
    // WEBHOOK actor = courier/platform pushing the delivery lifecycle. It can
    // legitimately outrun our kitchen state (e.g. "delivered" while we still
    // show PREPARING), so it may fast-forward to any later stage; only a
    // terminal order is protected. Everyone else follows the strict machine.
    if (actorType === "WEBHOOK") {
      assertWebhookTransition(order.status, newStatus);
    } else {
      assertTransition(order.status, newStatus);
    }

    // Phase AV — operator gate. For PLATFORM-delivered orders (Uber
    // Eats / Deliveroo / Just Eat couriers) HubRise owns the post-
    // READY lifecycle. Block the dashboard from advancing past READY
    // unless the call is system-driven (the WEBHOOK actor type is set
    // by the HubRise delivery.update handler). CANCELLED stays
    // operator-allowed — the restaurant can always reject an order
    // they no longer want to make.
    // Anything after READY in the kitchen → courier → handover chain.
    // Note: there's no "DELIVERED" enum value — COMPLETED is the end
    // state; the courier-side statuses (ASSIGNED_DRIVER, OUT_FOR_DELIVERY,
    // RIDER_ARRIVED, DISPATCHED) are intermediate.
    const POST_READY: OrderStatus[] = [
      "PENDING_DISPATCH",
      "ASSIGNED_DRIVER",
      "ACCEPTED_BY_DRIVER",
      "RIDER_ARRIVED",
      "OUT_FOR_DELIVERY",
      "DISPATCHED",
      "COMPLETED",
    ];
    if (
      (order as any).deliveryType === "PLATFORM" &&
      actorType === "STAFF" &&
      POST_READY.includes(newStatus)
    ) {
      throw new BadRequestException(
        "This order is delivered by the marketplace courier — the platform updates this stage automatically. You can only mark up to Ready.",
      );
    }

    const timestampField = getTimestampField(newStatus);
    const timestampData = timestampField ? { [timestampField]: new Date() } : {};

    const updated = await this.prisma.$transaction(async (tx) => {
      // Optimistic concurrency: include updatedAt in where clause.
      const result = await tx.order.updateMany({
        where: { id: orderId, updatedAt: order.updatedAt },
        data: {
          status: newStatus,
          cancelReason: dto.cancelReason,
          ...timestampData,
        },
      });

      if (result.count === 0) {
        throw new ConflictException(
          "Order was modified by another request. Fetch the latest state and retry.",
        );
      }

      // WITH the relations. The board merges this response straight into the
      // row it already has, so returning a bare Order blanked the brand and
      // location columns the moment an order was accepted — the fields were
      // not changed, they were absent, and absent overwrote them.
      const updated = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: ORDER_INCLUDE,
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId,
          tenantId,
          fromStatus: order.status,
          toStatus: newStatus,
          actorType,
          changedBy,
          note: dto.note,
        },
      });

      // Outbox event is written in the same transaction as the status update.
      await tx.outboxEvent.create({
        data: this.outbox.forStatusChanged(
          tenantId,
          order.locationId,
          orderId,
          order.status,
          newStatus,
          dto.cancelReason,
        ),
      });

      return updated;
    });

    // Only STAFF actors carry a real User id. WEBHOOK/SYSTEM changes pass a
    // synthetic label (e.g. "webhook:UBER_EATS", "system") in `changedBy` that
    // is NOT a User.id — writing it to auditLog.userId violated the FK and
    // spammed warnings on every marketplace status push. Store the label in
    // meta.changedBy instead and leave userId null for non-staff actors.
    const auditUserId = actorType === "STAFF" ? changedBy : undefined;
    void this.audit.log({
      tenantId,
      userId: auditUserId,
      event: `order.status.${newStatus.toLowerCase()}`,
      resource: "order",
      resourceId: orderId,
      before: { status: order.status },
      after: { status: newStatus },
      meta: {
        locationId: order.locationId,
        platform: order.platform,
        actorType,
        changedBy,
        cancelReason: dto.cancelReason,
      },
    });

    // Phase AM — wire the print pipeline. Triggers on:
    //   • PENDING → ACCEPTED (the POS auto-accept path and the manager-tap
    //     accept path both go through here).
    //   • Scheduled future orders bypass the trigger at create-time and arrive
    //     here when the operator clicks "Start preparing now".
    // CANCELLED also fires a cancel ticket so the kitchen knows to bin the bag.
    // Phase AS-2 — drive the print engine off the same status events.
    // Each non-MANUAL trigger fans out via PrintJobsService which honours
    // each printer's autoPrintRules; printers without a matching rule
    // silently skip. Scheduled orders short-circuit ORDER_RECEIVED in
    // the service.
    const triggerForStatus = (() => {
      switch (newStatus) {
        case "ACCEPTED": return "ORDER_ACCEPTED";
        case "PREPARING": return "ORDER_PREPARING";
        case "READY": return "ORDER_READY";
        default: return null;
      }
    })();
    if (triggerForStatus) {
      this.printJobs
        .createFromOrder({ orderId, trigger: triggerForStatus as any })
        .catch((err: any) =>
          this.logger.warn(
            `createFromOrder(${triggerForStatus}) failed for ${orderId}: ${err.message}`,
          ),
        );
    }

    if (newStatus === "ACCEPTED") {
      // Phase AS-2 fully owns the print pipeline now. The legacy
      // `printQueue.enqueueForNewOrder(orderId)` call used to fire here
      // as well, which double-created PrintJob rows — one from the
      // routing service (claimed by the Print Bridge) and a second
      // identical row from the Bull-queue receipt formatter. Operators
      // saw it as "first ticket is wrong, second is right" because the
      // two pipelines used different payload field names and a stale
      // renderer. Removed; the legacy pipeline stays available for
      // CANCEL_TICKET (see below) until that flow is ported too.
      // Phase AP-8 — capture the held card authorization. No-op for
      // cash orders / orders without a held PI. Best-effort by design;
      // a capture failure is reported in logs and surfaced to ops, but
      // does NOT roll back the status change because the bag is going
      // out either way and reconciliation can happen out-of-band.
      this.payments
        .captureForOrder(orderId)
        .catch((err: any) =>
          this.logger.error(`Stripe capture failed for ${orderId}: ${err.message}`),
        );
    } else if (newStatus === "CANCELLED" || newStatus === "REJECTED") {
      this.printQueue.enqueueCancel(orderId).catch((err: any) => {
        this.logger.warn(
          `enqueueCancel failed for ${orderId}: ${err.message}`,
        );
      });
      // Phase AP-8 — refund-or-cancel based on capture state.
      // refundForOrder() is the smart entry point: if the payment is
      // already captured it issues a refund; if it's still in
      // authorization (pre-accept rejection) it cancels the auth
      // instead, which is cheaper and leaves no charge on the
      // customer's statement.
      //
      // The provider fork lives HERE rather than inside refundForOrder
      // because TapService already depends on PaymentsService for the
      // shared settle path, and branching downstream would make that a
      // cycle. Tap has no authorise-then-capture step — its charges are
      // captured outright — so there is no auth to cancel and a
      // cancellation is always a refund.
      //
      // Not silently skippable: refundForOrder bails early on a payment with
      // no stripePaymentIntentId, which every Tap payment is. Without this
      // branch a cancelled Gulf order would keep the customer's money and
      // nothing would say so.
      void (async () => {
        const loc = order.locationId
          ? await this.prisma.location.findUnique({
              where: { id: order.locationId },
              select: { country: true },
            })
          : null;
        if (usesTap(loc?.country)) {
          await this.tap.refundOrder(orderId, dto.cancelReason ?? "Order cancelled");
        } else {
          await this.payments.refundForOrder(orderId, dto.cancelReason ?? undefined);
        }
      })().catch((err: any) =>
        this.logger.error(`Refund/cancel failed for ${orderId}: ${err.message}`),
      );
    }

    // In-process event so channels (e.g. WhatsApp) can notify the customer of
    // status changes. Best-effort, decoupled via EventEmitter (no module cycle).
    this.events.emit("order.status_changed", {
      orderId,
      tenantId,
      locationId: order.locationId,
      fromStatus: order.status,
      toStatus: newStatus,
      // Lets platform-sync listeners (Deliveroo) skip echoing an inbound
      // webhook-driven transition straight back to the platform it came from.
      actorType,
    });

    // Phase LG — dashboard Logs page. One readable line per transition.
    this.events.emit("activity.log", {
      tenantId,
      locationId: order.locationId,
      brandId: (order as any).brandId ?? null,
      category: "ORDERS",
      channel: (order as any).platform ?? "DIRECT",
      action: `order.${newStatus.toLowerCase()}`,
      status:
        newStatus === "CANCELLED" || newStatus === "REJECTED"
          ? "WARNING"
          : "INFO",
      message: `Order #${(order as any).orderNumber ?? orderId} → ${newStatus}${actorType === "WEBHOOK" ? " (from platform)" : ""}`,
      details: { orderId, fromStatus: order.status, actorType },
    });

    // Phase AU — push the new status back to HubRise so every
    // connected aggregator (Uber Eats, Deliveroo, Just Eat) walks the
    // same lifecycle the operator sees here. No-op for non-HubRise
    // orders; failures are logged but never roll back the transition
    // (the bag has to leave the kitchen regardless of what HubRise's
    // API does).
    void this.hubriseSync.pushStatus({
      orderId,
      newStatus,
      fulfillmentType: order.fulfillmentType,
    });

    // Broadcast update — best-effort, immediate
    if (newStatus === "CANCELLED") {
      this.socket.emitToLocation(order.locationId, "order:cancelled", {
        orderId,
        locationId: order.locationId,
        reason: dto.cancelReason ?? null,
        cancelledAt: updated.cancelledAt?.toISOString() ?? new Date().toISOString(),
      });
    } else {
      this.socket.emitOrderUpdated(order.locationId, {
        orderId,
        tenantId,
        locationId: order.locationId,
        platform: updated.platform,
        orderSource: updated.orderSource,
        fulfillmentType: updated.fulfillmentType,
        displayId: updated.displayId,
        status: updated.status,
        total: Number(updated.total),
        itemCount: 0,
        customerName: (updated.customerInfo as any)?.name ?? "",
        scheduledFor: updated.scheduledFor?.toISOString() ?? null,
        createdAt: updated.createdAt.toISOString(),
      });
    }

    // Phase AX — tell the customer's browser. Fire-and-forget for the same
    // reason as HubRise above: the bag leaves the kitchen whether or not
    // Apple's push service is having a good day. notifyOrderStatus swallows
    // its own errors, and the void here stops an unhandled rejection if it
    // ever stops doing so.
    void this.customerPush
      .notifyOrderStatus({
        orderId,
        status: newStatus,
        orderNumber: updated.orderNumber,
        displayId: updated.displayId,
        fulfillmentType: updated.fulfillmentType,
        storefrontSlug: await this.storefrontSlugFor(order.locationId),
      })
      .catch(() => undefined);

    return updated;
  }

  /** The slug the customer-facing storefront lives under, so a notification
   *  can deep-link to /order/<slug>/status/<id>. Mirrors the resolution order
   *  in OrderingService.getStorefrontBySlug — onlineOrderingSlug is the
   *  current field, `slug` the legacy one older locations still use. */
  private async storefrontSlugFor(locationId?: string | null): Promise<string | null> {
    if (!locationId) return null;
    try {
      const loc = await this.prisma.location.findUnique({
        where: { id: locationId },
        select: { onlineOrderingSlug: true, slug: true },
      });
      return loc?.onlineOrderingSlug ?? loc?.slug ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Manually set an order's payment status (e.g. paid on a separate card
   * terminal). The Stripe Terminal flow sets PAID automatically; this is the
   * operator fallback. Broadcasts so the board's payment chip updates live.
   */
  async setPaymentStatus(
    orderId: string,
    tenantId: string,
    paymentStatus: "PAID" | "PENDING" | "FAILED",
    // How it was settled — recorded so the board/receipt say "Paid · Cash"
    // rather than just "Paid" (table tabs settle cash at Pay & close).
    paymentMethod?: string,
  ): Promise<Order> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      select: { id: true, locationId: true },
    });
    if (!order) throw new NotFoundException("Order not found");
    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        paymentStatus: paymentStatus as any,
        ...(paymentMethod ? { paymentMethod: paymentMethod as any } : {}),
      },
    });
    this.socket.emitOrderUpdated(order.locationId, {
      orderId,
      tenantId,
      locationId: order.locationId,
      platform: updated.platform,
      orderSource: updated.orderSource,
      fulfillmentType: updated.fulfillmentType,
      displayId: updated.displayId,
      status: updated.status,
      total: Number(updated.total),
      itemCount: 0,
      customerName: updated.customerName ?? "",
      scheduledFor: updated.scheduledFor?.toISOString() ?? null,
      createdAt: updated.createdAt.toISOString(),
    });
    // Money just landed — re-run the accept gate.
    //
    // maybeAutoAccept holds an order PENDING while WE are the ones collecting
    // (payment link, QR, card terminal, direct card, walk-in cash). Every one
    // of those needs something to knock on the door once payment succeeds:
    // the Stripe paths have the payment.authorized listener, and the terminal
    // has settleTerminalPi. Cash taken at the counter had nothing, so a
    // guarded walk-in order would have sat PENDING for ever and never
    // printed — the guard is only safe BECAUSE of this call.
    if (paymentStatus === "PAID" && updated.status === "PENDING") {
      void this.maybeAutoAccept(orderId, tenantId, order.locationId);
    }
    return updated;
  }

  // ── Queries ───────────────────────────────────────────

  // ── Access scoping (Phase AR team roles) ──────────────────────────────
  //
  // Orders must be scoped to the user's assigned locations AND brands. A
  // user assigned to brand A at a location running brands A+B must never
  // see brand B's orders, and "All locations" must never spill orders from
  // a location the user isn't assigned to. Admin roles see the whole
  // tenant. Scope is derived server-side from UserLocation/UserBrand — the
  // client-supplied locationId is only ever a NARROWING filter, never a way
  // to widen past the user's allowlist.

  /**
   * Resolve the user's order visibility. Returns id allowlists where
   * `null` = unrestricted for that dimension. An empty `locationIds`
   * array means the (non-admin) user has no assignments → sees nothing.
   */
  private resolveOrderScope(user: AuthenticatedUser): Promise<OrderScope> {
    return resolveOrderScopePure(this.prisma, user);
  }

  /**
   * Build the tenant + location + brand access constraint for an orders query.
   * Returns null when a non-admin user has no assignments at all (caller returns
   * an empty result rather than leaking the tenant). A requested locationId is
   * honoured only when it's inside the allowlist.
   *
   * Visibility is a UNION, not an intersection:
   *   • every order at a location the user is directly assigned to (ALL brands
   *     trading there — a location owner sees the whole board), OR
   *   • every order for a brand the user is assigned to (wherever it trades).
   * Intersecting the two used to hide marketplace orders homed to a different
   * brand (e.g. an Uber Eats order under the "Order Hub" brand) from the owner
   * of the location those orders physically arrive at.
   */
  /**
   * Public since Phase JE-6 — visibility only, no behaviour change.
   *
   * This is the canonical per-user order scope and the JET modification
   * routes need exactly it: an operator marking items out of stock must not
   * be able to reach an order outside their own brands and locations. Copying
   * the rule into another module is how scoping drifts, so callers outside
   * OrdersService use this one.
   *
   * Returns null when the user can see nothing — callers must treat that as
   * "no access", never as "no filter".
   */
  async resolveOrderAccessWhere(
    user: AuthenticatedUser,
    requestedLocationId?: string,
  ): Promise<Prisma.OrderWhereInput | null> {
    const scope = await this.resolveOrderScope(user);
    const where: Prisma.OrderWhereInput = { tenantId: user.tenantId };

    if (scope.admin) {
      // Admin — whole tenant; honour an explicit location filter if given.
      if (requestedLocationId) where.locationId = requestedLocationId;
      return where;
    }

    const or: Prisma.OrderWhereInput[] = [];
    if (scope.directLocationIds.length) {
      // A directly-assigned location: the whole board there, every brand.
      or.push({ locationId: { in: scope.directLocationIds } });
    }
    if (scope.brandIds && scope.allowedLocationIds.length) {
      // A brand assignment shows that brand's orders — but ONLY at locations
      // the user may see at all. The bound matters: this clause used to be a
      // bare `brandId IN (...)` with no location constraint, so any order
      // carrying an assigned brand was visible WHEREVER it was placed. A
      // brand that trades at several sites (or a shared marketplace brand
      // such as "Order Hub", which orders at unrelated locations are homed
      // to) therefore exposed other operators' boards to a location owner.
      or.push({
        AND: [
          { brandId: { in: scope.brandIds } },
          { locationId: { in: scope.allowedLocationIds } },
        ],
      });
    }
    if (!or.length) return null; // no assignments → nothing
    where.OR = or;

    // A requested location narrows the board to that one location — but only if
    // it's in the allowlist. ANDed with the union above: a directly-owned
    // location shows all its orders; a brand-derived location shows only the
    // user's brand orders there.
    if (requestedLocationId) {
      if (!scope.allowedLocationIds.includes(requestedLocationId)) return null;
      where.locationId = requestedLocationId;
    }

    return where;
  }

  async findMany(user: AuthenticatedUser, filters: OrderFilters) {
    const {
      locationId,
      status,
      platform,
      orderSource,
      from,
      to,
      page = 1,
      limit = 50,
    } = filters;

    const access = await this.resolveOrderAccessWhere(user, locationId);
    if (!access) return { total: 0, page, limit, orders: [] };

    const where: Prisma.OrderWhereInput = {
      ...access,
      ...(status && {
        status: Array.isArray(status) ? { in: status } : status,
      }),
      ...(platform && { platform: platform as any }),
      ...(orderSource && { orderSource: orderSource as any }),
      ...(from || to
        ? {
            createdAt: {
              ...(from && { gte: from }),
              ...(to && { lte: to }),
            },
          }
        : {}),
    };

    const [total, orders] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        include: ORDER_INCLUDE,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return { total, page, limit, orders };
  }

  async findOne(orderId: string, tenantId: string): Promise<OrderWithRelations> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new NotFoundException("Order not found");
    // Table Tabs — resolve the table's name (Order.tableId has no Prisma
    // relation) so the POS header and the tablet Bluetooth print path can
    // show/print "TABLE T5" without a second round-trip.
    if ((order as any).tableId) {
      const t = await this.prisma.table.findUnique({
        where: { id: (order as any).tableId },
        select: { name: true },
      });
      (order as any).tableName = t?.name ?? null;
    }
    return order;
  }

  /**
   * Phase AM — list orders that the POS marked as "scheduled for later".
   * These are still PENDING (no printer fired, kitchen doesn't see them yet)
   * with a non-null scheduledAt in the future. Used by the Orders board to
   * render a dedicated Scheduled section.
   */
  async findScheduledOrders(user: AuthenticatedUser, locationId?: string) {
    const access = await this.resolveOrderAccessWhere(user, locationId);
    if (!access) return [];
    return this.prisma.order.findMany({
      where: {
        ...access,
        status: { in: ["PENDING"] },
        scheduledAt: { not: null, gte: new Date(Date.now() - 60 * 60 * 1000) },
      },
      include: ORDER_INCLUDE,
      orderBy: { scheduledAt: "asc" },
    });
  }

  /**
   * Phase AM — "Start preparing now" action for scheduled orders.
   * Transitions PENDING → ACCEPTED via the normal status path so the print
   * pipeline (and status history, outbox, websocket emit) fire identically
   * to a regular accept. Also nulls scheduledAt so the order leaves the
   * Scheduled section on the board.
   */
  async startPreparingScheduled(
    orderId: string,
    tenantId: string,
    changedBy: string,
  ): Promise<Order> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (order.status !== "PENDING") {
      throw new ConflictException(
        `Order is in status ${order.status} — cannot start preparing`,
      );
    }

    // Clear scheduledAt so the order disappears from the Scheduled board.
    // We KEEP scheduledFor for audit (so we can compare promised vs actual).
    await this.prisma.order.update({
      where: { id: orderId },
      data: { scheduledAt: null },
    });

    return this.updateStatus(
      orderId,
      tenantId,
      { status: "ACCEPTED", note: "Started early via POS" },
      changedBy,
      "STAFF",
    );
  }

  /**
   * Phase AW-23 — Business-day reset helper.
   *
   * Returns the most recent occurrence of `resetHour:00` in the
   * given timezone that is ≤ now. Falls back to server-local time
   * when no timezone is supplied. Used to roll yesterday's
   * terminal orders off the live board at the start of the new
   * shift instead of letting them sit there for a rolling 24h.
   *
   * Example with resetHour=5 in Europe/London:
   *   - Asked at 03:30 BST  → returns yesterday 05:00 BST
   *   - Asked at 05:00 BST  → returns today 05:00 BST
   *   - Asked at 14:00 BST  → returns today 05:00 BST
   */
  private computeBusinessDayCutoff(
    timezone: string | undefined,
    resetHour: number,
  ): Date {
    const now = new Date();
    const local = timezone
      ? new Date(now.toLocaleString("en-US", { timeZone: timezone }))
      : now;
    // Drift between local and now (in ms) tells us how to shift
    // back to a real UTC Date once we've picked the calendar day
    // we want to anchor on.
    const drift = local.getTime() - now.getTime();
    // Today's reset moment (local clock).
    const todayReset = new Date(local);
    todayReset.setHours(resetHour, 0, 0, 0);
    // If we haven't crossed today's reset yet, the business day
    // started at yesterday's reset.
    if (local.getTime() < todayReset.getTime()) {
      todayReset.setDate(todayReset.getDate() - 1);
    }
    return new Date(todayReset.getTime() - drift);
  }

  async findLiveOrders(user: AuthenticatedUser, locationId?: string) {
    // Phase AW-23 — Business-day reset.
    //
    // Operators want yesterday's completed orders to drop off the
    // live board at the start of the new business day (5am local
    // by default) — not after a rolling 24h. Without this, a 23h-
    // ago COMPLETED order from a busy Friday night was still
    // staring at the Saturday-morning shift.
    //
    // We compute "most recent 5am in the location's timezone that
    // isn't in the future" and use it as the lower bound for
    // terminal orders. Active orders (PENDING/ACCEPTED/PREPARING/
    // READY/etc.) are never filtered by time — a stuck order from
    // any age still needs operator eyes on it.
    //
    // Tenant-wide view (no locationId) uses UTC 5am as a single
    // threshold; computing per-location would require a second
    // query for every order's timezone, which isn't worth it for
    // the rare "all locations" view.
    const access = await this.resolveOrderAccessWhere(user, locationId);
    if (!access) return [];
    let timezone: string | undefined;
    if (locationId) {
      const loc = await this.prisma.location.findUnique({
        where: { id: locationId },
        select: { timezone: true },
      });
      timezone = loc?.timezone ?? undefined;
    }
    const since24h = this.computeBusinessDayCutoff(timezone, 5);
    const rows = await this.prisma.order.findMany({
      where: {
        // AND, not a spread. `access` carries the location/brand scoping in
        // its own `OR` key, and this literal needs an `OR` of its own for the
        // live-status filter. Spreading access and then declaring `OR:` here
        // silently OVERWROTE the scoping — the later key wins in an object
        // literal — leaving `tenantId` as the only constraint, so every user
        // saw every order in the tenant on the live board. Composing with AND
        // means neither clause can clobber the other, whatever gets added
        // later.
        AND: [
          access,
          // Simulated marketplace orders are ours, not the shop's.
          //
          // They exist so we can exercise the marketplace receipt path — the
          // QR especially — against a real till without asking Uber or
          // Deliveroo to send anything. A shop's staff seeing a Deliveroo
          // order that nobody can deliver is worse than useless, so they are
          // visible to platform admins only.
          //
          // The ordinary DIRECT test order is untouched: operators use that
          // to check printer and board wiring, and it stays visible to them.
          ...(user.role === "PLATFORM_ADMIN"
            ? []
            : [
                {
                  NOT: {
                    AND: [
                      { isSandbox: true },
                      {
                        orderSource: {
                          notIn: ["POS", "DIRECT"],
                        },
                      },
                    ],
                  },
                } satisfies Prisma.OrderWhereInput,
              ]),
          {
        // Phase AP-8 — card orders aren't real to the kitchen until the
        // customer's authorization webhook lands and we flip paymentStatus
        // to AUTHORIZED. Hide PENDING+CARD from the board so staff don't
        // start preparing food the customer hasn't successfully paid for.
        // Phase AP-8 — card orders aren't real to the kitchen until
        // the authorize webhook lands. But this filter ONLY applies to
        // direct/storefront orders that go through Stripe Connect —
        // marketplace orders (HubRise, Uber Eats, Deliveroo) settle on
        // the channel side and arrive already paid, so they should
        // never be hidden here even if their paymentStatus briefly
        // shows PENDING during ingestion. Restricting by orderSource
        // keeps the kitchen-safety check intact for DIRECT while
        // letting HubRise/marketplace orders through.
        NOT: {
          AND: [
            { paymentMethod: "CARD" },
            { paymentStatus: "PENDING" },
            // Phase AW-30 — storefront places these as orderSource:
            // "ONLINE", DIRECT predates the AP flows. Hide both until
            // Stripe authorisation lands. Marketplace sources stay
            // visible because those orders arrive already paid.
            // Phase AY — WhatsApp is our own card-collect flow too, so hide
            // its PENDING card orders from the board until payment is
            // authorised. They reliably flip to AUTHORIZED via the Stripe
            // webhook or the WhatsAppReconcileCron (~20s), at which point
            // they appear (and auto-accept if enabled).
            { orderSource: { in: ["DIRECT", "ONLINE", "WHATSAPP"] } },
          ],
        },
        OR: [
          {
            status: {
              in: [
                "PENDING",
                "ACCEPTED",
                "PREPARING",
                "READY",
                "PENDING_DISPATCH",
                "ASSIGNED_DRIVER",
                "ACCEPTED_BY_DRIVER",
                "OUT_FOR_DELIVERY",
                // A driver sliding "Arrived at customer" sets RIDER_ARRIVED.
                // Leaving it out of this list made the order VANISH from the
                // board mid-delivery — it only came back when the driver
                // slid "delivered" and it landed in COMPLETED. It is a live
                // stage of a live order and belongs here.
                "RIDER_ARRIVED",
                "DISPATCHED",
              ],
            },
            // Phase AM — scheduled-for-later orders live in their own
            // section of the Orders board; exclude them here so they don't
            // clutter the "happening now" columns.
            OR: [
              { scheduledAt: null },
              { scheduledAt: { lt: new Date() } },
            ],
          },
          {
            status: { in: ["COMPLETED", "CANCELLED", "REJECTED", "FAILED"] },
            // Terminal orders belong to the business day they were PLACED in,
            // not last-touched — so an order created yesterday but completed
            // (by staff or the 5am rollover) still drops off at the reset,
            // rather than lingering because its updatedAt got bumped.
            createdAt: { gte: since24h },
          },
        ],
          },
        ],
      },
      include: ORDER_INCLUDE,
      orderBy: { createdAt: "desc" },
    });
    return this.attachKitchenNames(
      await this.attachCustomerVisitCounts(rows, user.tenantId),
    );
  }

  /**
   * Attach the kitchen-language name to each order line, for locations that
   * print translated tickets.
   *
   * WHY HERE and not only in the print queue: the desktop print agent uses the
   * server's KITCHEN_TICKET payload, but TABLETS BUILD THEIR OWN payload from
   * the live-orders feed (see buildPrintPayload in the web app). The same
   * split already cost us the driver PIN never reaching a printed ticket. The
   * tablet is also the only renderer that can draw CJK — it rasters the line,
   * where the desktop bridge depends on the printer's own font — so the path
   * that needs this most is the one that would not have had it.
   *
   * Costs one indexed lookup for shops that do not use the feature, and
   * returns before touching anything else.
   */
  private async attachKitchenNames<T extends Record<string, any>>(
    rows: T[],
  ): Promise<T[]> {
    try {
      const locIds = Array.from(
        new Set(rows.map((r) => r.locationId).filter((x): x is string => !!x)),
      );
      if (!locIds.length) return rows;

      const locs = await this.prisma.location.findMany({
        where: { id: { in: locIds } },
        select: { id: true, settings: true },
      });
      const translating = new Set(
        locs
          .filter(
            (l) =>
              ((l.settings ?? {}) as Record<string, unknown>)
                .kitchenTicketSecondLanguage === true,
          )
          .map((l) => l.id),
      );
      if (!translating.size) return rows;

      const live = rows.filter((r) => translating.has(r.locationId));
      const itemIds = Array.from(
        new Set(
          live
            .flatMap((r) => r.items ?? [])
            .map((i: any) => i.menuItemId)
            .filter((x: any): x is string => typeof x === "string" && !!x),
        ),
      );
      const modNames = Array.from(
        new Set(
          live
            .flatMap((r) => r.items ?? [])
            .flatMap((i: any) => i.modifiers ?? [])
            .map((m: any) => String(m?.name ?? "").trim())
            .filter(Boolean),
        ),
      );
      // Tenant, not brand. A modifier group is brand-wide when its locationId
      // is null, and an imported menu routinely references groups belonging to
      // a SIBLING brand of the same tenant — matching on the order's brandId
      // silently found nothing for exactly those, which is how translated
      // options still printed in English.
      const tenantIds = Array.from(
        new Set(live.map((r) => r.tenantId).filter((x: any): x is string => !!x)),
      );

      const [items, mods] = await Promise.all([
        itemIds.length
          ? this.prisma.menuItem.findMany({
              where: { id: { in: itemIds }, NOT: { secondLanguageName: null } },
              select: { id: true, secondLanguageName: true },
            })
          : Promise.resolve([]),
        modNames.length && tenantIds.length
          ? this.prisma.modifierOption.findMany({
              where: {
                name: { in: modNames },
                group: { brand: { tenantId: { in: tenantIds } } },
                NOT: { secondLanguageName: null },
              },
              select: { name: true, secondLanguageName: true },
            })
          : Promise.resolve([]),
      ]);

      const byItem = new Map(
        items
          .filter((i) => (i.secondLanguageName ?? "").trim())
          .map((i) => [i.id, i.secondLanguageName!.trim()]),
      );
      const byMod = new Map(
        mods
          .filter((m) => (m.secondLanguageName ?? "").trim())
          .map((m) => [m.name.trim(), m.secondLanguageName!.trim()]),
      );
      if (!byItem.size && !byMod.size) return rows;

      for (const r of live) {
        for (const it of (r.items ?? []) as any[]) {
          const n = it.menuItemId ? byItem.get(it.menuItemId) : undefined;
          // Only set a real translation. Absent means the ticket prints the
          // original, which is how a half-translated menu keeps working.
          if (n) it.secondLanguageName = n;
          for (const m of (it.modifiers ?? []) as any[]) {
            const mn = byMod.get(String(m?.name ?? "").trim());
            if (mn) m.secondLanguageName = mn;
          }
        }
      }
      return rows;
    } catch (e: any) {
      // A board that loads in English beats a board that does not load.
      this.logger.warn(`attachKitchenNames failed: ${e?.message ?? e}`);
      return rows;
    }
  }

  /**
   * Phase AW-26 — Annotate each order with how many TOTAL orders the
   * customer has placed at this tenant up to and including this one.
   *
   *   visitCount === 1  → "NEW CUSTOMER" badge on the card/ticket
   *   visitCount  >  1  → "Returning · #N" badge
   *
   * Identity = phone first (most reliable across guest checkouts +
   * POS + marketplace ingests), then customerAccountId, then
   * customerId. Orders missing all three get visitCount=1 to avoid
   * misleading the operator.
   *
   * Batched: one tenant-wide groupBy on phone covers the entire
   * board response, then we attribute counts in-process. For each
   * order, we cap visitCount to (orderCount) so the order itself
   * is included in its own running total — i.e. if a phone has 3
   * orders total, the oldest is #1, then #2, then #3.
   */
  private async attachCustomerVisitCounts<
    T extends {
      id: string;
      customerName: string | null;
      customerPhone: string | null;
      postcode: string | null;
      platform: string;
      orderSource: string;
      integrationSource: string;
      viaHubrise: boolean;
      brandId: string | null;
      createdAt: Date;
    },
  >(
    rows: T[],
    tenantId: string,
  ): Promise<Array<T & { customerVisitCount: number; customerVisitTag: string }>> {
    if (rows.length === 0) return [] as any;

    // Table Tabs — stamp the table's NAME onto dine-in rows (Order.tableId
    // has no Prisma relation). The board shows it and the tablet print
    // bridge prints "TABLE X" from the same field.
    try {
      const tableIds = [
        ...new Set(
          rows
            .map((r) => (r as any).tableId as string | null | undefined)
            .filter((id): id is string => !!id),
        ),
      ];
      if (tableIds.length) {
        const tables = await this.prisma.table.findMany({
          where: { id: { in: tableIds } },
          select: { id: true, name: true },
        });
        const byId = new Map(tables.map((t) => [t.id, t.name]));
        for (const r of rows) {
          const tid = (r as any).tableId;
          if (tid) (r as any).tableName = byId.get(tid) ?? null;
        }
      }
    } catch {
      /* table names are cosmetic — never fail the board over them */
    }

    // Build a per-row identity key. Marketplaces mask the customer
    // phone (Uber / Just Eat / Deliveroo / HubRise rotate the number
    // per order so dedup-by-phone always shows "NEW"), so for those
    // channels we key by name + postcode. POS + our direct online
    // storefront use name + phone + postcode — phone is reliable when
    // it's ours, and the extra signals tighten the match for walk-ins
    // who share a postcode.
    const MARKETPLACES = new Set([
      "JUST_EAT",
      "UBER_EATS",
      "DELIVEROO",
      "HUBRISE",
    ]);
    const norm = (s: string | null | undefined) =>
      (s ?? "").replace(/\s+/g, "").toLowerCase();
    // Phase AW-30 — identity is brand-scoped. Same customer ordering
    // from MONSTER and PIZZA UNO at the same kitchen lives in two
    // separate buckets so the receipt at MONSTER says "ORDER #4"
    // (their fourth MONSTER order) instead of "#9" (total across the
    // whole tenant).
    const identityFor = (o: {
      customerName: string | null;
      customerPhone: string | null;
      postcode: string | null;
      platform: string;
      orderSource: string;
      integrationSource: string;
      viaHubrise: boolean;
      brandId: string | null;
    }): string | null => {
      const isMarketplace =
        MARKETPLACES.has(o.integrationSource) ||
        MARKETPLACES.has(o.platform) ||
        o.viaHubrise;
      const name = norm(o.customerName);
      const postcode = norm(o.postcode);
      const phone = norm(o.customerPhone);
      const brand = o.brandId ?? "_";
      if (isMarketplace) {
        if (!name) return null;
        return `b:${brand}|mkt|${name}|${postcode}`;
      }
      if (!name) return null;
      if (!phone && !postcode) return null;
      return `b:${brand}|dir|${name}|${phone}|${postcode}`;
    };

    // Compute identities for every board row, then pull all tenant
    // orders that could plausibly contribute to any of those
    // identities. We don't reach for a DB-side GROUP BY on a derived
    // identity (Prisma can't express it efficiently), so the safer
    // path is a single findMany filtered to the *components* present
    // on the board (names, phones, postcodes) and a bucket pass in
    // process. Bounded to 365 days to keep the scan tight for big
    // tenants — anything older than a year shouldn't influence a
    // "returning customer" call anyway.
    const names = new Set<string>();
    const phones = new Set<string>();
    const postcodes = new Set<string>();
    for (const r of rows) {
      if (r.customerName) names.add(r.customerName);
      if (r.customerPhone) phones.add(r.customerPhone);
      if (r.postcode) postcodes.add(r.postcode);
    }

    const orClauses: any[] = [];
    if (names.size) orClauses.push({ customerName: { in: Array.from(names) } });
    if (phones.size) orClauses.push({ customerPhone: { in: Array.from(phones) } });
    if (postcodes.size)
      orClauses.push({ postcode: { in: Array.from(postcodes) } });

    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const countById = new Map<string, number>();
    if (orClauses.length > 0) {
      try {
        const siblings = await this.prisma.order.findMany({
          where: {
            tenantId,
            isSandbox: false,
            status: { not: "CANCELLED" },
            createdAt: { gte: oneYearAgo },
            OR: orClauses,
          },
          select: {
            customerName: true,
            customerPhone: true,
            postcode: true,
            platform: true,
            orderSource: true,
            integrationSource: true,
            viaHubrise: true,
            brandId: true,
          },
        });
        for (const s of siblings) {
          const id = identityFor(s);
          if (!id) continue;
          countById.set(id, (countById.get(id) ?? 0) + 1);
        }
        this.logger.log(
          `attachCustomerVisitCounts tenant=${tenantId} rows=${rows.length} siblings=${siblings.length} identities=${countById.size}`,
        );
      } catch (err) {
        this.logger.warn(
          `attachCustomerVisitCounts lookup failed for tenant=${tenantId}: ${(err as Error).message}`,
        );
      }
    }

    return rows.map((r) => {
      const id = identityFor(r);
      const lifetime = id ? (countById.get(id) ?? 1) : 1;
      return {
        ...r,
        customerVisitCount: lifetime,
        customerVisitTag: lifetime <= 1 ? "NEW" : "RETURNING",
      };
    });
  }
}

/** Money rounding — avoids 0.1+0.2 style drift when summing part-payments. */
function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
