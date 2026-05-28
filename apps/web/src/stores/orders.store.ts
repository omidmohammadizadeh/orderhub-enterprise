"use client";

import { create } from "zustand";
import type { Order } from "../lib/api/orders.client";
import type { OrderEventPayload, OrderCancelledPayload } from "@orderhub/shared";

interface OrdersState {
  liveOrders: Order[];
  // Set initial snapshot from server
  setLiveOrders: (orders: Order[]) => void;
  // Apply real-time socket event — new order arrives
  applyNewOrder: (payload: OrderEventPayload) => void;
  // Apply status update from socket
  applyOrderUpdated: (payload: OrderEventPayload) => void;
  // Apply cancellation
  applyOrderCancelled: (payload: OrderCancelledPayload) => void;
  // Optimistic update (before server confirms)
  optimisticStatusUpdate: (orderId: string, newStatus: string) => void;
}

export const useOrdersStore = create<OrdersState>((set) => ({
  liveOrders: [],

  setLiveOrders: (orders) => set({ liveOrders: orders }),

  applyNewOrder: (payload) =>
    set((state) => {
      const exists = state.liveOrders.some((o) => o.id === payload.orderId);
      if (exists) return state;
      // Partial order from socket — will be hydrated on next query refresh
      const partial: Order = {
        id: payload.orderId,
        tenantId: payload.tenantId,
        locationId: payload.locationId,
        externalId: null,
        platform: payload.platform,
        orderSource: payload.orderSource,
        integrationSource: "DIRECT",
        viaHubrise: false,
        fulfillmentType: payload.fulfillmentType,
        displayId: payload.displayId,
        status: payload.status,
        customerInfo: { name: payload.customerName },
        items: [],
        statusHistory: [],
        subtotal: payload.total,
        taxAmount: 0,
        deliveryFee: 0,
        discount: 0,
        total: payload.total,
        receivedAt: payload.createdAt,
        createdAt: payload.createdAt,
        scheduledFor: payload.scheduledFor,
      };
      return { liveOrders: [partial, ...state.liveOrders] };
    }),

  applyOrderUpdated: (payload) =>
    set((state) => ({
      // Terminal-state orders stay on the board for 24 hours (the API's
      // findLiveOrders enforces the same window), so we don't filter
      // COMPLETED / CANCELLED / REJECTED / FAILED here — the board has
      // dedicated Delivered / Collected / Cancelled / Denied columns to
      // surface them. They drop off naturally on the next refetch once
      // updatedAt is more than 24h old.
      liveOrders: state.liveOrders.map((o) =>
        o.id === payload.orderId ? { ...o, status: payload.status } : o,
      ),
    })),

  applyOrderCancelled: (payload) =>
    set((state) => ({
      liveOrders: state.liveOrders.map((o) =>
        o.id === payload.orderId ? { ...o, status: "CANCELLED" } : o,
      ),
    })),

  optimisticStatusUpdate: (orderId, newStatus) =>
    set((state) => ({
      liveOrders: state.liveOrders.map((o) =>
        o.id === orderId ? { ...o, status: newStatus } : o,
      ),
    })),
}));
