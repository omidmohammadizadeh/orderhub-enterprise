"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  MoreHorizontal,
  Globe,
  Archive,
  Copy,
  Trash2,
  UtensilsCrossed,
  ChevronRight,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { menusClient, type Menu } from "@/lib/api/menus.client";
import { useAuthStore } from "@/stores/auth.store";
import { cn } from "@/lib/utils";

const STATUS_CONFIG = {
  DRAFT: { label: "Draft", cls: "bg-zinc-100 text-zinc-500" },
  PUBLISHED: { label: "Live", cls: "bg-emerald-50 text-emerald-700 border border-emerald-200" },
  ARCHIVED: { label: "Archived", cls: "bg-zinc-100 text-zinc-400" },
} as const;

export default function MenuPage() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const brandId = user?.brandId ?? "";

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  const { data: menus = [], isLoading } = useQuery({
    queryKey: ["menus", brandId],
    queryFn: () => menusClient.listMenus(brandId),
    enabled: !!brandId,
  });

  const createMutation = useMutation({
    mutationFn: (name: string) => menusClient.createMenu(brandId, { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["menus", brandId] });
      setCreating(false);
      setNewName("");
    },
  });

  const publishMutation = useMutation({
    mutationFn: (menuId: string) => menusClient.publishMenu(menuId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["menus", brandId] }),
  });

  const archiveMutation = useMutation({
    mutationFn: (menuId: string) => menusClient.archiveMenu(menuId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["menus", brandId] }),
  });

  const cloneMutation = useMutation({
    mutationFn: ({ menuId, name }: { menuId: string; name: string }) =>
      menusClient.cloneMenu(menuId, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["menus", brandId] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (menuId: string) => menusClient.deleteMenu(menuId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["menus", brandId] }),
  });

  const handleCreate = () => {
    if (newName.trim()) createMutation.mutate(newName.trim());
  };

  if (!brandId) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <UtensilsCrossed className="h-10 w-10 text-zinc-300 mb-4" />
        <p className="font-medium text-zinc-600">No brand configured</p>
        <p className="text-sm text-zinc-400 mt-1">Complete onboarding to set up your brand.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Menu Management</h1>
          <p className="text-sm text-zinc-500">Manage menus, categories, and items across all platforms.</p>
        </div>
        <Button
          size="sm"
          onClick={() => setCreating(true)}
          className="bg-orange-500 hover:bg-orange-600 text-white"
        >
          <Plus className="h-4 w-4 mr-1.5" />
          New menu
        </Button>
      </div>

      {creating && (
        <Card className="p-4 border-orange-200 bg-orange-50">
          <p className="text-sm font-medium text-zinc-800 mb-3">New menu name</p>
          <div className="flex gap-2">
            <Input
              autoFocus
              placeholder="e.g. Main menu, Lunch special, Delivery menu"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") { setCreating(false); setNewName(""); }
              }}
              className="flex-1 h-9 text-sm"
            />
            <Button
              size="sm"
              onClick={handleCreate}
              disabled={!newName.trim() || createMutation.isPending}
              className="bg-orange-500 hover:bg-orange-600 text-white"
            >
              Create
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setCreating(false); setNewName(""); }}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="h-20 rounded-xl bg-zinc-100 animate-pulse" />
          ))}
        </div>
      ) : menus.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 border-2 border-dashed border-zinc-200 rounded-xl">
          <UtensilsCrossed className="h-10 w-10 text-zinc-300 mb-3" />
          <p className="font-medium text-zinc-500">No menus yet</p>
          <p className="text-sm text-zinc-400 mt-1 mb-5">Create your first menu to get started</p>
          <Button
            size="sm"
            onClick={() => setCreating(true)}
            className="bg-orange-500 hover:bg-orange-600 text-white"
          >
            <Plus className="h-4 w-4 mr-1.5" />
            Create menu
          </Button>
        </div>
      ) : (
        <div className="grid gap-3">
          {menus.map((menu) => (
            <MenuCard
              key={menu.id}
              menu={menu}
              isDropdownOpen={openMenuId === menu.id}
              onToggleDropdown={() => setOpenMenuId(openMenuId === menu.id ? null : menu.id)}
              onPublish={() => { publishMutation.mutate(menu.id); setOpenMenuId(null); }}
              onArchive={() => { archiveMutation.mutate(menu.id); setOpenMenuId(null); }}
              onClone={() => { cloneMutation.mutate({ menuId: menu.id, name: `${menu.name} (copy)` }); setOpenMenuId(null); }}
              onDelete={() => { deleteMutation.mutate(menu.id); setOpenMenuId(null); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface MenuCardProps {
  menu: Menu;
  isDropdownOpen: boolean;
  onToggleDropdown: () => void;
  onPublish: () => void;
  onArchive: () => void;
  onClone: () => void;
  onDelete: () => void;
}

function MenuCard({ menu, isDropdownOpen, onToggleDropdown, onPublish, onArchive, onClone, onDelete }: MenuCardProps) {
  const cfg = STATUS_CONFIG[menu.status];
  return (
    <div className="group relative flex items-center gap-4 rounded-xl border border-zinc-200 bg-white px-5 py-4 hover:border-zinc-300 transition-colors">
      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-zinc-100">
        <UtensilsCrossed className="h-5 w-5 text-zinc-400" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="font-medium text-zinc-900 truncate">{menu.name}</p>
          <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold", cfg.cls)}>
            {cfg.label}
          </span>
        </div>
        <p className="text-xs text-zinc-400 mt-0.5">{menu._count?.categories ?? 0} categories</p>
      </div>
      <div className="flex items-center gap-2">
        <Link href={`/dashboard/menu/${menu.id}`}>
          <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs">
            Edit <ChevronRight className="h-3 w-3" />
          </Button>
        </Link>
        <div className="relative">
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onToggleDropdown}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
          {isDropdownOpen && (
            <div className="absolute right-0 top-9 z-20 w-44 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg">
              {menu.status !== "PUBLISHED" && (
                <DropItem icon={Globe} label="Publish" onClick={onPublish} />
              )}
              {menu.status === "PUBLISHED" && (
                <DropItem icon={Archive} label="Archive" onClick={onArchive} />
              )}
              <DropItem icon={Copy} label="Clone" onClick={onClone} />
              <div className="my-1 h-px bg-zinc-100" />
              <DropItem icon={Trash2} label="Delete" onClick={onDelete} danger />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DropItem({ icon: Icon, label, onClick, danger }: { icon: React.ElementType; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn("flex w-full items-center gap-2.5 px-3 py-2 text-sm transition-colors hover:bg-zinc-50", danger ? "text-red-600" : "text-zinc-700")}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}
