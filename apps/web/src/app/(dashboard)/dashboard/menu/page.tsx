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
import toast from "react-hot-toast";
import { menusClient, brandsClient, type Menu, type Brand } from "@/lib/api/menus.client";
import { useAuthStore } from "@/stores/auth.store";
import { cn } from "@/lib/utils";
import { AddMenuModal } from "@/components/menu/add-menu-modal";
import { CreateMenuModal } from "@/components/menu/create-menu-modal";
import { AiImportMenuModal } from "@/components/menu/ai-import-menu-modal";
import { ImportMenuModal } from "@/components/menu/import-menu-modal";
import { MasterMenuModal } from "@/components/menu/master-menu-modal";
import { PublishMenuModal } from "@/components/menu/publish-menu-modal";
import { PublishHoursModal } from "@/components/menu/publish-hours-modal";
import { PlatformLogo, platformLabel } from "@/components/ui/platform-logo";
import { Send, CheckCircle2, Clock } from "lucide-react";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { locationsClient } from "@/lib/api/locations.client";

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
    null | "chooser" | "create" | "import-ai" | "import-channel" | "import-pos" | "master"
  >(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  // Phase AM — publish target picker per menu card.
  const [publishingMenu, setPublishingMenu] = useState<Menu | null>(null);
  const [publishHoursOpen, setPublishHoursOpen] = useState(false);
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

  // Phase AP — Menu tab is scoped to the currently selected location.
  // Each location only ever sees its own menus, not the franchise
  // brand's union of menus across every sibling location.
  const selectedLocationId = useSelectedLocationStore(
    (s) => s.selectedLocationId,
  );

  // Phase BA — location names for the "Live at" chips (shares the
  // ["locations"] cache with the switcher + publish modal).
  const locationsQuery = useQuery({
    queryKey: ["locations"],
    queryFn: () => locationsClient.list(),
  });
  const locationNameById = new Map<string, string>(
    ((locationsQuery.data ?? []) as any[]).map((l) => [l.id, l.name]),
  );
  // Phase AW-18 — when the operator picks "All locations" in the
  // location switcher, list every menu they can see across every
  // location they have access to (server filters by UserLocation).
  // Otherwise stick with the location-scoped list.
  const { data: menus = [], isLoading } = useQuery({
    queryKey: selectedLocationId
      ? (["menus", "location", selectedLocationId] as const)
      : (["menus", "tenant"] as const),
    queryFn: () =>
      selectedLocationId
        ? menusClient.listMenusForLocation(selectedLocationId)
        : menusClient.listMenusForTenant(),
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ["menus"] }),
  });

  const archiveMutation = useMutation({
    mutationFn: (menuId: string) => menusClient.archiveMenu(menuId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["menus"] }),
  });

  const cloneMutation = useMutation({
    mutationFn: ({ menuId, name }: { menuId: string; name: string }) =>
      menusClient.cloneMenu(menuId, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["menus"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (menuId: string) => menusClient.deleteMenu(menuId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["menus"] }),
  });

  // Phase AW-11 — HubRise catalog import. Pulls the location's
  // configured catalog into a new (or existing, matched by HubRise
  // catalog id) menu under the active brand. Toast surfaces row counts
  // so the operator sees what landed.
  const importHubRiseMutation = useMutation({
    mutationFn: () =>
      menusClient.importFromHubRise(brandId!, {
        locationId: selectedLocationId!,
      }),
    // Snapshot which of this brand's menus already exist + their status,
    // so onError can tell a genuinely-new/updated import apart from stale
    // menus when it has to fall back to polling.
    onMutate: () => {
      const before = new Map<string, string>();
      for (const m of (menus as Menu[]) ?? []) {
        if ((m as any).brandId === brandId) {
          before.set(m.id, (m as any).importStatus ?? "IDLE");
        }
      }
      return { before };
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["menus"] });
      toast.success(
        `Imported from HubRise: ${r.counts.categories} categories, ${r.counts.products} products, ${r.counts.modifierGroups} modifier groups.`,
      );
      router.push(`/dashboard/menu/${r.menuId}`);
    },
    onError: async (err: any, _vars, context) => {
      const status = err?.response?.status;
      // A real client-side rejection (no catalog configured, bad request,
      // token revoked → 401/403, etc.) is a genuine failure — show it.
      if (status && status >= 400 && status < 500) {
        toast.error(
          `HubRise import failed: ${
            err?.response?.data?.message ?? err?.message ?? "Unknown error"
          }`,
        );
        return;
      }
      // 5xx / network / gateway timeout: a HubRise import of a large
      // catalog takes ~40s and a proxy in front severs the browser
      // connection before it finishes — but the import keeps running
      // server-side and flips the menu's importStatus to SUCCESS/FAILED.
      // Poll that real outcome instead of showing a false "failed".
      const before = (context as { before: Map<string, string> } | undefined)
        ?.before ?? new Map<string, string>();
      const toastId = toast.loading(
        "Import is taking a while — finishing in the background…",
      );
      const fetchMenus = () =>
        selectedLocationId
          ? menusClient.listMenusForLocation(selectedLocationId)
          : menusClient.listMenusForTenant();
      try {
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 4000));
          const list = (await fetchMenus()) as Menu[];
          qc.setQueryData(
            selectedLocationId
              ? ["menus", "location", selectedLocationId]
              : ["menus", "tenant"],
            list,
          );
          const mine = list.filter((m) => (m as any).brandId === brandId);
          // The in-flight import is the menu that's new, or whose status
          // changed since we started (IMPORTING → SUCCESS/FAILED).
          const touched = mine.filter(
            (m) =>
              !before.has(m.id) ||
              before.get(m.id) !== ((m as any).importStatus ?? "IDLE"),
          );
          if (touched.some((m) => (m as any).importStatus === "IMPORTING")) {
            continue; // still running
          }
          const done = touched.find(
            (m) => (m as any).importStatus === "SUCCESS",
          );
          const failed = touched.find(
            (m) => (m as any).importStatus === "FAILED",
          );
          if (done) {
            toast.success("HubRise menu imported.", { id: toastId });
            qc.invalidateQueries({ queryKey: ["menus"] });
            router.push(`/dashboard/menu/${done.id}`);
            return;
          }
          if (failed) {
            toast.error(
              "HubRise import failed on the server. Check the catalog and try again.",
              { id: toastId },
            );
            return;
          }
        }
        toast(
          "Import is still processing — it should appear shortly. Refresh if it doesn't.",
          { id: toastId },
        );
        qc.invalidateQueries({ queryKey: ["menus"] });
      } catch {
        toast.error(
          "Couldn't confirm the HubRise import. Refresh to check your menus.",
          { id: toastId },
        );
      }
    },
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
      qc.invalidateQueries({ queryKey: ["menus"] });
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
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Menu Management</h1>
          <p className="text-sm text-zinc-500">
            Menus belong to the selected location. Switch the location to see its menus.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            variant="outline"
            onClick={() => generatePlusMutation.mutate()}
            disabled={generatePlusMutation.isPending}
            title="Backfill PLUs on any product, modifier group, or modifier missing one. Existing PLUs are left untouched."
          >
            Generate missing PLUs
          </Button>
          {/* Phase AW-11 — pull the brand's HubRise catalog into a new
              (or existing) Menu in one click. The button is enabled
              whenever a location is selected; the backend rejects if
              the location hasn't connected HubRise yet, surfaced as a
              red toast. */}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (!brandId || !selectedLocationId) return;
              importHubRiseMutation.mutate();
            }}
            disabled={
              !brandId ||
              !selectedLocationId ||
              importHubRiseMutation.isPending
            }
            title="Pull the location's HubRise catalog into a menu"
          >
            {importHubRiseMutation.isPending
              ? "Importing…"
              : "Import from HubRise"}
          </Button>
          {/* Phase AW-16 — Publish brand-level opening hours + prep
              time to one channel (HubRise wired; marketplaces stubbed
              for now). Separate from menu publish because hours change
              far more often than menus do. */}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPublishHoursOpen(true)}
            disabled={!selectedLocationId}
            title="Push the brand's opening hours + prep time to a channel"
          >
            <Clock className="h-4 w-4 mr-1.5" />
            Publish hours
          </Button>
          <Button
            size="sm"
            onClick={openAddMenu}
            disabled={!selectedLocationId}
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
          else if (kind === "import-ai") setAddStep("import-ai");
          else if (kind === "import-channel") setAddStep("import-channel");
          else if (kind === "import-pos") setAddStep("import-pos");
          else if (kind === "master") {
            if (!selectedLocationId) {
              toast.error("Select a single location first (not \"All locations\").");
              return;
            }
            setAddStep("master");
          }
        }}
        onCancel={() => setAddStep(null)}
      />
      <CreateMenuModal
        open={addStep === "create"}
        brandId={brandId}
        locationId={selectedLocationId}
        onCreated={(menu) => {
          qc.invalidateQueries({ queryKey: ["menus"] });
          setAddStep(null);
          router.push(`/dashboard/menu/${menu.id}`);
        }}
        onCancel={() => setAddStep(null)}
      />
      <AiImportMenuModal
        open={addStep === "import-ai"}
        brandId={brandId}
        locationId={selectedLocationId}
        onCreated={(menuId) => {
          qc.invalidateQueries({ queryKey: ["menus"] });
          setAddStep(null);
          router.push(`/dashboard/menu/${menuId}`);
        }}
        onCancel={() => setAddStep(null)}
      />
      <ImportMenuModal
        open={addStep === "import-channel"}
        source="channel"
        onCancel={() => setAddStep(null)}
        onImported={(menuId) => router.push(`/dashboard/menu/${menuId}`)}
      />
      <ImportMenuModal
        open={addStep === "import-pos"}
        source="pos"
        onCancel={() => setAddStep(null)}
      />
      {selectedLocationId && (
        <MasterMenuModal
          open={addStep === "master"}
          locationId={selectedLocationId}
          menus={menus as Menu[]}
          brands={brands}
          onCreated={(menu) => {
            qc.invalidateQueries({ queryKey: ["menus"] });
            setAddStep(null);
            toast.success("Master menu created.");
            router.push(`/dashboard/menu/${menu.id}`);
          }}
          onCancel={() => setAddStep(null)}
        />
      )}

      {/* Phase AP — brand chip strip removed. The Menu tab is now
          location-scoped (see the LocationSelector in the header).
          A franchise can still cross-publish a menu via the publish
          modal; the per-location list keeps the operator focused on
          the shop they're working at. */}

      {!selectedLocationId && menus.length === 0 && !isLoading && (
        <div className="flex flex-col items-center justify-center py-24 border-2 border-dashed border-zinc-200 rounded-xl">
          <UtensilsCrossed className="h-10 w-10 text-zinc-300 mb-3" />
          <p className="font-medium text-zinc-500">No menus across your locations yet</p>
          <p className="text-sm text-zinc-400 mt-1">
            Pick a specific location above to create the first one.
          </p>
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
              locationNameById={locationNameById}
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

      <PublishHoursModal
        open={publishHoursOpen}
        locationId={selectedLocationId ?? undefined}
        onClose={() => setPublishHoursOpen(false)}
      />

      <PublishMenuModal
        open={!!publishingMenu}
        menuId={publishingMenu?.id ?? ""}
        menuName={publishingMenu?.name ?? ""}
        initiallyPublishedTo={
          ((publishingMenu as any)?.publishedTo ?? []) as string[]
        }
        // Phase AW — two-step picker needs the current brand to
        // pre-select Step 2, and the location to scope the brand
        // dropdown to brands at this kitchen.
        currentBrandId={(publishingMenu as any)?.brandId ?? brandId}
        locationId={selectedLocationId ?? undefined}
        // Phase BA — pre-tick every location the menu currently serves.
        assignedLocationIds={Array.from(
          new Set(
            (((publishingMenu as any)?.assignments ?? []) as Array<{
              locationId: string;
            }>).map((a) => a.locationId),
          ),
        )}
        onConfirmed={(targets) => {
          qc.invalidateQueries({ queryKey: ["menus"] });
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
                      <PlatformLogo platform={t} size={22} />
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
  /** Phase BA — id → name for the "Live at" location chips. */
  locationNameById: Map<string, string>;
  isDropdownOpen: boolean;
  onToggleDropdown: () => void;
  onPublish: () => void;
  onArchive: () => void;
  onClone: () => void;
  onDelete: () => void;
}

function MenuCard({ menu, locationNameById, isDropdownOpen, onToggleDropdown, onPublish, onArchive, onClone, onDelete }: MenuCardProps) {
  // Phase AM — show the Live badge only when the menu is actually
  // published to at least one target. status=PUBLISHED alone isn't
  // enough; an operator might toggle every target off and that needs
  // to read as Draft, not "Live" with no destinations.
  const publishedTo: string[] =
    (menu as any).publishedTo && Array.isArray((menu as any).publishedTo)
      ? (menu as any).publishedTo
      : [];
  // Phase BA — serving assignments are the real "where is this live";
  // grouped by location for the chips. publishedTo stays as the channel
  // fallback for menus not re-published since the assignment migration.
  const assignments = (menu.assignments ?? []) as Array<{
    locationId: string;
    channel: string;
  }>;
  const liveByLocation = new Map<string, string[]>();
  for (const a of assignments) {
    const arr = liveByLocation.get(a.locationId) ?? [];
    if (!arr.includes(a.channel)) arr.push(a.channel);
    liveByLocation.set(a.locationId, arr);
  }
  const isLive =
    (assignments.length > 0 || publishedTo.length > 0) &&
    menu.status === "PUBLISHED";
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
          {/* Menu id — click to copy, for support / bug reports. */}
          <button
            type="button"
            title={`Menu ID: ${menu.id} (click to copy)`}
            onClick={(e) => {
              e.stopPropagation();
              navigator.clipboard?.writeText(menu.id).catch(() => {});
            }}
            className="font-mono text-[10px] text-zinc-400 hover:text-zinc-600"
          >
            ID:{menu.id.slice(-8)}
          </button>
          <span className="text-zinc-300">·</span>
          <span>{menu._count?.categories ?? 0} categories</span>
          {liveByLocation.size > 0 ? (
            // Phase BA — one chip per serving location with its channels.
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <span className="text-zinc-300">·</span>
              <span className="text-zinc-500">Live at</span>
              {Array.from(liveByLocation.entries()).map(([locId, channels]) => (
                <span
                  key={locId}
                  className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700"
                >
                  {locationNameById.get(locId) ?? "Location"}
                  <span className="inline-flex items-center gap-0.5">
                    {channels.map((t) => (
                      <PlatformLogo key={t} platform={t} size={12} />
                    ))}
                  </span>
                </span>
              ))}
            </span>
          ) : publishedTo.length > 0 ? (
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
          ) : null}
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
