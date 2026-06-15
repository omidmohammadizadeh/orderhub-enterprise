// Main agent loop. Roughly:
//
//   * connect WebSocket; on printer:job:created, kick the drain loop
//   * every 5s, drain anyway (HTTP fallback)
//   * every 15s, send heartbeat
//   * every 2s, flush local outbox (queued completions/failures)
//
// Each PrintJob → choose transport from config → render → send →
// report outcome. Hard rule: a failed send NEVER drops the job
// locally; the outbox holds the report-back POST until network
// returns, and `printed_history` retains the last N payloads for
// offline reprint.

import * as os from "os";
import * as crypto from "crypto";
import type { Config, ConfiguredPrinter } from "./config/config";
import { saveConfig } from "./config/config";
import { ApiClient, type PrintJob } from "./net/api-client";
import { JobSocket } from "./net/socket";
import { Outbox } from "./queue/outbox";
import { renderToEscPosAsync } from "./renderer/escpos-renderer";
import { pickTransport } from "./transport";

const VERSION = "0.1.0";
const HEARTBEAT_MS = 15_000;
const POLL_MS = 5_000;
const OUTBOX_MS = 2_000;

export class Agent {
  private api: ApiClient;
  private socket: JobSocket;
  private outbox: Outbox;
  private printerById = new Map<string, ConfiguredPrinter>();
  private draining = false;

  constructor(private cfg: Config) {
    this.api = new ApiClient(cfg);
    this.socket = new JobSocket(cfg);
    this.outbox = new Outbox();
    for (const p of cfg.printers) this.printerById.set(p.printerId, p);
  }

  async run() {
    if (!this.cfg.agentId || !this.cfg.apiToken) {
      throw new Error("Agent not paired — run the pair flow first.");
    }
    console.log(
      `[agent] starting v${VERSION} as ${this.cfg.deviceName ?? "(unnamed)"} (${this.cfg.deviceId.slice(0, 8)})`,
    );

    this.socket.connect(() => this.drain());

    setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    setInterval(() => this.drain(), POLL_MS);
    setInterval(() => this.flushOutbox(), OUTBOX_MS);

    // Immediate first pass.
    await this.heartbeat();
    await this.drain();
  }

  // ── Heartbeat ──────────────────────────────────────────────────────

  private async heartbeat() {
    try {
      await this.api.heartbeat({
        versionString: VERSION,
        osType: `${os.type()} ${os.release()}`,
        hostname: os.hostname(),
        printerCount: this.cfg.printers.length,
        printerStatuses: this.cfg.printers.map((p) => ({
          printerId: p.printerId,
          // For LAN we don't probe here — server already does. The
          // agent's view comes from whether the last send succeeded.
          isOnline: true,
        })),
      });
    } catch (err: any) {
      console.warn(`[heartbeat] failed: ${err.message}`);
    }
  }

  // ── Drain (claim + print + report) ──────────────────────────────────

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      const printerIds = this.cfg.printers.map((p) => p.printerId);
      if (!printerIds.length) return;
      const jobs = await this.api.claim(printerIds, 5);
      for (const job of jobs) await this.handle(job);
    } finally {
      this.draining = false;
    }
  }

  private async handle(job: PrintJob) {
    const printer = job.printerId
      ? this.printerById.get(job.printerId)
      : undefined;
    if (!printer) {
      await this.fail(job, "bad_payload", "Printer not configured locally", false);
      return;
    }

    // Persist the payload to history BEFORE we attempt printing —
    // that way an offline reprint is possible even if the network
    // drops before we ack.
    this.outbox.rememberPrinted(job.id, job.payload);

    // renderToEscPosAsync awaits the brand logo fetch + raster, then
    // delegates to the sync renderer. After first print the logo bytes
    // are cached in-process so subsequent prints don't re-download.
    const buf = await renderToEscPosAsync(job.payload, {
      paperWidth: (printer.paperWidth ?? 80) as 58 | 80,
      openCashDrawer: !!job.payload?.openCashDrawer,
      printLogo: !!job.payload?.printLogo,
    });
    const transport = pickTransport(printer);

    try {
      await this.api.start(job.id);
      for (let copy = 0; copy < (job.copies || 1); copy++) {
        await transport.send(buf, printer);
      }
      await this.complete(job);
    } catch (err: any) {
      console.warn(`[print] ${job.id} failed: ${err.message}`);
      const tag = this.classify(err);
      await this.fail(job, tag, err?.message ?? String(err), true);
    }
  }

  private classify(err: any): string {
    const m = String(err?.message ?? err).toLowerCase();
    if (m.includes("econnrefused") || m.includes("timeout") || m.includes("ehostunreach"))
      return "printer_offline";
    if (m.includes("network")) return "network";
    if (m.includes("payload") || m.includes("undefined")) return "bad_payload";
    return "unknown";
  }

  // ── Outbox (queue reports for replay when network down) ────────────

  private async complete(job: PrintJob) {
    const res = await this.api.complete(job.id).catch(() => null);
    if (!res || !res.ok) {
      this.outbox.enqueue({
        id: crypto.randomUUID(),
        method: "POST",
        url: `${this.cfg.apiUrl}/print-jobs/${job.id}/complete`,
        body: "{}",
        idempotencyKey: `complete:${job.id}`,
        attempts: 0,
        nextTryAt: Date.now() + 1000,
      });
    }
  }

  private async fail(
    job: PrintJob,
    failureReason: string,
    lastError: string,
    retryable: boolean,
  ) {
    const body = { failureReason, lastError, retryable };
    const res = await this.api.fail(job.id, body).catch(() => null);
    if (!res || !res.ok) {
      this.outbox.enqueue({
        id: crypto.randomUUID(),
        method: "POST",
        url: `${this.cfg.apiUrl}/print-jobs/${job.id}/fail`,
        body: JSON.stringify(body),
        idempotencyKey: `fail:${job.id}`,
        attempts: 0,
        nextTryAt: Date.now() + 1000,
      });
    }
  }

  private async flushOutbox() {
    const ready = this.outbox.ready(Date.now());
    for (const op of ready) {
      try {
        const res = await fetch(op.url, {
          method: op.method,
          headers: {
            "Content-Type": "application/json",
            "X-Agent-Id": this.cfg.agentId ?? "",
            "X-Agent-Token": this.cfg.apiToken ?? "",
            "Idempotency-Key": op.idempotencyKey,
          },
          body: op.body,
        });
        if (res.ok || res.status === 409 || res.status === 410) {
          this.outbox.ack(op.id);
        } else {
          this.outbox.reschedule(
            op.id,
            Date.now() + Math.min(60_000, 1000 * (op.attempts + 1) ** 2),
            `${res.status} ${await res.text().catch(() => "")}`,
          );
        }
      } catch (err: any) {
        this.outbox.reschedule(
          op.id,
          Date.now() + Math.min(60_000, 1000 * (op.attempts + 1) ** 2),
          err?.message ?? String(err),
        );
      }
    }
  }
}
