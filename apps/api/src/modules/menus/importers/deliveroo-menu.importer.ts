import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { MenuWriterService } from "./menu-writer.service";
import {
  classifyDeliverooMenu,
  type DeliverooMenuPayload,
} from "./deliveroo-menu.classifier";

// ── Deliveroo menu importer ────────────────────────────────────────────────
//
// Same shape as the Uber importer (see its header comment). Two HTTP hops
// when fetching live:
//   1. GET /site/v1/restaurant_locations/{storeId} → resolves the
//      Deliveroo brand id, which we cache on the Integration row for
//      next time.
//   2. GET /menu/v2/brands/{brandId}/sites/{storeId}/menu → the menu
//      itself.
//
// We expose the same payload-bypass affordance: operators can paste a
// raw export from the Deliveroo dashboard.

const DELIVEROO_RESTAURANT_URL = (storeId: string) =>
  `https://api.developers.deliveroo.com/site/v1/restaurant_locations/${storeId}`;
const DELIVEROO_MENU_URL = (brandId: string, storeId: string) =>
  `https://api.developers.deliveroo.com/menu/v2/brands/${brandId}/sites/${storeId}/menu`;

interface ImportArgs {
  menuId: string;
  tenantId: string;
  payload?: DeliverooMenuPayload;
  storeId?: string;
  /** Pre-resolved Deliveroo brand id (skips the resolve hop when present). */
  deliverooBrandId?: string;
  accessToken?: string;
}

@Injectable()
export class DeliverooMenuImporter {
  private readonly logger = new Logger(DeliverooMenuImporter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly writer: MenuWriterService,
  ) {}

  async import(args: ImportArgs) {
    const menu = await this.prisma.menu.findFirst({
      where: { id: args.menuId, brand: { tenantId: args.tenantId } },
      select: { id: true, brandId: true, locationId: true },
    });
    if (!menu) throw new BadRequestException("Menu not found or not accessible");

    let payload: DeliverooMenuPayload;
    if (args.payload) {
      payload = args.payload;
    } else {
      if (!args.storeId) {
        throw new BadRequestException(
          "Provide either payload or storeId for Deliveroo import",
        );
      }
      payload = await this.fetchFromDeliveroo(
        args.storeId,
        args.deliverooBrandId,
        args.accessToken,
      );
    }

    const normalized = classifyDeliverooMenu(payload);
    return this.writer.apply({
      menuId: menu.id,
      tenantId: args.tenantId,
      brandId: menu.brandId,
      locationId: menu.locationId,
      normalized,
    });
  }

  private async fetchFromDeliveroo(
    storeId: string,
    deliverooBrandId: string | undefined,
    accessToken: string | undefined,
  ): Promise<DeliverooMenuPayload> {
    if (!accessToken) {
      throw new BadRequestException(
        "Deliveroo access token required (configure the Integration first)",
      );
    }

    let brandId = deliverooBrandId;
    if (!brandId) {
      const r = await fetch(DELIVEROO_RESTAURANT_URL(storeId), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new BadRequestException(
          `Deliveroo restaurant_locations returned ${r.status}: ${body.slice(0, 200)}`,
        );
      }
      const json = (await r.json()) as { brand_id?: string };
      if (!json.brand_id) {
        throw new BadRequestException(
          "Deliveroo restaurant_locations response did not include brand_id",
        );
      }
      brandId = json.brand_id;
    }

    const r2 = await fetch(DELIVEROO_MENU_URL(brandId, storeId), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r2.ok) {
      const body = await r2.text().catch(() => "");
      throw new BadRequestException(
        `Deliveroo menu returned ${r2.status}: ${body.slice(0, 200)}`,
      );
    }
    return (await r2.json()) as DeliverooMenuPayload;
  }
}
