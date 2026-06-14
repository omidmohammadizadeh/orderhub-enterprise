// Local SQLite outbox for offline operations.
//
// Two tables:
//   pending_operations — POSTs we owe the server (job complete /
//                        fail / heartbeat). Drained when network up.
//   printed_history    — last N PrintJob payloads we successfully
//                        printed. Lets the operator reprint locally
//                        with no network.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database, { Database as Db } from "better-sqlite3";

function dbPath(): string {
  const dir = path.join(os.homedir(), ".orderhub-print-bridge");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "outbox.db");
}

export interface PendingOp {
  id: string;
  method: "POST" | "PATCH" | "PUT";
  url: string;
  body: string;
  idempotencyKey: string;
  attempts: number;
  nextTryAt: number;
  lastError?: string | null;
}

const HISTORY_LIMIT = 200;

export class Outbox {
  private db: Db;

  constructor() {
    this.db = new Database(dbPath());
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_operations (
        id              TEXT PRIMARY KEY,
        method          TEXT NOT NULL,
        url             TEXT NOT NULL,
        body            TEXT NOT NULL,
        idempotencyKey  TEXT NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        nextTryAt       INTEGER NOT NULL DEFAULT 0,
        lastError       TEXT
      );
      CREATE TABLE IF NOT EXISTS printed_history (
        jobId    TEXT PRIMARY KEY,
        payload  TEXT NOT NULL,
        printedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pending_next_idx
        ON pending_operations(nextTryAt);
    `);
  }

  enqueue(op: PendingOp) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO pending_operations
         (id, method, url, body, idempotencyKey, attempts, nextTryAt, lastError)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        op.id,
        op.method,
        op.url,
        op.body,
        op.idempotencyKey,
        op.attempts,
        op.nextTryAt,
        op.lastError ?? null,
      );
  }

  ready(now: number): PendingOp[] {
    return this.db
      .prepare<[number]>(
        `SELECT * FROM pending_operations WHERE nextTryAt <= ? ORDER BY nextTryAt ASC LIMIT 10`,
      )
      .all(now) as PendingOp[];
  }

  ack(id: string) {
    this.db.prepare(`DELETE FROM pending_operations WHERE id = ?`).run(id);
  }

  reschedule(id: string, nextTryAt: number, lastError: string) {
    this.db
      .prepare(
        `UPDATE pending_operations
         SET attempts = attempts + 1,
             nextTryAt = ?,
             lastError = ?
         WHERE id = ?`,
      )
      .run(nextTryAt, lastError, id);
  }

  rememberPrinted(jobId: string, payload: any) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO printed_history (jobId, payload, printedAt)
         VALUES (?, ?, ?)`,
      )
      .run(jobId, JSON.stringify(payload), Date.now());

    // Trim to N most recent.
    this.db
      .prepare(
        `DELETE FROM printed_history WHERE jobId NOT IN
         (SELECT jobId FROM printed_history ORDER BY printedAt DESC LIMIT ?)`,
      )
      .run(HISTORY_LIMIT);
  }

  recentHistory(limit = 20): { jobId: string; payload: any; printedAt: number }[] {
    const rows = this.db
      .prepare<[number]>(
        `SELECT jobId, payload, printedAt FROM printed_history
         ORDER BY printedAt DESC LIMIT ?`,
      )
      .all(limit) as { jobId: string; payload: string; printedAt: number }[];
    return rows.map((r) => ({
      jobId: r.jobId,
      payload: JSON.parse(r.payload),
      printedAt: r.printedAt,
    }));
  }
}
