import { apiClient } from "./client";

export type ContractStatus = "DRAFT" | "SENT" | "OPENED" | "SIGNED" | "VOIDED";

export interface ContractTemplate {
  id: string;
  name: string;
  description: string | null;
  bodyHtml: string | null;
  fileUrl: string | null;
  fileName: string | null;
  fileType: string | null;
  subscriptionAmountPence: number | null;
  /** True when the uploaded file is a finished Order Hub document — it
   *  carries someone else's signature certificate inside it. */
  isFinishedDocument?: boolean;
  createdAt: string;
}

export interface Contract {
  id: string;
  title: string;
  status: ContractStatus;
  recipientName: string;
  recipientEmail: string;
  recipientCompany: string | null;
  recipientCompanyNumber: string | null;
  recipientAddress: string | null;
  recipientPhone: string | null;
  locationCount: number | null;
  locationId: string | null;
  locationName: string | null;
  templateId: string | null;
  templateName: string | null;
  subscriptionAmountPence: number | null;
  commissionPercent: number | null;
  customerServiceChargePence: number | null;
  hasFile: boolean;
  fileUrl: string | null;
  fileName: string | null;
  bodyHtml: string | null;
  sentAt: string | null;
  firstOpenedAt: string | null;
  signedAt: string | null;
  voidedAt: string | null;
  signerName: string | null;
  signerEmail: string | null;
  signerIp: string | null;
  signatureImageUrl: string | null;
  subscriptionStartedAt: string | null;
  signingUrl: string;
  createdAt: string;
}

export interface ContractEvent {
  id: string;
  type: string;
  ip: string | null;
  userAgent: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export const contractsClient = {
  // ── Templates ──────────────────────────────────────────────────────────
  issuerDefaults: () =>
    apiClient
      .get<{
        name: string;
        companyNumber: string | null;
        address: string | null;
        email: string | null;
      }>("/v1/contracts/issuer-defaults")
      .then((r) => r.data),

  listStarters: () =>
    apiClient
      .get<
        Array<{
          key: string;
          name: string;
          description: string;
          installed: boolean;
          bodyHtml: string;
        }>
      >("/v1/contracts/templates/starters")
      .then((r) => r.data),

  installStarter: (key: string) =>
    apiClient
      .post<ContractTemplate>(`/v1/contracts/templates/starters/${key}`)
      .then((r) => r.data),

  listTemplates: () =>
    apiClient
      .get<ContractTemplate[]>("/v1/contracts/templates")
      .then((r) => r.data),

  createTemplate: (body: {
    name: string;
    description?: string;
    bodyHtml?: string;
    fileUrl?: string;
    fileName?: string;
    fileType?: string;
    subscriptionAmountPence?: number;
  }) =>
    apiClient
      .post<ContractTemplate>("/v1/contracts/templates", body)
      .then((r) => r.data),

  deleteTemplate: (id: string) =>
    apiClient.delete(`/v1/contracts/templates/${id}`).then((r) => r.data),

  // ── Contracts ──────────────────────────────────────────────────────────
  list: (status?: string) =>
    apiClient
      .get<Contract[]>("/v1/contracts", {
        params: status && status !== "ALL" ? { status } : undefined,
      })
      .then((r) => r.data),

  get: (id: string) =>
    apiClient
      .get<Contract & { events: ContractEvent[] }>(`/v1/contracts/${id}`)
      .then((r) => r.data),

  create: (body: {
    templateId?: string;
    title?: string;
    bodyHtml?: string;
    fileUrl?: string;
    fileName?: string;
    fileType?: string;
    recipientName: string;
    recipientEmail: string;
    recipientCompany?: string;
    recipientCompanyNumber?: string;
    recipientAddress?: string;
    recipientPhone?: string;
    locationCount?: number;
    locationId?: string;
    subscriptionAmountPence?: number;
    /** Commission per order as a percentage. Blank omits the clause entirely. */
    commissionPercent?: number;
    /** Per-order charge the CUSTOMER pays, in pence. Blank omits the clause. */
    customerServiceChargePence?: number;
    /** Overrides the platform's own details on the signature certificate. */
    issuer?: {
      name?: string;
      companyNumber?: string;
      address?: string;
      email?: string;
    } | null;
  }) => apiClient.post<Contract>("/v1/contracts", body).then((r) => r.data),

  /**
   * Amend a sent-but-unsigned contract. Signed ones are refused server-side —
   * the signed artefact has to stay exactly what was agreed.
   */
  update: (
    id: string,
    body: {
      title?: string;
      recipientName?: string;
      recipientEmail?: string;
      recipientCompany?: string | null;
      locationId?: string | null;
      subscriptionAmountPence?: number | null;
      commissionPercent?: number | null;
      customerServiceChargePence?: number | null;
    },
  ) => apiClient.patch<Contract>(`/v1/contracts/${id}`, body).then((r) => r.data),

  send: (id: string, body: { emailIt?: boolean; message?: string } = {}) =>
    apiClient
      .post<Contract & { signingUrl: string }>(`/v1/contracts/${id}/send`, body)
      .then((r) => r.data),

  /**
   * Issue the contract WITHOUT emailing it, and hand back the link.
   *
   * This is not the same as reading `signingUrl` off the list row. A DRAFT
   * cannot be signed — the link would open, the client would type their name,
   * and signing would fail. Issuing it here moves DRAFT → SENT so the link
   * actually works when it lands in someone's WhatsApp.
   */
  generateLink: (id: string) =>
    apiClient
      .post<Contract & { signingUrl: string }>(`/v1/contracts/${id}/send`, {
        emailIt: false,
      })
      .then((r) => r.data.signingUrl),

  /**
   * Remove a contract from the list. Soft server-side — the signed record and
   * its audit trail survive; the signing link stops working.
   */
  remove: (id: string) =>
    apiClient.delete(`/v1/contracts/${id}`).then((r) => r.data),

  void: (id: string, reason?: string) =>
    apiClient
      .post<Contract>(`/v1/contracts/${id}/void`, { reason })
      .then((r) => r.data),

  /**
   * Fetched as a blob through apiClient rather than opening the URL in a new
   * tab, because the route needs the Authorization header — a bare link would
   * arrive unauthenticated and 401.
   */
  downloadPdf: async (id: string, filename: string) => {
    const res = await apiClient.get(`/v1/contracts/${id}/pdf`, {
      responseType: "blob",
    });
    const url = URL.createObjectURL(res.data as Blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
};
