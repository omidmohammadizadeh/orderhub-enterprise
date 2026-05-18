import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from "@nestjs/common";
import type { ProviderCategory } from "@orderhub/database";
import { PrismaService } from "../../infrastructure/database/prisma.service";

export interface UpsertWebhookRouteDto {
  locationId?: string;
  providerKey: string;
  pathPattern: string;
}

@Injectable()
export class ProviderRegistryService {
  private readonly logger = new Logger(ProviderRegistryService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getAllProviders() {
    return this.prisma.providerDefinition.findMany({
      orderBy: [{ category: "asc" }, { name: "asc" }],
    });
  }

  async getEnabledProviders() {
    return this.prisma.providerDefinition.findMany({
      where: { isEnabled: true },
      orderBy: [{ category: "asc" }, { name: "asc" }],
    });
  }

  async getProvidersByCategory(category: ProviderCategory) {
    return this.prisma.providerDefinition.findMany({
      where: { category },
      orderBy: { name: "asc" },
    });
  }

  async getProvider(key: string) {
    const provider = await this.prisma.providerDefinition.findUnique({
      where: { key },
    });
    if (!provider) throw new NotFoundException(`Provider '${key}' not found`);
    return provider;
  }

  async getCapabilityMatrix() {
    const providers = await this.prisma.providerDefinition.findMany({
      where: { isEnabled: true },
      select: {
        key: true,
        name: true,
        category: true,
        capabilities: true,
        isBeta: true,
      },
      orderBy: [{ category: "asc" }, { name: "asc" }],
    });

    return { providers };
  }

  async getWebhookRoutes(tenantId: string) {
    return this.prisma.webhookRoute.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    });
  }

  async upsertWebhookRoute(tenantId: string, dto: UpsertWebhookRouteDto) {
    // Ensure provider exists
    const provider = await this.prisma.providerDefinition.findUnique({
      where: { key: dto.providerKey },
    });
    if (!provider) throw new NotFoundException(`Provider '${dto.providerKey}' not found`);

    // Try to find an existing route with same providerKey + locationId combination
    const existing = await this.prisma.webhookRoute.findFirst({
      where: {
        tenantId,
        providerKey: dto.providerKey,
        locationId: dto.locationId ?? null,
      },
    });

    if (existing) {
      return this.prisma.webhookRoute.update({
        where: { id: existing.id },
        data: {
          pathPattern: dto.pathPattern,
          isActive: true,
        },
      });
    }

    return this.prisma.webhookRoute.create({
      data: {
        tenantId,
        locationId: dto.locationId ?? null,
        providerKey: dto.providerKey,
        pathPattern: dto.pathPattern,
        isActive: true,
      },
    });
  }

  async removeWebhookRoute(routeId: string, tenantId: string) {
    const route = await this.prisma.webhookRoute.findFirst({
      where: { id: routeId, tenantId },
    });
    if (!route) throw new NotFoundException("Webhook route not found");
    await this.prisma.webhookRoute.delete({ where: { id: routeId } });
  }

  async resolveRoute(
    providerKey: string,
    path: string,
    tenantId: string,
  ) {
    const routes = await this.prisma.webhookRoute.findMany({
      where: { tenantId, providerKey, isActive: true },
    });

    for (const route of routes) {
      // Convert path pattern to regex: {param} → ([^/]+), * → .*
      const pattern = route.pathPattern
        .replace(/\{[^}]+\}/g, "([^/]+)")
        .replace(/\*/g, ".*");
      const regex = new RegExp(`^${pattern}$`);
      if (regex.test(path)) {
        return route;
      }
    }

    return null;
  }
}
