import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import type { IntegrationPlatform, IntegrationStatus } from "@orderhub/database";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { CredentialEncryptionService } from "./credential-encryption.service";

export interface CreateIntegrationDto {
  locationId: string;
  platform: IntegrationPlatform;
  credentials: Record<string, string>;
  settings?: Record<string, unknown>;
}

export interface UpdateIntegrationDto {
  status?: IntegrationStatus;
  credentials?: Record<string, string>;
  settings?: Record<string, unknown>;
}

// Safe integration summary — never exposes credentials
export interface IntegrationSummary {
  id: string;
  locationId: string;
  platform: string;
  status: string;
  webhookUrl: string | null;
  lastSyncAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  credentialsEncrypted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: CredentialEncryptionService,
  ) {}

  async findByLocation(locationId: string, tenantId: string): Promise<IntegrationSummary[]> {
    await this.assertLocationAccess(locationId, tenantId);
    const rows = await this.prisma.integration.findMany({
      where: { locationId, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => this.toSummary(r));
  }

  /** Returns integration metadata only — credentials are never exposed. */
  async findOne(integrationId: string, tenantId: string): Promise<IntegrationSummary> {
    const integration = await this.prisma.integration.findFirst({
      where: { id: integrationId, tenantId, deletedAt: null },
    });
    if (!integration) throw new NotFoundException("Integration not found");
    return this.toSummary(integration);
  }

  /**
   * Internal use only — returns decrypted credentials for provider operations.
   * Must NOT be called from controllers.
   */
  async getDecryptedCredentials(
    integrationId: string,
  ): Promise<Record<string, string>> {
    const integration = await this.prisma.integration.findUnique({
      where: { id: integrationId },
      select: { credentials: true },
    });
    if (!integration) throw new NotFoundException("Integration not found");
    const raw = integration.credentials as Record<string, unknown>;
    return this.encryption.decrypt(raw) as Record<string, string>;
  }

  async create(tenantId: string, dto: CreateIntegrationDto) {
    await this.assertLocationAccess(dto.locationId, tenantId);

    const existing = await this.prisma.integration.findUnique({
      where: { locationId_platform: { locationId: dto.locationId, platform: dto.platform } },
    });

    const encryptedCredentials = this.encryption.encrypt(
      dto.credentials as Record<string, unknown>,
    );

    if (existing && !existing.deletedAt) {
      const updated = await this.prisma.integration.update({
        where: { id: existing.id },
        data: {
          status: "PENDING_SETUP",
          credentials: encryptedCredentials as any,
          settings: (dto.settings ?? {}) as any,
          deletedAt: null,
          webhookUrl: this.generateWebhookUrl(dto.locationId, dto.platform),
        },
      });
      return this.toSummary(updated);
    }

    const created = await this.prisma.integration.create({
      data: {
        tenantId,
        locationId: dto.locationId,
        platform: dto.platform,
        status: "PENDING_SETUP",
        credentials: encryptedCredentials as any,
        settings: (dto.settings ?? {}) as any,
        webhookUrl: this.generateWebhookUrl(dto.locationId, dto.platform),
      },
    });
    return this.toSummary(created);
  }

  async update(integrationId: string, tenantId: string, dto: UpdateIntegrationDto) {
    await this.assertIntegrationAccess(integrationId, tenantId);

    const encryptedCredentials = dto.credentials
      ? this.encryption.encrypt(dto.credentials as Record<string, unknown>)
      : undefined;

    const updated = await this.prisma.integration.update({
      where: { id: integrationId },
      data: {
        ...(dto.status && { status: dto.status }),
        ...(encryptedCredentials && { credentials: encryptedCredentials as any }),
        ...(dto.settings && { settings: dto.settings as any }),
      },
    });
    return this.toSummary(updated);
  }

  async remove(integrationId: string, tenantId: string) {
    await this.assertIntegrationAccess(integrationId, tenantId);
    await this.prisma.integration.update({
      where: { id: integrationId },
      data: { deletedAt: new Date(), status: "INACTIVE" },
    });
  }

  async retrySync(integrationId: string, tenantId: string) {
    const integration = await this.assertIntegrationAccess(integrationId, tenantId);
    this.logger.log(`Retrying sync for integration ${integrationId} (${integration.platform})`);
    const updated = await this.prisma.integration.update({
      where: { id: integrationId },
      data: { status: "ACTIVE", lastError: null, lastErrorAt: null },
    });
    return this.toSummary(updated);
  }

  async healthCheck(tenantId: string): Promise<IntegrationSummary[]> {
    const rows = await this.prisma.integration.findMany({
      where: { tenantId, deletedAt: null },
    });
    return rows.map((r) => this.toSummary(r));
  }

  /** Counts how many integrations still have plaintext credentials (for release readiness). */
  async countPlaintextCredentials(tenantId: string): Promise<number> {
    const rows = await this.prisma.integration.findMany({
      where: { tenantId, deletedAt: null },
      select: { credentials: true },
    });
    return this.encryption.countPlaintext(rows.map((r) => r.credentials));
  }

  private toSummary(integration: {
    id: string;
    locationId: string;
    platform: any;
    status: any;
    webhookUrl: string | null;
    lastSyncAt: Date | null;
    lastErrorAt: Date | null;
    lastError: string | null;
    credentials: any;
    createdAt: Date;
    updatedAt: Date;
  }): IntegrationSummary {
    return {
      id: integration.id,
      locationId: integration.locationId,
      platform: integration.platform,
      status: integration.status,
      webhookUrl: integration.webhookUrl,
      lastSyncAt: integration.lastSyncAt,
      lastErrorAt: integration.lastErrorAt,
      lastError: integration.lastError,
      credentialsEncrypted: this.encryption.isEncrypted(integration.credentials),
      createdAt: integration.createdAt,
      updatedAt: integration.updatedAt,
    };
  }

  private generateWebhookUrl(locationId: string, platform: string): string {
    const base = process.env.API_PUBLIC_URL ?? "https://api.orderhub.io";
    return `${base}/api/v1/webhooks/${platform.toLowerCase()}?locationId=${locationId}`;
  }

  private async assertLocationAccess(locationId: string, tenantId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
    });
    if (!loc) throw new NotFoundException("Location not found");
    return loc;
  }

  private async assertIntegrationAccess(integrationId: string, tenantId: string) {
    const integration = await this.prisma.integration.findFirst({
      where: { id: integrationId, tenantId },
    });
    if (!integration) throw new NotFoundException("Integration not found");
    return integration;
  }
}
