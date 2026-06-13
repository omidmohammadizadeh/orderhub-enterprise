// Phase AR — leads / contact requests.
//
// Two write paths:
//   1. Authenticated no-access screen → submitter is recorded so the
//      Order Hub team can match a user account to a lead.
//   2. Unauthenticated marketing form → submittedByUserId is null.
//
// Reads + updates require PLATFORM_ADMIN / ONBOARDING_AGENT.

import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";

export interface CreateLeadDto {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  country?: string;
  companyName?: string;
  numberOfLocations?: string;
  hearAboutUs?: string;
  message?: string;
  source?: "NO_ACCESS_SCREEN" | "MARKETING_SITE" | "OTHER";
}

export interface UpdateLeadDto {
  status?: "NEW" | "CONTACTED" | "QUALIFIED" | "WON" | "LOST";
  notes?: string;
}

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateLeadDto, submittedByUserId?: string) {
    const email = (dto.email ?? "").toLowerCase().trim();
    if (!email.includes("@")) throw new BadRequestException("Invalid email");
    if (!dto.firstName?.trim() || !dto.lastName?.trim()) {
      throw new BadRequestException("Name is required");
    }
    const lead = await (this.prisma as any).lead.create({
      data: {
        firstName: dto.firstName.trim(),
        lastName: dto.lastName.trim(),
        email,
        phone: dto.phone ?? null,
        country: dto.country ?? null,
        companyName: dto.companyName ?? null,
        numberOfLocations: dto.numberOfLocations ?? null,
        hearAboutUs: dto.hearAboutUs ?? null,
        message: dto.message ?? null,
        source: dto.source ?? "NO_ACCESS_SCREEN",
        submittedByUserId: submittedByUserId ?? null,
      },
    });
    this.logger.log(`Lead captured: ${email} (source=${lead.source})`);
    return lead;
  }

  async list(params: { status?: string; q?: string }) {
    return (this.prisma as any).lead.findMany({
      where: {
        ...(params.status && { status: params.status }),
        ...(params.q && {
          OR: [
            { email: { contains: params.q, mode: "insensitive" } },
            { companyName: { contains: params.q, mode: "insensitive" } },
            { firstName: { contains: params.q, mode: "insensitive" } },
            { lastName: { contains: params.q, mode: "insensitive" } },
          ],
        }),
      },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        submittedBy: {
          select: { email: true, firstName: true, lastName: true },
        },
      },
    });
  }

  // Lightweight count of unread (status=NEW) leads. Drives the
  // sidebar badge — keep it cheap so we can poll every 30s without
  // straining the DB.
  async unreadCount(): Promise<number> {
    return (this.prisma as any).lead.count({ where: { status: "NEW" } });
  }

  async update(id: string, dto: UpdateLeadDto) {
    const exists = await (this.prisma as any).lead.findUnique({
      where: { id },
    });
    if (!exists) throw new NotFoundException("Lead not found");
    return (this.prisma as any).lead.update({
      where: { id },
      data: {
        ...(dto.status && { status: dto.status }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
      },
    });
  }
}
