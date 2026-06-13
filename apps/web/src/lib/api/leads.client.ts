import { apiClient } from "./client";

export interface Lead {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  country: string | null;
  companyName: string | null;
  numberOfLocations: string | null;
  hearAboutUs: string | null;
  message: string | null;
  source: "NO_ACCESS_SCREEN" | "MARKETING_SITE" | "OTHER";
  status: "NEW" | "CONTACTED" | "QUALIFIED" | "WON" | "LOST";
  notes: string | null;
  createdAt: string;
  submittedBy: {
    email: string;
    firstName: string | null;
    lastName: string | null;
  } | null;
}

export interface CreateLeadBody {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  country?: string;
  companyName?: string;
  numberOfLocations?: string;
  hearAboutUs?: string;
  message?: string;
  source?: "NO_ACCESS_SCREEN" | "MARKETING_SITE" | "OTHER";
}

export const leadsClient = {
  submit: (body: CreateLeadBody) =>
    apiClient.post("/v1/leads", body).then((r) => r.data),
  list: (params?: { status?: string; q?: string }) =>
    apiClient
      .get<Lead[]>("/v1/leads", { params })
      .then((r) => r.data),
  update: (id: string, body: { status?: string; notes?: string }) =>
    apiClient.patch(`/v1/leads/${id}`, body).then((r) => r.data),
};

export const LEAD_STATUSES: { value: Lead["status"]; label: string; tone: string }[] = [
  { value: "NEW", label: "New", tone: "bg-blue-50 text-blue-700" },
  { value: "CONTACTED", label: "Contacted", tone: "bg-amber-50 text-amber-700" },
  { value: "QUALIFIED", label: "Qualified", tone: "bg-violet-50 text-violet-700" },
  { value: "WON", label: "Won", tone: "bg-emerald-50 text-emerald-700" },
  { value: "LOST", label: "Lost", tone: "bg-zinc-100 text-zinc-700" },
];
