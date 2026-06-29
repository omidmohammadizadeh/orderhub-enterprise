// Phase AW — brand custom-domain (Cloudflare for SaaS) client.
import { apiClient } from "./client";

export interface BrandDomain {
  configured: boolean;
  domain: string;
  status: string; // not_configured | pending | verified | failed
  fallbackOrigin: string;
  dnsRecords: { type: string; name: string; value: string }[];
}

export const brandDomainsClient = {
  get: (brandId: string) =>
    apiClient.get<BrandDomain>(`/v1/brands/${brandId}/domain`).then((r) => r.data),

  connect: (brandId: string, domain: string) =>
    apiClient
      .post<BrandDomain>(`/v1/brands/${brandId}/domain/connect`, { domain })
      .then((r) => r.data),

  disconnect: (brandId: string) =>
    apiClient.delete<BrandDomain>(`/v1/brands/${brandId}/domain`).then((r) => r.data),
};
