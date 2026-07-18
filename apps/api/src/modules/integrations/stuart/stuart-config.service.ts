// Phase BH — per-location Stuart config (encrypted credentials + webhook key).

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomBytes } from "crypto";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { CredentialEncryptionService } from "../credential-encryption.service";
import type { StuartCreds } from "./stuart-client.service";

export interface DecryptedStuartConfig extends StuartCreds {
  tenantId: string;
  locationId: string;
  webhookAuthKey: string;
  active: boolean;
}

@Injectable()
export class StuartConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: CredentialEncryptionService,
  ) {}

  private db(): any {
    return this.prisma as any;
  }

  private async assertLocation(
    locationId: string,
    tenantId: string,
  ): Promise<void> {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null, brand: { tenantId } },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException("Location not found");
  }

  /** Operator-facing view — never leaks the client secret. Returns the webhook
   *  auth key + URL so the operator can paste them into Stuart's dashboard. */
  async getPublicConfig(
    locationId: string,
    tenantId: string,
    apiBaseUrl: string,
  ) {
    await this.assertLocation(locationId, tenantId);
    const row = await this.db().stuartConfig.findUnique({
      where: { locationId },
    });
    if (!row) {
      return {
        configured: false,
        active: false,
        environment: "sandbox",
        webhookUrl: `${apiBaseUrl}/api/v1/webhooks/stuart/${locationId}`,
        webhookAuthHeader: "X-OrderHub-Auth",
        webhookAuthKey: null,
        clientIdMasked: null,
      };
    }
    const creds = this.encryption.decrypt(row.credentials) as any;
    const clientId: string = creds?.clientId ?? "";
    return {
      configured: true,
      active: row.active,
      environment: row.environment,
      webhookUrl: `${apiBaseUrl}/api/v1/webhooks/stuart/${locationId}`,
      webhookAuthHeader: "X-OrderHub-Auth",
      webhookAuthKey: row.webhookAuthKey,
      clientIdMasked: clientId
        ? `${clientId.slice(0, 4)}…${clientId.slice(-4)}`
        : null,
    };
  }

  /** Create or update the location's Stuart credentials. Generates a webhook
   *  auth key on first save (kept stable afterwards so the operator doesn't
   *  have to re-paste it into Stuart on every edit). */
  async upsert(
    locationId: string,
    tenantId: string,
    dto: {
      clientId: string;
      clientSecret: string;
      environment?: string;
    },
  ) {
    await this.assertLocation(locationId, tenantId);
    const clientId = dto.clientId?.trim();
    const clientSecret = dto.clientSecret?.trim();
    if (!clientId || !clientSecret) {
      throw new BadRequestException(
        "Both Stuart client ID and client secret are required.",
      );
    }
    const environment =
      dto.environment === "production" ? "production" : "sandbox";
    const credentials = this.encryption.encrypt({ clientId, clientSecret });

    const existing = await this.db().stuartConfig.findUnique({
      where: { locationId },
      select: { id: true, webhookAuthKey: true },
    });
    const webhookAuthKey =
      existing?.webhookAuthKey ?? randomBytes(24).toString("hex");

    await this.db().stuartConfig.upsert({
      where: { locationId },
      create: {
        tenantId,
        locationId,
        environment,
        credentials,
        webhookAuthKey,
      },
      update: { environment, credentials },
    });
    return { ok: true };
  }

  async setActive(locationId: string, tenantId: string, active: boolean) {
    await this.assertLocation(locationId, tenantId);
    const row = await this.db().stuartConfig.findUnique({
      where: { locationId },
      select: { id: true },
    });
    if (!row) {
      throw new BadRequestException(
        "Add your Stuart client ID and secret before activating.",
      );
    }
    await this.db().stuartConfig.update({
      where: { locationId },
      data: { active },
    });
    return { ok: true, active };
  }

  /** Internal — decrypted config for dispatch/webhook. Returns null when the
   *  location has no Stuart config at all. */
  async getDecrypted(locationId: string): Promise<DecryptedStuartConfig | null> {
    const row = await this.db().stuartConfig.findUnique({
      where: { locationId },
    });
    if (!row) return null;
    const creds = this.encryption.decrypt(row.credentials) as any;
    return {
      tenantId: row.tenantId,
      locationId: row.locationId,
      environment: row.environment,
      clientId: creds?.clientId ?? "",
      clientSecret: creds?.clientSecret ?? "",
      webhookAuthKey: row.webhookAuthKey,
      active: row.active,
    };
  }
}
