import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { UberEatsClientService } from "./ubereats-client.service";
import { UberEatsOauthService } from "./ubereats-oauth.service";

// Phase UE-2 — store discovery, provisioning and store control.
//
// Discovery + provisioning use the MERCHANT token (eats.pos_provisioning):
//   GET  /v1/eats/stores                          → merchant's stores
//   POST /v1/eats/stores/{store_id}/pos_data      → activate our integration
//   PATCH/DELETE same path                        → toggle / deactivate
// Store control uses client-credentials (attached Store API spec, servers
// https://api.uber.com):
//   GET  /v1/delivery/store/{store_id}/status
//   POST /v1/delivery/store/{store_id}/update-store-status   {status, reason}
//   POST /v1/delivery/store/{store_id}/update-store-prep-time {default_prep_time}
// Uber confirms provisioning asynchronously with a store.provisioned webhook,
// which flips our row to "connected".

const STORE_SCOPES = ["eats.store"];
const STATUS_SCOPES = ["eats.store.status.write"];

@Injectable()
export class UberEatsConnectionService {
  private readonly logger = new Logger(UberEatsConnectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: UberEatsClientService,
    private readonly oauth: UberEatsOauthService,
  ) {}

  /** Stores visible to the authorised merchant (for the store picker). */
  async listMerchantStores(tenantId: string, brandId: string, locationId: string) {
    const row = await this.pendingOrConnected(tenantId, brandId, locationId);
    const token = await this.oauth.merchantToken(row);
    const json = await this.client.request<any>("GET", "/v1/eats/stores", {
      userToken: token,
    });
    const stores = (json?.stores ?? json ?? []) as any[];
    return stores.map((s) => ({
      storeId: s.store_id ?? s.id ?? s.uuid,
      name: s.name ?? s.store_name ?? "",
      address:
        s.location?.address ??
        s.address?.formatted_address ??
        s.address ??
        null,
      raw: s,
    }));
  }

  /** Activate our integration against the chosen Uber store. */
  async provision(
    tenantId: string,
    dto: { brandId: string; locationId: string; storeId: string },
  ) {
    const row = await this.pendingOrConnected(
      tenantId,
      dto.brandId,
      dto.locationId,
    );
    const token = await this.oauth.merchantToken(row);
    const storeId = dto.storeId.trim();
    if (!storeId) throw new BadRequestException("Uber store id is required.");

    // integrator_store_id is OUR stable id for the store — the connection id
    // survives reconnects and encodes brand+location uniquely.
    await this.client.request(
      "POST",
      `/v1/eats/stores/${encodeURIComponent(storeId)}/pos_data`,
      {
        userToken: token,
        body: {
          integrator_store_id: row.id,
          integrator_brand_id: dto.brandId,
          integration_enabled: true,
        },
      },
    );

    const updated = await this.prisma.brandPlatformConnection.update({
      where: { id: row.id },
      data: {
        externalStoreId: storeId,
        // store.provisioned webhook confirms; until then leave as pending so
        // the UI shows "waiting for Uber confirmation".
        status: "pending",
        lastError: null,
      },
    });
    this.logger.log(
      `Uber Eats pos_data posted for store=${storeId} conn=${row.id} — waiting for store.provisioned webhook`,
    );
    return this.view(updated);
  }

  /** store.provisioned / store.deprovisioned webhook → flip connection. */
  async applyProvisioningEvent(
    uberStoreId: string,
    provisioned: boolean,
  ): Promise<string | null> {
    const row = await this.prisma.brandPlatformConnection.findFirst({
      where: { platform: "UBER_EATS", externalStoreId: uberStoreId },
    });
    if (!row) {
      this.logger.warn(
        `Uber Eats ${provisioned ? "provisioned" : "deprovisioned"} webhook for unknown store ${uberStoreId}`,
      );
      return null;
    }
    await this.prisma.brandPlatformConnection.update({
      where: { id: row.id },
      data: {
        status: provisioned ? "connected" : "not_connected",
        lastWebhookAt: new Date(),
        ...(provisioned ? { lastError: null } : {}),
      },
    });
    this.logger.log(
      `Uber Eats connection ${row.id} → ${provisioned ? "connected" : "not_connected"} (store ${uberStoreId})`,
    );
    return row.id;
  }

  async disconnect(tenantId: string, connectionId: string) {
    const row = await this.prisma.brandPlatformConnection.findFirst({
      where: { id: connectionId, tenantId, platform: "UBER_EATS" },
    });
    if (!row) throw new NotFoundException("Uber Eats connection not found");
    // Best-effort deactivation on Uber's side; the row flips regardless so
    // the operator is never stuck behind a dead token.
    if (row.externalStoreId) {
      try {
        const token = await this.oauth.merchantToken(row);
        await this.client.request(
          "DELETE",
          `/v1/eats/stores/${encodeURIComponent(row.externalStoreId)}/pos_data`,
          { userToken: token },
        );
      } catch (err: any) {
        this.logger.warn(
          `Uber Eats pos_data delete failed (continuing): ${err?.message}`,
        );
      }
    }
    await this.prisma.brandPlatformConnection.update({
      where: { id: connectionId },
      data: {
        status: "not_connected",
        externalStoreId: null,
        lastError: null,
        metadata: {},
      },
    });
    return { ok: true };
  }

  /** ONLINE/OFFLINE from Uber (client-credentials). */
  async storeStatus(tenantId: string, connectionId: string) {
    const c = await this.connected(tenantId, connectionId);
    const json = await this.client.request<{
      status?: string;
      is_offline_until?: string;
      offline_reason?: string;
    }>("GET", `/v1/delivery/store/${c.externalStoreId}/status`, {
      scopes: STATUS_SCOPES,
    });
    return {
      status: String(json?.status ?? "UNKNOWN").toUpperCase(),
      offlineUntil: json?.is_offline_until ?? null,
      offlineReason: json?.offline_reason ?? null,
    };
  }

  /** Pause (OFFLINE) / resume (ONLINE) the store on Uber Eats. */
  async setStoreOnline(
    tenantId: string,
    connectionId: string,
    online: boolean,
    reason?: string,
  ) {
    const c = await this.connected(tenantId, connectionId);
    await this.client.request(
      "POST",
      `/v1/delivery/store/${c.externalStoreId}/update-store-status`,
      {
        scopes: STATUS_SCOPES,
        body: {
          status: online ? "ONLINE" : "OFFLINE",
          ...(reason ? { reason } : {}),
        },
      },
    );
    await this.prisma.brandPlatformConnection.update({
      where: { id: connectionId },
      data: { status: online ? "connected" : "suspended" },
    });
    return { status: online ? "ONLINE" : "OFFLINE" };
  }

  /** Push the location's default prep time (seconds, max 10800). */
  async publishPrepTime(tenantId: string, connectionId: string) {
    const c = await this.connected(tenantId, connectionId);
    const loc = await this.prisma.location.findUnique({
      where: { id: c.locationId },
      select: { prepTime: true, brand: { select: { prepTime: true } } },
    });
    const minutes =
      (loc?.prepTime ?? null) ?? (loc?.brand?.prepTime ?? null) ?? 15;
    const seconds = Math.min(minutes * 60, 10_800);
    await this.client.request(
      "POST",
      `/v1/delivery/store/${c.externalStoreId}/update-store-prep-time`,
      { scopes: STORE_SCOPES, body: { default_prep_time: seconds } },
    );
    return { ok: true, defaultPrepTimeSeconds: seconds };
  }

  // ── Store API suite (certification checklist) ───────────────────────────

  /** Get Stores — every store this app's token is authorised against. */
  async listAppStores(pageToken?: string) {
    const qs = pageToken ? `?page_token=${encodeURIComponent(pageToken)}` : "";
    const json = await this.client.request<any>(
      "GET",
      `/v1/delivery/stores${qs}`,
      { scopes: STORE_SCOPES },
    );
    return json ?? { stores: [] };
  }

  /** Get Store Details — full store record incl. orderability + config. */
  async storeDetails(tenantId: string, connectionId: string) {
    const c = await this.connected(tenantId, connectionId);
    return (
      (await this.client.request<any>(
        "GET",
        `/v1/delivery/store/${c.externalStoreId}`,
        { scopes: STORE_SCOPES },
      )) ?? null
    );
  }

  /** Update Store Information — contact / location / pickup instructions. */
  async updateStoreInfo(
    tenantId: string,
    connectionId: string,
    dto: {
      contact?: { email?: string; name?: string; phone_number?: string };
      location?: Record<string, string>;
      pickupInstructions?: string;
    },
  ) {
    const c = await this.connected(tenantId, connectionId);
    const body: Record<string, unknown> = {
      ...(dto.contact ? { contact: dto.contact } : {}),
      ...(dto.location ? { location: dto.location } : {}),
      ...(dto.pickupInstructions !== undefined
        ? { pickup_instructions: dto.pickupInstructions }
        : {}),
    };
    if (Object.keys(body).length === 0) {
      throw new BadRequestException("Nothing to update.");
    }
    await this.client.request(
      "POST",
      `/v1/delivery/store/${c.externalStoreId}`,
      { scopes: STORE_SCOPES, body },
    );
    return { ok: true };
  }

  /** Update Fulfillment Configuration (BYOC min-ETD override). */
  async updateFulfillmentConfig(
    tenantId: string,
    connectionId: string,
    dto: { customMinEtdMinutes: number },
  ) {
    if (!Number.isFinite(Number(dto.customMinEtdMinutes))) {
      throw new BadRequestException("customMinEtdMinutes is required");
    }
    const c = await this.connected(tenantId, connectionId);
    await this.client.request(
      "POST",
      `/v1/delivery/store/${c.externalStoreId}/update-fulfillment-configuration`,
      {
        scopes: ["eats.byoc.fulfillment.config"],
        body: {
          override_config: {
            custom_min_etd_minutes: Number(dto.customMinEtdMinutes),
          },
        },
      },
    );
    return { ok: true };
  }

  /** Active orders on Uber's side (recovery/reconciliation + verification). */
  async listStoreOrders(tenantId: string, connectionId: string) {
    const c = await this.connected(tenantId, connectionId);
    const json = await this.client.request<any>(
      "GET",
      `/v1/delivery/store/${c.externalStoreId}/orders`,
      { scopes: ["eats.order"] },
    );
    return json ?? { orders: [] };
  }

  /** Connection row for the dashboard card. */
  async get(tenantId: string, brandId: string, locationId: string) {
    const row = await this.prisma.brandPlatformConnection.findFirst({
      where: {
        tenantId,
        brandId,
        locationId,
        platform: "UBER_EATS",
      },
    });
    return row ? this.view(row) : { status: "not_connected" };
  }

  private async pendingOrConnected(
    tenantId: string,
    brandId: string,
    locationId: string,
  ) {
    const row = await this.prisma.brandPlatformConnection.findFirst({
      where: { tenantId, brandId, locationId, platform: "UBER_EATS" },
    });
    if (!row) {
      throw new BadRequestException(
        "Uber Eats isn't authorised for this brand yet — run Connect Uber Eats first.",
      );
    }
    return row;
  }

  private async connected(tenantId: string, connectionId: string) {
    const row = await this.prisma.brandPlatformConnection.findFirst({
      where: { id: connectionId, tenantId, platform: "UBER_EATS" },
    });
    if (!row?.externalStoreId) {
      throw new BadRequestException(
        "Uber Eats isn't connected for this brand.",
      );
    }
    return row;
  }

  private view(row: any) {
    return {
      id: row.id,
      status: row.status,
      storeId: row.externalStoreId ?? null,
    };
  }
}
