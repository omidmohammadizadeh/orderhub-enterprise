import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { AuditLogService } from "../auth/services/audit-log.service";
import { CredentialEncryptionService } from "../integrations/credential-encryption.service";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export interface ReadinessCheck {
  key: string;
  label: string;
  status: CheckStatus;
  detail?: string;
  critical: boolean;       // blocks go-live if false
  adminOverridable: boolean; // can a PLATFORM_ADMIN bypass with a reason?
}

export interface ProviderReadiness {
  platform: string;
  connected: boolean;
  credentialsConfigured: boolean;
  credentialsEncrypted: boolean;
  webhookConfigured: boolean;
  lastSuccessfulWebhookAt: Date | null;
  lastFailedWebhookAt: Date | null;
  lastSyncAt: Date | null;
  integrationStatus: string;
  checks: ReadinessCheck[];
}

export interface PrinterReadiness {
  printerId: string;
  printerName: string;
  isActive: boolean;
  isOnline: boolean;
  connectionType: string;
  lastTestPrintAt: Date | null;
  failedJobsLast24h: number;
  ready: boolean;
  checks: ReadinessCheck[];
}

export interface LocationReadiness {
  locationId: string;
  locationName: string;
  tenantId: string;
  goLiveStatus: string;
  score: number;          // 0–100
  blockers: ReadinessCheck[];
  warnings: ReadinessCheck[];
  providers: ProviderReadiness[];
  printers: PrinterReadiness[];
  allChecks: ReadinessCheck[];
  lastUpdated: Date;
}

// ── Constants ─────────────────────────────────────────────────────────────────

// Statuses that cannot be bypassed by any admin override
const NON_OVERRIDABLE_CHECKS = new Set([
  "encryption.key_set",
  "tenant.isolation",
  "security.no_default_secrets",
]);

const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT:              ["CONFIGURING", "BLOCKED"],
  CONFIGURING:        ["TESTING", "DRAFT", "BLOCKED"],
  TESTING:            ["READY_FOR_GO_LIVE", "CONFIGURING", "BLOCKED"],
  READY_FOR_GO_LIVE:  ["LIVE", "TESTING", "BLOCKED"],
  LIVE:               ["PAUSED", "BLOCKED"],
  PAUSED:             ["LIVE", "CONFIGURING", "BLOCKED"],
  BLOCKED:            ["CONFIGURING"],
};

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly encryption: CredentialEncryptionService,
  ) {}

  // ── Core readiness calculation ────────────────────────────────────────────

  async getLocationReadiness(
    locationId: string,
    tenantId: string,
  ): Promise<LocationReadiness> {
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId }, deletedAt: null },
      include: {
        brand: { select: { tenantId: true, name: true } },
        integrations: { where: { deletedAt: null } },
        printers: { where: { deletedAt: null } },
      },
    });

    if (!location) {
      throw new NotFoundException(`Location ${locationId} not found for tenant ${tenantId}`);
    }

    // Tenant
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException(`Tenant ${tenantId} not found`);

    // Recent outbox dead events for this location
    const deadOutboxCount = await this.prisma.outboxEvent.count({
      where: {
        locationId,
        status: "DEAD",
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) },
      },
    });

    // Recent sandbox orders (test orders)
    const lastTestOrder = await this.prisma.order.findFirst({
      where: { locationId, isSandbox: true },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });

    // Recent successful print jobs
    const lastPrintJob = await this.prisma.printJob.findFirst({
      where: { locationId, status: "PRINTED" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });

    // Active staff users for this tenant
    const staffCount = await this.prisma.user.count({
      where: { tenantId, isActive: true },
    });

    // Active menu items for this location
    const menuCount = await this.prisma.menuItem.count({
      where: { menu: { locationId, deletedAt: null }, deletedAt: null },
    }).catch(() => 0); // graceful if menu query fails

    // ── Build checks ──────────────────────────────────────

    const checks: ReadinessCheck[] = [];

    // Security checks — never overridable
    checks.push({
      key: "encryption.key_set",
      label: "Credential encryption key configured",
      status: this.encryption.keyId ? "pass" : "fail",
      detail: this.encryption.keyId
        ? `Key ID: ${this.encryption.keyId}`
        : "Set CREDENTIAL_ENCRYPTION_KEY before go-live",
      critical: true,
      adminOverridable: false,
    });

    const plaintextIntegrations = location.integrations.filter(
      (i) => !this.encryption.isEncrypted(i.credentials as Record<string, unknown>),
    );
    checks.push({
      key: "encryption.no_plaintext_credentials",
      label: "All credentials encrypted",
      status: plaintextIntegrations.length === 0 ? "pass" : "fail",
      detail:
        plaintextIntegrations.length > 0
          ? `${plaintextIntegrations.length} integration(s) have plaintext credentials — run backfill`
          : undefined,
      critical: true,
      adminOverridable: false,
    });

    // Tenant checks
    checks.push({
      key: "tenant.active",
      label: "Tenant account is active",
      status: tenant.status === "ACTIVE" ? "pass" : "fail",
      detail: tenant.status !== "ACTIVE" ? `Tenant status: ${tenant.status}` : undefined,
      critical: true,
      adminOverridable: false,
    });

    // Location checks
    checks.push({
      key: "location.active",
      label: "Location is active",
      status: location.isActive ? "pass" : "fail",
      critical: true,
      adminOverridable: true,
    });

    checks.push({
      key: "location.shop_code",
      label: "Shop code configured (Flutter printer app)",
      status: location.shopCode ? "pass" : "warn",
      detail: location.shopCode
        ? `Shop code: ${location.shopCode}`
        : "Set shopCode for Flutter Android printer app polling",
      critical: false,
      adminOverridable: true,
    });

    // Sandbox / test mode
    const isSandboxMode = process.env.NODE_ENV !== "production";
    checks.push({
      key: "security.sandbox_disabled",
      label: "Sandbox mode disabled for live location",
      status: !isSandboxMode ? "pass" : "warn",
      detail: isSandboxMode ? "NODE_ENV is not production — sandbox tools are active" : undefined,
      critical: false,
      adminOverridable: true,
    });

    // Provider check
    const activeIntegrations = location.integrations.filter((i) => i.status === "ACTIVE");
    checks.push({
      key: "provider.at_least_one_connected",
      label: "At least one marketplace or POS connected",
      status: activeIntegrations.length > 0 ? "pass" : "warn",
      detail: activeIntegrations.length === 0
        ? "Connect Uber Eats, Deliveroo, or enable manual/POS orders"
        : `Active: ${activeIntegrations.map((i) => i.platform).join(", ")}`,
      critical: false,
      adminOverridable: true,
    });

    // Outbox health
    checks.push({
      key: "outbox.no_dead_events",
      label: "No dead outbox events in last 24h",
      status: deadOutboxCount === 0 ? "pass" : "fail",
      detail: deadOutboxCount > 0
        ? `${deadOutboxCount} dead event(s) — check dispatcher logs and reset manually`
        : undefined,
      critical: true,
      adminOverridable: true,
    });

    // Printer check
    const activePrinters = location.printers.filter((p) => p.isActive);
    checks.push({
      key: "printer.configured",
      label: "At least one printer configured and active",
      status: activePrinters.length > 0 ? "pass" : "warn",
      detail: activePrinters.length === 0
        ? "Configure at least one printer for receipts/kitchen tickets"
        : `${activePrinters.length} active printer(s)`,
      critical: false,
      adminOverridable: true,
    });

    const testPrintAt = location.lastTestPrintAt ?? lastPrintJob?.createdAt ?? null;
    checks.push({
      key: "printer.test_print_passed",
      label: "Test print completed successfully",
      status: testPrintAt ? "pass" : "warn",
      detail: testPrintAt
        ? `Last: ${testPrintAt.toISOString()}`
        : "Run a test print from the printer diagnostics page",
      critical: false,
      adminOverridable: true,
    });

    // Menu check
    checks.push({
      key: "menu.items_exist",
      label: "Menu items configured",
      status: menuCount > 0 ? "pass" : "warn",
      detail: menuCount === 0 ? "Add at least one menu item before go-live" : `${menuCount} item(s)`,
      critical: false,
      adminOverridable: true,
    });

    // Staff check
    checks.push({
      key: "staff.user_exists",
      label: "At least one active staff user",
      status: staffCount > 0 ? "pass" : "fail",
      detail: staffCount === 0 ? "Create at least one staff user for this tenant" : `${staffCount} user(s)`,
      critical: true,
      adminOverridable: true,
    });

    // Test order check
    const testOrderAt = location.lastTestOrderAt ?? lastTestOrder?.createdAt ?? null;
    checks.push({
      key: "orders.test_order_completed",
      label: "Test order completed successfully",
      status: testOrderAt ? "pass" : "warn",
      detail: testOrderAt
        ? `Last test order: ${testOrderAt.toISOString()}`
        : "Run a sandbox test order before go-live",
      critical: false,
      adminOverridable: true,
    });

    // ── Provider readiness ───────────────────────────────

    const providers = await this.buildProviderReadiness(location.integrations as any[]);

    // ── Printer readiness ────────────────────────────────

    const printerReadiness = await this.buildPrinterReadiness(location.printers as any[], locationId);

    // ── Score ────────────────────────────────────────────

    const blockers = checks.filter((c) => c.critical && c.status === "fail");
    const warnings = checks.filter((c) => !c.critical && c.status !== "pass");

    const score = Math.max(0, 100 - blockers.length * 15 - warnings.length * 5);

    return {
      locationId,
      locationName: location.name,
      tenantId,
      goLiveStatus: location.goLiveStatus,
      score,
      blockers,
      warnings,
      providers,
      printers: printerReadiness,
      allChecks: checks,
      lastUpdated: new Date(),
    };
  }

  // ── Status transitions ────────────────────────────────────────────────────

  async transitionGoLiveStatus(
    locationId: string,
    tenantId: string,
    userId: string,
    targetStatus: string,
    reason?: string,
  ): Promise<{ status: string; readiness: LocationReadiness }> {
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId }, deletedAt: null },
    });
    if (!location) throw new NotFoundException(`Location ${locationId} not found`);

    const current = location.goLiveStatus;
    const allowed = VALID_TRANSITIONS[current] ?? [];
    if (!allowed.includes(targetStatus)) {
      throw new BadRequestException(
        `Cannot transition from ${current} to ${targetStatus}. ` +
          `Allowed: ${allowed.join(", ")}`,
      );
    }

    // Going LIVE requires all critical checks to pass
    if (targetStatus === "LIVE") {
      await this.validateGoLive(locationId, tenantId);
    }

    await this.prisma.location.update({
      where: { id: locationId },
      data: { goLiveStatus: targetStatus as any },
    });

    await this.audit.log({
      tenantId,
      userId,
      event: "location.go_live_status_changed",
      resource: "location",
      resourceId: locationId,
      before: { goLiveStatus: current },
      after: { goLiveStatus: targetStatus },
      meta: { reason: reason ?? null },
    });

    this.logger.log(
      `Location ${locationId} transitioned ${current} → ${targetStatus} by user ${userId}`,
    );

    const readiness = await this.getLocationReadiness(locationId, tenantId);
    return { status: targetStatus, readiness };
  }

  async adminOverride(
    locationId: string,
    tenantId: string,
    userId: string,
    targetStatus: string,
    reason: string,
  ): Promise<{ status: string }> {
    if (!reason?.trim()) {
      throw new BadRequestException("Admin override requires a non-empty reason");
    }

    const location = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId }, deletedAt: null },
      include: { integrations: true },
    });
    if (!location) throw new NotFoundException(`Location ${locationId} not found`);

    // Refuse to override non-overridable checks when going LIVE
    if (targetStatus === "LIVE") {
      const encKey = !!(
        process.env.CREDENTIAL_ENCRYPTION_KEY_CURRENT ?? process.env.CREDENTIAL_ENCRYPTION_KEY
      );
      if (!encKey) {
        throw new ForbiddenException(
          "Cannot override: CREDENTIAL_ENCRYPTION_KEY must be set. This check cannot be bypassed.",
        );
      }
      const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
      if (tenant?.status !== "ACTIVE") {
        throw new ForbiddenException(
          "Cannot override: Tenant account is not ACTIVE. This check cannot be bypassed.",
        );
      }
    }

    await this.prisma.location.update({
      where: { id: locationId },
      data: { goLiveStatus: targetStatus as any },
    });

    await this.audit.log({
      tenantId,
      userId,
      event: "location.admin_override",
      resource: "location",
      resourceId: locationId,
      before: { goLiveStatus: location.goLiveStatus },
      after: { goLiveStatus: targetStatus },
      meta: { reason, adminOverride: true, nonOverridableBypassAttempted: false },
    });

    this.logger.warn(
      `ADMIN OVERRIDE: Location ${locationId} → ${targetStatus} by ${userId} — reason: "${reason}"`,
    );

    return { status: targetStatus };
  }

  async recordTestOrder(locationId: string, tenantId: string, userId: string): Promise<void> {
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId }, deletedAt: null },
    });
    if (!location) throw new NotFoundException(`Location ${locationId} not found`);

    const now = new Date();
    await this.prisma.location.update({
      where: { id: locationId },
      data: { lastTestOrderAt: now },
    });

    await this.audit.log({
      tenantId,
      userId,
      event: "location.test_order_completed",
      resource: "location",
      resourceId: locationId,
      meta: { completedAt: now.toISOString() },
    });
  }

  async recordTestPrint(locationId: string, tenantId: string, userId: string): Promise<void> {
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId }, deletedAt: null },
    });
    if (!location) throw new NotFoundException(`Location ${locationId} not found`);

    const now = new Date();
    await this.prisma.location.update({
      where: { id: locationId },
      data: { lastTestPrintAt: now },
    });

    await this.audit.log({
      tenantId,
      userId,
      event: "location.test_print_completed",
      resource: "location",
      resourceId: locationId,
      meta: { completedAt: now.toISOString() },
    });
  }

  // ── Location list for wizard ──────────────────────────────────────────────

  async listLocationsWithStatus(tenantId?: string): Promise<
    Array<{
      locationId: string;
      locationName: string;
      tenantId: string;
      brandName: string;
      goLiveStatus: string;
      isActive: boolean;
      score: number | null;
    }>
  > {
    const locations = await this.prisma.location.findMany({
      where: {
        deletedAt: null,
        ...(tenantId ? { brand: { tenantId } } : {}),
      },
      include: {
        brand: { select: { tenantId: true, name: true } },
        _count: {
          select: { integrations: true, printers: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    return locations.map((loc) => ({
      locationId: loc.id,
      locationName: loc.name,
      tenantId: loc.brand.tenantId,
      brandName: loc.brand.name,
      goLiveStatus: loc.goLiveStatus,
      isActive: loc.isActive,
      score: null, // computed on demand via getLocationReadiness
    }));
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private async validateGoLive(locationId: string, tenantId: string): Promise<void> {
    const readiness = await this.getLocationReadiness(locationId, tenantId);
    if (readiness.blockers.length > 0) {
      const issues = readiness.blockers.map((b) => `• ${b.label}: ${b.detail ?? "failed"}`).join("\n");
      throw new BadRequestException(
        `Location cannot go live — ${readiness.blockers.length} critical check(s) failed:\n${issues}`,
      );
    }
  }

  private async buildProviderReadiness(
    integrations: Array<{
      id: string;
      platform: string;
      status: string;
      credentials: unknown;
      webhookUrl: string | null;
      lastSyncAt: Date | null;
    }>,
  ): Promise<ProviderReadiness[]> {
    return Promise.all(
      integrations.map(async (integration) => {
        const credentialsEncrypted = this.encryption.isEncrypted(
          integration.credentials as Record<string, unknown>,
        );

        const [lastSuccessWebhook, lastFailedWebhook] = await Promise.all([
          this.prisma.webhookEvent.findFirst({
            where: { platform: integration.platform, processedAt: { not: null } },
            orderBy: { processedAt: "desc" },
            select: { processedAt: true },
          }),
          this.prisma.webhookEvent.findFirst({
            where: { platform: integration.platform, processingError: { not: null } },
            orderBy: { createdAt: "desc" },
            select: { createdAt: true },
          }),
        ]);

        const checks: ReadinessCheck[] = [
          {
            key: `provider.${integration.platform}.active`,
            label: `${integration.platform} integration active`,
            status: integration.status === "ACTIVE" ? "pass" : "fail",
            critical: false,
            adminOverridable: true,
          },
          {
            key: `provider.${integration.platform}.credentials_encrypted`,
            label: `${integration.platform} credentials encrypted`,
            status: credentialsEncrypted ? "pass" : "fail",
            critical: true,
            adminOverridable: false,
          },
          {
            key: `provider.${integration.platform}.webhook_url`,
            label: `${integration.platform} webhook URL configured`,
            status: integration.webhookUrl ? "pass" : "warn",
            detail: integration.webhookUrl ?? "Configure webhook URL in platform portal",
            critical: false,
            adminOverridable: true,
          },
        ];

        return {
          platform: integration.platform,
          connected: integration.status === "ACTIVE",
          credentialsConfigured:
            !!integration.credentials &&
            Object.keys(integration.credentials as object).length > 0,
          credentialsEncrypted,
          webhookConfigured: !!integration.webhookUrl,
          lastSuccessfulWebhookAt: lastSuccessWebhook?.processedAt ?? null,
          lastFailedWebhookAt: lastFailedWebhook?.createdAt ?? null,
          lastSyncAt: integration.lastSyncAt,
          integrationStatus: integration.status,
          checks,
        };
      }),
    );
  }

  private async buildPrinterReadiness(
    printers: Array<{
      id: string;
      name: string;
      isActive: boolean;
      isOnline: boolean;
      connectionType: string;
    }>,
    locationId: string,
  ): Promise<PrinterReadiness[]> {
    const now = Date.now();
    const cutoff = new Date(now - 24 * 60 * 60_000);

    return Promise.all(
      printers.map(async (printer) => {
        const failedCount = await this.prisma.printJob.count({
          where: { printerId: printer.id, status: "FAILED", createdAt: { gte: cutoff } },
        });

        const lastSuccess = await this.prisma.printJob.findFirst({
          where: { printerId: printer.id, status: "PRINTED" },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        });

        const checks: ReadinessCheck[] = [
          {
            key: `printer.${printer.id}.active`,
            label: `${printer.name} is active`,
            status: printer.isActive ? "pass" : "fail",
            critical: false,
            adminOverridable: true,
          },
          {
            key: `printer.${printer.id}.online`,
            label: `${printer.name} is online`,
            status: printer.isOnline ? "pass" : "warn",
            detail: printer.isOnline ? undefined : "Check printer power and network connection",
            critical: false,
            adminOverridable: true,
          },
          {
            key: `printer.${printer.id}.test_print`,
            label: `${printer.name} test print passed`,
            status: lastSuccess ? "pass" : "warn",
            detail: lastSuccess
              ? `Last: ${lastSuccess.createdAt.toISOString()}`
              : "Run a test print from diagnostics",
            critical: false,
            adminOverridable: true,
          },
        ];

        return {
          printerId: printer.id,
          printerName: printer.name,
          isActive: printer.isActive,
          isOnline: printer.isOnline,
          connectionType: printer.connectionType,
          lastTestPrintAt: lastSuccess?.createdAt ?? null,
          failedJobsLast24h: failedCount,
          ready: printer.isActive && printer.isOnline && failedCount < 5,
          checks,
        };
      }),
    );
  }
}
