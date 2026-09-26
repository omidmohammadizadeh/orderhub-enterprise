// Phase BJ — per-location JET Go config (encrypted credentials).
//
// Mirrors StuartConfigService / UberDirectConfigService, with two additions JET
// Go forces on us:
//
//   • collectPointId — JET takes a pickup POINT id, not an address, so a
//     location with credentials but no collect point still can't dispatch.
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
}

const MARKETS = ["UK", "CA", "AU", "EU"];

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
        market: "UK",
        environment: "sandbox",
        webhookUrl: null,
        webhookUsername: null,
        clientIdMasked: null,
        collectPointId: null,
        collectPointName: null,
        /** Dispatch needs all three: credentials, a collect point, and active. */
        readyToDispatch: false,
      };
    }
    const creds = this.encryption.decrypt(row.credentials) as any;
    const id = String(creds?.clientId ?? "");
    return {
      configured: true,
      active: row.active,
      market: row.market,
      environment: row.environment,
      webhookUrl: this.webhookUrl(apiBaseUrl, row.webhookToken),
      // JET's BASIC notification config needs a username; we always use this one
      // so the operator can read it back off the screen if JET ops ask.
      webhookUsername: "orderhub",
      clientIdMasked: id ? `${id.slice(0, 4)}…${id.slice(-4)}` : null,
      collectPointId: row.collectPointId,
      collectPointName: row.collectPointName,
      readyToDispatch: Boolean(row.active && row.collectPointId),
    };
  }

  async upsert(
    locationId: string,
    tenantId: string,
    dto: { clientId: string; clientSecret: string; market?: string; environment?: string },
  ) {
    await this.assertLocation(locationId, tenantId);
    const clientId = dto.clientId?.trim();
    const clientSecret = dto.clientSecret?.trim();
    if (!clientId || !clientSecret) {
      throw new BadRequestException(
        "JET Go Client ID and Client Secret are both required.",
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
      const siblings = await this.db().jetGoConfig.findMany({
        where: { tenantId, NOT: { locationId } },
        select: { credentials: true, webhookToken: true, webhookSecret: true },
      });
      for (const sib of siblings) {
        let sid = "";
        try {
          sid = String((this.encryption.decrypt(sib.credentials) as any)?.clientId ?? "");
        } catch {
          // A sibling we can't decrypt (rotated key) tells us nothing about
          // whether it shares this clientId, so skip it rather than guess.
          continue;
        }
        if (sid && sid === clientId) {
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

    const credentials = this.encryption.encrypt({ clientId, clientSecret });
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
      creds = {};
    }
    return {
      tenantId: row.tenantId,
      locationId: row.locationId,
      market: row.market,
      environment: row.environment,
      clientId: creds?.clientId ?? "",
      clientSecret: creds?.clientSecret ?? "",
      collectPointId: row.collectPointId ?? null,
      collectPointName: row.collectPointName ?? null,
      webhookToken: row.webhookToken,
      webhookSecret: row.webhookSecret ?? "",
      active: row.active,
    };
  }
}
