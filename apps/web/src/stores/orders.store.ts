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
      liveOrders: state.liveOrders
        .map((o) =>
          o.id === payload.orderId ? { ...o, status: payload.status } : o,
        )
        // Remove from live board if terminal
        .filter((o) => !["COMPLETED", "CANCELLED", "REJECTED"].includes(o.status)),
    })),

  applyOrderCancelled: (payload) =>
    set((state) => ({
      liveOrders: state.liveOrders.filter((o) => o.id !== payload.orderId),
    })),

  optimisticStatusUpdate: (orderId, newStatus) =>
    set((state) => ({
      liveOrders: state.liveOrders
        .map((o) => (o.id === orderId ? { ...o, status: newStatus } : o))
        .filter((o) => !["COMPLETED", "CANCELLED", "REJECTED"].includes(o.status)),
    })),
}));
