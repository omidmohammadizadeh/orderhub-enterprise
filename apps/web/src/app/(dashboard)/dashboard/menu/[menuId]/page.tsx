"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Plus,
  Trash2,
  GripVertical,
  ToggleLeft,
  ToggleRight,
  Pencil,
  ChevronDown,
  ChevronRight,
  Globe,
  Package,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { menusClient, type MenuWithCategories, type MenuCategory, type MenuItem } from "@/lib/api/menus.client";
import { ImportMenuDialog } from "@/components/menu/import-menu-dialog";
import { Download } from "lucide-react";
import { useAuthStore } from "@/stores/auth.store";
import { cn } from "@/lib/utils";

export default function MenuEditorPage() {
  const { menuId } = useParams<{ menuId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const brandId = user?.brandId ?? "";

  const [addingCategory, setAddingCategory] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());
  const [addingItemToCat, setAddingItemToCat] = useState<string | null>(null);
  const [itemDialogOpen, setItemDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<Partial<MenuItem> | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const { data: menu, isLoading } = useQuery({
    queryKey: ["menu", menuId],
    queryFn: () => menusClient.getMenu(menuId),
  });

  const { data: allItems = [] } = useQuery({
    queryKey: ["items", brandId],
    queryFn: () => menusClient.listItems(brandId),
    enabled: !!brandId,
  });

  const publishMutation = useMutation({
    mutationFn: () => menusClient.publishMenu(menuId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["menu", menuId] }),
  });

  const addCatMutation = useMutation({
    mutationFn: (name: string) => menusClient.createCategory(menuId, { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["menu", menuId] });
      setAddingCategory(false);
      setNewCatName("");
    },
  });

  const deleteCatMutation = useMutation({
    mutationFn: (catId: string) => menusClient.deleteCategory(catId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["menu", menuId] }),
  });

  const toggleItemMutation = useMutation({
    mutationFn: (itemId: string) => menusClient.toggleAvailability(itemId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["menu", menuId] });
      qc.invalidateQueries({ queryKey: ["items", brandId] });
    },
  });

  const createItemMutation = useMutation({
    mutationFn: (data: Partial<MenuItem>) =>
      menusClient.createItem(brandId, {
        name: data.name ?? "",
        description: data.description,
        basePrice: Number(data.basePrice ?? 0),
        isAvailable: true,
        modifierGroups: [],
        allergens: [],
      } as any),
    onSuccess: (newItem) => {
      qc.invalidateQueries({ queryKey: ["items", brandId] });
      if (addingItemToCat) {
        menusClient.addItemToCategory(addingItemToCat, { itemId: newItem.id }).then(() => {
          qc.invalidateQueries({ queryKey: ["menu", menuId] });
        });
      }
      setItemDialogOpen(false);
      setEditingItem(null);
    },
  });

  const addItemToCatMutation = useMutation({
    mutationFn: ({ catId, itemId }: { catId: string; itemId: string }) =>
      menusClient.addItemToCategory(catId, { itemId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["menu", menuId] }),
  });

  const removeFromCatMutation = useMutation({
    mutationFn: ({ catId, itemId }: { catId: string; itemId: string }) =>
      menusClient.removeItemFromCategory(catId, itemId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["menu", menuId] }),
  });

  const toggleCat = (catId: string) => {
    const next = new Set(expandedCats);
    next.has(catId) ? next.delete(catId) : next.add(catId);
    setExpandedCats(next);
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-10 w-48 bg-zinc-100 rounded-lg animate-pulse" />
        <div className="h-64 bg-zinc-100 rounded-xl animate-pulse" />
      </div>
    );
  }

  if (!menu) {
    return <div className="text-zinc-500 text-sm">Menu not found.</div>;
  }

  const linkedItemIds = new Set(
    menu.categories.flatMap((c) => c.items.map((i) => i.itemId)),
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-semibold text-zinc-900 truncate">{menu.name}</h1>
          <p className="text-xs text-zinc-400">
            {menu.status === "PUBLISHED" ? "Live on all connected channels" : "Draft — not visible to customers"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setImportOpen(true)}
            className="gap-1.5"
          >
            <Download className="h-3.5 w-3.5" />
            Import from Uber / Deliveroo
          </Button>
          {menu.status !== "PUBLISHED" && (
            <Button
              size="sm"
              onClick={() => publishMutation.mutate()}
              disabled={publishMutation.isPending}
              className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
            >
              <Globe className="h-3.5 w-3.5" />
              Publish
            </Button>
          )}
          {menu.status === "PUBLISHED" && (
            <Badge className="bg-emerald-50 text-emerald-700 border border-emerald-200 font-medium">
              Live
            </Badge>
          )}
        </div>
      </div>

      <ImportMenuDialog
        menuId={menuId}
        open={importOpen}
        onClose={() => setImportOpen(false)}
      />

      {/* Category list */}
      <div className="space-y-3">
        {menu.categories.map((cat) => (
          <CategoryBlock
            key={cat.id}
            cat={cat}
            expanded={expandedCats.has(cat.id)}
            onToggle={() => toggleCat(cat.id)}
            onDelete={() => deleteCatMutation.mutate(cat.id)}
            onToggleItem={(itemId) => toggleItemMutation.mutate(itemId)}
            onRemoveItem={(itemId) => removeFromCatMutation.mutate({ catId: cat.id, itemId })}
            onAddItem={() => setAddingItemToCat(cat.id)}
          />
        ))}
      </div>

      {/* Add category */}
      {addingCategory ? (
        <Card className="p-4 border-zinc-200">
          <div className="flex gap-2">
            <Input
              autoFocus
              placeholder="Category name"
              value={newCatName}
              onChange={(e) => setNewCatName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newCatName.trim()) addCatMutation.mutate(newCatName.trim());
                if (e.key === "Escape") { setAddingCategory(false); setNewCatName(""); }
              }}
              className="h-9 text-sm flex-1"
            />
            <Button size="sm" onClick={() => addCatMutation.mutate(newCatName.trim())} disabled={!newCatName.trim()} className="bg-orange-500 hover:bg-orange-600 text-white">Add</Button>
            <Button size="sm" variant="outline" onClick={() => { setAddingCategory(false); setNewCatName(""); }}>Cancel</Button>
          </div>
        </Card>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="w-full border-dashed h-10 text-zinc-400 hover:text-zinc-700"
          onClick={() => setAddingCategory(true)}
        >
          <Plus className="h-4 w-4 mr-1.5" />
          Add category
        </Button>
      )}

      {/* Add item to category picker */}
      {addingItemToCat && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-4">
          <Card className="w-full max-w-md p-5">
            <div className="flex items-center justify-between mb-4">
              <p className="font-semibold text-zinc-900">Add item to category</p>
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setAddingItemToCat(null)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {allItems
                .filter((item) => !linkedItemIds.has(item.id))
                .map((item) => (
                  <button
                    key={item.id}
                    className="flex w-full items-center justify-between rounded-lg border border-zinc-200 px-3 py-2.5 text-sm hover:bg-zinc-50 transition-colors"
                    onClick={() => {
                      addItemToCatMutation.mutate({ catId: addingItemToCat, itemId: item.id });
                      setAddingItemToCat(null);
                    }}
                  >
                    <span className="font-medium text-zinc-800">{item.name}</span>
                    <span className="text-zinc-400">£{Number(item.basePrice).toFixed(2)}</span>
                  </button>
                ))}
              {allItems.filter((item) => !linkedItemIds.has(item.id)).length === 0 && (
                <p className="text-sm text-zinc-400 text-center py-6">No more items to add</p>
              )}
            </div>
            <div className="mt-4 pt-4 border-t">
              <Button
                size="sm"
                className="w-full bg-orange-500 hover:bg-orange-600 text-white"
                onClick={() => {
                  setItemDialogOpen(true);
                  setEditingItem({});
                }}
              >
                <Plus className="h-4 w-4 mr-1.5" />
                Create new item
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* Create item dialog */}
      {itemDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-4">
          <Card className="w-full max-w-lg p-5">
            <div className="flex items-center justify-between mb-4">
              <p className="font-semibold text-zinc-900">New menu item</p>
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setItemDialogOpen(false); setEditingItem(null); }}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-3">
              <div>
                <Label className="text-xs text-zinc-500 mb-1">Name</Label>
                <Input
                  autoFocus
                  placeholder="e.g. Cheeseburger"
                  value={editingItem?.name ?? ""}
                  onChange={(e) => setEditingItem((p) => ({ ...p, name: e.target.value }))}
                  className="h-9 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs text-zinc-500 mb-1">Description (optional)</Label>
                <Input
                  placeholder="Short description"
                  value={editingItem?.description ?? ""}
                  onChange={(e) => setEditingItem((p) => ({ ...p, description: e.target.value }))}
                  className="h-9 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs text-zinc-500 mb-1">Base price (£)</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                  value={editingItem?.basePrice ?? ""}
                  onChange={(e) => setEditingItem((p) => ({ ...p, basePrice: parseFloat(e.target.value) || 0 }))}
                  className="h-9 text-sm"
                />
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <Button
                className="flex-1 bg-orange-500 hover:bg-orange-600 text-white"
                size="sm"
                onClick={() => createItemMutation.mutate(editingItem ?? {})}
                disabled={!editingItem?.name?.trim() || createItemMutation.isPending}
              >
                Create item
              </Button>
              <Button variant="outline" size="sm" onClick={() => { setItemDialogOpen(false); setEditingItem(null); }}>
                Cancel
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

// ── Category block ─────────────────────────────────────────────────────────────

interface CategoryBlockProps {
  cat: MenuCategory;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onToggleItem: (itemId: string) => void;
  onRemoveItem: (itemId: string) => void;
  onAddItem: () => void;
}

function CategoryBlock({ cat, expanded, onToggle, onDelete, onToggleItem, onRemoveItem, onAddItem }: CategoryBlockProps) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <GripVertical className="h-4 w-4 text-zinc-300 flex-shrink-0" />
        <button onClick={onToggle} className="flex flex-1 items-center gap-2 text-left min-w-0">
          {expanded ? <ChevronDown className="h-4 w-4 text-zinc-400" /> : <ChevronRight className="h-4 w-4 text-zinc-400" />}
          <span className="font-medium text-zinc-900 truncate">{cat.name}</span>
          <span className="text-xs text-zinc-400 flex-shrink-0">{cat.items.length} items</span>
        </button>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-zinc-500 hover:text-zinc-900" onClick={onAddItem}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add item
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7 text-zinc-400 hover:text-red-500" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-zinc-100 divide-y divide-zinc-50">
          {cat.items.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-zinc-400">
              No items — <button className="text-orange-500 hover:underline" onClick={onAddItem}>add one</button>
            </div>
          ) : (
            cat.items.map(({ item, itemId }) => (
              <div key={itemId} className="flex items-center gap-3 px-4 py-3">
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-zinc-100">
                  <Package className="h-4 w-4 text-zinc-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className={cn("text-sm font-medium truncate", !item.isAvailable && "line-through text-zinc-400")}>
                    {item.name}
                  </p>
                  <p className="text-xs text-zinc-400">£{Number(item.basePrice).toFixed(2)}</p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => onToggleItem(itemId)}
                    className={cn("h-7 w-12 rounded-full transition-colors text-xs font-medium flex items-center justify-center gap-1",
                      item.isAvailable
                        ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                        : "bg-zinc-100 text-zinc-400 hover:bg-zinc-200"
                    )}
                  >
                    {item.isAvailable ? <ToggleRight className="h-3.5 w-3.5" /> : <ToggleLeft className="h-3.5 w-3.5" />}
                  </button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-zinc-300 hover:text-red-400"
                    onClick={() => onRemoveItem(itemId)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
