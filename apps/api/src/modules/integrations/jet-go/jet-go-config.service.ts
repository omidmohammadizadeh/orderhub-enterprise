// Phase BJ — JET Go config.
//
// TWO COMMERCIAL MODES, because our contract with JET defines both and they
// bill in opposite directions:
//
//   RESELLER (the default, and what we signed). The JET Go account is OURS.
//   JET has no relationship with the restaurant at all — it invoices US per
//   completed delivery, £4.25–£9.20 by distance. Credentials are therefore
//   platform-level, from the environment, and no merchant ever sees or holds
//   them. The wallet has to recover the courier cost as well as our margin,
//   because we owe JET that money whether or not the shop pays us
//   (Schedule 2, clause 8).
//
//   MERCHANT ACCOUNT (Payment Processor / Intermediary in the contract). A
//   chain brings its own JET Go account; JET bills them directly. Credentials
//   live on the location row, and the wallet only takes our margin — the same
//   shape as Stuart and Uber Direct.
//
// Per-location credentials therefore OVERRIDE the platform ones, and their
// presence is what selects the mode. Everything else here is shared:
//
//   • collectPointId — JET takes a pickup POINT id, not an address, so a
//     location with credentials but no collect point still can't dispatch.
//     Under the reseller model this is how one account serves many shops: one
//     credential, one collect point per site.
//   • a webhookToken + webhookSecret pair, SHARED between locations on the same
//     clientId because JET keeps one notification config per credential. The
//     token is the path segment (shown to the operator); the secret is what JET
//     sends back. They are different values so copying the URL leaks nothing.

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomBytes } from "crypto";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { CredentialEncryptionService } from "../credential-encryption.service";
import type { JetGoCreds } from "./jet-go-client.service";

export interface DecryptedJetGoConfig extends JetGoCreds {
  tenantId: string;
  locationId: string;
  collectPointId: string | null;
  collectPointName: string | null;
  webhookToken: string;
  webhookSecret: string;
  active: boolean;
  /** Ask JET for a PIN the customer must give the courier to close the job. */
  requirePinOnDelivery: boolean;
  /** Age to check at the door, and whether the courier scans ID, when the
   *  order carries an age-restricted line. */
  alcoholAgeRestriction: number;
  alcoholIdScan: boolean;
  /**
   * True when these are OUR credentials, so JET invoices us for the courier and
   * the wallet must recover that cost on top of our margin. False when the
   * merchant brought their own account and JET bills them directly.
   */
  reseller: boolean;
}

const MARKETS = ["UK", "CA", "AU", "EU"];

/** The platform JET Go account — the reseller credentials from our own
 *  contract. Absent in dev, which simply means reseller mode is unavailable
 *  and only merchant-owned accounts work. */
export function platformJetGoCredentials(): JetGoCreds | null {
  const clientId = (process.env.JET_GO_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.JET_GO_CLIENT_SECRET ?? "").trim();
  if (!clientId || !clientSecret) return null;
  const market = String(process.env.JET_GO_MARKET ?? "UK").trim().toUpperCase();
  return {
    clientId,
    clientSecret,
    market: MARKETS.includes(market) ? market : "UK",
    environment:
      process.env.JET_GO_ENVIRONMENT === "production" ? "production" : "sandbox",
  };
}

@Injectable()
export class JetGoConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: CredentialEncryptionService,
  ) {}

  private db(): any {
    return this.prisma as any;
  }

  private async assertLocation(locationId: string, tenantId: string): Promise<void> {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null, brand: { tenantId } },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException("Location not found");
  }

  /** The URL JET posts webhooks to. Keyed on the token, not the location,
   *  because one credential serves every location that shares it. */
  webhookUrl(apiBaseUrl: string, token: string): string {
    return `${apiBaseUrl.replace(/\/$/, "")}/api/v1/webhooks/jet-go/${token}`;
  }

  /** Operator view — never leaks the client secret or the webhook token. */
  async getPublicConfig(locationId: string, tenantId: string, apiBaseUrl: string) {
    await this.assertLocation(locationId, tenantId);
    const row = await this.db().jetGoConfig.findUnique({ where: { locationId } });
    if (!row) {
      return {
        configured: false,
        active: false,
        market: platformJetGoCredentials()?.market ?? "UK",
        environment: platformJetGoCredentials()?.environment ?? "sandbox",
        reseller: Boolean(platformJetGoCredentials()),
        webhookUrl: null,
        webhookUsername: null,
        clientIdMasked: null,
        collectPointId: null,
        collectPointName: null,
        requirePinOnDelivery: false,
        alcoholAgeRestriction: 18,
        alcoholIdScan: true,
        onboardingStatus: null,
        onboardingReference: null,
        onboardingError: null,
        /** Dispatch needs all three: credentials, a collect point, and active. */
        readyToDispatch: false,
      };
    }
    const cfg = this.toDecrypted(row);
    const id = cfg.reseller ? "" : cfg.clientId;
    return {
      configured: true,
      active: row.active,
      market: cfg.market,
      environment: cfg.environment,
      // Which account this shop's deliveries go on, and therefore who JET
      // invoices for the courier.
      reseller: cfg.reseller,
      webhookUrl: this.webhookUrl(apiBaseUrl, row.webhookToken),
      // JET's BASIC notification config needs a username; we always use this one
      // so the operator can read it back off the screen if JET ops ask.
      webhookUsername: "orderhub",
      clientIdMasked: id ? `${id.slice(0, 4)}…${id.slice(-4)}` : null,
      collectPointId: row.collectPointId,
      collectPointName: row.collectPointName,
      requirePinOnDelivery: Boolean(row.requirePinOnDelivery),
      alcoholAgeRestriction: Number(row.alcoholAgeRestriction) || 18,
      alcoholIdScan: row.alcoholIdScan ?? true,
      onboardingStatus: row.onboardingStatus ?? null,
      onboardingReference: row.onboardingReference ?? null,
      onboardingError: row.onboardingError ?? null,
      readyToDispatch: Boolean(row.active && row.collectPointId),
    };
  }

  async upsert(
    locationId: string,
    tenantId: string,
    dto: { clientId: string; clientSecret: string; market?: string; environment?: string },
  ) {
    await this.assertLocation(locationId, tenantId);
    const clientId = dto.clientId?.trim() ?? "";
    const clientSecret = dto.clientSecret?.trim() ?? "";
    // No credentials means "put this shop on OUR JET Go account" — the normal
    // case under the reseller contract, where the merchant has no account of
    // their own and never will. Only an estate with its own JET agreement
    // pastes anything here.
    const usingPlatform = !clientId && !clientSecret;
    if (usingPlatform && !platformJetGoCredentials()) {
      throw new BadRequestException(
        "No platform JET Go account is configured, so this location needs its own " +
          "Client ID and Secret. Set JET_GO_CLIENT_ID and JET_GO_CLIENT_SECRET to use ours.",
      );
    }
    if (!usingPlatform && (!clientId || !clientSecret)) {
      throw new BadRequestException(
        "Enter both the Client ID and the Client Secret, or leave both blank to use the OrderHub JET Go account.",
      );
    }
    const market = MARKETS.includes(String(dto.market ?? "").trim().toUpperCase())
      ? String(dto.market).trim().toUpperCase()
      : "UK";
    const environment = dto.environment === "production" ? "production" : "sandbox";

    // One notification config per credential: any sibling location already on
    // this clientId must keep the same webhook URL, or re-registering here would
    // point JET at the new URL and strand that location's courier updates.
    const existing = await this.db().jetGoConfig.findUnique({
      where: { locationId },
      select: { webhookToken: true },
    });
    let webhookToken: string = existing?.webhookToken ?? "";
    let webhookSecret: string = existing?.webhookSecret ?? "";
    let shared = false;
    if (!webhookToken) {
      // JET keeps one notification config per credential, so every location on
      // the same account must land on the same callback URL — registering a
      // second would repoint JET and strand the first shop's courier updates.
      // Under the platform account that is EVERY location, which is why the
      // match is on the effective clientId rather than on what was typed.
      const effectiveId = usingPlatform
        ? (platformJetGoCredentials()?.clientId ?? "")
        : clientId;
      const siblings = await this.db().jetGoConfig.findMany({
        where: { tenantId, NOT: { locationId } },
        select: { credentials: true, webhookToken: true, webhookSecret: true },
      });
      for (const sib of siblings) {
        let sibOwn = "";
        try {
          sibOwn = String(
            (this.encryption.decrypt(sib.credentials) as any)?.clientId ?? "",
          ).trim();
        } catch {
          // A sibling we can't decrypt (rotated key) tells us nothing about
          // which account it is on, so skip it rather than guess.
          continue;
        }
        const sibId = sibOwn || (platformJetGoCredentials()?.clientId ?? "");
        if (sibId && sibId === effectiveId) {
          webhookToken = sib.webhookToken;
          webhookSecret = sib.webhookSecret;
          shared = true;
          break;
        }
      }
    }
    if (!webhookToken) webhookToken = randomBytes(24).toString("hex");
    // Backfills rows created before webhookSecret existed, too.
    if (!webhookSecret) webhookSecret = randomBytes(32).toString("hex");

    const credentials = this.encryption.encrypt(
      usingPlatform ? {} : { clientId, clientSecret },
    );
    await this.db().jetGoConfig.upsert({
      where: { locationId },
      create: {
        tenantId,
        locationId,
        market,
        environment,
        credentials,
        webhookToken,
        webhookSecret,
      },
      update: { market, environment, credentials, webhookToken, webhookSecret },
    });
    return { ok: true, sharedWebhook: shared };
  }

  async setCollectPoint(
    locationId: string,
    tenantId: string,
    collectPointId: string,
    collectPointName?: string | null,
  ) {
    await this.assertLocation(locationId, tenantId);
    const id = collectPointId?.trim();
    if (!id) throw new BadRequestException("Pick a collect point.");
    const row = await this.db().jetGoConfig.findUnique({
      where: { locationId },
      select: { id: true },
    });
    if (!row) {
      throw new BadRequestException(
        "Add your JET Go credentials before choosing a collect point.",
      );
    }
    await this.db().jetGoConfig.update({
      where: { locationId },
      data: { collectPointId: id, collectPointName: collectPointName?.trim() || null },
    });
    return { ok: true, collectPointId: id };
  }

  /**
   * PIN proof of delivery and alcohol handling for this location.
   *
   * Both change what the courier is told to do at the door, so they are
   * deliberately explicit rather than inferred: a shop that sells beer and
   * never ticks the item is the one that loses its licence, not us.
   */
  async setDeliveryOptions(
    locationId: string,
    tenantId: string,
    dto: {
      requirePinOnDelivery?: boolean;
      alcoholAgeRestriction?: number;
      alcoholIdScan?: boolean;
    },
  ) {
    await this.assertLocation(locationId, tenantId);
    const row = await this.db().jetGoConfig.findUnique({
      where: { locationId },
      select: { id: true },
    });
    if (!row) {
      throw new BadRequestException("Add your JET Go credentials before changing these.");
    }
    const data: Record<string, any> = {};
    if (dto.requirePinOnDelivery !== undefined) {
      data.requirePinOnDelivery = Boolean(dto.requirePinOnDelivery);
    }
    if (dto.alcoholIdScan !== undefined) data.alcoholIdScan = Boolean(dto.alcoholIdScan);
    if (dto.alcoholAgeRestriction !== undefined) {
      const age = Number(dto.alcoholAgeRestriction);
      if (!Number.isInteger(age) || age < 16 || age > 25) {
        throw new BadRequestException("Age restriction must be a whole number between 16 and 25.");
      }
      data.alcoholAgeRestriction = age;
    }
    if (!Object.keys(data).length) return { ok: true };
    await this.db().jetGoConfig.update({ where: { locationId }, data });
    return { ok: true, ...data };
  }

  async setActive(locationId: string, tenantId: string, active: boolean) {
    await this.assertLocation(locationId, tenantId);
    const row = await this.db().jetGoConfig.findUnique({
      where: { locationId },
      select: { id: true, collectPointId: true },
    });
    if (!row) {
      throw new BadRequestException("Add your JET Go credentials before activating.");
    }
    if (active && !row.collectPointId) {
      throw new BadRequestException(
        "Choose which JET Go collect point this location collects from before activating.",
      );
    }
    await this.db().jetGoConfig.update({ where: { locationId }, data: { active } });
    return { ok: true, active };
  }

  async getDecrypted(locationId: string | null | undefined): Promise<DecryptedJetGoConfig | null> {
    if (!locationId) return null;
    const row = await this.db().jetGoConfig.findUnique({ where: { locationId } });
    if (!row) return null;
    return this.toDecrypted(row);
  }

  /** Inbound-webhook lookup. Several locations can share a token (one JET
   *  credential, many shops), so this returns every config behind it — the
   *  handler routes by requestId, not by this. */
  async findByWebhookToken(token: string): Promise<DecryptedJetGoConfig[]> {
    const t = (token ?? "").trim();
    if (!t) return [];
    const rows = await this.db().jetGoConfig.findMany({ where: { webhookToken: t } });
    return rows.map((r: any) => this.toDecrypted(r));
  }

  private toDecrypted(row: any): DecryptedJetGoConfig {
    let creds: any = {};
    try {
      creds = this.encryption.decrypt(row.credentials) ?? {};
    } catch {
      // A row we cannot decrypt must not silently fall back to the PLATFORM
      // account: that would put the merchant's deliveries on our bill without
      // anyone choosing it. Left empty, dispatch refuses instead.
      creds = {};
    }
    const own = {
      clientId: String(creds?.clientId ?? "").trim(),
      clientSecret: String(creds?.clientSecret ?? "").trim(),
    };
    const hasOwn = Boolean(own.clientId && own.clientSecret);
    const platform = hasOwn ? null : platformJetGoCredentials();

    return {
      tenantId: row.tenantId,
      locationId: row.locationId,
      // The market and environment follow whichever account is in play — ours
      // is set once in the environment, theirs is set on their row.
      market: platform ? platform.market : row.market,
      environment: platform ? platform.environment : row.environment,
      clientId: platform ? platform.clientId : own.clientId,
      clientSecret: platform ? platform.clientSecret : own.clientSecret,
      collectPointId: row.collectPointId ?? null,
      collectPointName: row.collectPointName ?? null,
      webhookToken: row.webhookToken,
      webhookSecret: row.webhookSecret ?? "",
      active: row.active,
      requirePinOnDelivery: Boolean(row.requirePinOnDelivery),
      // Fall back to JET's own defaults rather than 0/false, so a row written
      // before these columns existed still asks for a legal check.
      alcoholAgeRestriction: Number(row.alcoholAgeRestriction) || 18,
      alcoholIdScan: row.alcoholIdScan ?? true,
      reseller: Boolean(platform),
    };
  }
}
