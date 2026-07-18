// Phase BI — per-location Uber Direct config (encrypted credentials).

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { CredentialEncryptionService } from "../credential-encryption.service";
import type { UberDirectCreds } from "./uber-direct-client.service";

export interface DecryptedUberDirectConfig extends UberDirectCreds {
  tenantId: string;
  locationId: string;
  signingKey: string;
  active: boolean;
}

@Injectable()
export class UberDirectConfigService {
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

  /** Operator view — never leaks the client secret or signing key. */
  async getPublicConfig(
    locationId: string,
    tenantId: string,
    apiBaseUrl: string,
  ) {
    await this.assertLocation(locationId, tenantId);
    const row = await this.db().uberDirectConfig.findUnique({
      where: { locationId },
    });
    const webhookUrl = `${apiBaseUrl}/api/v1/webhooks/uber-direct/${locationId}`;
    if (!row) {
      return {
        configured: false,
        active: false,
        environment: "sandbox",
        webhookUrl,
        customerIdMasked: null,
        clientIdMasked: null,
      };
    }
    const creds = this.encryption.decrypt(row.credentials) as any;
    const mask = (v: string) =>
      v ? `${v.slice(0, 4)}…${v.slice(-4)}` : null;
    return {
      configured: true,
      active: row.active,
      environment: row.environment,
      webhookUrl,
      customerIdMasked: mask(creds?.customerId ?? ""),
      clientIdMasked: mask(creds?.clientId ?? ""),
    };
  }

  async upsert(
    locationId: string,
    tenantId: string,
    dto: {
      customerId: string;
      clientId: string;
      clientSecret: string;
      signingKey?: string;
      environment?: string;
    },
  ) {
    await this.assertLocation(locationId, tenantId);
    const customerId = dto.customerId?.trim();
    const clientId = dto.clientId?.trim();
    const clientSecret = dto.clientSecret?.trim();
    if (!customerId || !clientId || !clientSecret) {
      throw new BadRequestException(
        "Uber Direct Customer ID, Client ID and Client Secret are all required.",
      );
    }
    const environment =
      dto.environment === "production" ? "production" : "sandbox";
    const credentials = this.encryption.encrypt({
      customerId,
      clientId,
      clientSecret,
      signingKey: dto.signingKey?.trim() ?? "",
    });
    await this.db().uberDirectConfig.upsert({
      where: { locationId },
      create: { tenantId, locationId, environment, credentials },
      update: { environment, credentials },
    });
    return { ok: true };
  }

  async setActive(locationId: string, tenantId: string, active: boolean) {
    await this.assertLocation(locationId, tenantId);
    const row = await this.db().uberDirectConfig.findUnique({
      where: { locationId },
      select: { id: true },
    });
    if (!row) {
      throw new BadRequestException(
        "Add your Uber Direct credentials before activating.",
      );
    }
    await this.db().uberDirectConfig.update({
      where: { locationId },
      data: { active },
    });
    return { ok: true, active };
  }

  async getDecrypted(
    locationId: string,
  ): Promise<DecryptedUberDirectConfig | null> {
    const row = await this.db().uberDirectConfig.findUnique({
      where: { locationId },
    });
    if (!row) return null;
    const creds = this.encryption.decrypt(row.credentials) as any;
    return {
      tenantId: row.tenantId,
      locationId: row.locationId,
      environment: row.environment,
      customerId: creds?.customerId ?? "",
      clientId: creds?.clientId ?? "",
      clientSecret: creds?.clientSecret ?? "",
      signingKey: creds?.signingKey ?? "",
      active: row.active,
    };
  }
}
