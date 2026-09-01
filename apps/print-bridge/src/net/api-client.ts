// Thin HTTP client over the OrderHub API. No fancy SDK — just fetch
// with bearer headers and a small retry helper.

import type { Config } from "../config/config";

export interface PrintJob {
  id: string;
  type: string;
  printerId: string | null;
  stationId: string | null;
  status: string;
  payload: any;
  copies: number;
  attempts: number;
}

export class ApiClient {
  constructor(private readonly cfg: Config) {}

  private get headers() {
    return {
      "Content-Type": "application/json",
      "X-Agent-Id": this.cfg.agentId ?? "",
      "X-Agent-Token": this.cfg.apiToken ?? "",
    };
  }

  async pair(body: any) {
    const res = await fetch(`${this.cfg.apiUrl}/print-agents/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`pair failed: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<{
      id: string;
      apiToken: string;
      locationId: string;
    }>;
  }

  async heartbeat(body: any) {
    const res = await fetch(
      `${this.cfg.apiUrl}/print-agents/${this.cfg.agentId}/heartbeat`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
      },
    );
    return res.ok;
  }

  async claim(printerIds: string[], limit = 5): Promise<PrintJob[]> {
    const res = await fetch(`${this.cfg.apiUrl}/print-jobs/claim`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ printerIds, limit }),
    });
    if (!res.ok) return [];
    return (await res.json()) as PrintJob[];
  }

  async start(jobId: string) {
    return fetch(`${this.cfg.apiUrl}/print-jobs/${jobId}/start`, {
      method: "POST",
      headers: this.headers,
    });
  }

  async complete(jobId: string) {
    return fetch(`${this.cfg.apiUrl}/print-jobs/${jobId}/complete`, {
      method: "POST",
      headers: this.headers,
    });
  }

  async listLocationPrinters(): Promise<
    Array<{
      id: string;
      name: string;
      type: string;
      connectionType: string;
      ipAddress: string | null;
      port: number | null;
      agentId: string | null;
      paperWidth: number;
      model: string | null;
      usbVendor: number | null;
      usbProduct: number | null;
    }>
  > {
    const res = await fetch(
      `${this.cfg.apiUrl}/print-agents/${this.cfg.agentId}/printers`,
      { headers: this.headers },
    );
    if (!res.ok) {
      throw new Error(`listPrinters failed: ${res.status} ${await res.text()}`);
    }
    return res.json() as any;
  }

  async bindPrinter(printerId: string) {
    const res = await fetch(
      `${this.cfg.apiUrl}/print-agents/${this.cfg.agentId}/bind`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ printerId }),
      },
    );
    if (!res.ok) {
      throw new Error(`bind failed: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<{ ok: true; printerId: string; agentId: string }>;
  }

  async fail(
    jobId: string,
    body: { failureReason: string; lastError: string; retryable: boolean },
  ) {
    return fetch(`${this.cfg.apiUrl}/print-jobs/${jobId}/fail`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });
  }
}
