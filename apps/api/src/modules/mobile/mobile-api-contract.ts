// ── Mobile API Contract ────────────────────────────────────────────────────────
// Shared DTOs and interfaces for all OrderHub mobile clients.
// This file is the single source of truth for the mobile app API contract.

export const MOBILE_APPS = ["driver", "kds", "pos", "manager"] as const;
export type MobileAppId = (typeof MOBILE_APPS)[number];

// Authentication payload sent from mobile app during login
export interface MobileAuthDto {
  email: string;
  password: string;
  appId: MobileAppId;
  deviceId: string;
  deviceModel?: string;
  osVersion?: string;
  appVersion: string;
  fcmToken?: string;
}

// Order payload shape optimised for mobile bandwidth
export interface MobileOrderPayload {
  orderId: string;
  displayId: string;
  status: string;
  platform: string;
  fulfillmentType: string;
  total: number;
  items: Array<{
    name: string;
    quantity: number;
    unitPrice: number;
    notes?: string;
    modifiers: Array<{ name: string; price: number }>;
  }>;
  customer?: {
    name: string;
    phone?: string;
  };
  deliveryAddress?: {
    line1: string;
    line2?: string;
    city: string;
    postcode: string;
    coordinates?: { lat: number; lng: number };
  };
  scheduledFor?: string; // ISO date string
  notes?: string;
  createdAt: string;
  acceptedAt?: string;
  readyAt?: string;
}

// Heartbeat sent periodically to keep session alive
export interface MobileHeartbeatDto {
  deviceId: string;
  appId: MobileAppId;
  fcmToken?: string;
}

// An item in the device's offline action queue (for sync on reconnect)
export interface OfflineQueueItem {
  id: string; // client-generated UUID
  action: "UPDATE_ORDER_STATUS" | "ACCEPT_ORDER" | "MARK_READY" | "MARK_DELIVERED";
  payload: Record<string, unknown>;
  createdAt: string; // ISO date string
  retries: number;
}

// Push notification token registration payload
export interface PushTokenDto {
  deviceId: string;
  appId: MobileAppId;
  fcmToken: string;
}

// Per-app capability flags — used by apps to enable/disable features
export interface MobileCapabilities {
  offlineQueue: boolean;
  pushNotifications: boolean;
  socketSync: boolean;
  biometricAuth: boolean;
}

export const APP_CAPABILITIES: Record<MobileAppId, MobileCapabilities> = {
  driver: {
    offlineQueue: true,
    pushNotifications: true,
    socketSync: true,
    biometricAuth: true,
  },
  kds: {
    offlineQueue: false,
    pushNotifications: true,
    socketSync: true,
    biometricAuth: false,
  },
  pos: {
    offlineQueue: true,
    pushNotifications: false,
    socketSync: true,
    biometricAuth: true,
  },
  manager: {
    offlineQueue: false,
    pushNotifications: true,
    socketSync: true,
    biometricAuth: true,
  },
};
