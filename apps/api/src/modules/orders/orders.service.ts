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
import type { Prisma, Order, OrderStatus, OrderStatusActorType } from "@orderhub/database";
import { QUEUES, ORDER_JOBS } from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SocketService } from "../../infrastructure/socket/socket.service";
import { AuditLogService } from "../auth/services/audit-log.service";
import { OutboxService } from "../outbox/outbox.service";
import { PrintQueueService } from "../printers/print-queue.service";
import { PrintJobsService } from "../printers/print-jobs.service";
import { HubRiseOrderSyncService } from "../integrations/hubrise/hubrise-order-sync.service";
import { PaymentsService } from "../payments/payments.service";
import { PromoCodesService } from "../promo-codes/promo-codes.service";
import { assertTransition, getTimestampField } from "./order-state-machine";
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
      brand: { select: { id: true, name: true, logoUrl: true, phone: true, addressLine1: true, city: true, postcode: true } },
    },
  },
  // Surface the order's brand to the dashboard so the board can render
  // a per-brand badge. Order.brandId is nullable (set when the cart
  // resolves to a specific virtual brand, null for unattached orders),
  // and onDelete: SetNull on the relation means the column may
  // legitimately be present-but-null after a brand is deleted.
  brand: { select: { id: true, name: true, logoUrl: true } },
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
    // Phase AU — push status back to HubRise. forwardRef needed because
    // HubRiseModule transitively imports OrdersModule (via WebhooksModule).
    @Inject(forwardRef(() => HubRiseOrderSyncService))
    private readonly hubriseSync: HubRiseOrderSyncService,
  ) {}

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
        select: { status: true, platform: true, orderSource: true },
      });
      if (!fresh) return;
      if (fresh.status !== "PENDING") {
        this.logger.log(
          `Auto-accept skipped order ${orderId} — already ${fresh.status}`,
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
    options: { isSandbox?: boolean } = {},
  ): Promise<Order> {
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
      const waitForOurAuth = !isPlatformOrder && isUnpaidCard;
      // Scheduled orders auto-accept on arrival too — the kitchen sees
      // them straight away with the scheduled date/time on the ticket,
      // rather than being parked until their slot.
      if (!waitForOurAuth) {
        void this.maybeAutoAccept(order.id, tenantId, locationId);
      }

      if (!isUnpaidCard) this.socket.emitNewOrder(locationId, {
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
    const canonical = {
      externalId: `${idPrefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      platform: resolvedSource as any,
      orderSource: resolvedSource as any,
      integrationSource: "DIRECT" as const,
      viaHubrise: false,
      fulfillmentType: dto.fulfillmentType ?? ("DELIVERY" as const),
      displayId: undefined,
      customerInfo: dto.customerInfo,
      deliveryAddress: dto.deliveryAddress
        ? { ...dto.deliveryAddress, country: dto.deliveryAddress.country ?? "GB" }
        : undefined,
      items: dto.items.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        totalPrice: i.totalPrice,
        notes: i.notes,
        sku: i.sku,
        modifiers: (i.modifiers ?? []).map((m) => ({
          name: m.name,
          price: m.price,
          quantity: m.quantity ?? 1,
        })),
      })),
      subtotal: dto.subtotal,
      taxAmount: dto.taxAmount ?? 0,
      deliveryFee: dto.deliveryFee ?? 0,
      discount: dto.discount ?? 0,
      total: dto.total,
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
      brandId: (dto as any).brandId,
    };

    const order = await this.ingestCanonical(canonical as any, tenantId, dto.locationId);

    // Persist the POS-specific structured columns + payment fields. We do
    // this in a follow-up update rather than threading every field through
    // CanonicalOrder so the webhook adapters stay unchanged.
    const posUpdate: Prisma.OrderUpdateInput = {};
    if (dto.deliveryAddress) {
      posUpdate.addressLine1 = dto.deliveryAddress.line1;
      posUpdate.addressLine2 = dto.deliveryAddress.line2 ?? null;
      posUpdate.city = dto.deliveryAddress.city;
      posUpdate.postcode = dto.deliveryAddress.postcode;
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
    overrides: { customerName?: string; fulfillmentType?: "PICKUP" | "DELIVERY" } = {},
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

    const canonical = {
      externalId,
      platform: "DIRECT" as const,
      orderSource: "POS" as const,
      integrationSource: "DIRECT" as const,
      viaHubrise: false,
      fulfillmentType,
      displayId: `TEST-${externalId.slice(-4).toUpperCase()}`,
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
      specialInstructions: "Phase AJ manual test order — safe to discard",
      metadata: { isTestOrder: true, createdByUserId: userId },
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
  //   - paymentMethod must be CASH. CARD orders may already be
  //     captured; we don't want a delta that the customer can't pay.
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
      discount?: number;
      total: number;
      customerInfo?: { name: string; phone?: string; email?: string };
      deliveryAddress?: {
        line1: string;
        line2?: string;
        city: string;
        postcode: string;
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
    if ((order.paymentMethod ?? "").toUpperCase() !== "CASH") {
      throw new BadRequestException(
        "Only cash orders can be edited",
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

    return updated;
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
    assertTransition(order.status, newStatus);

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

      const updated = await tx.order.findUniqueOrThrow({ where: { id: orderId } });

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

    void this.audit.log({
      tenantId,
      userId: changedBy,
      event: `order.status.${newStatus.toLowerCase()}`,
      resource: "order",
      resourceId: orderId,
      before: { status: order.status },
      after: { status: newStatus },
      meta: {
        locationId: order.locationId,
        platform: order.platform,
        actorType,
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
      this.payments
        .refundForOrder(orderId, dto.cancelReason ?? undefined)
        .catch((err: any) =>
          this.logger.error(`Stripe refund/cancel failed for ${orderId}: ${err.message}`),
        );
    }

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

    return updated;
  }

  // ── Queries ───────────────────────────────────────────

  async findMany(tenantId: string, filters: OrderFilters) {
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

    const where: Prisma.OrderWhereInput = {
      tenantId,
      ...(locationId && { locationId }),
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
    return order;
  }

  /**
   * Phase AM — list orders that the POS marked as "scheduled for later".
   * These are still PENDING (no printer fired, kitchen doesn't see them yet)
   * with a non-null scheduledAt in the future. Used by the Orders board to
   * render a dedicated Scheduled section.
   */
  async findScheduledOrders(tenantId: string, locationId?: string) {
    return this.prisma.order.findMany({
      where: {
        tenantId,
        ...(locationId && { locationId }),
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

  async findLiveOrders(tenantId: string, locationId?: string) {
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
        tenantId,
        ...(locationId && { locationId }),
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
            { orderSource: { in: ["DIRECT", "ONLINE"] } },
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
            updatedAt: { gte: since24h },
          },
        ],
      },
      include: ORDER_INCLUDE,
      orderBy: { createdAt: "desc" },
    });
    return this.attachCustomerVisitCounts(rows, tenantId);
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
