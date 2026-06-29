import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

// Phase AW — custom domains for brand storefronts via Cloudflare for SaaS
// (Custom Hostnames). The platform's Render origin sits behind a Cloudflare
// zone (e.g. orderhubcustomers.com); each brand domain is registered as a
// custom hostname with HTTP DCV, so the brand only adds ONE CNAME →
// fallback origin and Cloudflare auto-issues + renews the TLS cert.
//
// Required env: CLOUDFLARE_API_TOKEN (Zone:SSL+Certs Edit), CLOUDFLARE_ZONE_ID,
// CLOUDFLARE_SAAS_FALLBACK_ORIGIN (e.g. customers.orderhubcustomers.com).

const CF_API = "https://api.cloudflare.com/client/v4";

export interface CfHostname {
  id: string;
  hostname: string;
  status: string; // pending | active | blocked | moved | deleted
  sslStatus: string; // pending_validation | active | ...
}

@Injectable()
export class CloudflareService {
  private readonly logger = new Logger(CloudflareService.name);

  constructor(private readonly config: ConfigService) {}

  private get token(): string | undefined {
    return this.config.get<string>("CLOUDFLARE_API_TOKEN");
  }
  private get zoneId(): string | undefined {
    return this.config.get<string>("CLOUDFLARE_ZONE_ID");
  }
  get fallbackOrigin(): string {
    return this.config.get<string>("CLOUDFLARE_SAAS_FALLBACK_ORIGIN") ?? "";
  }
  get configured(): boolean {
    return !!this.token && !!this.zoneId && !!this.fallbackOrigin;
  }

  private async cf(path: string, init?: any): Promise<any> {
    const res = await fetch(`${CF_API}${path}`, {
      ...(init ?? {}),
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...((init?.headers as any) ?? {}),
      },
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.success === false) {
      const msg = json?.errors?.[0]?.message ?? `Cloudflare returned ${res.status}`;
      this.logger.warn(`Cloudflare API ${path} failed: ${msg}`);
      throw new BadRequestException(`Cloudflare: ${msg}`);
    }
    return json.result;
  }

  private map(r: any): CfHostname {
    return {
      id: r.id,
      hostname: r.hostname,
      status: r.status ?? "pending",
      sslStatus: r.ssl?.status ?? "pending_validation",
    };
  }

  async findByHostname(hostname: string): Promise<CfHostname | null> {
    const result = await this.cf(
      `/zones/${this.zoneId}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`,
    );
    if (Array.isArray(result) && result.length > 0) return this.map(result[0]);
    return null;
  }

  /** Idempotent — reuses the existing custom hostname if already created. */
  async createHostname(hostname: string): Promise<CfHostname> {
    const existing = await this.findByHostname(hostname);
    if (existing) return existing;
    const r = await this.cf(`/zones/${this.zoneId}/custom_hostnames`, {
      method: "POST",
      body: JSON.stringify({
        hostname,
        ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
      }),
    });
    return this.map(r);
  }

  async deleteHostname(hostname: string): Promise<void> {
    const existing = await this.findByHostname(hostname);
    if (!existing) return;
    await this.cf(`/zones/${this.zoneId}/custom_hostnames/${existing.id}`, { method: "DELETE" });
  }
}
