import { apiClient } from "./client";

// Table reservations — the staff diary (JWT) and the guest booking form.
//
// Two doors, mirroring the API: `reservationsClient` is tenant-scoped and
// goes through the authed axios instance; `publicReservationsClient` uses
// bare fetch (same as the signage board) so a guest with no token never
// touches the 401-refresh/redirect interceptor.

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export type ReservationStatus =
  | "PENDING"
  | "CONFIRMED"
  | "SEATED"
  | "COMPLETED"
  | "CANCELLED"
  | "NO_SHOW";

export type ReservationSource = "ONLINE" | "STAFF" | "PHONE";

export interface Reservation {
  id: string;
  tenantId: string;
  locationId: string;
  tableId: string | null;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  partySize: number;
  /** ISO string. */
  startsAt: string;
  durationMins: number;
  status: ReservationStatus;
  source: ReservationSource;
  notes: string | null;
  orderId: string | null;
  seatedAt: string | null;
  cancelledAt: string | null;
  /** Guest-facing booking reference, e.g. "R-7QK4M2". */
  reference: string;
  createdAt: string;
  updatedAt: string;
  table: { id: string; name: string; area: string | null } | null;
}

export interface CreateReservationInput {
  locationId: string;
  tableId?: string | null;
  customerName: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
  partySize: number;
  /** ISO string — build it from a LOCAL Date so the wall-clock time survives. */
  startsAt: string;
  durationMins?: number;
  notes?: string | null;
  source?: ReservationSource;
}

export interface AvailableTable {
  id: string;
  name: string;
  seats: number | null;
  area: string | null;
}

export interface AvailabilityResult {
  startsAt: string;
  endsAt: string;
  partySize: number;
  available: AvailableTable[];
  /** Tables already spoken for in this slot (assigned + unassigned holds). */
  takenCount: number;
  /** How many tables were big enough to consider at all. */
  totalConsidered: number;
}

export interface ReservationSettings {
  locationId: string;
  locationName: string;
  tableServiceEnabled: boolean;
  onlineEnabled: boolean;
  maxPartySize: number;
  slotMinutes: number;
  leadTimeMins: number;
  maxDaysAhead: number;
}

/** The sub-object written back to Location.settings.tableService.reservations. */
export interface ReservationSettingsInput {
  onlineEnabled: boolean;
  maxPartySize: number;
  slotMinutes: number;
  leadTimeMins: number;
  maxDaysAhead: number;
}

export interface PublicAvailability {
  startsAt: string;
  partySize: number;
  available: boolean;
  seatsLeft: number;
}

export interface PublicReservation {
  reference: string;
  customerName: string;
  partySize: number;
  startsAt: string;
  durationMins: number;
  status: ReservationStatus;
}

export const reservationsClient = {
  /** Bookings in [from, to). Both are ISO strings; omit for "today". */
  list: (params: {
    locationId?: string;
    from?: string;
    to?: string;
    status?: ReservationStatus;
  }) =>
    apiClient
      .get<Reservation[]>(`/v1/reservations`, { params })
      .then((r) => r.data),

  availability: (params: {
    locationId: string;
    startsAt: string;
    partySize: number;
    durationMins?: number;
    ignoreReservationId?: string;
  }) =>
    apiClient
      .get<AvailabilityResult>(`/v1/reservations/availability`, { params })
      .then((r) => r.data),

  create: (input: CreateReservationInput) =>
    apiClient.post<Reservation>(`/v1/reservations`, input).then((r) => r.data),

  update: (
    id: string,
    input: Partial<CreateReservationInput> & { status?: ReservationStatus },
  ) =>
    apiClient
      .patch<Reservation>(`/v1/reservations/${id}`, input)
      .then((r) => r.data),

  setStatus: (id: string, status: ReservationStatus) =>
    apiClient
      .post<Reservation>(`/v1/reservations/${id}/status`, { status })
      .then((r) => r.data),

  /** The party arrived: seats them, opens the table's tab, fills covers. */
  seat: (id: string, tableId?: string) =>
    apiClient
      .post<Reservation>(`/v1/reservations/${id}/seat`, tableId ? { tableId } : {})
      .then((r) => r.data),

  remove: (id: string) =>
    apiClient.delete<{ ok: true }>(`/v1/reservations/${id}`).then((r) => r.data),
};

// ── Guest-facing (no auth) ──────────────────────────────────────────────

/**
 * The API's 400s on this path are already written for guests ("We're fully
 * booked at that time…"), so surface the server message verbatim rather
 * than a generic failure string.
 */
async function publicFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = Array.isArray(body?.message)
      ? body.message.join(", ")
      : body?.message;
    throw new Error(message || "Something went wrong — please try again.");
  }
  return body as T;
}

export const publicReservationsClient = {
  settings: (locationId: string) =>
    publicFetch<ReservationSettings>(
      `/v1/reservations/public/settings?locationId=${encodeURIComponent(locationId)}`,
    ),

  availability: (params: {
    locationId: string;
    startsAt: string;
    partySize: number;
  }) =>
    publicFetch<PublicAvailability>(
      `/v1/reservations/public/availability?locationId=${encodeURIComponent(
        params.locationId,
      )}&startsAt=${encodeURIComponent(params.startsAt)}&partySize=${params.partySize}`,
    ),

  create: (input: CreateReservationInput) =>
    publicFetch<PublicReservation>(`/v1/reservations/public`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
};

// ── Local-time helpers ──────────────────────────────────────────────────
//
// The API speaks ISO/UTC but every human on both sides of this feature
// thinks in the restaurant's wall clock, so all conversions go through a
// LOCAL Date. Doing it any other way silently shifts bookings by the UTC
// offset in British Summer Time.

/** "2026-07-28" for a Date, in local time (not toISOString's UTC date). */
export function toDateInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "19:30" for a Date, in local time. */
export function toTimeInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** ("2026-07-28", "19:30") → ISO string for that local moment. */
export function toIsoFromLocal(date: string, time: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0, 0, 0).toISOString();
}

/** Local midnight of a "YYYY-MM-DD" day, as an ISO string. */
export function startOfDayIso(date: string): string {
  return toIsoFromLocal(date, "00:00");
}

/** Local midnight of the NEXT day — the exclusive end of a day range. */
export function endOfDayIso(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1, 0, 0, 0, 0).toISOString();
}

export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return toDateInput(new Date(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days));
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatLongDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export const RESERVATION_STATUS_LABELS: Record<ReservationStatus, string> = {
  PENDING: "Pending",
  CONFIRMED: "Confirmed",
  SEATED: "Seated",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  NO_SHOW: "No-show",
};
