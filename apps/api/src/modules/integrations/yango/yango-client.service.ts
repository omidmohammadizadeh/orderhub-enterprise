// Phase BK — low-level Yango Delivery client (B2B "express claims" API).
//
// Yango Delivery is the international brand of Yandex Delivery, and there is no
// Yango-branded API: every call — UAE included — goes to b2b.taxi.yandex.net
// under /b2b/cargo/integration/v2/. None of b2b.yango.com, b2b-platform.yango.com
// or b2b.taxi.yango.com resolve. The contract is Yandex's EN express docs
// (yandex.com/support/delivery-profile/en/api/express/), which is also what the
// only public Yango client (A1-x-Tech/mcp-yango-delivery) is built from.
//
// Auth is a STATIC bearer token copied from the business cabinet's Integration
// tab — no OAuth exchange, no refresh. It never expires on its own, but changing
// the cabinet password kills it, so a sudden 401 means "re-paste the token".
//
// There is NO sandbox for express claims. `claims/accept` sends a real courier
// and bills the shop. Nothing in this file accepts anything on its own; the
// dispatch service decides, and only in live mode.
//
// Traps this file exists to get right:
//   • Coordinates are [LONGITUDE, LATITUDE] — the docs say "exactly in that
//     order". We keep lat/lng everywhere else in OrderHub and flip here, once.
//   • claim_id goes in the QUERY for almost everything, but in the BODY for
//     claims/confirmation_code and driver-voiceforwarding.
//   • performer-position and tracking-links are GET; everything else is POST.
//   • The create body spells the item's drop-off reference `droppof_point`
//     (sic). check-price spells it `dropoff_point`. Both are real.
//   • check-price route points use `id` + flat `coordinates`/`fullname`;
//     create uses `point_id` + an `address` object.
//   • Estimation failures can come back INSIDE A 200 as `error_messages`.

import { Injectable, Logger } from "@nestjs/common";

export const YANGO_DEFAULT_BASE = "https://b2b.taxi.yandex.net";
const PREFIX = "/b2b/cargo/integration/v2";

export interface YangoCreds {
  token: string;
}

export interface YangoLatLng {
  lat: number;
  lng: number;
}

/** OrderHub keeps {lat, lng}; Yango wants [lon, lat]. The only place we flip. */
export function toYangoCoords(p: YangoLatLng): [number, number] {
  return [p.lng, p.lat];
}

export interface YangoCheckPriceBody {
  items: Array<{
    quantity: number;
    weight?: number;
    size?: { length: number; width: number; height: number };
    pickup_point: number;
    /** check-price spelling. The create body uses `droppof_point`. */
    dropoff_point: number;
  }>;
  route_points: Array<{ id: number; coordinates: [number, number]; fullname: string }>;
  requirements?: { taxi_class?: string; cargo_options?: string[] };
  skip_door_to_door?: boolean;
}

export interface YangoCheckPriceResponse {
  /** Decimal STRING, e.g. "12.5000". */
  price: string;
  currency_rules?: { code?: string; text?: string; sign?: string; template?: string };
  distance_meters?: number;
  /** Minutes. */
  eta?: number;
  zone_id?: string;
}

export interface YangoContact {
  name: string;
  phone: string;
  email?: string;
}

export interface YangoCreatePoint {
  point_id: number;
  visit_order: number;
  type: "source" | "destination" | "return";
  contact: YangoContact;
  address: {
    fullname: string;
    coordinates: [number, number];
    comment?: string;
    sflat?: string;
    city?: string;
    country?: string;
  };
  skip_confirmation?: boolean;
  external_order_id?: string;
  external_order_cost?: { value: string; currency: string; currency_sign?: string };
}

export interface YangoCreateBody {
  items: Array<{
    title: string;
    quantity: number;
    cost_value: string;
    cost_currency: string;
    pickup_point: number;
    /** Sic — this is how the create endpoint spells it. */
    droppof_point: number;
    weight?: number;
    size?: { length: number; width: number; height: number };
    extra_id?: string;
  }>;
  route_points: YangoCreatePoint[];
  client_requirements?: { taxi_class?: string; cargo_options?: string[] };
  callback_properties?: { callback_url: string };
  skip_client_notify?: boolean;
  comment?: string;
  emergency_contact?: { name: string; phone: string };
  referral_source?: string;
}

export interface YangoClaim {
  id: string;
  status: string;
  version: number;
  updated_ts?: string;
  created_ts?: string;
  route_points?: Array<{
    id: number;
    point_id?: number;
    type?: string;
    visit_order?: number;
    visit_status?: string;
    visited_at?: { expected?: string; actual?: string };
  }>;
  pricing?: {
    offer?: { offer_id?: string; price?: string; price_with_vat?: string; valid_until?: string };
    currency?: string;
    currency_rules?: { code?: string };
    final_price?: string;
  };
  performer_info?: {
    courier_name?: string;
    car_model?: string;
    car_number?: string;
    transport_type?: string;
  };
  error_messages?: Array<{ code?: string; message?: string }>;
  warnings?: Array<{ code?: string; message?: string; source?: string }>;
  eta?: number;
  current_point_id?: number;
}

export interface YangoCancelInfo {
  cancel_state: "free" | "paid" | "unavailable" | string;
  price?: string;
  price_with_vat?: string;
  currency?: string;
}

/** A Yango error with its machine `code` kept, because the caller branches on
 *  it (old_version, free_cancel_is_unavailable, inappropriate_status…). */
export class YangoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly body: unknown,
  ) {
    super(message);
  }
}

type Method = "GET" | "POST";

@Injectable()
export class YangoClientService {
  private readonly logger = new Logger(YangoClientService.name);

  /** Overridable for a future regional host, but there is only one today. */
  baseUrl(): string {
    return (process.env.YANGO_API_BASE || YANGO_DEFAULT_BASE).replace(/\/$/, "");
  }

  private userAgent(): string {
    return process.env.YANGO_USER_AGENT ?? "OrderHub/1.0 (+https://www.orderhubsolutions.com)";
  }

  private async request<T = any>(
    creds: YangoCreds,
    method: Method,
    path: string,
    opts: { query?: Record<string, string>; body?: unknown; retry429?: boolean } = {},
  ): Promise<T> {
    const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : "";
    const url = `${this.baseUrl()}${PREFIX}/${path}${qs}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${creds.token}`,
        // Marked required on most methods; harmless on the rest.
        "Accept-Language": "en",
        Accept: "application/json",
        "User-Agent": this.userAgent(),
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });

    // Yango publishes no quotas, just 429 too_many_requests. One short, bounded
    // retry — a dispatch button must not hang for 30s behind a Retry-After.
    if (res.status === 429 && opts.retry429 !== false) {
      const after = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 3000) : 750;
      await new Promise((r) => setTimeout(r, waitMs));
      return this.request<T>(creds, method, path, { ...opts, retry429: false });
    }

    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const code = typeof json?.code === "string" ? json.code : null;
      const msg =
        res.status === 401
          ? "Yango rejected the API token. Get a new one from your Yango business cabinet → Integration (changing the cabinet password invalidates the old one)."
          : json?.message || code || text.slice(0, 300);
      throw new YangoApiError(`Yango ${path} → ${res.status}: ${msg}`, res.status, code, json);
    }
    return json as T;
  }

  /** POST check-price — the international pre-quote. Free: creates no claim. */
  checkPrice(creds: YangoCreds, body: YangoCheckPriceBody): Promise<YangoCheckPriceResponse> {
    return this.request(creds, "POST", "check-price", { body });
  }

  /** POST tariffs — which classes Yango runs at a point. Used by the settings
   *  screen to prove the token AND that the shop is inside a Yango zone. */
  tariffs(creds: YangoCreds, at: YangoLatLng, fullname?: string): Promise<any> {
    return this.request(creds, "POST", "tariffs", {
      body: { start_point: toYangoCoords(at), ...(fullname ? { fullname } : {}) },
    });
  }

  /** POST claims/create?request_id= — creates a claim in status `new`. No
   *  courier moves until it is ACCEPTED. `requestId` is the idempotency key: a
   *  replay returns the original claim whatever the body says, so reuse it only
   *  to retry the same dispatch. */
  createClaim(creds: YangoCreds, requestId: string, body: YangoCreateBody): Promise<YangoClaim> {
    return this.request(creds, "POST", "claims/create", { query: { request_id: requestId }, body });
  }

  claimInfo(creds: YangoCreds, claimId: string): Promise<YangoClaim> {
    return this.request(creds, "POST", "claims/info", { query: { claim_id: claimId } });
  }

  /** POST claims/bulk_info — up to 1000 claims in one call. The poller's read. */
  async bulkInfo(creds: YangoCreds, claimIds: string[]): Promise<YangoClaim[]> {
    const out: YangoClaim[] = [];
    for (let i = 0; i < claimIds.length; i += 1000) {
      const json = await this.request<{ claims?: YangoClaim[] }>(creds, "POST", "claims/bulk_info", {
        body: { claim_ids: claimIds.slice(i, i + 1000) },
      });
      if (Array.isArray(json?.claims)) out.push(...json.claims);
    }
    return out;
  }

  /** POST claims/accept — THIS is the call that sends a real courier and costs
   *  money. `version` must be the claim's current one (409 old_version if not). */
  acceptClaim(creds: YangoCreds, claimId: string, version: number): Promise<YangoClaim> {
    return this.request(creds, "POST", "claims/accept", {
      query: { claim_id: claimId },
      body: { version },
    });
  }

  cancelInfo(creds: YangoCreds, claimId: string): Promise<YangoCancelInfo> {
    return this.request(creds, "POST", "claims/cancel-info", { query: { claim_id: claimId } });
  }

  /** `cancelState` must echo what cancel-info said; sending "free" once it has
   *  become "paid" is refused with free_cancel_is_unavailable. */
  cancelClaim(
    creds: YangoCreds,
    claimId: string,
    version: number,
    cancelState: string,
  ): Promise<YangoClaim> {
    return this.request(creds, "POST", "claims/cancel", {
      query: { claim_id: claimId },
      body: { version, cancel_state: cancelState },
    });
  }

  /** GET — named lat/lon fields, unix timestamp. 409 before a courier exists. */
  performerPosition(creds: YangoCreds, claimId: string): Promise<any> {
    return this.request(creds, "GET", "claims/performer-position", { query: { claim_id: claimId } });
  }

  /** GET — `sharing_link` on the destination point is safe to give a customer. */
  trackingLinks(creds: YangoCreds, claimId: string): Promise<any> {
    return this.request(creds, "GET", "claims/tracking-links", { query: { claim_id: claimId } });
  }

  /** POST driver-voiceforwarding — claim_id in the BODY, and point_id is
   *  Yango's server-side route point id, not the one we sent on create. */
  courierPhone(creds: YangoCreds, claimId: string, serverPointId: number): Promise<any> {
    return this.request(creds, "POST", "driver-voiceforwarding", {
      body: { claim_id: claimId, point_id: serverPointId },
    });
  }
}
