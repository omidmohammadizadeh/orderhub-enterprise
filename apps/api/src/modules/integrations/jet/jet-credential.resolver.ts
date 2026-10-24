import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { CredentialEncryptionService } from "../credential-encryption.service";

// Phase JE-0 — JET Connect credential resolution.
//
// JET is NOT OAuth. It issues plain API keys, and which key you need depends
// on both the operation and the restaurant:
//
//   MENU key   — issued per COUNTRY, and separately for any brand operating
//                more than 6 locations. Carries /menus, /item-availability
//                and /restaurants/{ref}/online|offline|servicetimes.
//   ORDER key  — a distinct key for the asynchronous acknowledgement
//                endpoints (/order/{id}/sent-to-pos-success|failed).
//
// So a single platform-level secret (the shape Deliveroo and Uber use) cannot
// express this. Keys resolve in three tiers, most specific first:
//
//   1. BRAND    — a key issued to one brand (the >6-locations case), stored
//                 encrypted on that brand's BrandPlatformConnection.
//   2. COUNTRY  — JET_MENU_KEYS / JET_ORDER_KEYS, "GB:key1,IE:key2".
//   3. PLATFORM — JET_MENU_API_KEY / JET_ORDER_API_KEY, the single-country
//                 default so a first pilot needs no per-brand setup at all.
//
// Brand-tier keys go through CredentialEncryptionService (AES-256-GCM), the
// same envelope HubRise's access token uses. They are never logged: resolve()
// returns the key and describe() returns only which TIER answered, which is
// what a "why is this 403ing?" investigation actually needs.

export type JetKeyType = "menu" | "order";

/** Where a resolved key came from. Safe to log — carries no secret. */
export type JetKeySource =
  | "brand"
  | "brandGroup"
  | "country"
  | "platform"
  | "none";

export interface JetKeyResolution {
  key: string | null;
  source: JetKeySource;
  /** Country the key was resolved for, when the country tier answered. */
  country?: string;
  /** The brand group that answered, when the group tier did. */
  group?: string;
}

/** One configured brand-key group. Carries NO key — safe to send to the UI. */
export interface JetBrandKeyGroup {
  name: string;
  hasMenuKey: boolean;
  hasOrderKey: boolean;
}

@Injectable()
export class JetCredentialResolver {
  private readonly logger = new Logger(JetCredentialResolver.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly crypto: CredentialEncryptionService,
  ) {}

  private cfg(key: string): string {
    return this.config.get<string>(`app.platforms.jet.${key}`) ?? "";
  }

  /**
   * Parse a "GB:key1,IE:key2" list into a country → key map. Country codes
   * are upper-cased so the env var can be written either way; blank or
   * malformed entries are skipped rather than throwing, because a typo in one
   * country's key must not take every other country's key down with it.
   */
  private parseCountryKeys(raw: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const entry of raw.split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf(":");
      if (idx <= 0) {
        this.logger.warn(
          `JET country key list has an entry without a "COUNTRY:key" separator — skipping it`,
        );
        continue;
      }
      const country = trimmed.slice(0, idx).trim().toUpperCase();
      const key = trimmed.slice(idx + 1).trim();
      if (country && key) out[country] = key;
    }
    return out;
  }

  /** True when at least one tier could produce a key of this type. */
  configured(type: JetKeyType): boolean {
    const platform = this.cfg(type === "menu" ? "menuApiKey" : "orderApiKey");
    const byCountry = this.cfg(
      type === "menu" ? "menuKeysByCountry" : "orderKeysByCountry",
    );
    return !!platform || Object.keys(this.parseCountryKeys(byCountry)).length > 0;
  }

  /**
   * Resolve the API key to use for an operation.
   *
   * `brandId` narrows to the brand tier; `country` (ISO-2) selects the country
   * tier, defaulting to JET_DEFAULT_COUNTRY. A miss at one tier falls through
   * to the next rather than failing — a brand without its own key is the
   * normal case, not an error.
   */
  async resolve(args: {
    type: JetKeyType;
    brandId?: string | null;
    locationId?: string | null;
    country?: string | null;
  }): Promise<JetKeyResolution> {
    const { type } = args;

    // ── Tier 1: brand-issued key ────────────────────────────────────────
    if (args.brandId) {
      const key = await this.brandKey(args.brandId, args.locationId ?? null, type);
      if (key) return { key, source: "brand" };
    }

    // ── Tier 1b: brand GROUP key ────────────────────────────────────────
    // A key JET issued to a brand that trades from many shops. Every shop is
    // its own Brand row, so the per-connection tier above cannot express
    // "all twenty Monster Burgerz shops share this key" without the operator
    // pasting it twenty times.
    //
    // STRICTLY ADDITIVE: this only answers when the connection explicitly
    // names a group, so a live connection that has never heard of groups
    // falls straight through to the country tier exactly as before. A group
    // with no key of this type, or a name nobody configured, also falls
    // through rather than failing — a typo must not take a shop off Just Eat.
    if (args.brandId) {
      const group = await this.brandKeyGroupOf(
        args.brandId,
        args.locationId ?? null,
      );
      if (group) {
        const key = this.brandGroupKeys(type)[group];
        // Reported lower-case, matching brandKeyGroups() and the dashboard,
        // so the log line and the picker show the same name.
        if (key) return { key, source: "brandGroup", group: group.toLowerCase() };
      }
    }

    // ── Tier 2: country key ─────────────────────────────────────────────
    const country = (args.country || this.cfg("defaultCountry") || "GB")
      .trim()
      .toUpperCase();
    const byCountry = this.parseCountryKeys(
      this.cfg(type === "menu" ? "menuKeysByCountry" : "orderKeysByCountry"),
    );
    if (byCountry[country]) {
      return { key: byCountry[country]!, source: "country", country };
    }

    // ── Tier 3: platform default ────────────────────────────────────────
    const platform = this.cfg(type === "menu" ? "menuApiKey" : "orderApiKey");
    if (platform) return { key: platform, source: "platform" };

    return { key: null, source: "none" };
  }

  /** The configured "group:key" map for one key type. */
  private brandGroupKeys(type: JetKeyType): Record<string, string> {
    return this.parseCountryKeys(
      this.cfg(type === "menu" ? "brandMenuKeys" : "brandOrderKeys"),
    );
  }

  /**
   * Which brand group a connection has opted into, normalised.
   *
   * Stored on the connection's metadata rather than in a new column so this
   * needs no migration and an existing row simply has no opinion. Names are
   * upper-cased by the shared parser, so both sides are compared that way and
   * the operator can save "Monster-Burgerz" or " monster-burgerz ".
   */
  private async brandKeyGroupOf(
    brandId: string,
    locationId: string | null,
  ): Promise<string | null> {
    try {
      const conn = await this.prisma.brandPlatformConnection.findFirst({
        where: {
          brandId,
          platform: "JUST_EAT",
          ...(locationId ? { locationId } : {}),
        },
        select: { metadata: true },
      });
      const raw = ((conn?.metadata as any) ?? {}).brandKeyGroup;
      const name = String(raw ?? "").trim().toUpperCase();
      return name || null;
    } catch {
      return null;
    }
  }

  /**
   * The groups an operator can pick from. Names only — never a key — because
   * this is rendered in the dashboard.
   */
  brandKeyGroups(): JetBrandKeyGroup[] {
    const menu = this.brandGroupKeys("menu");
    const order = this.brandGroupKeys("order");
    const names = [...new Set([...Object.keys(menu), ...Object.keys(order)])].sort();
    return names.map((name) => ({
      name: name.toLowerCase(),
      hasMenuKey: !!menu[name],
      hasOrderKey: !!order[name],
    }));
  }

  /**
   * Read a brand's own key off its JET connection.
   *
   * `metadata.credentials` holds ONE encrypted envelope covering both keys
   * ({menuKey, orderKey}) rather than an envelope per key —
   * CredentialEncryptionService encrypts a whole record, and splitting them
   * would mean two envelopes to keep in rotation sync for no benefit. When no
   * encryption key is configured (dev/test) the service round-trips the record
   * unchanged, so the same read works either way.
   *
   * A decrypt failure is logged and treated as "no brand key" so the country
   * tier still answers: a brand whose ciphertext predates a key rotation
   * should degrade to the shared key, not lose Just Eat entirely.
   */
  private async brandKey(
    brandId: string,
    locationId: string | null,
    type: JetKeyType,
  ): Promise<string | null> {
    try {
      const conn = await this.prisma.brandPlatformConnection.findFirst({
        where: {
          brandId,
          platform: "JUST_EAT",
          ...(locationId ? { locationId } : {}),
        },
        select: { id: true, metadata: true },
      });
      const stored = ((conn?.metadata as any) ?? {}).credentials;
      if (!stored || typeof stored !== "object") return null;
      const creds = this.crypto.decrypt(stored as Record<string, unknown>);
      const key = type === "menu" ? creds.menuKey : creds.orderKey;
      return key && String(key).trim() ? String(key).trim() : null;
    } catch (e: any) {
      this.logger.warn(
        `JET brand ${brandId} ${type} key could not be read (${e?.message}) — ` +
          `falling back to the country/platform key`,
      );
      return null;
    }
  }

  /**
   * Encrypt a brand's key pair for storage on the connection metadata.
   * Blank values are dropped rather than stored as empty strings, so
   * "brand has a menu key but uses the shared order key" is expressible.
   */
  encryptForStorage(keys: {
    menuKey?: string | null;
    orderKey?: string | null;
  }): Record<string, unknown> {
    const record: Record<string, unknown> = {};
    if (keys.menuKey?.trim()) record.menuKey = keys.menuKey.trim();
    if (keys.orderKey?.trim()) record.orderKey = keys.orderKey.trim();
    return this.crypto.encrypt(record);
  }
}
