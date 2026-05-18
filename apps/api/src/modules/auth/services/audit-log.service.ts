import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import type { AuditEventKey } from "@orderhub/shared";
import type { RequestMeta } from "../interfaces/request-meta.interface";

export interface AuditLogEntry {
  tenantId: string;
  userId?: string;
  event: AuditEventKey | string;
  resource?: string;
  resourceId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

// Append-only log of security-relevant platform events.
// Never throws — a failed audit write must not block the main flow,
// but it does log a warning so on-call can investigate.
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditLogEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          tenantId: entry.tenantId,
          userId: entry.userId,
          event: entry.event,
          resource: entry.resource,
          resourceId: entry.resourceId,
          before: entry.before as any,
          after: entry.after as any,
          meta: (entry.meta ?? {}) as any,
          ipAddress: entry.ipAddress,
          userAgent: entry.userAgent,
        },
      });
    } catch (err) {
      this.logger.warn(`Failed to write audit log for event "${entry.event}": ${err}`);
    }
  }

  logAuthEvent(
    event: AuditEventKey | string,
    {
      tenantId,
      userId,
      meta,
      requestMeta,
    }: {
      tenantId: string;
      userId?: string;
      meta?: Record<string, unknown>;
      requestMeta: RequestMeta;
    },
  ): Promise<void> {
    return this.log({
      tenantId,
      userId,
      event,
      resource: "auth",
      meta,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
    });
  }
}
