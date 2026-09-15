import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SupabaseStorageService } from "./supabase-storage.service";

/**
 * Move images already stored as base64 out of Postgres and into storage.
 *
 * New saves are handled at write time (rehostImageIfInline), but anything
 * saved before that — or saved while a Supabase upload was failing, since the
 * dashboard uploader falls back to a data URI — is still sitting in a column
 * as `data:image/...;base64,…`.
 *
 * Two separate costs, and the second is the one that is easy to miss:
 *   • the bytes are re-sent inside the JSON on every storefront load, because
 *     a data URI is part of the response rather than a resource the browser
 *     can cache. One live shop was carrying a 703KB banner this way — 18% of
 *     a 3.8MB payload, on every single visit.
 *   • no link-preview crawler can use it. WhatsApp, Facebook and the rest
 *     fetch og:image over HTTP by URL, so a shop whose banner lives in a
 *     column has no preview picture at all.
 *
 * Lives here rather than in the script so the admin screen and the CLI run
 * the SAME code. A migration with two implementations is a migration whose
 * dry run does not predict its apply.
 */

export interface RehostRow {
  model: string;
  column: string;
  id: string;
  name: string;
  kilobytes: number;
  url?: string;
  error?: string;
}

export interface RehostSummary {
  /** False for a dry run — the default, and what the UI shows first. */
  applied: boolean;
  /** Rows moved (or that would move). */
  moved: number;
  /** Rows whose upload failed. They are left inline and still render. */
  failed: number;
  /** Total size of everything moved. */
  kilobytes: number;
  /** Still inline after this pass hit its limit — click again to continue. */
  remaining: number;
  rows: RehostRow[];
  configured: boolean;
}

/**
 * Every column that can hold an inline image, and the storage folder its
 * contents belong in. `label` names the row in the report — a migration you
 * cannot read is one you cannot check afterwards.
 */
export const REHOST_TARGETS: Array<{
  model: string;
  columns: string[];
  folder: string;
  label: string;
}> = [
  { model: "brand", columns: ["logoUrl"], folder: "logos", label: "name" },
  { model: "location", columns: ["logoUrl"], folder: "logos", label: "name" },
  {
    model: "menu",
    columns: ["bannerImage", "heroImage", "logoImage"],
    folder: "menus",
    label: "name",
  },
  { model: "menuItem", columns: ["imageUrl"], folder: "products", label: "name" },
  {
    model: "modifierOption",
    columns: ["imageUrl"],
    folder: "modifiers",
    label: "name",
  },
  {
    model: "directOrderingConfig",
    columns: ["heroImageUrl"],
    folder: "storefront",
    label: "id",
  },
];

/**
 * How many images one pass will upload.
 *
 * Bounded because this runs behind an HTTP request: a shop with hundreds of
 * inline product photos would otherwise upload for minutes and time out with
 * no report of what it had already done. Each pass is complete in itself —
 * rows it moved stay moved — so the caller just runs it again.
 */
const DEFAULT_LIMIT = 25;

@Injectable()
export class InlineImageRehostService {
  private readonly logger = new Logger(InlineImageRehostService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: SupabaseStorageService,
  ) {}

  async run(opts: {
    apply?: boolean;
    only?: string;
    limit?: number;
    /** Overrides the injected client — the CLI passes a bare PrismaClient. */
    db?: any;
  } = {}): Promise<RehostSummary> {
    const apply = opts.apply === true;
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const db: any = opts.db ?? this.prisma;

    const summary: RehostSummary = {
      applied: apply,
      moved: 0,
      failed: 0,
      kilobytes: 0,
      remaining: 0,
      rows: [],
      configured: this.storage.isConfigured(),
    };
    if (!summary.configured) return summary;

    for (const target of REHOST_TARGETS) {
      if (opts.only && target.model !== opts.only) continue;

      for (const column of target.columns) {
        // `startsWith: "data:"` keeps this to the rows that actually need it
        // rather than pulling every image in the database into memory. One
        // extra row is fetched so we can report that more are waiting.
        const budget = limit - summary.moved - summary.failed;
        const rows: Array<Record<string, any>> = await db[target.model]
          .findMany({
            where: { [column]: { startsWith: "data:" } },
            select: { id: true, [target.label]: true, [column]: true },
            ...(budget > 0 ? { take: budget + 1 } : { take: 1 }),
          })
          .catch((err: any) => {
            // A column missing on this schema version is a reason to skip it,
            // not to abandon the other five.
            this.logger.error(
              `Could not read ${target.model}.${column}: ${err?.message ?? err}`,
            );
            return [];
          });

        if (rows.length === 0) continue;

        // Out of budget: everything found here is still waiting.
        if (budget <= 0) {
          summary.remaining += rows.length;
          continue;
        }
        const overflow = rows.length > budget;
        const batch = overflow ? rows.slice(0, budget) : rows;
        if (overflow) summary.remaining += 1;

        for (const row of batch) {
          const value: string = row[column];
          const name = String(row[target.label] ?? row.id);
          const kilobytes = Math.round(value.length / 1024);
          const base: RehostRow = {
            model: target.model,
            column,
            id: row.id,
            name,
            kilobytes,
          };

          if (!apply) {
            summary.rows.push(base);
            summary.moved++;
            summary.kilobytes += kilobytes;
            continue;
          }
          try {
            const url = await this.storage.uploadDataUrl(value, target.folder);
            await db[target.model].update({
              where: { id: row.id },
              data: { [column]: url },
            });
            summary.rows.push({ ...base, url });
            summary.moved++;
            summary.kilobytes += kilobytes;
          } catch (err: any) {
            // Left inline, still rendering. Worth a retry, not a rollback.
            const error = err?.message ?? String(err);
            this.logger.error(`Rehost failed for ${target.model} ${row.id}: ${error}`);
            summary.rows.push({ ...base, error });
            summary.failed++;
          }
        }
      }
    }

    return summary;
  }
}
