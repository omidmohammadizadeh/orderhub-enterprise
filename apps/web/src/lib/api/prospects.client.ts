// Admin → Prospects. Private shop previews and commission reports for shops we
// want to sign. Platform-admin only, across every tenant.

import { apiClient } from "./client";

export type ReadStatus = "NONE" | "READING" | "READY" | "FAILED";
export type StatementPlatform = "just_eat" | "uber_eats" | "deliveroo" | "other";

export interface PreviewOption {
  name: string;
  priceAdjustment?: number;
}

export interface PreviewGroup {
  key: string;
  name: string;
  selectionType: "VARIANT" | "ADDON";
  minSelections?: number;
  maxSelections?: number;
  options: PreviewOption[];
}

export interface PreviewItem {
  name: string;
  description?: string | null;
  price?: number;
  sizes?: { name: string; price: number; modifierGroupKeys?: string[] }[];
  modifierGroupKeys?: string[];
  imageUrl?: string | null;
}

export interface PreviewMenu {
  menuName?: string;
  currency?: string;
  categories: { name: string; description?: string | null; items: PreviewItem[] }[];
  modifierGroups?: PreviewGroup[];
  warnings?: string[];
}

export interface ProspectStatement {
  id: string;
  platform: StatementPlatform;
  periodStart: string | null;
  periodEnd: string | null;
  currency: string;
  sales: number;
  commission: number;
  commissionVat: number | null;
  orders: number | null;
  otherFees: { label: string; amount: number }[];
  payout: number | null;
  source: "statement" | "manual";
  warnings: string[];
}

export interface ReportAssumptions {
  movedSharePct: number;
  cardPct: number;
  cardFixedPence: number;
  subscriptionPerWeek: number;
  deliveryCostPerOrder: number;
}

export interface CommissionReport {
  currency: string;
  platforms: {
    platform: StatementPlatform;
    sales: number;
    commission: number;
    otherFees: number;
    orders: number | null;
    commissionRatePct: number;
    daysCovered: number | null;
  }[];
  sales: number;
  commission: number;
  otherFees: number;
  orders: number | null;
  commissionRatePct: number;
  shortestPeriodDays: number | null;
  year: { sales: number; commission: number; otherFees: number; orders: number | null } | null;
  scenario: {
    movedSales: number;
    commissionSaved: number;
    cardFees: number;
    deliveryCosts: number;
    subscription: number;
    netPerYear: number;
    breakEvenSharePct: number | null;
  } | null;
  assumptions: ReportAssumptions;
  notes: string[];
}

export interface Prospect {
  id: string;
  shopName: string;
  sourceUrl: string | null;
  city: string | null;
  postcode: string | null;
  logoUrl: string | null;
  bannerUrl: string | null;
  previewToken: string;
  previewExpiresAt: string;
  menu: PreviewMenu | null;
  menuStatus: ReadStatus;
  menuError: string | null;
  hygiene: { establishmentId: string; rating: string; url: string } | null;
  statements: ProspectStatement[];
  statementStatus: ReadStatus;
  statementError: string | null;
  report: CommissionReport | null;
  createdAt: string;
}

export interface UploadFile {
  mediaType: string;
  data: string;
}

export interface ExtractedMenuBody {
  draft: object;
  shopName?: string;
  logoUrl?: string | null;
  bannerUrl?: string | null;
  city?: string | null;
  postcode?: string | null;
}

export interface ManualStatement {
  platform: StatementPlatform;
  periodStart?: string;
  periodEnd?: string;
  sales: number;
  commission: number;
  orders?: number;
  otherFees?: { label: string; amount: number }[];
}

const base = "/v1/admin/prospects";

export const prospectsClient = {
  list: () => apiClient.get<Prospect[]>(base).then((r) => r.data),
  get: (id: string) => apiClient.get<Prospect>(`${base}/${id}`).then((r) => r.data),
  create: (body: { shopName?: string; sourceUrl?: string }) =>
    apiClient.post<Prospect>(base, body).then((r) => r.data),
  remove: (id: string) => apiClient.delete(`${base}/${id}`).then((r) => r.data),

  saveMenu: (id: string, body: ExtractedMenuBody) =>
    apiClient.put<Prospect>(`${base}/${id}/menu`, body).then((r) => r.data),
  readMenu: (id: string, files: UploadFile[]) =>
    apiClient.post<Prospect>(`${base}/${id}/menu/read`, { files }).then((r) => r.data),
  setHygiene: (id: string, url: string) =>
    apiClient.put<Prospect>(`${base}/${id}/hygiene`, { url }).then((r) => r.data),

  readStatements: (id: string, files: UploadFile[]) =>
    apiClient.post<Prospect>(`${base}/${id}/statements/read`, { files }).then((r) => r.data),
  addStatement: (id: string, body: ManualStatement) =>
    apiClient.post<Prospect>(`${base}/${id}/statements`, body).then((r) => r.data),
  removeStatement: (id: string, statementId: string) =>
    apiClient.delete<Prospect>(`${base}/${id}/statements/${statementId}`).then((r) => r.data),
  setAssumptions: (id: string, body: Partial<ReportAssumptions>) =>
    apiClient.put<Prospect>(`${base}/${id}/assumptions`, body).then((r) => r.data),
};
