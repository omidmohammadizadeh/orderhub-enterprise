import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { OrdersService } from "../../orders/orders.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { JetClientService } from "./jet-client.service";
import type { AuthenticatedUser } from "../../auth/interfaces/jwt-payload.interface";

// Phase JE-6 — out-of-stock and substitutions on a live Just Eat order.
//
//   POST /orders/{orderId}/validation    → would this be accepted?
//   POST /orders/{orderId}/modification  → do it
//   GET  /orders/{orderId}/modification  → what happened?
//
// (The /amend endpoint is marked Obsolete in the spec and says to use these
// instead, so it is deliberately not built.)
//
// WHERE THE RULES LIVE, AND WHY SPLIT THAT WAY
//
// JET documents two constraints on a substitution:
//   1. STRUCTURAL — one removed PLU may be replaced by one added PLU, and the
//      quantities must match. 2x500ml → 1x1L is rejected, and so is the
//      reverse.
//   2. PRICING — the added item must cost the same or less than the removed
//      one.
//
// The structural rules are checked HERE, before the call. They are
// deterministic, we can state them in words the operator understands, and a
// round trip to be told `notSupported` helps nobody mid-service.
//
// The pricing rule is left to JET. Our price and theirs can legitimately
// differ — per-channel pricing variants exist precisely so they can — and
// refusing locally on our own number would block a substitution their menu
// would have accepted. Their `validation` endpoint exists for exactly this.
//
// WHAT UPDATES OUR OWN ORDER: nothing here. The modification callback reports
// only success or failure, not the resulting basket. The amended order arrives
// as the Final Picked Order, which JE-1 already ingests through
// resyncMarketplaceItems — so the board updates from the same path that
// handles every other post-injection amendment.

export interface JetRemovedItem {
  plu: string;
  missingQuantity: number;
}

export interface JetAddedItem {
  plu: string;
  quantity: number;
}

export interface JetModificationPair {
  removedItems: JetRemovedItem[];
  addedItems?: JetAddedItem[];
}

export interface JetModificationError {
  errorCode: string;
  [key: string]: unknown;
}

@Injectable()
export class JetOrderModificationService {
  private readonly logger = new Logger(JetOrderModificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly client: JetClientService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  /**
   * Check the structural rules JET documents, before spending a round trip.
   *
   * Returns human-readable problems. Empty means "nothing we can rule out from
   * here" — NOT "JET will accept it", which only their validation endpoint can
   * say.
   */
  static structuralProblems(modifications: JetModificationPair[]): string[] {
    const problems: string[] = [];
    if (!Array.isArray(modifications) || modifications.length === 0) {
      return ["No modifications were supplied."];
    }

    const seenRemovedPlus = new Set<string>();
    modifications.forEach((pair, index) => {
      const label = `Change ${index + 1}`;
      const removed = pair?.removedItems ?? [];
      const added = pair?.addedItems ?? [];

      if (removed.length === 0) {
        problems.push(`${label}: nothing was marked as out of stock.`);
        return;
      }
      if (removed.length > 1) {
        // manyToOne / manyToMany — JET's own notSupportedReasons enum.
        problems.push(
          `${label}: Just Eat only accepts one out-of-stock item per change. ` +
            `Split "${removed.map((r) => r.plu).join('", "')}" into separate changes.`,
        );
        return;
      }
      if (added.length > 1) {
        problems.push(
          `${label}: an out-of-stock item can only be swapped for ONE replacement, ` +
            `not ${added.length}.`,
        );
        return;
      }

      const from = removed[0]!;
      if (!from.plu?.trim()) {
        problems.push(`${label}: the out-of-stock item has no PLU.`);
        return;
      }
      if (!(from.missingQuantity > 0)) {
        problems.push(
          `${label}: the missing quantity must be at least 1 (got ${from.missingQuantity}).`,
        );
        return;
      }
      // JET's own removedItemDuplicate error — cheaper to catch here.
      if (seenRemovedPlus.has(from.plu)) {
        problems.push(
          `${label}: "${from.plu}" is already marked out of stock in another change. ` +
            `Combine them into one.`,
        );
      }
      seenRemovedPlus.add(from.plu);

      const to = added[0];
      if (!to) return; // A straight removal, no substitution. Always allowed.
      if (!to.plu?.trim()) {
        problems.push(`${label}: the replacement item has no PLU.`);
        return;
      }
      if (to.quantity !== from.missingQuantity) {
        problems.push(
          `${label}: the replacement quantity must match — ${from.missingQuantity} ` +
            `× "${from.plu}" can only be swapped for ${from.missingQuantity} × "${to.plu}", ` +
            `not ${to.quantity}.`,
        );
      }
    });

    return problems;
  }

  /**
   * Ask JET whether a modification would be accepted.
   *
   * A 200 with a non-empty `errors` array is a REJECTION, not a failure — the
   * endpoint's whole job is to return the errors the real call would have
   * produced. Reading only the HTTP status here would report every invalid
   * substitution as valid.
   */
  async validate(
    user: AuthenticatedUser,
    orderId: string,
    modifications: JetModificationPair[],
  ): Promise<{ valid: boolean; problems: string[]; errors: JetModificationError[] }> {
    const order = await this.resolveOrder(user, orderId);

    const problems = JetOrderModificationService.structuralProblems(modifications);
    if (problems.length) return { valid: false, problems, errors: [] };

    const res = await this.client.request<{ errors?: JetModificationError[] }>(
      "POST",
      `/orders/${encodeURIComponent(order.externalId)}/validation`,
      {
        keyType: "order",
        brandId: order.brandId,
        locationId: order.locationId,
        body: { modifications },
      },
    );

    const errors = Array.isArray(res?.errors) ? res.errors : [];
    return {
      valid: errors.length === 0,
      problems: errors.map((e) => this.describeError(e)),
      errors,
    };
  }

  /**
   * Submit the modification.
   *
   * Validation runs first — structurally here, then against JET — because a
   * rejected modification leaves the order in limbo mid-service while the
   * kitchen waits to be told what to make.
   */
  async submit(
    user: AuthenticatedUser,
    orderId: string,
    modifications: JetModificationPair[],
  ) {
    const order = await this.resolveOrder(user, orderId);

    const problems = JetOrderModificationService.structuralProblems(modifications);
    if (problems.length) {
      throw new BadRequestException(problems.join(" "));
    }

    const check = await this.validate(user, orderId, modifications);
    if (!check.valid) {
      throw new BadRequestException(
        `Just Eat would reject this change: ${check.problems.join(" ")}`,
      );
    }

    await this.client.request(
      "POST",
      `/orders/${encodeURIComponent(order.externalId)}/modification`,
      {
        keyType: "order",
        brandId: order.brandId,
        locationId: order.locationId,
        body: { modifications },
        retries: 1,
      },
    );

    const summary = modifications
      .map((m) => {
        const from = m.removedItems[0]!;
        const to = m.addedItems?.[0];
        return to
          ? `${from.missingQuantity}× ${from.plu} → ${to.quantity}× ${to.plu}`
          : `${from.missingQuantity}× ${from.plu} removed`;
      })
      .join("; ");

    this.logger.log(
      `JET modification submitted for order ${order.externalId}: ${summary}`,
    );
    this.activity?.record({
      tenantId: order.tenantId,
      brandId: order.brandId,
      locationId: order.locationId,
      category: "ORDERS",
      channel: "JUST_EAT",
      action: "order.modification",
      status: "INFO",
      message: `Out-of-stock change sent to Just Eat for order ${order.displayId ?? order.externalId}: ${summary}`,
      details: { modifications },
    });

    // Deliberately not marked done. JET processes asynchronously and reports
    // on the modification callback; the amended basket itself arrives as the
    // Final Picked Order.
    return { ok: true, pending: true, summary };
  }

  /** Current state: initialised | pending | accepted | failed | succeeded. */
  async getState(user: AuthenticatedUser, orderId: string) {
    const order = await this.resolveOrder(user, orderId);
    const res = await this.client.request<{ orderId?: string; state?: string }>(
      "GET",
      `/orders/${encodeURIComponent(order.externalId)}/modification`,
      {
        keyType: "order",
        brandId: order.brandId,
        locationId: order.locationId,
      },
    );
    return { orderId, jetOrderId: order.externalId, state: res?.state ?? "unknown" };
  }

  /**
   * JET's asynchronous modification result.
   *
   * The success and failure bodies are different shapes sharing one endpoint,
   * distinguished by the presence of `errors`. Neither carries the resulting
   * basket — that arrives as the Final Picked Order, which JE-1 already
   * ingests.
   */
  async handleModificationCallback(
    payload: any,
  ): Promise<{ handled: boolean; reason?: string }> {
    const jetOrderId = String(payload?.orderId ?? payload?.orderID ?? "").trim();
    if (!jetOrderId) return { handled: false, reason: "no_order_id" };

    const errors: JetModificationError[] = Array.isArray(payload?.errors)
      ? payload.errors
      : [];
    const succeeded = errors.length === 0;

    const order = await this.prisma.order.findFirst({
      where: { externalId: jetOrderId, platform: "JUST_EAT" },
      select: {
        id: true,
        tenantId: true,
        brandId: true,
        locationId: true,
        displayId: true,
      },
    });
    if (!order) {
      this.logger.warn(
        `JET modification callback for unknown order ${jetOrderId} — ignoring`,
      );
      return { handled: false, reason: "order_not_found" };
    }

    const described = errors.map((e) => this.describeError(e));
    if (succeeded) {
      this.logger.log(`JET modification SUCCEEDED for order ${jetOrderId}`);
    } else {
      this.logger.error(
        `JET modification FAILED for order ${jetOrderId}: ${described.join(" ")}`,
      );
    }

    this.activity?.record({
      tenantId: order.tenantId,
      brandId: order.brandId,
      locationId: order.locationId,
      category: "ORDERS",
      channel: "JUST_EAT",
      action: "order.modification_result",
      status: succeeded ? "SUCCESS" : "ERROR",
      message: succeeded
        ? `Just Eat applied the out-of-stock change to order ${order.displayId ?? jetOrderId}`
        : `Just Eat rejected the out-of-stock change on order ${order.displayId ?? jetOrderId}: ${described.join(" ")}`,
      details: { jetOrderId, errors },
    });

    return { handled: true };
  }

  /**
   * Turn one of JET's error codes into something a person can act on.
   *
   * Their own note says the enum "could be expanded in the future" and that
   * applications should tolerate new values, so an unknown code falls through
   * to the raw value rather than being swallowed or mapped to a wrong guess.
   */
  private describeError(error: JetModificationError): string {
    const code = String(error?.errorCode ?? "unknown");
    switch (code) {
      case "orderNotFound":
        return "Just Eat no longer has this order.";
      case "removedItemNotFound":
        return `The out-of-stock item (${(error.removed as any)?.plu ?? "?"}) isn't on this order.`;
      case "removedItemDuplicate":
        return "The same item was marked out of stock twice — combine those changes.";
      case "removedItemSubstitutionNotEnabled":
        return "The customer didn't allow substitutions for this item, so it can only be removed.";
      case "addedItemNotFound":
        return `The replacement (${(error.added as any)?.plu ?? "?"}) isn't on the published menu.`;
      case "addedPriceIsGreaterThanRemoved": {
        const pricing = error.pricing as any;
        const diff = pricing?.priceDifference;
        return (
          "The replacement costs more than the item it replaces" +
          (diff ? ` (by ${diff} ${pricing?.currency ?? ""})` : "") +
          " — pick something the same price or cheaper."
        );
      }
      case "newTotalPriceLessThanOrEqualToZero":
        return "This change would take the order total to zero — cancel the order instead.";
      case "notSupported": {
        const reasons = (error.notSupportedReasons as string[]) ?? [];
        if (reasons.includes("oneToManySubstitution"))
          return "One item can't be swapped for several — Just Eat only accepts one-for-one.";
        if (reasons.includes("manyToOneSubstitution"))
          return "Several items can't be swapped for one — Just Eat only accepts one-for-one.";
        if (reasons.includes("manyToManySubstitution"))
          return "Just Eat only accepts one-for-one substitutions.";
        if (reasons.includes("removedComplexItemInSubstitution"))
          return "An item with options can't be substituted — remove it instead.";
        return "Just Eat doesn't support this kind of change.";
      }
      case "cancelOrderNotAllowed":
        return "This change would empty the order, which isn't allowed here.";
      case "badRequestFormat":
        return "Just Eat rejected the request format.";
      case "upstreamPartner":
        return "The delivery partner rejected the change.";
      default:
        return `Just Eat returned "${code}".`;
    }
  }

  /**
   * Load the order, scoped to what this user may actually see.
   *
   * Uses OrdersService.resolveOrderAccessWhere — the canonical per-user
   * location+brand scope — rather than re-deriving it. A null result means no
   * access at all and must never fall back to a tenant-wide lookup.
   */
  private async resolveOrder(user: AuthenticatedUser, orderId: string) {
    const access = await this.orders.resolveOrderAccessWhere(user);
    if (!access) throw new ForbiddenException("You don't have access to this order");

    const order = await this.prisma.order.findFirst({
      where: { AND: [access, { id: orderId, platform: "JUST_EAT" }] },
      select: {
        id: true,
        tenantId: true,
        brandId: true,
        locationId: true,
        externalId: true,
        displayId: true,
        status: true,
      },
    });
    if (!order) throw new NotFoundException("Just Eat order not found");
    if (!order.externalId) {
      throw new BadRequestException(
        "This order has no Just Eat reference, so it can't be modified there.",
      );
    }
    return order as typeof order & { externalId: string };
  }
}
