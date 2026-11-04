// Eat For Less — private calls between a customer and their driver.
//
// One phone number (EFL_CALL_NUMBER) and two codes per order. Whoever rings
// keys their code; we look it up and transfer the call FROM our number, so
// neither side ever sees the other's. The line closes CALL_LINE_HOURS_AFTER
// the handover, and on a cancelled order at once.
//
// The driver app already knows how to dial a number then a code after a
// pause (marketplaces mask their customers the same way), so drivers on the
// builds already installed get private calls the moment this deploys: their
// job card is simply handed our number and their code as the customer's.

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DriverAssignmentStatus } from "@orderhub/database";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { TelnyxCallControlService } from "../voice/telnyx-call-control.service";
import { callLineOpen, generateCallCode, normaliseKeyedCode } from "./efl-rules";

/** Wrong codes a caller gets before we say goodbye. */
const MAX_CODE_TRIES = 3;

const DRIVER_STILL_HAS_IT: DriverAssignmentStatus[] = [
  DriverAssignmentStatus.ASSIGNED,
  DriverAssignmentStatus.ACCEPTED,
  DriverAssignmentStatus.PICKED_UP,
  DriverAssignmentStatus.DELIVERED,
];

type Prisma = Pick<PrismaService, "eflCallLine" | "order">;

/**
 * The order's line, made on first use. Codes repeat over time, so a new one
 * is only refused if a line that is still OPEN already answers it.
 */
export async function ensureCallLine(prisma: Prisma, orderId: string) {
  const existing = await prisma.eflCallLine.findUnique({ where: { orderId } });
  if (existing) return existing;
  const customerCode = await freeCode(prisma);
  let driverCode = await freeCode(prisma);
  while (driverCode === customerCode) driverCode = await freeCode(prisma);
  // Two requests can both miss `existing`; the unique orderId makes the
  // second a no-op instead of a second pair of codes.
  return prisma.eflCallLine.upsert({
    where: { orderId },
    create: { orderId, customerCode, driverCode },
    update: {},
  });
}

async function freeCode(prisma: Prisma): Promise<string> {
  const now = new Date();
  for (let i = 0; i < 8; i++) {
    const code = generateCallCode();
    const clashes = await prisma.eflCallLine.findMany({
      where: { OR: [{ customerCode: code }, { driverCode: code }] },
      select: { orderId: true },
    });
    if (!clashes.length) return code;
    const orders = await prisma.order.findMany({
      where: { id: { in: clashes.map((c) => c.orderId) } },
      select: { status: true, deliveredAt: true, updatedAt: true },
    });
    if (!orders.some((o) => callLineOpen(o, now))) return code;
  }
  throw new Error("Couldn't find a free call code");
}

/** The number both sides ring, or null when private calls aren't set up. */
export function eflCallNumber(config?: Pick<ConfigService, "get">): string | null {
  const value = config ? config.get<string>("EFL_CALL_NUMBER") : process.env.EFL_CALL_NUMBER;
  return value?.trim() || null;
}

export type CallTarget = { to: string; who: "driver" | "shop" | "customer" };

@Injectable()
export class EflCallsService {
  private readonly logger = new Logger(EflCallsService.name);
  /** Wrong codes so far, per call. One API instance answers these. */
  private readonly tries = new Map<string, number>();
  /** Calls to hang up once the goodbye has been said. */
  private readonly hangUpAfterSpeech = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    readonly telnyx: TelnyxCallControlService,
  ) {}

  number(): string | null {
    return eflCallNumber(this.config);
  }

  /** What the customer's app dials, while the line is open. */
  async customerLine(order: { id: string; status: string; deliveredAt?: Date | null; updatedAt?: Date | null }) {
    const number = this.number();
    if (!number || !callLineOpen(order, new Date())) return null;
    const line = await ensureCallLine(this.prisma, order.id);
    return { number, code: line.customerCode };
  }

  /** Who a keyed code should reach, or null for a wrong or closed one. */
  async targetFor(digits: unknown, now = new Date()): Promise<CallTarget | null> {
    const code = normaliseKeyedCode(digits);
    if (code.length !== 6) return null;
    const lines = await this.prisma.eflCallLine.findMany({
      where: { OR: [{ customerCode: code }, { driverCode: code }] },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    for (const line of lines) {
      const order = await this.prisma.order.findUnique({
        where: { id: line.orderId },
        select: {
          status: true,
          deliveredAt: true,
          updatedAt: true,
          customerPhone: true,
          location: { select: { phone: true } },
        },
      });
      if (!order || !callLineOpen(order, now)) continue;

      if (line.driverCode === code) {
        return order.customerPhone ? { to: order.customerPhone, who: "customer" } : null;
      }
      // The customer's code reaches whoever has the food: the driver once
      // one has it, the shop before that (or for a courier we can't reach).
      const assignment = await this.prisma.driverAssignment.findFirst({
        // One assignment per order (orderId is unique on it).
        where: { orderId: line.orderId, status: { in: DRIVER_STILL_HAS_IT } },
        select: { driver: { select: { phone: true } } },
      });
      if (assignment?.driver?.phone) return { to: assignment.driver.phone, who: "driver" };
      return order.location?.phone ? { to: order.location.phone, who: "shop" } : null;
    }
    return null;
  }

  // ── The phone call ────────────────────────────────────────────────────

  async onEvent(type: string, p: any): Promise<void> {
    const ccid: string | undefined = p?.call_control_id;
    if (!ccid) return;
    switch (type) {
      case "call.initiated":
        // Our own transfer leg reports here too; only answer callers.
        if (p.direction === "incoming") await this.telnyx.answer(ccid);
        break;
      case "call.answered":
        if (p.direction === "incoming") await this.askForCode(ccid, false);
        break;
      case "call.gather.ended":
        await this.onDigits(ccid, p?.digits);
        break;
      case "call.speak.ended":
        if (this.hangUpAfterSpeech.delete(ccid)) await this.telnyx.hangup(ccid);
        break;
      case "call.hangup":
        this.tries.delete(ccid);
        this.hangUpAfterSpeech.delete(ccid);
        this.telnyx.markEnded(ccid);
        break;
    }
  }

  private askForCode(ccid: string, retry: boolean) {
    const prompt = retry
      ? "Sorry, that code didn't work. Please enter the six digit code from your Eat For Less app, then press hash."
      : "Eat For Less private line. Please enter your six digit call code, then press hash.";
    return this.telnyx.gatherDigits(ccid, prompt, { maxDigits: 6 });
  }

  private async onDigits(ccid: string, digits: unknown) {
    const target = await this.targetFor(digits).catch((e) => {
      this.logger.error(`EFL call ${ccid.slice(-8)} lookup failed: ${(e as Error).message}`);
      return null;
    });
    if (target) {
      this.tries.delete(ccid);
      this.logger.log(`EFL call ${ccid.slice(-8)} connecting to the ${target.who}`);
      const ok = await this.telnyx.transfer(ccid, target.to, this.number() ?? undefined);
      if (!ok) await this.goodbye(ccid, "Sorry, we couldn't connect your call. Please try again in a moment.");
      return;
    }
    const tries = (this.tries.get(ccid) ?? 0) + 1;
    this.tries.set(ccid, tries);
    this.logger.log(`EFL call ${ccid.slice(-8)} wrong or closed code (${tries}/${MAX_CODE_TRIES})`);
    if (tries >= MAX_CODE_TRIES) {
      await this.goodbye(
        ccid,
        "Sorry, we couldn't find that code. Private lines close two hours after delivery. Goodbye.",
      );
      return;
    }
    await this.askForCode(ccid, true);
  }

  private async goodbye(ccid: string, text: string) {
    this.hangUpAfterSpeech.add(ccid);
    if (!(await this.telnyx.speak(ccid, text))) {
      this.hangUpAfterSpeech.delete(ccid);
      await this.telnyx.hangup(ccid);
    }
  }
}
