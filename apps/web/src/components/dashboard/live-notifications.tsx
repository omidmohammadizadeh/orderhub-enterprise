"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Bell,
  ShoppingBag,
  Store,
  AlertTriangle,
  Truck,
  X,
  CheckCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getSocket } from "@/lib/socket/socket.client";
import { useAuthStore } from "@/stores/auth.store";
import type { OrderEventPayload, StoreStatusPayload, DriverAssignedPayload } from "@orderhub/shared";

interface Notification {
  id: string;
  type: "order:new" | "order:updated" | "store:status" | "dispatch:assignment" | "alert";
  title: string;
  body: string;
  timestamp: Date;
  read: boolean;
}

const ICON_MAP: Record<Notification["type"], React.ElementType> = {
  "order:new": ShoppingBag,
  "order:updated": ShoppingBag,
  "store:status": Store,
  "dispatch:assignment": Truck,
  alert: AlertTriangle,
};

const COLOR_MAP: Record<Notification["type"], string> = {
  "order:new": "text-orange-500 bg-orange-100",
  "order:updated": "text-blue-500 bg-blue-100",
  "store:status": "text-emerald-500 bg-emerald-100",
  "dispatch:assignment": "text-purple-500 bg-purple-100",
  alert: "text-red-500 bg-red-100",
};

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function LiveNotifications() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);
  const token = useAuthStore((s) => s.accessToken);

  const addNotification = useCallback((n: Omit<Notification, "id" | "timestamp" | "read">) => {
    setNotifications((prev) => [
      { ...n, id: crypto.randomUUID(), timestamp: new Date(), read: false },
      ...prev.slice(0, 49),
    ]);
  }, []);

  useEffect(() => {
    if (!token) return;
    const socket = getSocket(token);

    const onOrderNew = (data: OrderEventPayload) => {
      addNotification({
        type: "order:new",
        title: "New order",
        body: `#${data.displayId ?? "–"} received from ${data.platform}`,
      });
    };

    const onOrderUpdated = (data: OrderEventPayload) => {
      addNotification({
        type: "order:updated",
        title: "Order updated",
        body: `#${data.displayId ?? "–"} → ${data.status}`,
      });
    };

    const onStoreStatus = (data: StoreStatusPayload) => {
      addNotification({
        type: "store:status",
        title: "Store status changed",
        body: `${data.locationName} is now ${data.status}`,
      });
    };

    const onDriverAssigned = (data: DriverAssignedPayload) => {
      addNotification({
        type: "dispatch:assignment",
        title: "Driver assigned",
        body: `${data.driverName} assigned to order #${data.displayId}`,
      });
    };

    socket.on("order:new", onOrderNew);
    socket.on("order:updated", onOrderUpdated);
    socket.on("store:emergency-closed", onStoreStatus);
    socket.on("dispatch:driver:assigned", onDriverAssigned);

    return () => {
      socket.off("order:new", onOrderNew);
      socket.off("order:updated", onOrderUpdated);
      socket.off("store:emergency-closed", onStoreStatus);
      socket.off("dispatch:driver:assigned", onDriverAssigned);
    };
  }, [token, addNotification]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const unreadCount = notifications.filter((n) => !n.read).length;

  const markAllRead = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  };

  const dismiss = (id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  };

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => {
          setOpen((v) => !v);
          if (!open) markAllRead();
        }}
        className="relative flex h-9 w-9 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 transition-colors"
        aria-label="Notifications"
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-orange-500 text-[9px] font-bold text-white leading-none">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-11 z-50 w-80 rounded-2xl border border-zinc-200 bg-white shadow-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100">
            <span className="text-sm font-semibold text-zinc-900">Notifications</span>
            {notifications.length > 0 && (
              <button
                onClick={markAllRead}
                className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-700 transition-colors"
              >
                <CheckCheck className="w-3.5 h-3.5" />
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="py-10 text-center text-sm text-zinc-400">
                <Bell className="w-8 h-8 mx-auto mb-2 text-zinc-200" />
                No notifications yet
              </div>
            ) : (
              notifications.map((n) => {
                const Icon = ICON_MAP[n.type];
                return (
                  <div
                    key={n.id}
                    className={cn(
                      "flex items-start gap-3 px-4 py-3 border-b border-zinc-50 last:border-0",
                      !n.read && "bg-orange-50/50",
                    )}
                  >
                    <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5", COLOR_MAP[n.type])}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-zinc-900">{n.title}</div>
                      <div className="text-xs text-zinc-500 mt-0.5">{n.body}</div>
                      <div className="text-[10px] text-zinc-400 mt-1">{timeAgo(n.timestamp)}</div>
                    </div>
                    <button
                      onClick={() => dismiss(n.id)}
                      className="text-zinc-300 hover:text-zinc-500 flex-shrink-0 mt-0.5"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
