"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Users,
  Search,
  Plus,
  Star,
  Phone,
  Mail,
  MapPin,
  ShoppingBag,
  ChevronRight,
  X,
  Loader2,
  Gift,
  TrendingUp,
  Tag,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import { apiClient } from "@/lib/api/client";
import { useAuthStore } from "@/stores/auth.store";
import { cn } from "@/lib/utils";

interface Customer {
  id: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  totalOrders: number;
  totalSpend: string;
  createdAt: string;
  loyaltyAccount: {
    points: number;
    tier: string;
    lifetimeSpend: string;
  } | null;
}

interface PromoCode {
  id: string;
  code: string;
  type: "PERCENTAGE" | "FIXED_AMOUNT" | "FREE_DELIVERY";
  value: string;
  minOrderAmount: string | null;
  maxUses: number | null;
  usedCount: number;
  isActive: boolean;
  expiresAt: string | null;
  locationId: string | null;
}

type Tab = "customers" | "promos";

const TIER_COLORS: Record<string, string> = {
  BRONZE: "text-amber-700 bg-amber-100",
  SILVER: "text-zinc-600 bg-zinc-100",
  GOLD: "text-yellow-700 bg-yellow-100",
  PLATINUM: "text-purple-700 bg-purple-100",
};

export default function CustomersPage() {
  const { user } = useAuthStore();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("customers");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedCustomer, setSelectedCustomer] = useState<string | null>(null);
  const [showPromoForm, setShowPromoForm] = useState(false);
  const [promoForm, setPromoForm] = useState({
    code: "",
    type: "PERCENTAGE" as PromoCode["type"],
    value: "",
    minOrderAmount: "",
    maxUses: "",
    expiresAt: "",
  });

  const searchTimer = useState<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = (val: string) => {
    setSearch(val);
    if (searchTimer[0]) clearTimeout(searchTimer[0]);
    searchTimer[1](setTimeout(() => setDebouncedSearch(val), 300));
  };

  const { data: customersData, isLoading: custLoading } = useQuery({
    queryKey: ["customers", user?.tenantId, debouncedSearch],
    queryFn: () =>
      apiClient
        .get(`/v1/customers`, { params: { search: debouncedSearch || undefined, limit: 50 } })
        .then((r) => r.data as { customers: Customer[]; total: number }),
    enabled: !!user?.tenantId && tab === "customers",
  });

  const { data: selectedCust } = useQuery({
    queryKey: ["customer", selectedCustomer],
    queryFn: () =>
      apiClient.get(`/v1/customers/${selectedCustomer}`).then((r) => r.data as Customer & {
        addresses: Array<{ id: string; label: string; street: string; city: string }>;
        recentOrders: Array<{ id: string; displayId: string; total: string; status: string; createdAt: string }>;
      }),
    enabled: !!selectedCustomer,
  });

  const { data: promosData, isLoading: promoLoading } = useQuery({
    queryKey: ["promos", user?.tenantId],
    queryFn: () =>
      apiClient.get(`/v1/promo-codes`).then((r) => r.data as PromoCode[]),
    enabled: !!user?.tenantId && tab === "promos",
  });

  const createPromoMutation = useMutation({
    mutationFn: (dto: typeof promoForm) =>
      apiClient.post(`/v1/promo-codes`, {
        ...dto,
        value: parseFloat(dto.value),
        minOrderAmount: dto.minOrderAmount ? parseFloat(dto.minOrderAmount) : null,
        maxUses: dto.maxUses ? parseInt(dto.maxUses) : null,
        expiresAt: dto.expiresAt || null,
      }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["promos"] });
      setShowPromoForm(false);
      setPromoForm({ code: "", type: "PERCENTAGE", value: "", minOrderAmount: "", maxUses: "", expiresAt: "" });
    },
  });

  const togglePromoMutation = useMutation({
    mutationFn: (promoId: string) =>
      apiClient.patch(`/v1/promo-codes/${promoId}/toggle`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["promos"] }),
  });

  const customers = customersData?.customers ?? [];

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">Customers</h1>
          <p className="text-sm text-zinc-500 mt-0.5">CRM, loyalty tracking, and promo codes</p>
        </div>
        {tab === "promos" && (
          <button
            onClick={() => setShowPromoForm(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-900 text-white hover:bg-zinc-700 text-sm font-medium"
          >
            <Plus className="w-4 h-4" />
            New promo code
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-zinc-100 rounded-xl w-fit">
        {(["customers", "promos"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-4 py-2 rounded-lg text-sm font-medium transition-colors capitalize",
              tab === t ? "bg-white shadow-sm text-zinc-900" : "text-zinc-500 hover:text-zinc-700",
            )}
          >
            {t === "customers" ? (
              <span className="flex items-center gap-2"><Users className="w-4 h-4" /> Customers</span>
            ) : (
              <span className="flex items-center gap-2"><Tag className="w-4 h-4" /> Promo codes</span>
            )}
          </button>
        ))}
      </div>

      {tab === "customers" && (
        <div className="flex gap-4">
          {/* Customer list */}
          <div className="flex-1 min-w-0">
            <div className="relative mb-4">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
              <input
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="Search by name, email, or phone…"
                className="w-full pl-10 pr-4 py-2 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
            </div>

            {custLoading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
              </div>
            ) : customers.length === 0 ? (
              <div className="text-center py-16 text-zinc-500">
                {debouncedSearch ? "No customers found." : "No customers yet."}
              </div>
            ) : (
              <div className="space-y-1">
                {customers.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setSelectedCustomer(c.id)}
                    className={cn(
                      "w-full flex items-center justify-between p-4 rounded-xl border text-left transition-colors",
                      selectedCustomer === c.id
                        ? "border-orange-300 bg-orange-50"
                        : "border-zinc-200 bg-white hover:border-zinc-300",
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-zinc-200 flex items-center justify-center text-sm font-semibold text-zinc-600">
                        {(c.firstName?.[0] ?? c.email?.[0] ?? "?").toUpperCase()}
                      </div>
                      <div>
                        <div className="text-sm font-medium text-zinc-900">
                          {c.firstName && c.lastName
                            ? `${c.firstName} ${c.lastName}`
                            : c.email ?? c.phone ?? "Guest"}
                        </div>
                        <div className="text-xs text-zinc-500 flex items-center gap-2 mt-0.5">
                          {c.email && <span className="flex items-center gap-1"><Mail className="w-3 h-3" />{c.email}</span>}
                          {c.phone && <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{c.phone}</span>}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-zinc-500">
                      <div className="text-right hidden sm:block">
                        <div className="font-medium text-zinc-900">${parseFloat(c.totalSpend).toFixed(2)}</div>
                        <div>{c.totalOrders} orders</div>
                      </div>
                      {c.loyaltyAccount && (
                        <span className={cn("px-2 py-0.5 rounded-full text-xs font-medium", TIER_COLORS[c.loyaltyAccount.tier] ?? "bg-zinc-100 text-zinc-600")}>
                          {c.loyaltyAccount.tier}
                        </span>
                      )}
                      <ChevronRight className="w-4 h-4 text-zinc-400" />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Customer detail panel */}
          {selectedCustomer && selectedCust && (
            <div className="w-80 flex-shrink-0">
              <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden sticky top-4">
                <div className="p-5 border-b border-zinc-100">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-full bg-orange-100 flex items-center justify-center text-lg font-bold text-orange-600">
                        {(selectedCust.firstName?.[0] ?? selectedCust.email?.[0] ?? "?").toUpperCase()}
                      </div>
                      <div>
                        <div className="font-semibold text-zinc-900">
                          {selectedCust.firstName && selectedCust.lastName
                            ? `${selectedCust.firstName} ${selectedCust.lastName}`
                            : "Guest customer"}
                        </div>
                        {selectedCust.loyaltyAccount && (
                          <span className={cn("text-xs font-medium px-2 py-0.5 rounded-full", TIER_COLORS[selectedCust.loyaltyAccount.tier] ?? "bg-zinc-100 text-zinc-600")}>
                            {selectedCust.loyaltyAccount.tier}
                          </span>
                        )}
                      </div>
                    </div>
                    <button onClick={() => setSelectedCustomer(null)} className="text-zinc-400 hover:text-zinc-600">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="p-5 space-y-4">
                  {/* Contact */}
                  <div className="space-y-1.5">
                    {selectedCust.email && (
                      <div className="flex items-center gap-2 text-sm text-zinc-600">
                        <Mail className="w-4 h-4 text-zinc-400" />
                        {selectedCust.email}
                      </div>
                    )}
                    {selectedCust.phone && (
                      <div className="flex items-center gap-2 text-sm text-zinc-600">
                        <Phone className="w-4 h-4 text-zinc-400" />
                        {selectedCust.phone}
                      </div>
                    )}
                  </div>

                  {/* Stats */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-zinc-50 rounded-xl p-3 text-center">
                      <div className="text-lg font-bold text-zinc-900">{selectedCust.totalOrders}</div>
                      <div className="text-xs text-zinc-500 flex items-center justify-center gap-1 mt-0.5">
                        <ShoppingBag className="w-3 h-3" /> Orders
                      </div>
                    </div>
                    <div className="bg-zinc-50 rounded-xl p-3 text-center">
                      <div className="text-lg font-bold text-zinc-900">${parseFloat(selectedCust.totalSpend).toFixed(0)}</div>
                      <div className="text-xs text-zinc-500 flex items-center justify-center gap-1 mt-0.5">
                        <TrendingUp className="w-3 h-3" /> Spent
                      </div>
                    </div>
                  </div>

                  {/* Loyalty */}
                  {selectedCust.loyaltyAccount && (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <Star className="w-4 h-4 text-amber-500" />
                        <span className="text-sm font-medium text-zinc-900">Loyalty</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-zinc-600">Points</span>
                        <span className="font-semibold text-zinc-900">{selectedCust.loyaltyAccount.points.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between text-sm mt-1">
                        <span className="text-zinc-600">Lifetime spend</span>
                        <span className="font-semibold text-zinc-900">${parseFloat(selectedCust.loyaltyAccount.lifetimeSpend).toFixed(0)}</span>
                      </div>
                    </div>
                  )}

                  {/* Addresses */}
                  {selectedCust.addresses?.length > 0 && (
                    <div>
                      <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">Saved addresses</div>
                      <div className="space-y-1.5">
                        {selectedCust.addresses.slice(0, 2).map((addr) => (
                          <div key={addr.id} className="flex items-start gap-2 text-sm text-zinc-600">
                            <MapPin className="w-3.5 h-3.5 text-zinc-400 mt-0.5 flex-shrink-0" />
                            <span>{addr.street}, {addr.city}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Recent orders */}
                  {selectedCust.recentOrders?.length > 0 && (
                    <div>
                      <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">Recent orders</div>
                      <div className="space-y-1.5">
                        {selectedCust.recentOrders.slice(0, 4).map((o) => (
                          <div key={o.id} className="flex items-center justify-between text-sm">
                            <span className="text-zinc-600">#{o.displayId}</span>
                            <div className="flex items-center gap-2">
                              <span className="text-zinc-900 font-medium">${parseFloat(o.total).toFixed(2)}</span>
                              <span className={cn(
                                "text-xs px-1.5 py-0.5 rounded-full",
                                o.status === "DELIVERED" ? "bg-emerald-100 text-emerald-700" : "bg-zinc-100 text-zinc-600",
                              )}>
                                {o.status}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "promos" && (
        <div className="space-y-4">
          {showPromoForm && (
            <div className="bg-white border border-zinc-200 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-medium text-zinc-900">New promo code</h3>
                <button onClick={() => setShowPromoForm(false)}><X className="w-4 h-4 text-zinc-400" /></button>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Code</label>
                  <input
                    value={promoForm.code}
                    onChange={(e) => setPromoForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
                    placeholder="SUMMER20"
                    className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-orange-500 uppercase"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Type</label>
                  <select
                    value={promoForm.type}
                    onChange={(e) => setPromoForm((f) => ({ ...f, type: e.target.value as PromoCode["type"] }))}
                    className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                  >
                    <option value="PERCENTAGE">Percentage off</option>
                    <option value="FIXED_AMOUNT">Fixed amount off</option>
                    <option value="FREE_DELIVERY">Free delivery</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">
                    {promoForm.type === "PERCENTAGE" ? "Discount %" : promoForm.type === "FIXED_AMOUNT" ? "Discount amount $" : "Delivery cap $"}
                  </label>
                  <input
                    type="number"
                    value={promoForm.value}
                    onChange={(e) => setPromoForm((f) => ({ ...f, value: e.target.value }))}
                    placeholder={promoForm.type === "PERCENTAGE" ? "20" : "5.00"}
                    className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Min order ($, optional)</label>
                  <input
                    type="number"
                    value={promoForm.minOrderAmount}
                    onChange={(e) => setPromoForm((f) => ({ ...f, minOrderAmount: e.target.value }))}
                    placeholder="15.00"
                    className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Max uses (optional)</label>
                  <input
                    type="number"
                    value={promoForm.maxUses}
                    onChange={(e) => setPromoForm((f) => ({ ...f, maxUses: e.target.value }))}
                    placeholder="100"
                    className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Expires (optional)</label>
                  <input
                    type="date"
                    value={promoForm.expiresAt}
                    onChange={(e) => setPromoForm((f) => ({ ...f, expiresAt: e.target.value }))}
                    className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowPromoForm(false)}
                  className="px-4 py-2 rounded-lg border border-zinc-200 text-sm font-medium text-zinc-700"
                >
                  Cancel
                </button>
                <button
                  onClick={() => createPromoMutation.mutate(promoForm)}
                  disabled={createPromoMutation.isPending || !promoForm.code || !promoForm.value}
                  className="px-4 py-2 rounded-lg bg-zinc-900 text-white text-sm font-medium disabled:opacity-50 flex items-center gap-2"
                >
                  {createPromoMutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Create promo
                </button>
              </div>
            </div>
          )}

          {promoLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
            </div>
          ) : !promosData?.length ? (
            <div className="text-center py-16 text-zinc-500">
              <Gift className="w-10 h-10 mx-auto mb-3 text-zinc-300" />
              No promo codes yet. Create one to get started.
            </div>
          ) : (
            <div className="bg-white border border-zinc-200 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-100">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wide">Code</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wide">Discount</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wide">Usage</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wide">Expires</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wide">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {promosData.map((promo) => (
                    <tr key={promo.id} className="border-b border-zinc-50 hover:bg-zinc-50">
                      <td className="px-4 py-3">
                        <span className="font-mono font-semibold text-zinc-900">{promo.code}</span>
                      </td>
                      <td className="px-4 py-3 text-zinc-700">
                        {promo.type === "PERCENTAGE" && `${promo.value}% off`}
                        {promo.type === "FIXED_AMOUNT" && `$${parseFloat(promo.value).toFixed(2)} off`}
                        {promo.type === "FREE_DELIVERY" && "Free delivery"}
                        {promo.minOrderAmount && (
                          <span className="text-xs text-zinc-400 ml-1">(min ${parseFloat(promo.minOrderAmount).toFixed(0)})</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-zinc-600">
                        {promo.usedCount}
                        {promo.maxUses ? ` / ${promo.maxUses}` : ""}
                      </td>
                      <td className="px-4 py-3 text-zinc-600">
                        {promo.expiresAt
                          ? new Date(promo.expiresAt).toLocaleDateString()
                          : <span className="text-zinc-400">Never</span>}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => togglePromoMutation.mutate(promo.id)}
                          disabled={togglePromoMutation.isPending}
                          className="flex items-center gap-1.5 text-sm"
                        >
                          {promo.isActive ? (
                            <><ToggleRight className="w-5 h-5 text-emerald-500" /><span className="text-emerald-700">Active</span></>
                          ) : (
                            <><ToggleLeft className="w-5 h-5 text-zinc-400" /><span className="text-zinc-500">Inactive</span></>
                          )}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
