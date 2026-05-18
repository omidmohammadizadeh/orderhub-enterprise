"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Truck,
  Plus,
  MapPin,
  Phone,
  CheckCircle2,
  Clock,
  XCircle,
  Loader2,
  Circle,
} from "lucide-react";
import { apiClient } from "@/lib/api/client";
import { cn } from "@/lib/utils";

interface Driver {
  id: string;
  name: string;
  phone: string | null;
  vehicleType: string | null;
  licensePlate: string | null;
  isActive: boolean;
  currentAssignment: {
    orderId: string;
    displayId: string;
    status: string;
    assignedAt: string;
  } | null;
}

const STATUS_COLORS: Record<string, string> = {
  ASSIGNED: "text-amber-700 bg-amber-100",
  ACCEPTED: "text-blue-700 bg-blue-100",
  PICKED_UP: "text-purple-700 bg-purple-100",
  DELIVERED: "text-emerald-700 bg-emerald-100",
  CANCELLED: "text-zinc-500 bg-zinc-100",
};

export default function DriversPage() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", vehicleType: "CAR", licensePlate: "" });

  const { data: drivers, isLoading } = useQuery({
    queryKey: ["drivers"],
    queryFn: () => apiClient.get("/v1/drivers").then((r) => r.data as Driver[]),
    refetchInterval: 15_000,
  });

  const createMutation = useMutation({
    mutationFn: (dto: typeof form) => apiClient.post("/v1/drivers", dto).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["drivers"] });
      setShowForm(false);
      setForm({ name: "", phone: "", vehicleType: "CAR", licensePlate: "" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (driver: Driver) =>
      apiClient.patch(`/v1/drivers/${driver.id}`, { isActive: !driver.isActive }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["drivers"] }),
  });

  const activeDrivers = drivers?.filter((d) => d.isActive) ?? [];
  const inactiveDrivers = drivers?.filter((d) => !d.isActive) ?? [];

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">Drivers</h1>
          <p className="text-sm text-zinc-500 mt-0.5">Manage your delivery driver fleet</p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-900 text-white hover:bg-zinc-700 text-sm font-medium"
        >
          <Plus className="w-4 h-4" />
          Add driver
        </button>
      </div>

      {showForm && (
        <div className="bg-white border border-zinc-200 rounded-xl p-5 space-y-4">
          <h3 className="font-medium text-zinc-900">Add new driver</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">Full name</label>
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                placeholder="Jane Smith"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">Phone</label>
              <input
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                placeholder="+1 555 000 1234"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">Vehicle type</label>
              <select
                value={form.vehicleType}
                onChange={(e) => setForm((f) => ({ ...f, vehicleType: e.target.value }))}
                className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              >
                <option value="CAR">Car</option>
                <option value="MOTORCYCLE">Motorcycle</option>
                <option value="BICYCLE">Bicycle</option>
                <option value="VAN">Van</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">License plate</label>
              <input
                value={form.licensePlate}
                onChange={(e) => setForm((f) => ({ ...f, licensePlate: e.target.value }))}
                className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-orange-500 uppercase"
                placeholder="ABC 1234"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowForm(false)}
              className="px-4 py-2 rounded-lg border border-zinc-200 text-sm font-medium text-zinc-700"
            >
              Cancel
            </button>
            <button
              onClick={() => createMutation.mutate(form)}
              disabled={createMutation.isPending || !form.name}
              className="px-4 py-2 rounded-lg bg-zinc-900 text-white text-sm font-medium disabled:opacity-50 flex items-center gap-2"
            >
              {createMutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Add driver
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
        </div>
      ) : !drivers?.length ? (
        <div className="text-center py-16 text-zinc-500">
          <Truck className="w-10 h-10 mx-auto mb-3 text-zinc-300" />
          No drivers yet. Add your first driver to get started.
        </div>
      ) : (
        <div className="space-y-4">
          {activeDrivers.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">
                Active ({activeDrivers.length})
              </div>
              <div className="space-y-2">
                {activeDrivers.map((driver) => (
                  <DriverCard key={driver.id} driver={driver} onToggle={() => toggleMutation.mutate(driver)} />
                ))}
              </div>
            </div>
          )}

          {inactiveDrivers.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">
                Inactive ({inactiveDrivers.length})
              </div>
              <div className="space-y-2 opacity-60">
                {inactiveDrivers.map((driver) => (
                  <DriverCard key={driver.id} driver={driver} onToggle={() => toggleMutation.mutate(driver)} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DriverCard({ driver, onToggle }: { driver: Driver; onToggle: () => void }) {
  return (
    <div className="bg-white border border-zinc-200 rounded-xl p-4 flex items-center justify-between">
      <div className="flex items-center gap-4">
        <div className="relative">
          <div className="w-10 h-10 rounded-full bg-zinc-200 flex items-center justify-center text-sm font-semibold text-zinc-600">
            {(driver.name[0] ?? "?").toUpperCase()}
          </div>
          <Circle
            className={cn(
              "absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5",
              driver.isActive ? "text-emerald-500 fill-emerald-500" : "text-zinc-300 fill-zinc-300",
            )}
          />
        </div>
        <div>
          <div className="text-sm font-medium text-zinc-900">{driver.name}</div>
          <div className="flex items-center gap-3 text-xs text-zinc-500 mt-0.5">
            {driver.phone && (
              <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{driver.phone}</span>
            )}
            {driver.vehicleType && (
              <span className="flex items-center gap-1"><Truck className="w-3 h-3" />{driver.vehicleType}</span>
            )}
            {driver.licensePlate && (
              <span className="font-mono">{driver.licensePlate}</span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        {driver.currentAssignment ? (
          <div className="text-right">
            <div className={cn("text-xs font-medium px-2 py-1 rounded-full", STATUS_COLORS[driver.currentAssignment.status] ?? "bg-zinc-100 text-zinc-600")}>
              {driver.currentAssignment.status.replace("_", " ")}
            </div>
            <div className="text-xs text-zinc-500 mt-0.5">Order #{driver.currentAssignment.displayId}</div>
          </div>
        ) : driver.isActive ? (
          <div className="flex items-center gap-1 text-xs text-emerald-600">
            <CheckCircle2 className="w-3.5 h-3.5" />
            Available
          </div>
        ) : (
          <div className="flex items-center gap-1 text-xs text-zinc-400">
            <XCircle className="w-3.5 h-3.5" />
            Inactive
          </div>
        )}
        <button
          onClick={onToggle}
          className={cn(
            "text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors",
            driver.isActive
              ? "border-zinc-200 text-zinc-600 hover:bg-zinc-50"
              : "border-emerald-200 text-emerald-700 hover:bg-emerald-50",
          )}
        >
          {driver.isActive ? "Deactivate" : "Activate"}
        </button>
      </div>
    </div>
  );
}
