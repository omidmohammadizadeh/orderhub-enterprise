import { Injectable } from "@nestjs/common";

// The last few calls Talabat's middleware made to our plugin, in memory, for
// the diagnostics page.
//
// The question it answers is the one only a live delivery can: did the JWT
// verify? An operator who just set TALABAT_PLUGIN_SECRET has no other way to
// know. Diagnostic only — capped, per-instance, lost on restart; the record of
// an order is the Order row, and of a dispatch the WebhookEvent row.

export interface TalabatPluginCall {
  at: string;
  endpoint: "order" | "status" | "availability" | "menuimport" | "catalog-callback";
  remoteId: string | null;
  ref: string | null;
  jwt: string;
  httpStatus: number;
  outcome: string;
  preview: string;
}

const MAX = 50;

@Injectable()
export class TalabatWebhookLogService {
  private readonly rows: TalabatPluginCall[] = [];

  record(row: TalabatPluginCall): void {
    this.rows.unshift(row);
    if (this.rows.length > MAX) this.rows.length = MAX;
  }

  recent(limit = MAX): TalabatPluginCall[] {
    return this.rows.slice(0, limit);
  }

  /** Has a correctly-signed call ever arrived on this instance? */
  get everVerified(): boolean {
    return this.rows.some((r) => r.jwt === "ok");
  }
}
