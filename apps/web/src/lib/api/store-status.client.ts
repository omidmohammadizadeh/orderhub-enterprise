"use client";
import { apiClient } from "./client";

// Phase AW-21 — Read-only overview of operational issues.

export interface StoreStatusActor {
  id: string;
  name: string;
}

export interface PausedEntry {
  id: string;
  locationId: string;
  locationName: string;
  brandId: string | null;
  brandName: string | null;
  channel: string | null;
  reason: string | null;
  resumeAt: string | null;
  pausedAt: string;
  pausedBy: StoreStatusActor | null;
}

export interface BusyEntry extends PausedEntry {
  extraPrepTime: number | null;
}

export interface SnoozeEntry {
  id: string;
  itemId: string;
  itemName: string;
  brandId: string | null;
  brandName: string | null;
  channel: string;
  reason: string | null;
  expiresAt: string | null;
  snoozedAt: string;
  snoozedBy: StoreStatusActor | null;
}

export interface OutOfStockEntry {
  itemId: string;
  itemName: string;
  brandId: string;
  brandName: string;
  autoResumeAt: string | null;
}

export interface StoreStatusOverview {
  summary: {
    paused: number;
    busy: number;
    snoozedItems: number;
    outOfStock: number;
    issuesTotal: number;
  };
  pauses: PausedEntry[];
  busyModes: BusyEntry[];
  snoozes: SnoozeEntry[];
  outOfStock: OutOfStockEntry[];
  generatedAt: string;
}

export const storeStatusClient = {
  overview: () =>
    apiClient
      .get<StoreStatusOverview>("/v1/store-status/overview")
      .then((r) => r.data),
};
