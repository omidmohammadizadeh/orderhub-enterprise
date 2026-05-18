import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaService } from "../../infrastructure/database/prisma.service";

export interface UpsertBrandingDto {
  logoUrl?: string;
  faviconUrl?: string;
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string;
  fontFamily?: string;
  customCss?: string;
  appName?: string;
  metaTitle?: string;
  metaDescription?: string;
  emailFromName?: string;
  emailFromAddr?: string;
  emailFooterHtml?: string;
  senderSmsName?: string;
  socialLinks?: Record<string, string>;
}

@Injectable()
export class BrandingService {
  private readonly logger = new Logger(BrandingService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getBranding(tenantId: string) {
    return this.prisma.tenantBranding.findUnique({
      where: { tenantId },
      include: {
        customDomains: {
          orderBy: { createdAt: "desc" },
        },
      },
    });
  }

  async upsertBranding(tenantId: string, dto: UpsertBrandingDto) {
    const data: any = {};
    if (dto.logoUrl !== undefined) data.logoUrl = dto.logoUrl;
    if (dto.faviconUrl !== undefined) data.faviconUrl = dto.faviconUrl;
    if (dto.primaryColor !== undefined) data.primaryColor = dto.primaryColor;
    if (dto.secondaryColor !== undefined) data.secondaryColor = dto.secondaryColor;
    if (dto.accentColor !== undefined) data.accentColor = dto.accentColor;
    if (dto.fontFamily !== undefined) data.fontFamily = dto.fontFamily;
    if (dto.customCss !== undefined) data.customCss = dto.customCss;
    if (dto.appName !== undefined) data.appName = dto.appName;
    if (dto.metaTitle !== undefined) data.metaTitle = dto.metaTitle;
    if (dto.metaDescription !== undefined) data.metaDescription = dto.metaDescription;
    if (dto.emailFromName !== undefined) data.emailFromName = dto.emailFromName;
    if (dto.emailFromAddr !== undefined) data.emailFromAddr = dto.emailFromAddr;
    if (dto.emailFooterHtml !== undefined) data.emailFooterHtml = dto.emailFooterHtml;
    if (dto.senderSmsName !== undefined) data.senderSmsName = dto.senderSmsName;
    if (dto.socialLinks !== undefined) data.socialLinks = dto.socialLinks;

    return this.prisma.tenantBranding.upsert({
      where: { tenantId },
      create: { tenantId, ...data },
      update: data,
      include: {
        customDomains: { orderBy: { createdAt: "desc" } },
      },
    });
  }

  async getPublicBranding(tenantSlug: string) {
    const tenant = await this.prisma.tenant.findFirst({
      where: { slug: tenantSlug },
      select: { id: true },
    });
    if (!tenant) throw new NotFoundException("Tenant not found");

    const branding = await this.prisma.tenantBranding.findUnique({
      where: { tenantId: tenant.id },
      select: {
        logoUrl: true,
        faviconUrl: true,
        primaryColor: true,
        secondaryColor: true,
        accentColor: true,
        fontFamily: true,
        appName: true,
        metaTitle: true,
        metaDescription: true,
      },
    });

    return branding ?? null;
  }

  async addCustomDomain(tenantId: string, domain: string) {
    // Ensure branding record exists
    await this.prisma.tenantBranding.upsert({
      where: { tenantId },
      create: { tenantId },
      update: {},
    });

    const branding = await this.prisma.tenantBranding.findUnique({
      where: { tenantId },
      select: { id: true },
    });

    const txtRecord = `orderhub-verify-${randomUUID().slice(0, 8)}`;

    return this.prisma.customDomain.create({
      data: {
        tenantId,
        brandingId: branding!.id,
        domain: domain.toLowerCase().trim(),
        status: "PENDING",
        txtRecord,
      },
    });
  }

  async verifyDomain(domainId: string, tenantId: string) {
    const record = await this.prisma.customDomain.findFirst({
      where: { id: domainId, tenantId },
    });
    if (!record) throw new NotFoundException("Custom domain not found");
    if (record.status === "ACTIVE") {
      return record;
    }

    // In production this would perform a real DNS TXT lookup.
    // For now we log the intent and mark as VERIFIED.
    this.logger.log(
      `DNS verification requested for domain=${record.domain} txtRecord=${record.txtRecord} — marking VERIFIED`,
    );

    return this.prisma.customDomain.update({
      where: { id: domainId },
      data: {
        status: "VERIFIED",
        verifiedAt: new Date(),
      },
    });
  }

  async removeDomain(domainId: string, tenantId: string) {
    const record = await this.prisma.customDomain.findFirst({
      where: { id: domainId, tenantId },
    });
    if (!record) throw new NotFoundException("Custom domain not found");

    await this.prisma.customDomain.delete({ where: { id: domainId } });
  }

  async getDomainByHostname(domain: string) {
    return this.prisma.customDomain.findFirst({
      where: {
        domain: domain.toLowerCase().trim(),
        status: "ACTIVE",
      },
      include: {
        branding: true,
      },
    });
  }
}
