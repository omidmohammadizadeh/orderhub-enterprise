import { Injectable, NotFoundException, Logger } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import type { MobileAppId } from "./mobile-api-contract";

export interface RegisterSessionDto {
  appId: string;
  deviceId: string;
  deviceModel?: string;
  osVersion?: string;
  appVersion: string;
  fcmToken?: string;
}

export interface RegisterWebPushDto {
  endpoint: string;
  p256dh: string;
  auth: string;
}

@Injectable()
export class MobileService {
  private readonly logger = new Logger(MobileService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── MOBILE SESSIONS ───────────────────────────────────────────────────────────

  async registerSession(userId: string, tenantId: string, dto: RegisterSessionDto) {
    const session = await this.prisma.mobileSession.upsert({
      where: {
        userId_deviceId_appId: {
          userId,
          deviceId: dto.deviceId,
          appId: dto.appId,
        },
      },
      create: {
        userId,
        tenantId,
        appId: dto.appId,
        deviceId: dto.deviceId,
        deviceModel: dto.deviceModel ?? null,
        osVersion: dto.osVersion ?? null,
        appVersion: dto.appVersion,
        fcmToken: dto.fcmToken ?? null,
        isActive: true,
        lastSyncAt: new Date(),
      },
      update: {
        appVersion: dto.appVersion,
        ...(dto.deviceModel !== undefined && { deviceModel: dto.deviceModel }),
        ...(dto.osVersion !== undefined && { osVersion: dto.osVersion }),
        ...(dto.fcmToken !== undefined && { fcmToken: dto.fcmToken }),
        isActive: true,
        lastSyncAt: new Date(),
      },
    });

    this.logger.log(
      `Mobile session registered: userId=${userId} appId=${dto.appId} deviceId=${dto.deviceId}`,
    );

    return session;
  }

  async heartbeat(
    userId: string,
    deviceId: string,
    appId: string,
    fcmToken?: string,
  ) {
    const session = await this.prisma.mobileSession.findFirst({
      where: { userId, deviceId, appId, isActive: true },
    });
    if (!session) throw new NotFoundException("Active session not found");

    return this.prisma.mobileSession.update({
      where: { id: session.id },
      data: {
        lastSyncAt: new Date(),
        ...(fcmToken !== undefined && { fcmToken }),
      },
    });
  }

  async listSessions(userId: string) {
    return this.prisma.mobileSession.findMany({
      where: { userId, isActive: true },
      orderBy: { lastSyncAt: "desc" },
    });
  }

  async revokeSession(userId: string, deviceId: string, appId: string) {
    const session = await this.prisma.mobileSession.findFirst({
      where: { userId, deviceId, appId },
    });
    if (!session) throw new NotFoundException("Session not found");

    await this.prisma.mobileSession.update({
      where: { id: session.id },
      data: { isActive: false },
    });

    this.logger.log(
      `Mobile session revoked: userId=${userId} appId=${appId} deviceId=${deviceId}`,
    );
  }

  async getSessionsByApp(tenantId: string, appId: string) {
    return this.prisma.mobileSession.findMany({
      where: { tenantId, appId, isActive: true },
      orderBy: { lastSyncAt: "desc" },
    });
  }

  // ── WEB PUSH ──────────────────────────────────────────────────────────────────

  async registerWebPush(userId: string, tenantId: string, dto: RegisterWebPushDto) {
    return this.prisma.webPushSubscription.upsert({
      where: { endpoint: dto.endpoint },
      create: {
        userId,
        tenantId,
        endpoint: dto.endpoint,
        p256dh: dto.p256dh,
        auth: dto.auth,
        isActive: true,
      },
      update: {
        userId,
        p256dh: dto.p256dh,
        auth: dto.auth,
        isActive: true,
      },
    });
  }

  async unregisterWebPush(userId: string, endpoint: string) {
    const sub = await this.prisma.webPushSubscription.findFirst({
      where: { userId, endpoint },
    });
    if (!sub) throw new NotFoundException("Web push subscription not found");

    await this.prisma.webPushSubscription.update({
      where: { id: sub.id },
      data: { isActive: false },
    });
  }

  async getWebPushSubscriptions(userId: string) {
    return this.prisma.webPushSubscription.findMany({
      where: { userId, isActive: true },
      orderBy: { createdAt: "desc" },
    });
  }

  async getWebPushSubscriptionsByTenant(tenantId: string) {
    return this.prisma.webPushSubscription.findMany({
      where: { tenantId, isActive: true },
      orderBy: { createdAt: "desc" },
    });
  }
}
