import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import type { IntegrationPlatform, IntegrationStatus } from "@orderhub/database";
import { PrismaService } from "../../infrastructure/database/prisma.service";

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

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findByLocation(locationId: string, tenantId: string) {
    await this.assertLocationAccess(locationId, tenantId);
    return this.prisma.integration.findMany({
      where: { locationId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        locationId: true,
        platform: true,
        status: true,
        webhookUrl: true,
        lastSyncAt: true,
        lastErrorAt: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
        // credentials intentionally excluded from list response
      },
    });
  }

  async findOne(integrationId: string, tenantId: string) {
    const integration = await this.prisma.integration.findFirst({
      where: { id: integrationId, tenantId, deletedAt: null },
    });
    if (!integration) throw new NotFoundException("Integration not found");
    return integration;
  }

  async create(tenantId: string, dto: CreateIntegrationDto) {
    await this.assertLocationAccess(dto.locationId, tenantId);

    // Check for existing active integration on this platform for this location
    const existing = await this.prisma.integration.findUnique({
      where: { locationId_platform: { locationId: dto.locationId, platform: dto.platform } },
    });
    if (existing && !existing.deletedAt) {
      // Reactivate if previously deactivated
      return this.prisma.integration.update({
        where: { id: existing.id },
        data: {
          status: "PENDING_SETUP",
          credentials: dto.credentials as any,
          settings: (dto.settings ?? {}) as any,
          deletedAt: null,
          webhookUrl: this.generateWebhookUrl(dto.locationId, dto.platform),
        },
      });
    }

    return this.prisma.integration.create({
      data: {
        tenantId,
        locationId: dto.locationId,
        platform: dto.platform,
        status: "PENDING_SETUP",
        credentials: dto.credentials as any,
        settings: (dto.settings ?? {}) as any,
        webhookUrl: this.generateWebhookUrl(dto.locationId, dto.platform),
      },
    });
  }

  async update(integrationId: string, tenantId: string, dto: UpdateIntegrationDto) {
    await this.assertIntegrationAccess(integrationId, tenantId);
    return this.prisma.integration.update({
      where: { id: integrationId },
      data: {
        ...(dto.status && { status: dto.status }),
        ...(dto.credentials && { credentials: dto.credentials as any }),
        ...(dto.settings && { settings: dto.settings as any }),
      },
    });
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
    // In production: enqueue a sync job
    return this.prisma.integration.update({
      where: { id: integrationId },
      data: { status: "ACTIVE", lastError: null, lastErrorAt: null },
    });
  }

  async healthCheck(tenantId: string) {
    const integrations = await this.prisma.integration.findMany({
      where: { tenantId, deletedAt: null },
      select: { id: true, locationId: true, platform: true, status: true, lastSyncAt: true, lastError: true },
    });
    return integrations;
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
