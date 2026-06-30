import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

// Phase AW — custom domains for brand storefronts via Render's own
// custom-domain API (the app is hosted on Render, so this avoids the
// Cloudflare-for-SaaS "Error 1000" loop). The dashboard panel calls these
// methods so operators never touch the Render dashboard per brand.
//
// Env: RENDER_API_KEY, RENDER_WEB_SERVICE_ID (e.g. srv-…), and optionally
// RENDER_WEB_ONRENDER_HOST (default orderhub-web.onrender.com) +
// RENDER_APEX_IP (default 216.24.57.1, Render's anycast IP for apex A records).

const RENDER_API = "https://api.render.com/v1";

// Common 2-label public suffixes so example.co.uk is treated as an apex.
const TWO_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk", "ac.uk", "gov.uk", "nhs.uk",
  "com.au", "net.au", "org.au", "co.nz", "co.za",
]);

export interface RenderDomain {
  id: string;
  name: string;
  verified: boolean;
}

export interface DnsRecord {
  type: "A" | "CNAME";
  name: string;
  value: string;
}

@Injectable()
export class RenderDomainsService {
  private readonly logger = new Logger(RenderDomainsService.name);

  constructor(private readonly config: ConfigService) {}

  private get apiKey(): string | undefined {
    return this.config.get<string>("RENDER_API_KEY");
  }
  private get serviceId(): string | undefined {
    return this.config.get<string>("RENDER_WEB_SERVICE_ID");
  }
  get serviceHost(): string {
    return this.config.get<string>("RENDER_WEB_ONRENDER_HOST") ?? "orderhub-web.onrender.com";
  }
  private get apexIp(): string {
    return this.config.get<string>("RENDER_APEX_IP") ?? "216.24.57.1";
  }
  get configured(): boolean {
    return !!this.apiKey && !!this.serviceId;
  }

  /** apex (example.com / example.co.uk) → A record; subdomain → CNAME. */
  isApex(host: string): boolean {
    const labels = host.split(".");
    if (labels.length <= 2) return true;
    if (labels.length === 3 && TWO_LABEL_SUFFIXES.has(labels.slice(-2).join("."))) return true;
    return false;
  }

  dnsRecordsFor(host: string): DnsRecord[] {
    if (this.isApex(host)) {
      return [{ type: "A", name: "@", value: this.apexIp }];
    }
    return [{ type: "CNAME", name: host, value: this.serviceHost }];
  }

  private async api(path: string, init?: any): Promise<any> {
    const res = await fetch(`${RENDER_API}${path}`, {
      ...(init ?? {}),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...((init?.headers as any) ?? {}),
      },
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const msg = json?.message ?? `Render API returned ${res.status}`;
      this.logger.warn(`Render API ${path} failed: ${msg}`);
      throw new BadRequestException(`Render: ${msg}`);
    }
    return json;
  }

  private map(d: any): RenderDomain {
    return {
      id: d?.id ?? "",
      name: d?.name ?? "",
      // Render exposes verificationStatus: "verified" | "unverified".
      verified: (d?.verificationStatus ?? d?.status) === "verified",
    };
  }

  async findByName(name: string): Promise<RenderDomain | null> {
    const list = await this.api(`/services/${this.serviceId}/custom-domains?limit=100`);
    const arr = Array.isArray(list) ? list : [];
    // Render list items may be wrapped as { customDomain, cursor }.
    const found = arr
      .map((x: any) => x?.customDomain ?? x)
      .find((d: any) => d?.name?.toLowerCase() === name.toLowerCase());
    return found ? this.map(found) : null;
  }

  /** Idempotent — reuses the existing Render custom domain if present. */
  async create(name: string): Promise<RenderDomain> {
    const existing = await this.findByName(name);
    if (existing) return existing;
    const created = await this.api(`/services/${this.serviceId}/custom-domains`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    const d = created?.customDomain ?? created;
    return this.map(d);
  }

  /** Ask Render to re-check DNS now (best-effort). */
  async triggerVerify(idOrName: string): Promise<void> {
    await this.api(`/services/${this.serviceId}/custom-domains/${idOrName}/verify`, {
      method: "POST",
    }).catch(() => undefined);
  }

  async remove(name: string): Promise<void> {
    const existing = await this.findByName(name);
    if (!existing?.id) return;
    await this.api(`/services/${this.serviceId}/custom-domains/${existing.id}`, {
      method: "DELETE",
    });
  }
}
