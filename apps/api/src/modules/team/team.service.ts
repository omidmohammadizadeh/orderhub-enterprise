// Phase AR — Team Roles service.
//
// Implements three primary flows the Team Roles page in the dashboard
// drives:
//
//   1. List members + their scope (locations / brands).
//   2. Assign an existing user (already has a User row in this tenant,
//      or globally — see lookup()) to a role + scope.
//   3. Invite a new email — create a single-use Invitation row, send
//      an email with the accept link, and on accept create the User
//      row + optional password.
//
// Per-controller scope enforcement (only letting users see data for
// their assigned locations / brands) lands in Phase AR-2 alongside
// guard updates. For now this service is the source of truth for
// "who has access to what" and the rest of the API still trusts the
// existing @Roles decorators.

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import * as crypto from "crypto";
import * as bcrypt from "bcryptjs";
import { TeamInviteEmailService } from "./team-invite-email.service";

const NEW_ROLES = [
  "OWNER",
  "DARK_KITCHEN_MANAGER",
  "MANAGER",
  "STAFF",
  "DRIVER",
  "ONBOARDING_AGENT",
  "FINANCIAL_AGENT",
  // Platform-level — kept in the list so an admin user can re-assign
  // peers, but the UI hides this option for non-admins.
  "PLATFORM_ADMIN",
] as const;

type NewRole = (typeof NEW_ROLES)[number];

function isValidRole(role: string): role is NewRole {
  return (NEW_ROLES as readonly string[]).includes(role);
}

const INVITE_TTL_DAYS = 14;

export interface AssignRoleDto {
  userId: string;
  role: string;
  locationIds: string[];
  brandIds: string[];
}

export interface InviteDto {
  email: string;
  role: string;
  locationIds: string[];
  brandIds: string[];
}

export interface AcceptInviteDto {
  firstName: string;
  lastName: string;
  password?: string;
}

@Injectable()
export class TeamService {
  private readonly logger = new Logger(TeamService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly invites: TeamInviteEmailService,
  ) {}

  // ── Members ────────────────────────────────────────────────────

  async listMembers(tenantId: string) {
    const users = await this.prisma.user.findMany({
      where: { tenantId, isActive: true },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        locations: {
          select: {
            location: { select: { id: true, name: true } },
          },
        },
        brands: {
          select: {
            brand: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return users.map((u: any) => ({
      id: u.id,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      role: u.role,
      isActive: u.isActive,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
      locations: u.locations.map((l: any) => l.location),
      brands: u.brands.map((b: any) => b.brand),
    }));
  }

  // ── User lookup for Assign-Role flow ──────────────────────────
  //
  // Search across the entire system by email — the user typed it
  // into the Assign-Role modal because they're already in the
  // platform. We return shallow info; the actual assign call
  // re-validates the email belongs to a user the caller can manage.
  async lookupByEmail(email: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        tenantId: true,
        role: true,
      },
    });
    return user;
  }

  // ── Assign role + scope to an existing user ────────────────────

  async assignRole(actorTenantId: string, dto: AssignRoleDto) {
    if (!isValidRole(dto.role)) {
      throw new BadRequestException(`Unknown role: ${dto.role}`);
    }

    const target = await this.prisma.user.findUnique({
      where: { id: dto.userId },
      select: { id: true, tenantId: true, email: true },
    });
    if (!target) throw new NotFoundException("User not found");

    // For now, only allow assigning within the same tenant — cross-
    // tenant admin moves are PLATFORM_ADMIN-only territory and we
    // don't have that UI path. Surface the constraint clearly so a
    // future tool author knows where the check lives.
    if (target.tenantId !== actorTenantId) {
      throw new BadRequestException(
        "User belongs to a different tenant — cross-tenant assignment isn't supported from this flow.",
      );
    }

    // Validate referenced locations / brands actually belong to this
    // tenant. Cheap guard against a forged payload that ships an
    // unrelated locationId.
    if (dto.locationIds.length) {
      const count = await this.prisma.location.count({
        where: {
          id: { in: dto.locationIds },
          brand: { tenantId: actorTenantId },
        },
      });
      if (count !== dto.locationIds.length) {
        throw new BadRequestException(
          "One or more locations don't belong to this tenant.",
        );
      }
    }
    if (dto.brandIds.length) {
      const count = await this.prisma.brand.count({
        where: { id: { in: dto.brandIds }, tenantId: actorTenantId },
      });
      if (count !== dto.brandIds.length) {
        throw new BadRequestException(
          "One or more brands don't belong to this tenant.",
        );
      }
    }

    await this.prisma.$transaction(async (tx: any) => {
      await tx.user.update({
        where: { id: dto.userId },
        data: { role: dto.role as any },
      });
      // Replace the user's existing scope with the new set.
      // Deterministic and easier to reason about than diffing.
      await tx.userLocation.deleteMany({ where: { userId: dto.userId } });
      await tx.userBrand.deleteMany({ where: { userId: dto.userId } });
      if (dto.locationIds.length) {
        await tx.userLocation.createMany({
          data: dto.locationIds.map((locationId: string) => ({
            userId: dto.userId,
            locationId,
          })),
        });
      }
      if (dto.brandIds.length) {
        await tx.userBrand.createMany({
          data: dto.brandIds.map((brandId: string) => ({
            userId: dto.userId,
            brandId,
          })),
        });
      }
    });

    this.logger.log(
      `Role assigned: ${target.email} → ${dto.role} (${dto.locationIds.length} locs, ${dto.brandIds.length} brands)`,
    );
    return { ok: true };
  }

  // ── Invitations ────────────────────────────────────────────────

  async listInvitations(tenantId: string) {
    return this.prisma.invitation.findMany({
      where: { tenantId, acceptedAt: null, cancelledAt: null },
      orderBy: { createdAt: "desc" },
      include: {
        invitedBy: {
          select: { firstName: true, lastName: true, email: true },
        },
      },
    });
  }

  async createInvitation(
    tenantId: string,
    invitedById: string,
    dto: InviteDto,
  ) {
    if (!isValidRole(dto.role)) {
      throw new BadRequestException(`Unknown role: ${dto.role}`);
    }
    const email = dto.email.toLowerCase().trim();
    if (!email.includes("@")) {
      throw new BadRequestException("Invalid email");
    }

    // Block double-invites + duplicate user creation.
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, tenantId: true },
    });
    if (existingUser) {
      throw new ConflictException(
        "A user with that email already exists — use Assign Role instead.",
      );
    }
    const existingInvite = await this.prisma.invitation.findFirst({
      where: { email, tenantId, acceptedAt: null, cancelledAt: null },
    });
    if (existingInvite) {
      throw new ConflictException(
        "An invitation has already been sent to this email.",
      );
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(
      Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
    );

    const invite = await this.prisma.invitation.create({
      data: {
        tenantId,
        email,
        role: dto.role as any,
        locationIds: dto.locationIds ?? [],
        brandIds: dto.brandIds ?? [],
        token,
        expiresAt,
        invitedById,
      },
    });

    // Best-effort: email failure shouldn't block the invitation row
    // from being created — operators can resend.
    try {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true },
      });
      const inviter = await this.prisma.user.findUnique({
        where: { id: invitedById },
        select: { firstName: true, lastName: true, email: true },
      });
      await this.invites.sendInvite({
        to: email,
        token,
        role: dto.role,
        tenantName: tenant?.name ?? "Order Hub",
        inviterName: inviter
          ? `${inviter.firstName} ${inviter.lastName}`.trim() || inviter.email
          : "Order Hub",
      });
    } catch (err: any) {
      this.logger.warn(
        `Invite email send failed for ${email}: ${err.message} — invite row is still active.`,
      );
    }

    return invite;
  }

  async cancelInvitation(tenantId: string, id: string) {
    const invite = await this.prisma.invitation.findFirst({
      where: { id, tenantId },
    });
    if (!invite) throw new NotFoundException("Invitation not found");
    if (invite.acceptedAt) {
      throw new BadRequestException("Invitation already accepted");
    }
    await this.prisma.invitation.update({
      where: { id },
      data: { cancelledAt: new Date() },
    });
    return { ok: true };
  }

  // ── Accept invitation (public) ────────────────────────────────

  async getInvitationByToken(token: string) {
    const invite = await this.prisma.invitation.findUnique({
      where: { token },
      include: {
        tenant: { select: { name: true } },
        invitedBy: {
          select: { firstName: true, lastName: true, email: true },
        },
      },
    });
    if (!invite) throw new NotFoundException("Invitation not found");
    if (invite.acceptedAt) {
      throw new BadRequestException("This invitation has already been accepted.");
    }
    if (invite.cancelledAt) {
      throw new BadRequestException("This invitation was cancelled.");
    }
    if (invite.expiresAt < new Date()) {
      throw new BadRequestException("This invitation has expired.");
    }

    // Surface the location / brand names so the accept page can show
    // "you'll have access to: X, Y, Z" before the invitee commits.
    const [locations, brands] = await Promise.all([
      invite.locationIds.length
        ? this.prisma.location.findMany({
            where: { id: { in: invite.locationIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
      invite.brandIds.length
        ? this.prisma.brand.findMany({
            where: { id: { in: invite.brandIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ]);

    return {
      email: invite.email,
      role: invite.role,
      tenantName: invite.tenant.name,
      inviterName: invite.invitedBy
        ? `${invite.invitedBy.firstName} ${invite.invitedBy.lastName}`.trim() ||
          invite.invitedBy.email
        : "Order Hub",
      locations,
      brands,
      expiresAt: invite.expiresAt,
    };
  }

  async acceptInvitation(token: string, dto: AcceptInviteDto) {
    const invite = await this.prisma.invitation.findUnique({
      where: { token },
    });
    if (!invite) throw new NotFoundException("Invitation not found");
    if (invite.acceptedAt) {
      throw new BadRequestException("This invitation has already been accepted.");
    }
    if (invite.cancelledAt) {
      throw new BadRequestException("This invitation was cancelled.");
    }
    if (invite.expiresAt < new Date()) {
      throw new BadRequestException("This invitation has expired.");
    }

    // If a User with this email already exists (Google OAuth signup
    // before invite acceptance), reuse the row — just bind the role
    // and scope. No password mutation in that case.
    const existing = await this.prisma.user.findUnique({
      where: { email: invite.email },
    });

    let userId: string;
    if (existing) {
      userId = existing.id;
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          role: invite.role,
          tenantId: invite.tenantId,
          firstName: existing.firstName || dto.firstName,
          lastName: existing.lastName || dto.lastName,
        },
      });
    } else {
      if (!dto.password || dto.password.length < 8) {
        throw new BadRequestException(
          "Password is required for new accounts (minimum 8 characters).",
        );
      }
      const hashed = await bcrypt.hash(dto.password, 12);
      const created = await this.prisma.user.create({
        data: {
          email: invite.email,
          firstName: dto.firstName,
          lastName: dto.lastName,
          password: hashed,
          role: invite.role,
          tenantId: invite.tenantId,
          isActive: true,
          isVerified: true, // accepting via email link proves ownership
        },
      });
      userId = created.id;
    }

    // Replace any existing scope with the invitation's scope.
    await this.prisma.$transaction(async (tx: any) => {
      await tx.userLocation.deleteMany({ where: { userId } });
      await tx.userBrand.deleteMany({ where: { userId } });
      if (invite.locationIds.length) {
        await tx.userLocation.createMany({
          data: invite.locationIds.map((locationId: string) => ({
            userId,
            locationId,
          })),
        });
      }
      if (invite.brandIds.length) {
        await tx.userBrand.createMany({
          data: invite.brandIds.map((brandId: string) => ({ userId, brandId })),
        });
      }
      await tx.invitation.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
      });
    });

    return { ok: true, userId, email: invite.email };
  }
}
