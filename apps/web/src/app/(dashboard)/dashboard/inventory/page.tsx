"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Package,
  AlertTriangle,
  Plus,
  ChevronRight,
  Loader2,
  X,
  Truck,
  BarChart3,
  ClipboardList,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
} from "lucide-react";
import { apiClient } from "@/lib/api/client";
import { useAuthStore } from "@/stores/auth.store";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { cn } from "@/lib/utils";

type Tab = "stock" | "suppliers" | "purchase-orders";

interface Ingredient {
  id: string;
  name: string;
  unit: string;
  costPerUnit: string;
  lowStockAlert: number | null;
  isActive: boolean;
  stockLevel: { quantity: string } | null;
  supplier: { name: string } | null;
}

interface Supplier {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  isActive: boolean;
}

interface PurchaseOrder {
  id: string;
  status: string;
  totalCost: string;
  orderedAt: string | null;
  expectedAt: string | null;
  receivedAt: string | null;
  notes: string | null;
  supplier: { name: string };
  lines: Array<{ id: string; ingredient: { name: string; unit: string }; quantity: string; unitCost: string; totalCost: string; receivedQty: string | null }>;
}

const PO_STATUS_COLORS: Record<string, string> = {
  DRAFT:     "bg-zinc-100 text-zinc-600",
  SUBMITTED: "bg-blue-100 text-blue-700",
  ORDERED:   "bg-purple-100 text-purple-700",
  PARTIAL:   "bg-amber-100 text-amber-700",
  RECEIVED:  "bg-emerald-100 text-emerald-700",
  CANCELLED: "bg-red-100 text-red-600",
};

export default function InventoryPage() {
  const { user } = useAuthStore();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("stock");
  // Phase AR — read selected location from the sidebar switcher
  // instead of a local state slot. "" means "All locations" — the
  // inventory API treats absent locationId as no filter.
  const sidebarLocationId = useSelectedLocationStore(
    (s) => s.selectedLocationId,
  );
  const selectedLocation = sidebarLocationId ?? "";
  const [showAddIngredient, setShowAddIngredient] = useState(false);
  const [showAddSupplier, setShowAddSupplier] = useState(false);
  const [showCreatePO, setShowCreatePO] = useState(false);
  const [selectedPO, setSelectedPO] = useState<string | null>(null);
  const [adjustTarget, setAdjustTarget] = useState<string | null>(null);
  const [adjustQty, setAdjustQty] = useState("");
  const [adjustType, setAdjustType] = useState("ADJUSTMENT");
  const [ingredientForm, setIngredientForm] = useState({ name: "", unit: "g", costPerUnit: "", lowStockAlert: "" });
  const [supplierForm, setSupplierForm] = useState({ name: "", email: "", phone: "" });

  const { data: ingredients, isLoading: ingLoading } = useQuery({
    queryKey: ["ingredients", selectedLocation],
    queryFn: () =>
      apiClient
        .get(`/v1/inventory/ingredients${selectedLocation ? `?locationId=${selectedLocation}` : ""}`)
        .then((r) => r.data as Ingredient[]),
  });

  const { data: suppliers, isLoading: supLoading } = useQuery({
    queryKey: ["suppliers"],
    queryFn: () => apiClient.get("/v1/inventory/suppliers").then((r) => r.data as Supplier[]),
    enabled: tab === "suppliers",
  });

  const { data: purchaseOrders, isLoading: poLoading } = useQuery({
    queryKey: ["purchase-orders", selectedLocation],
    queryFn: () =>
      apiClient
        .get(`/v1/inventory/purchase-orders${selectedLocation ? `?locationId=${selectedLocation}` : ""}`)
        .then((r) => r.data as PurchaseOrder[]),
    enabled: tab === "purchase-orders",
  });

  const lowStock = ingredients?.filter(
    (i) => i.lowStockAlert !== null && parseFloat(i.stockLevel?.quantity ?? "999") <= i.lowStockAlert,
  ) ?? [];

  const createIngredientMutation = useMutation({
    mutationFn: (dto: typeof ingredientForm) =>
      apiClient.post("/v1/inventory/ingredients", { ...dto, locationId: selectedLocation, costPerUnit: parseFloat(dto.costPerUnit), lowStockAlert: dto.lowStockAlert ? parseInt(dto.lowStockAlert) : null }).then((r) => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["ingredients"] }); setShowAddIngredient(false); setIngredientForm({ name: "", unit: "g", costPerUnit: "", lowStockAlert: "" }); },
  });

  const createSupplierMutation = useMutation({
    mutationFn: (dto: typeof supplierForm) => apiClient.post("/v1/inventory/suppliers", dto).then((r) => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["suppliers"] }); setShowAddSupplier(false); setSupplierForm({ name: "", email: "", phone: "" }); },
  });

  const adjustMutation = useMutation({
    mutationFn: ({ id, qty, type }: { id: string; qty: number; type: string }) =>
      apiClient.post(`/v1/inventory/ingredients/${id}/adjust`, { quantity: qty, type }).then((r) => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["ingredients"] }); setAdjustTarget(null); setAdjustQty(""); },
  });

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">Inventory</h1>
          <p className="text-sm text-zinc-500 mt-0.5">Stock levels, recipes, suppliers, and purchase orders</p>
        </div>
        <div className="flex items-center gap-3">
          {tab === "stock" && (
            <button onClick={() => setShowAddIngredient(true)} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-900 text-white hover:bg-zinc-700 text-sm font-medium">
              <Plus className="w-4 h-4" /> Add ingredient
            </button>
          )}
          {tab === "suppliers" && (
            <button onClick={() => setShowAddSupplier(true)} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-900 text-white hover:bg-zinc-700 text-sm font-medium">
              <Plus className="w-4 h-4" /> Add supplier
            </button>
          )}
          {tab === "purchase-orders" && (
            <button onClick={() => setShowCreatePO(true)} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-900 text-white hover:bg-zinc-700 text-sm font-medium">
              <Plus className="w-4 h-4" /> Create PO
            </button>
          )}
        </div>
      </div>

      {/* Low stock banner */}
      {lowStock.length > 0 && (
        <div className="flex items-center gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
          <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0" />
          <div className="text-sm text-amber-700">
            <strong>{lowStock.length} ingredient{lowStock.length > 1 ? "s" : ""}</strong> below alert threshold:{" "}
            {lowStock.map((i) => i.name).join(", ")}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-zinc-100 rounded-xl w-fit">
        {([
          { key: "stock", label: "Stock", icon: Package },
          { key: "suppliers", label: "Suppliers", icon: Truck },
          { key: "purchase-orders", label: "Purchase Orders", icon: ClipboardList },
        ] as const).map(({ key, label, icon: Icon }) => (
          <button key={key} onClick={() => setTab(key)}
            className={cn("flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors",
              tab === key ? "bg-white shadow-sm text-zinc-900" : "text-zinc-500 hover:text-zinc-700")}>
            <Icon className="w-4 h-4" />{label}
          </button>
        ))}
      </div>

      {/* STOCK TAB */}
      {tab === "stock" && (
        <>
          {showAddIngredient && (
            <div className="bg-white border border-zinc-200 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-medium text-zinc-900">Add ingredient</h3>
                <button onClick={() => setShowAddIngredient(false)}><X className="w-4 h-4 text-zinc-400" /></button>
              </div>
              <div className="grid grid-cols-2 gap-4">
                {[
                  { key: "name", label: "Name", placeholder: "Flour" },
                  { key: "unit", label: "Unit", placeholder: "g" },
                  { key: "costPerUnit", label: "Cost per unit (£)", placeholder: "0.002" },
                  { key: "lowStockAlert", label: "Low stock alert", placeholder: "500" },
                ].map(({ key, label, placeholder }) => (
                  <div key={key}>
                    <label className="block text-xs font-medium text-zinc-600 mb-1">{label}</label>
                    <input value={ingredientForm[key as keyof typeof ingredientForm]}
                      onChange={(e) => setIngredientForm((f) => ({ ...f, [key]: e.target.value }))}
                      placeholder={placeholder}
                      className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500" />
                  </div>
                ))}
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowAddIngredient(false)} className="px-4 py-2 border border-zinc-200 rounded-lg text-sm font-medium">Cancel</button>
                <button onClick={() => createIngredientMutation.mutate(ingredientForm)} disabled={createIngredientMutation.isPending || !ingredientForm.name}
                  className="px-4 py-2 bg-zinc-900 text-white rounded-lg text-sm font-medium disabled:opacity-50 flex items-center gap-2">
                  {createIngredientMutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Add
                </button>
              </div>
            </div>
          )}

          {ingLoading ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-zinc-400" /></div>
          ) : !ingredients?.length ? (
            <div className="text-center py-16 text-zinc-500">
              <Package className="w-10 h-10 mx-auto mb-3 text-zinc-300" />
              No ingredients yet. Add your first to start tracking stock.
            </div>
          ) : (
            <div className="bg-white border border-zinc-200 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-100">
                    {["Ingredient", "Unit", "In stock", "Alert at", "Cost/unit", "Supplier", ""].map((h) => (
                      <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wide">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ingredients.map((ing) => {
                    const qty = parseFloat(ing.stockLevel?.quantity ?? "0");
                    const isLow = ing.lowStockAlert !== null && qty <= ing.lowStockAlert;
                    return (
                      <tr key={ing.id} className="border-b border-zinc-50 last:border-0 hover:bg-zinc-50">
                        <td className="px-4 py-3 font-medium text-zinc-900">{ing.name}</td>
                        <td className="px-4 py-3 text-zinc-500">{ing.unit}</td>
                        <td className="px-4 py-3">
                          <span className={cn("font-semibold", isLow ? "text-red-600" : "text-zinc-900")}>
                            {qty.toFixed(1)}
                          </span>
                          {isLow && <AlertTriangle className="inline w-3.5 h-3.5 text-amber-500 ml-1" />}
                        </td>
                        <td className="px-4 py-3 text-zinc-500">{ing.lowStockAlert ?? "—"}</td>
                        <td className="px-4 py-3 text-zinc-600">£{parseFloat(ing.costPerUnit).toFixed(4)}</td>
                        <td className="px-4 py-3 text-zinc-500 text-xs">{ing.supplier?.name ?? "—"}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            <button onClick={() => { setAdjustTarget(ing.id); setAdjustType("ADJUSTMENT"); }}
                              className="p-1 rounded hover:bg-zinc-100 text-zinc-400 hover:text-zinc-700">
                              <BarChart3 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Adjust modal */}
          {adjustTarget && (
            <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
              <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-2xl">
                <h3 className="font-semibold text-zinc-900 mb-4">Adjust stock</h3>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-zinc-600 mb-1">Type</label>
                    <select value={adjustType} onChange={(e) => setAdjustType(e.target.value)}
                      className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500">
                      {["ADJUSTMENT", "WASTE", "COUNT_CORRECTION", "TRANSFER_IN", "TRANSFER_OUT"].map((t) => (
                        <option key={t} value={t}>{t.replace(/_/g, " ")}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-zinc-600 mb-1">Quantity (use − for decrease)</label>
                    <input type="number" value={adjustQty} onChange={(e) => setAdjustQty(e.target.value)}
                      placeholder="e.g. -50 or 200"
                      className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500" />
                  </div>
                </div>
                <div className="flex gap-3 mt-5">
                  <button onClick={() => setAdjustTarget(null)} className="flex-1 py-2 border border-zinc-200 rounded-xl text-sm font-medium">Cancel</button>
                  <button onClick={() => adjustMutation.mutate({ id: adjustTarget, qty: parseFloat(adjustQty), type: adjustType })}
                    disabled={adjustMutation.isPending || !adjustQty}
                    className="flex-1 py-2 bg-zinc-900 text-white rounded-xl text-sm font-medium disabled:opacity-50">
                    Apply
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* SUPPLIERS TAB */}
      {tab === "suppliers" && (
        <>
          {showAddSupplier && (
            <div className="bg-white border border-zinc-200 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-medium text-zinc-900">Add supplier</h3>
                <button onClick={() => setShowAddSupplier(false)}><X className="w-4 h-4 text-zinc-400" /></button>
              </div>
              <div className="grid grid-cols-3 gap-4">
                {[
                  { key: "name", label: "Name", placeholder: "Sysco Foods" },
                  { key: "email", label: "Email", placeholder: "orders@sysco.com" },
                  { key: "phone", label: "Phone", placeholder: "+44 20 1234 5678" },
                ].map(({ key, label, placeholder }) => (
                  <div key={key}>
                    <label className="block text-xs font-medium text-zinc-600 mb-1">{label}</label>
                    <input value={supplierForm[key as keyof typeof supplierForm]}
                      onChange={(e) => setSupplierForm((f) => ({ ...f, [key]: e.target.value }))}
                      placeholder={placeholder}
                      className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500" />
                  </div>
                ))}
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowAddSupplier(false)} className="px-4 py-2 border border-zinc-200 rounded-lg text-sm font-medium">Cancel</button>
                <button onClick={() => createSupplierMutation.mutate(supplierForm)} disabled={createSupplierMutation.isPending || !supplierForm.name}
                  className="px-4 py-2 bg-zinc-900 text-white rounded-lg text-sm font-medium disabled:opacity-50">Add</button>
              </div>
            </div>
          )}
          {supLoading ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-zinc-400" /></div>
          ) : !suppliers?.length ? (
            <div className="text-center py-16 text-zinc-500">
              <Truck className="w-10 h-10 mx-auto mb-3 text-zinc-300" />
              No suppliers yet.
            </div>
          ) : (
            <div className="space-y-2">
              {suppliers.map((s) => (
                <div key={s.id} className="bg-white border border-zinc-200 rounded-xl px-5 py-4 flex items-center justify-between">
                  <div>
                    <div className="font-medium text-zinc-900">{s.name}</div>
                    <div className="text-sm text-zinc-500 mt-0.5 flex items-center gap-3">
                      {s.email && <span>{s.email}</span>}
                      {s.phone && <span>{s.phone}</span>}
                    </div>
                  </div>
                  <span className={cn("text-xs font-medium px-2 py-0.5 rounded-full", s.isActive ? "bg-emerald-100 text-emerald-700" : "bg-zinc-100 text-zinc-500")}>
                    {s.isActive ? "Active" : "Inactive"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* PURCHASE ORDERS TAB */}
      {tab === "purchase-orders" && (
        <>
          {poLoading ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-zinc-400" /></div>
          ) : !purchaseOrders?.length ? (
            <div className="text-center py-16 text-zinc-500">
              <ClipboardList className="w-10 h-10 mx-auto mb-3 text-zinc-300" />
              No purchase orders yet.
            </div>
          ) : (
            <div className="space-y-2">
              {purchaseOrders.map((po) => (
                <div key={po.id} className="bg-white border border-zinc-200 rounded-xl p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div>
                        <div className="font-medium text-zinc-900">{po.supplier.name}</div>
                        <div className="text-xs text-zinc-500 mt-0.5 flex items-center gap-3">
                          <span>{po.lines.length} item{po.lines.length !== 1 ? "s" : ""}</span>
                          <span>£{parseFloat(po.totalCost).toFixed(2)}</span>
                          {po.expectedAt && <span>Expected {new Date(po.expectedAt).toLocaleDateString()}</span>}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={cn("text-xs font-medium px-2 py-0.5 rounded-full", PO_STATUS_COLORS[po.status] ?? "bg-zinc-100 text-zinc-600")}>
                        {po.status}
                      </span>
                      <button onClick={() => setSelectedPO(selectedPO === po.id ? null : po.id)} className="text-zinc-400 hover:text-zinc-700">
                        <ChevronRight className={cn("w-4 h-4 transition-transform", selectedPO === po.id && "rotate-90")} />
                      </button>
                    </div>
                  </div>
                  {selectedPO === po.id && (
                    <div className="mt-3 pt-3 border-t border-zinc-100">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-zinc-400">
                            <th className="text-left pb-1">Item</th>
                            <th className="text-left pb-1">Qty</th>
                            <th className="text-left pb-1">Unit cost</th>
                            <th className="text-left pb-1">Total</th>
                            <th className="text-left pb-1">Received</th>
                          </tr>
                        </thead>
                        <tbody>
                          {po.lines.map((line) => (
                            <tr key={line.id} className="text-zinc-600">
                              <td className="py-1">{line.ingredient.name}</td>
                              <td>{line.quantity} {line.ingredient.unit}</td>
                              <td>£{parseFloat(line.unitCost).toFixed(4)}</td>
                              <td>£{parseFloat(line.totalCost).toFixed(2)}</td>
                              <td>{line.receivedQty ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
