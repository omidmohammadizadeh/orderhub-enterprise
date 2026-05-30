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
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { menusClient, brandsClient, type Menu, type Brand } from "@/lib/api/menus.client";
import { useAuthStore } from "@/stores/auth.store";
import { cn } from "@/lib/utils";
import { AddMenuModal } from "@/components/menu/add-menu-modal";
import { CreateMenuModal } from "@/components/menu/create-menu-modal";
import { ImportMenuModal } from "@/components/menu/import-menu-modal";
import { PublishMenuModal } from "@/components/menu/publish-menu-modal";
import { PlatformLogo, platformLabel } from "@/components/ui/platform-logo";
import { Send, CheckCircle2 } from "lucide-react";

const STATUS_CONFIG = {
  DRAFT: { label: "Draft", cls: "bg-zinc-100 text-zinc-500" },
  PUBLISHED: { label: "Live", cls: "bg-emerald-50 text-emerald-700 border border-emerald-200" },
  ARCHIVED: { label: "Archived", cls: "bg-zinc-100 text-zinc-400" },
} as const;

export default function MenuPage() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const router = useRouter();

  // Phase AM — three-step Deliverect-style "Add a menu" flow:
  //   addStep "chooser"          → AddMenuModal with 3 cards
  //   addStep "create"           → CreateMenuModal (name, description, type,
  //                                banner 1920×1080, logo 1:1)
  //   addStep "import-channel"   → ImportMenuModal sourced from channel
  //   addStep "import-pos"       → ImportMenuModal sourced from POS
  //   addStep null               → no modal showing
  const [addStep, setAddStep] = useState<
    null | "chooser" | "create" | "import-channel" | "import-pos"
  >(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  // Phase AM — publish target picker per menu card.
  const [publishingMenu, setPublishingMenu] = useState<Menu | null>(null);
  // Phase AM — transient success toast after a publish, dismissed
  // after 4s or on next user interaction.
  const [publishToast, setPublishToast] = useState<{
    menuName: string;
    targets: string[];
  } | null>(null);
  const [selectedBrandId, setSelectedBrandId] = useState<string | null>(null);
  const [creatingBrand, setCreatingBrand] = useState(false);
  const [newBrandName, setNewBrandName] = useState("");

  // Phase AK — Platform admins / managers without an assigned brand still
  // need to manage menus. Pull the tenant's brand list; auto-select the
  // first one or fall back to user.brandId when assigned. If the tenant
  // has zero brands, surface a "create brand" CTA inline (no separate
  // onboarding round-trip required).
  const { data: brands = [], isLoading: brandsLoading } = useQuery({
    queryKey: ["brands"],
    queryFn: () => brandsClient.list(),
  });

  const brandId =
    selectedBrandId ?? user?.brandId ?? brands[0]?.id ?? "";

  const { data: menus = [], isLoading } = useQuery({
    queryKey: ["menus", brandId],
    queryFn: () => menusClient.listMenus(brandId),
    enabled: !!brandId,
  });

  const createBrandMutation = useMutation({
    mutationFn: (name: string) =>
      brandsClient.create({
        name,
        slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      }),
    onSuccess: (b) => {
      qc.invalidateQueries({ queryKey: ["brands"] });
      setSelectedBrandId(b.id);
      setCreatingBrand(false);
      setNewBrandName("");
    },
  });

  // Kept for backward-compat with the empty-state "Create menu" button
  // further down (refactored to use the modal too).
  void null;

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

  // Phase AK — bulk PLU backfill. MUST stay above the early-return branches
  // below: React requires every hook to be called in the same order on
  // every render. When `brandsLoading` flips to false and we proceed past
  // the empty-brand early return, this useMutation only "appears" on that
  // second render, which mismatches the hook list from the first render
  // and trips "Rendered more hooks than during the previous render" —
  // crashing the page with the generic "Application error" boundary.
  const generatePlusMutation = useMutation({
    mutationFn: () => menusClient.generateMissingPlus(),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["menus", brandId] });
      alert(
        `Generated PLUs: ${r.products} products, ${r.modifierGroups} groups, ${r.modifiers} modifiers.`,
      );
    },
  });

  // Phase AM — opens the Deliverect-style 3-card chooser.
  const openAddMenu = () => setAddStep("chooser");

  if (brandsLoading) {
    return (
      <div className="space-y-3">
        {[1, 2].map((i) => (
          <div key={i} className="h-20 rounded-xl bg-zinc-100 animate-pulse" />
        ))}
      </div>
    );
  }

  if (!brandId && brands.length === 0) {
    // No brands for this tenant yet — let the operator create one inline.
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <UtensilsCrossed className="h-10 w-10 text-zinc-300 mb-4" />
        <p className="font-medium text-zinc-600">No brand set up yet</p>
        <p className="text-sm text-zinc-400 mt-1 mb-5">
          Create your first brand to start building menus.
        </p>
        {creatingBrand ? (
          <Card className="p-4 border-orange-200 bg-orange-50 w-full max-w-md">
            <p className="text-sm font-medium text-zinc-800 mb-3 text-left">
              New brand name
            </p>
            <div className="flex gap-2">
              <Input
                autoFocus
                placeholder="e.g. Greek Gyros, Pizza Express"
                value={newBrandName}
                onChange={(e) => setNewBrandName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newBrandName.trim()) {
                    createBrandMutation.mutate(newBrandName.trim());
                  }
                  if (e.key === "Escape") {
                    setCreatingBrand(false);
                    setNewBrandName("");
                  }
                }}
                className="flex-1 h-9 text-sm"
              />
              <Button
                size="sm"
                onClick={() => createBrandMutation.mutate(newBrandName.trim())}
                disabled={
                  !newBrandName.trim() || createBrandMutation.isPending
                }
                className="bg-orange-500 hover:bg-orange-600 text-white"
              >
                Create
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setCreatingBrand(false);
                  setNewBrandName("");
                }}
              >
                Cancel
              </Button>
            </div>
          </Card>
        ) : (
          <Button
            size="sm"
            onClick={() => setCreatingBrand(true)}
            className="bg-orange-500 hover:bg-orange-600 text-white"
          >
            <Plus className="h-4 w-4 mr-1.5" />
            Create brand
          </Button>
        )}
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
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => generatePlusMutation.mutate()}
            disabled={generatePlusMutation.isPending}
            title="Backfill PLUs on any product, modifier group, or modifier missing one. Existing PLUs are left untouched."
          >
            Generate missing PLUs
          </Button>
          <Button
            size="sm"
            onClick={openAddMenu}
            className="bg-zinc-900 hover:bg-zinc-800 text-white"
          >
            <Plus className="h-4 w-4 mr-1.5" />
            Create menu
          </Button>
        </div>
      </div>

      {/* Phase AM — modal chain */}
      <AddMenuModal
        open={addStep === "chooser"}
        onPick={(kind) => {
          if (kind === "create") setAddStep("create");
          else if (kind === "import-channel") setAddStep("import-channel");
          else if (kind === "import-pos") setAddStep("import-pos");
        }}
        onCancel={() => setAddStep(null)}
      />
      <CreateMenuModal
        open={addStep === "create"}
        brandId={brandId}
        onCreated={(menu) => {
          qc.invalidateQueries({ queryKey: ["menus", brandId] });
          setAddStep(null);
          router.push(`/dashboard/menu/${menu.id}`);
        }}
        onCancel={() => setAddStep(null)}
      />
      <ImportMenuModal
        open={addStep === "import-channel"}
        source="channel"
        onCancel={() => setAddStep(null)}
      />
      <ImportMenuModal
        open={addStep === "import-pos"}
        source="pos"
        onCancel={() => setAddStep(null)}
      />

      {brands.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
            Brand
          </span>
          {brands.map((b) => (
            <button
              key={b.id}
              onClick={() => setSelectedBrandId(b.id)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                brandId === b.id
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300",
              )}
            >
              {b.name}
            </button>
          ))}
        </div>
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
            onClick={openAddMenu}
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
              onPublish={() => {
                // Phase AM — Publish opens a target picker (online / POS /
                // marketplace channels) rather than firing the legacy
                // single-shot publishMutation.
                setPublishingMenu(menu);
                setOpenMenuId(null);
              }}
              onArchive={() => { archiveMutation.mutate(menu.id); setOpenMenuId(null); }}
              onClone={() => { cloneMutation.mutate({ menuId: menu.id, name: `${menu.name} (copy)` }); setOpenMenuId(null); }}
              onDelete={() => { deleteMutation.mutate(menu.id); setOpenMenuId(null); }}
            />
          ))}
        </div>
      )}

      <PublishMenuModal
        open={!!publishingMenu}
        menuId={publishingMenu?.id ?? ""}
        menuName={publishingMenu?.name ?? ""}
        initiallyPublishedTo={
          ((publishingMenu as any)?.publishedTo ?? []) as string[]
        }
        onConfirmed={(targets) => {
          qc.invalidateQueries({ queryKey: ["menus", brandId] });
          // Show the success toast even when the operator unchecks
          // every target — distinguish in the copy.
          if (publishingMenu) {
            setPublishToast({
              menuName: publishingMenu.name,
              targets,
            });
            window.setTimeout(() => setPublishToast(null), 4500);
          }
          setPublishingMenu(null);
        }}
        onCancel={() => setPublishingMenu(null)}
      />

      {/* Publish success toast */}
      {publishToast && (
        <div className="fixed bottom-6 right-6 z-50 max-w-md rounded-xl border border-emerald-200 bg-white shadow-lg px-4 py-3">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="h-5 w-5 text-emerald-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-zinc-900">
                {publishToast.targets.length > 0
                  ? `${publishToast.menuName} published`
                  : `${publishToast.menuName} unpublished`}
              </p>
              {publishToast.targets.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {publishToast.targets.map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center gap-1 text-[11px] text-zinc-600"
                    >
                      <PlatformLogo platform={t} size={16} />
                      {platformLabel(t)}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-0.5 text-xs text-zinc-500">
                  No active publish targets.
                </p>
              )}
            </div>
            <button
              onClick={() => setPublishToast(null)}
              className="text-zinc-400 hover:text-zinc-700 -mt-1"
            >
              <span className="sr-only">Dismiss</span>×
            </button>
          </div>
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
  // Phase AM — show the Live badge only when the menu is actually
  // published to at least one target. status=PUBLISHED alone isn't
  // enough; an operator might toggle every target off and that needs
  // to read as Draft, not "Live" with no destinations.
  const publishedTo: string[] =
    (menu as any).publishedTo && Array.isArray((menu as any).publishedTo)
      ? (menu as any).publishedTo
      : [];
  const isLive = publishedTo.length > 0 && menu.status === "PUBLISHED";
  const lastPublishedAt: string | null =
    (menu as any).lastPublishedAt ?? null;
  const cfg = isLive
    ? STATUS_CONFIG.PUBLISHED
    : menu.status === "ARCHIVED"
      ? STATUS_CONFIG.ARCHIVED
      : STATUS_CONFIG.DRAFT;
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
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
          <span>{menu._count?.categories ?? 0} categories</span>
          {publishedTo.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <span className="text-zinc-300">·</span>
              <span className="text-zinc-500">Live on</span>
              <span className="inline-flex items-center gap-1">
                {publishedTo.map((t) => (
                  <PlatformLogo
                    key={t}
                    platform={t}
                    size={14}
                  />
                ))}
              </span>
            </span>
          )}
          {lastPublishedAt && (
            <span className="text-zinc-400">
              <span className="text-zinc-300 mr-1">·</span>
              Last published {formatRelative(lastPublishedAt)}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={onPublish}
          className="h-8 gap-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
        >
          <Send className="h-3 w-3" />
          Publish
        </Button>
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

// Compact relative-time formatter for the menu card's "last published"
// stamp. ISO date in, "5m ago" / "3 days ago" out. Falls back to the
// raw date string for anything over 30 days so operators still see
// something meaningful.
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
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
