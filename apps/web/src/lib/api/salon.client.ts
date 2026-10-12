import { apiClient } from "./client";

// Barbers, hair and nail salons — the staff side (JWT, through the authed
// axios instance) and the guest side (bare fetch, so a guest with no token
// never meets the 401-refresh/redirect interceptor).

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export type SalonTrade = "BARBER" | "HAIR" | "NAILS" | "BEAUTY";

export interface SalonSettings {
  trade: SalonTrade;
  onlineBookingEnabled: boolean;
  slotStepMins: number;
  leadTimeMins: number;
  maxDaysAhead: number;
  cancellationWindowHours: number;
  allowGuestChanges: boolean;
  forfeitDepositOnNoShow: boolean;
  reminderEnabled: boolean;
  reminderHoursBefore: number;
  reminderSms: boolean;
  rebookAfterDays: number;
  queueEnabled: boolean;
  queueOnlineJoin: boolean;
  queueCallSms: boolean;
  bookingPolicy: string;
  offerAnyStaff: boolean;
}

export type WeeklyHours = Partial<Record<string, Array<{ from: string; to: string }>>>;

export interface SalonSettingsResponse {
  locationId: string;
  locationName: string;
  timezone: string;
  currency: string;
  businessType: string;
  isSalon: boolean;
  configured: boolean;
  shopHours: WeeklyHours;
  settings: SalonSettings;
}

export interface SalonAddon {
  id: string;
  name: string;
  price: number;
  durationMins: number;
}

export type DepositType = "NONE" | "FIXED" | "PERCENT" | "FULL";

export interface SalonService {
  id: string;
  locationId: string;
  category: string;
  name: string;
  description: string | null;
  price: number;
  priceFrom: boolean;
  durationMins: number;
  bufferMins: number;
  processingStartMins: number | null;
  processingMins: number | null;
  depositType: DepositType;
  depositValue: number | null;
  requiresPatchTest: boolean;
  bookableOnline: boolean;
  isActive: boolean;
  sortOrder: number;
  imageUrl: string | null;
  addons: SalonAddon[];
}

export interface SalonStaff {
  id: string;
  locationId: string;
  userId: string | null;
  name: string;
  title: string | null;
  bio: string | null;
  avatarUrl: string | null;
  colour: string;
  bookableOnline: boolean;
  acceptsWalkIns: boolean;
  isActive: boolean;
  sortOrder: number;
  weeklyHours: WeeklyHours;
  serviceIds: string[];
  priceOverrides: Record<string, number>;
  commissionPercent: number | null;
}

export interface SalonTimeOff {
  id: string;
  staffId: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
  staff: { id: string; name: string; colour: string };
}

export type AppointmentStatus =
  | "PENDING_PAYMENT"
  | "CONFIRMED"
  | "CHECKED_IN"
  | "IN_SERVICE"
  | "COMPLETED"
  | "CANCELLED"
  | "NO_SHOW";

export type AppointmentSource = "ONLINE" | "STAFF" | "PHONE" | "WALK_IN" | "WHATSAPP" | "VOICE";

export interface AppointmentLine {
  serviceId: string;
  name: string;
  price: number;
  durationMins: number;
  bufferMins: number;
  processingStartMins: number | null;
  processingMins: number | null;
  addons: SalonAddon[];
  priceFrom?: boolean;
  requiresPatchTest?: boolean;
}

export interface Appointment {
  id: string;
  locationId: string;
  staffId: string | null;
  staff: { id: string; name: string; colour: string; commissionPercent?: number | null } | null;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  anyStaff: boolean;
  services: AppointmentLine[];
  summary: string;
  totalPrice: number;
  notes: string | null;
  staffNotes: string | null;
  reference: string;
  manageToken: string;
  depositAmount: number;
  depositStatus: string;
  depositOrderId: string | null;
  orderId: string | null;
  tipAmount: number | null;
  checkedInAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  queueEntryId: string | null;
  createdAt: string;
}

export interface ClientHistory {
  visits: number;
  noShows: number;
  spent: number;
  last: { startsAt: string; staffName: string | null; summary: string } | null;
  recent: Array<{ id: string; startsAt: string; status: AppointmentStatus; staffName: string | null; summary: string; totalPrice: number }>;
}

export interface AppointmentDetail extends Appointment {
  history: ClientHistory;
  order: { id: string; orderNumber: number | null; total: number; paymentStatus: string; paymentMethod: string | null; status: string } | null;
}

export interface WantedService {
  serviceId: string;
  addonIds?: string[];
}

export interface Availability {
  date: string;
  timezone: string;
  durationMins: number;
  total: number;
  deposit: number;
  slots: Array<{ startsAt: string; staffIds: string[] }>;
}

export interface CheckoutPreview {
  lines: Array<{ name: string; unitPrice: number; quantity: number; notes?: string }>;
  subtotal: number;
  deposit: number;
  dueBeforeTip: number;
  existingOrder: { id: string; total: number; paymentStatus: string; paymentMethod: string | null; status: string; orderNumber: number | null } | null;
}

export type PayMethod = "CASH" | "CARD_TERMINAL" | "PAYMENT_LINK" | "EXTERNAL";

export interface CheckoutBody {
  paymentMethod: PayMethod;
  tipAmount?: number;
  discount?: number;
  prices?: Array<{ index: number; price: number }>;
  extras?: Array<{ name: string; price: number; quantity?: number }>;
  /** Walk-in loyalty card scanned at checkout: the visit earns a stamp. */
  loyaltyMemberId?: string;
  /** A reward on that card being spent on this visit. */
  loyaltyRewardId?: string;
}

export interface CheckoutResult {
  orderId: string;
  orderNumber: number | null;
  amount: number;
  paymentMethod: PayMethod;
  paid: boolean;
  appointmentId?: string;
}

export interface QueueEntry {
  id: string;
  customerName: string;
  customerPhone: string | null;
  serviceSummary: string | null;
  serviceIds: string[];
  estimatedMins: number;
  preferredStaffId: string | null;
  preferredStaffName: string | null;
  staffId: string | null;
  staffName: string | null;
  status: "WAITING" | "CALLED" | "IN_SERVICE" | "DONE" | "LEFT";
  source: "STAFF" | "ONLINE" | "KIOSK";
  appointmentId: string | null;
  createdAt: string;
  calledAt: string | null;
  position: number | null;
  waitMins: number | null;
  likelyStaffId: string | null;
  likelyStaffName: string | null;
  publicToken: string;
}

export interface QueueBoard {
  nextWaitMins: number | null;
  /** Someone is working right now. */
  openNow: boolean;
  /** When the first chair opens, if nobody is working yet. */
  opensAt: string | null;
  locationId: string;
  locationName: string;
  timezone: string;
  queueEnabled: boolean;
  onlineJoin: boolean;
  barbersOn: Array<{ id: string; name: string; colour: string }>;
  entries: QueueEntry[];
}

export interface SalonReport {
  from: string;
  to: string;
  currency: string;
  trade: SalonTrade;
  totals: {
    appointments: number;
    completed: number;
    takings: number;
    tips: number;
    commission: number;
    noShows: number;
    cancelled: number;
    depositsHeld: number;
    depositsKept: number;
    clients: number;
    newClients: number;
    onlineShare: number;
  };
  staff: Array<{
    staffId: string;
    name: string;
    colour: string;
    appointments: number;
    completed: number;
    walkIns: number;
    noShows: number;
    cancelled: number;
    takings: number;
    tips: number;
    commissionPercent: number | null;
    commission: number;
    averageTicket: number;
    bookedMins: number;
    availableMins: number;
    utilisation: number;
    requested: number;
  }>;
  services: Array<{ name: string; count: number; takings: number }>;
  bySource: Record<string, number>;
  byDay: Array<{ date: string; appointments: number; takings: number }>;
}

/** ?services=svc1:addonA,addonB;svc2 */
export function servicesParam(list: WantedService[]): string {
  return list.map((s) => (s.addonIds?.length ? `${s.serviceId}:${s.addonIds.join(",")}` : s.serviceId)).join(";");
}

export const salonClient = {
  settings: async (locationId: string) =>
    (await apiClient.get<SalonSettingsResponse>("/v1/salon/settings", { params: { locationId } })).data,
  saveSettings: async (locationId: string, patch: Partial<SalonSettings>) =>
    (await apiClient.put<SalonSettingsResponse>("/v1/salon/settings", patch, { params: { locationId } })).data,
  enable: async (body: { locationId: string; trade: SalonTrade; starterServices?: boolean; firstStaffName?: string }) =>
    (await apiClient.post<SalonSettingsResponse>("/v1/salon/enable", body)).data,

  services: async (locationId: string) =>
    (await apiClient.get<SalonService[]>("/v1/salon/services", { params: { locationId } })).data,
  createService: async (locationId: string, body: Partial<SalonService>) =>
    (await apiClient.post<SalonService>("/v1/salon/services", body, { params: { locationId } })).data,
  updateService: async (id: string, body: Partial<SalonService>) =>
    (await apiClient.patch<SalonService>(`/v1/salon/services/${id}`, body)).data,
  deleteService: async (id: string) => (await apiClient.delete(`/v1/salon/services/${id}`)).data,
  reorderServices: async (locationId: string, ids: string[]) =>
    (await apiClient.put<SalonService[]>("/v1/salon/services/order", { ids }, { params: { locationId } })).data,

  staff: async (locationId: string, archived = false) =>
    (await apiClient.get<SalonStaff[]>("/v1/salon/staff", { params: { locationId, ...(archived ? { archived: "1" } : {}) } }))
      .data,
  createStaff: async (locationId: string, body: Partial<SalonStaff>) =>
    (await apiClient.post<SalonStaff>("/v1/salon/staff", body, { params: { locationId } })).data,
  updateStaff: async (id: string, body: Partial<SalonStaff>) =>
    (await apiClient.patch<SalonStaff>(`/v1/salon/staff/${id}`, body)).data,
  archiveStaff: async (id: string) => (await apiClient.delete(`/v1/salon/staff/${id}`)).data,

  timeOff: async (locationId: string, from?: string, to?: string) =>
    (await apiClient.get<SalonTimeOff[]>("/v1/salon/time-off", { params: { locationId, from, to } })).data,
  addTimeOff: async (body: { staffId: string; startsAt: string; endsAt: string; reason?: string; force?: boolean }) =>
    (await apiClient.post("/v1/salon/time-off", body)).data,
  removeTimeOff: async (id: string) => (await apiClient.delete(`/v1/salon/time-off/${id}`)).data,

  appointments: async (q: { locationId: string; from: string; to: string; staffId?: string }) =>
    (await apiClient.get<Appointment[]>("/v1/salon/appointments", { params: q })).data,
  appointment: async (id: string) => (await apiClient.get<AppointmentDetail>(`/v1/salon/appointments/${id}`)).data,
  availability: async (q: { locationId: string; date: string; services: WantedService[]; staffId?: string; ignore?: string }) =>
    (
      await apiClient.get<Availability>("/v1/salon/availability", {
        params: { locationId: q.locationId, date: q.date, services: servicesParam(q.services), staffId: q.staffId, ignore: q.ignore },
      })
    ).data,
  clients: async (locationId: string, q: string) =>
    (
      await apiClient.get<Array<{ name: string; phone: string | null; email: string | null; lastVisit: string }>>(
        "/v1/salon/clients",
        { params: { locationId, q } },
      )
    ).data,
  book: async (body: {
    locationId: string;
    staffId: string;
    startsAt: string;
    services: WantedService[];
    customerName: string;
    customerPhone?: string | null;
    customerEmail?: string | null;
    notes?: string | null;
    staffNotes?: string | null;
    source?: AppointmentSource;
    force?: boolean;
    silent?: boolean;
  }) => (await apiClient.post<Appointment>("/v1/salon/appointments", body)).data,
  update: async (id: string, body: Record<string, unknown>) =>
    (await apiClient.patch<AppointmentDetail>(`/v1/salon/appointments/${id}`, body)).data,
  setStatus: async (id: string, body: { status: AppointmentStatus; reason?: string; refundDeposit?: boolean; notifyGuest?: boolean }) =>
    (await apiClient.post<AppointmentDetail>(`/v1/salon/appointments/${id}/status`, body)).data,
  resend: async (id: string) => (await apiClient.post<{ sent: boolean }>(`/v1/salon/appointments/${id}/resend`)).data,
  checkoutPreview: async (id: string) =>
    (await apiClient.get<CheckoutPreview>(`/v1/salon/appointments/${id}/checkout`)).data,
  checkout: async (id: string, body: CheckoutBody) =>
    (await apiClient.post<CheckoutResult>(`/v1/salon/appointments/${id}/checkout`, body)).data,
  sync: async (id: string) => (await apiClient.post<AppointmentDetail>(`/v1/salon/appointments/${id}/sync`)).data,
  quickSale: async (body: CheckoutBody & { locationId: string; staffId: string; services: WantedService[]; customerName?: string; customerPhone?: string }) =>
    (await apiClient.post<CheckoutResult>("/v1/salon/quick-sale", body)).data,

  queue: async (locationId: string) => (await apiClient.get<QueueBoard>("/v1/salon/queue", { params: { locationId } })).data,
  queueJoin: async (body: { locationId: string; customerName: string; customerPhone?: string; serviceIds?: string[]; preferredStaffId?: string }) =>
    (await apiClient.post<QueueBoard>("/v1/salon/queue", body)).data,
  queueCall: async (id: string, staffId?: string) =>
    (await apiClient.post<QueueBoard>(`/v1/salon/queue/${id}/call`, { staffId })).data,
  queueStart: async (id: string, body: { staffId: string; serviceIds?: string[]; services?: WantedService[] }) =>
    (await apiClient.post<{ appointmentId: string; board: QueueBoard }>(`/v1/salon/queue/${id}/start`, body)).data,
  queueRequeue: async (id: string) => (await apiClient.post<QueueBoard>(`/v1/salon/queue/${id}/requeue`)).data,
  queueDone: async (id: string) => (await apiClient.post<QueueBoard>(`/v1/salon/queue/${id}/done`)).data,
  queueLeft: async (id: string) => (await apiClient.post<QueueBoard>(`/v1/salon/queue/${id}/left`)).data,

  report: async (q: { locationId: string; from: string; to: string }) =>
    (await apiClient.get<SalonReport>("/v1/salon/reports", { params: q })).data,
};

// ── Guest side ────────────────────────────────────────────────────────────

export interface PublicShop {
  locationId: string;
  name: string;
  phone: string | null;
  timezone: string;
  currency: string;
  logoUrl: string | null;
  address: string | null;
  onlineBookingEnabled: boolean;
  queueOnlineJoin: boolean;
  trade: SalonTrade;
  bookingPolicy: string;
  cancellationWindowHours: number;
  offerAnyStaff: boolean;
  leadTimeMins: number;
  maxDaysAhead: number;
  services: Array<{
    id: string;
    category: string;
    name: string;
    description: string | null;
    price: number;
    priceFrom: boolean;
    durationMins: number;
    imageUrl: string | null;
    requiresPatchTest: boolean;
    depositType: DepositType;
    depositValue: number | null;
    addons: SalonAddon[];
  }>;
  staff: Array<{
    id: string;
    name: string;
    title: string | null;
    bio: string | null;
    avatarUrl: string | null;
    serviceIds: string[];
    priceOverrides: Record<string, number>;
  }>;
}

export interface PublicBooking {
  reference: string;
  token: string;
  status: AppointmentStatus;
  startsAt: string;
  endsAt: string;
  staff: { id: string; name: string; avatarUrl: string | null } | null;
  services: Array<{ name: string; price: number; priceFrom: boolean; durationMins: number; addons: string[] }>;
  summary: string;
  totalPrice: number;
  depositAmount: number;
  depositStatus: string;
  customerName: string;
  notes: string | null;
  patchTest: boolean;
  canChange: boolean;
  freeChange: boolean;
  cancellationWindowHours: number;
  shop: {
    locationId: string;
    name: string;
    phone: string | null;
    timezone: string;
    currency: string;
    logoUrl: string | null;
    address: string | null;
    trade: SalonTrade;
  };
}

export interface PublicQueueBoard {
  locationName: string;
  queueEnabled: boolean;
  onlineJoin: boolean;
  barbersOn: Array<{ name: string; colour: string }>;
  nowServing: Array<{ name: string; staffName: string | null; status: string }>;
  waiting: Array<{ position: number | null; name: string; waitMins: number | null; staffName: string | null }>;
  nextWaitMins: number | null;
  openNow: boolean;
  opensAt: string | null;
  timezone: string;
}

export interface QueueTicket {
  status: QueueEntry["status"];
  customerName: string;
  serviceSummary: string | null;
  position: number | null;
  waitMins: number | null;
  staffName: string | null;
  locationId: string;
  locationName: string;
  ahead: number;
  openNow: boolean;
  opensAt: string | null;
  timezone: string;
}

export class PublicApiError extends Error {}

async function pub<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/v1/salon/public${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const m = data?.message;
    throw new PublicApiError(
      (Array.isArray(m) ? m.join(", ") : m) ||
        (res.status === 429 ? "Too many tries — wait a minute and try again" : "Something went wrong — please try again"),
    );
  }
  return data as T;
}

export const publicSalonClient = {
  shop: (locationId: string) => pub<PublicShop>(`/shop/${encodeURIComponent(locationId)}`),
  days: (locationId: string, q: { from: string; days: number; services: WantedService[]; staffId?: string }) =>
    pub<{ days: Array<{ date: string; slots: number }> }>(
      `/shop/${encodeURIComponent(locationId)}/days?from=${q.from}&days=${q.days}&services=${encodeURIComponent(servicesParam(q.services))}${q.staffId ? `&staffId=${encodeURIComponent(q.staffId)}` : ""}`,
    ),
  slots: (locationId: string, q: { date: string; services: WantedService[]; staffId?: string }) =>
    pub<Availability>(
      `/shop/${encodeURIComponent(locationId)}/slots?date=${q.date}&services=${encodeURIComponent(servicesParam(q.services))}${q.staffId ? `&staffId=${encodeURIComponent(q.staffId)}` : ""}`,
    ),
  book: (
    locationId: string,
    body: {
      staffId: string;
      startsAt: string;
      services: WantedService[];
      customerName: string;
      customerPhone: string;
      customerEmail: string;
      notes?: string;
    },
  ) =>
    pub<{ appointment: PublicBooking; checkoutUrl: string | null }>(`/shop/${encodeURIComponent(locationId)}/book`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  booking: (token: string) => pub<PublicBooking>(`/booking/${encodeURIComponent(token)}`),
  cancel: (token: string) => pub<PublicBooking>(`/booking/${encodeURIComponent(token)}/cancel`, { method: "POST" }),
  rescheduleSlots: (token: string, date: string) =>
    pub<Availability>(`/booking/${encodeURIComponent(token)}/slots?date=${date}`),
  reschedule: (token: string, startsAt: string) =>
    pub<PublicBooking>(`/booking/${encodeURIComponent(token)}/reschedule`, {
      method: "POST",
      body: JSON.stringify({ startsAt }),
    }),
  pay: (token: string) => pub<{ url: string }>(`/booking/${encodeURIComponent(token)}/pay`, { method: "POST" }),
  queueBoard: (locationId: string) => pub<PublicQueueBoard>(`/queue/${encodeURIComponent(locationId)}`),
  queueJoin: (
    locationId: string,
    body: { customerName: string; customerPhone: string; serviceIds?: string[]; preferredStaffId?: string },
  ) =>
    pub<{ token: string; already: boolean }>(`/queue/${encodeURIComponent(locationId)}/join`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  ticket: (token: string) => pub<QueueTicket>(`/queue/ticket/${encodeURIComponent(token)}`),
  leave: (token: string) => pub<QueueTicket>(`/queue/ticket/${encodeURIComponent(token)}/leave`, { method: "POST" }),
};

// ── Shop-time helpers ─────────────────────────────────────────────────────
// Every time on these screens is the SHOP's wall clock, not the device's:
// a guest abroad booking their trim back home must see 10:00, not 11:00.

export function shopDate(iso: string | number | Date, tz: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: tz });
}

export function shopTime(iso: string | number | Date, tz: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
}

export function shopMinutes(iso: string | number | Date, tz: string): number {
  const [h = "0", m = "0"] = shopTime(iso, tz).split(":");
  return Number(h) * 60 + Number(m);
}

export function longDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + n));
  return t.toISOString().slice(0, 10);
}

export function todayIn(tz: string): string {
  return shopDate(Date.now(), tz);
}

/** "2026-10-14" + "10:15" in the shop's zone → ISO. */
export function shopIso(date: string, hhmm: string, tz: string): string {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  const offset = (ms: number) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
        .formatToParts(new Date(ms))
        .filter((x) => x.type !== "literal")
        .map((x) => [x.type, Number(x.value)]),
    ) as Record<string, number>;
    return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!) - Math.floor(ms / 60000) * 60000;
  };
  let ms = guess - offset(guess);
  ms = guess - offset(ms);
  return new Date(ms).toISOString();
}

export function minutesLabel(mins: number): string {
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

export const STATUS_LABEL: Record<AppointmentStatus, string> = {
  PENDING_PAYMENT: "Awaiting deposit",
  CONFIRMED: "Booked",
  CHECKED_IN: "Arrived",
  IN_SERVICE: "In the chair",
  COMPLETED: "Done",
  CANCELLED: "Cancelled",
  NO_SHOW: "No-show",
};

export const LIVE_APPOINTMENT: AppointmentStatus[] = ["PENDING_PAYMENT", "CONFIRMED", "CHECKED_IN", "IN_SERVICE"];

export function apiError(e: unknown, fallback: string): string {
  const m = (e as any)?.response?.data?.message ?? (e instanceof Error ? e.message : null);
  return (Array.isArray(m) ? m.join(", ") : m) || fallback;
}
