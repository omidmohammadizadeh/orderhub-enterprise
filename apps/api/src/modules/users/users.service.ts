import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import type { UserRole } from "@orderhub/database";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { PasswordService } from "../auth/services/password.service";

export interface InviteUserDto {
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
}

export interface AcceptInviteDto {
  token: string;
  password: string;
}

export interface UpdateUserRoleDto {
  role: UserRole;
}

interface InviteTokenPayload {
  sub: string;
  tenantId: string;
  type: "invite";
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly passwordService: PasswordService,
  ) {}

  async findAll(tenantId: string) {
    return this.prisma.user.findMany({
      where: { tenantId, isActive: true },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        isVerified: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
      },
      orderBy: [{ role: "asc" }, { firstName: "asc" }],
    });
  }

  async findOne(userId: string, tenantId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId, isActive: true },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        permissions: true,
        isVerified: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });
    if (!user) throw new NotFoundException("User not found");
    return user;
  }

  async invite(tenantId: string, dto: InviteUserDto) {
    const email = dto.email.toLowerCase().trim();

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      if (existing.tenantId === tenantId) {
        throw new ConflictException("A user with this email already exists in your organisation");
      }
      throw new ConflictException("This email address is already registered");
    }

    const user = await this.prisma.user.create({
      data: {
        tenantId,
        email,
        firstName: dto.firstName,
        lastName: dto.lastName,
        role: dto.role,
        isActive: true,
        isVerified: false,
      },
    });

    const token = await this.jwt.signAsync(
      { sub: user.id, tenantId, type: "invite" } satisfies InviteTokenPayload,
      {
        secret: this.config.get("JWT_SECRET"),
        expiresIn: "72h",
      },
    );

    const webUrl = this.config.get<string>("WEB_URL", "http://localhost:3000");
    const inviteUrl = `${webUrl}/auth/accept-invite?token=${token}`;

    this.logger.log(`Invite created for ${email} (${user.id}) in tenant ${tenantId}`);

    return {
      userId: user.id,
      email: user.email,
      inviteUrl,
      expiresIn: "72 hours",
    };
  }

  async acceptInvite(dto: AcceptInviteDto) {
    let payload: InviteTokenPayload;
    try {
      payload = this.jwt.verify<InviteTokenPayload>(dto.token, {
        secret: this.config.get("JWT_SECRET"),
      });
    } catch {
      throw new BadRequestException("Invite link is invalid or has expired");
    }

    if (payload.type !== "invite") {
      throw new BadRequestException("Invalid token type");
    }

    const user = await this.prisma.user.findFirst({
      where: { id: payload.sub, tenantId: payload.tenantId, isVerified: false },
    });
    if (!user) {
      throw new BadRequestException("Invite has already been accepted or is no longer valid");
    }

    const hashed = await this.passwordService.hash(dto.password);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { password: hashed, isVerified: true },
    });

    this.logger.log(`Invite accepted for user ${user.id}`);
    return { message: "Account activated. You can now sign in." };
  }

  async updateRole(userId: string, tenantId: string, dto: UpdateUserRoleDto, actorRole: UserRole) {
    const target = await this.findOne(userId, tenantId);

    // Only TENANT_OWNER and PLATFORM_ADMIN can assign TENANT_OWNER role
    if (dto.role === "TENANT_OWNER" && !["TENANT_OWNER", "PLATFORM_ADMIN"].includes(actorRole)) {
      throw new ForbiddenException("Only the tenant owner can assign the TENANT_OWNER role");
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: { role: dto.role },
      select: { id: true, email: true, role: true, updatedAt: true },
    });
  }

  async deactivate(userId: string, tenantId: string) {
    await this.findOne(userId, tenantId);
    await this.prisma.user.update({
      where: { id: userId },
      data: { isActive: false },
    });
    // Invalidate all active sessions
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
