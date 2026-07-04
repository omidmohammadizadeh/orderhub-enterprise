// Phase UE-7 — Marketplace Reporting API (Base44-era cert item).
//
// Spec (partner OpenAPI, Reporting 1.0.0):
//   POST /v1/eats/report  {report_type, store_uuids[], start_date, end_date}
//     scope eats.report → { workflow_id }  (async — generation takes time)
//   eats.report.success webhook → { event_id, job_id, report_type,
//     report_metadata.sections[{section_id, content_type, download_url}] }
//
// The webhook receiver records every event idempotently; here we track the
// tenant's requested jobs (on the first UBER_EATS connection's metadata) and
// join them with received report.success events so the dashboard can show
// "pending → ready + download links" without a schema migration.

import {
  BadRequestException,
  Injectable,
  Logger,
} from "@nestjs/common";
import type { Prisma } from "@orderhub/database";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { UberEatsClientService } from "./ubereats-client.service";

const SCOPES = ["eats.report"];

export const UBER_REPORT_TYPES = [
  "PAYMENT_DETAILS_REPORT",
  "ORDER_ERRORS_MENU_ITEM_REPORT",
  "ORDER_ERRORS_TRANSACTION_REPORT",
  "ORDER_HISTORY_REPORT",
  "DOWNTIME_REPORT",
  "CUSTOMER_AND_DELIVERY_FEEDBACK_REPORT",
  "MENU_ITEM_FEEDBACK_REPORT",
  "ORDERS_AND_ITEMS_REPORT",
  "FINANCE_SUMMARY_REPORT",
] as const;
export type UberReportType = (typeof UBER_REPORT_TYPES)[number];

interface ReportJob {
  workflowId: string;
  reportType: string;
  startDate: string;
  endDate: string;
  requestedAt: string;
}

@Injectable()
export class UberEatsReportingService {
  private readonly logger = new Logger(UberEatsReportingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: UberEatsClientService,
  ) {}

  /** Request a report for the tenant's connected stores (or a subset). */
  async createReport(
    tenantId: string,
    dto: {
      reportType: UberReportType;
      startDate: string; // YYYY-MM-DD
      endDate: string;
      storeIds?: string[];
    },
  ) {
    if (!UBER_REPORT_TYPES.includes(dto.reportType)) {
      throw new BadRequestException(
        `reportType must be one of: ${UBER_REPORT_TYPES.join(", ")}`,
      );
    }
    if (!dto.startDate || !dto.endDate) {
      throw new BadRequestException("startDate and endDate are required");
    }

    const conns = await this.prisma.brandPlatformConnection.findMany({
      where: {
        tenantId,
        platform: "UBER_EATS",
        externalStoreId: { not: null },
      },
      orderBy: { createdAt: "asc" },
    });
    if (conns.length === 0) {
      throw new BadRequestException(
        "No Uber Eats stores are connected for this account.",
      );
    }
    const storeUuids =
      dto.storeIds?.length
        ? dto.storeIds
        : conns.map((c) => c.externalStoreId!) ;

    const res = await this.client.request<{ workflow_id?: string }>(
      "POST",
      "/v1/eats/report",
      {
        scopes: SCOPES,
        body: {
          report_type: dto.reportType,
          store_uuids: storeUuids,
          start_date: dto.startDate,
          end_date: dto.endDate,
        },
      },
    );
    const workflowId = res?.workflow_id ?? "";
    this.logger.log(
      `Uber Eats report requested: ${dto.reportType} ${dto.startDate}→${dto.endDate} stores=${storeUuids.length} workflow=${workflowId}`,
    );

    // Track the job on the tenant's first connection (bounded list).
    const anchor = conns[0]!;
    const meta = (anchor.metadata ?? {}) as Record<string, any>;
    const jobs: ReportJob[] = Array.isArray(meta.reportJobs)
      ? meta.reportJobs
      : [];
    jobs.unshift({
      workflowId,
      reportType: dto.reportType,
      startDate: dto.startDate,
      endDate: dto.endDate,
      requestedAt: new Date().toISOString(),
    });
    await this.prisma.brandPlatformConnection
      .update({
        where: { id: anchor.id },
        data: {
          metadata: {
            ...meta,
            reportJobs: jobs.slice(0, 50),
          } as Prisma.InputJsonValue,
        },
      })
      .catch(() => {
        /* best-effort bookkeeping */
      });

    return { workflowId };
  }

  /**
   * The tenant's requested reports joined with received eats.report.success
   * webhooks: PENDING until the webhook lands, then READY with download URLs.
   */
  async listReports(tenantId: string) {
    const conns = await this.prisma.brandPlatformConnection.findMany({
      where: { tenantId, platform: "UBER_EATS" },
      select: { metadata: true },
    });
    const jobs: ReportJob[] = conns.flatMap((c) => {
      const m = (c.metadata ?? {}) as Record<string, any>;
      return Array.isArray(m.reportJobs) ? m.reportJobs : [];
    });
    if (jobs.length === 0) return { reports: [] };

    // Recent report.success deliveries (recorded by the webhook receiver).
    const events = await this.prisma.webhookEvent.findMany({
      where: {
        platform: "UBER_EATS",
        metadata: { path: ["event"], equals: "eats.report.success" },
      },
      orderBy: { receivedAt: "desc" },
      take: 200,
      select: { rawPayload: true, receivedAt: true },
    });
    const byJob = new Map<string, any>();
    for (const e of events) {
      const p = e.rawPayload as any;
      const key = String(p?.job_id ?? p?.workflow_id ?? "");
      if (key && !byJob.has(key)) {
        byJob.set(key, { ...p, receivedAt: e.receivedAt });
      }
    }

    return {
      reports: jobs.map((j) => {
        const hit = byJob.get(j.workflowId);
        return {
          ...j,
          status: hit ? "READY" : "PENDING",
          sections: hit?.report_metadata?.sections ?? [],
          receivedAt: hit?.receivedAt ?? null,
        };
      }),
    };
  }
}
