"use client";

// "Create menu" form modal. Deliverect parity:
//   - Menu name (required)
//   - Description
//   - Menu type: Delivery / Delivery_and_pickup
//   - Logo image (square, 1:1) — optional
//   - Banner image (1920×1080) — recommended
//
// The save action calls menusClient.createMenu and returns the new menu
// to the parent so it can navigate the operator into the editor.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { menusClient, type Menu } from "@/lib/api/menus.client";
import { ImageUploader } from "@/components/products/image-uploader";

interface Props {
  open: boolean;
  brandId: string;
  /** Phase AP — stamp the new menu with this location's id so it only
   *  appears under that location in the Menu tab. The Menu tab now
   *  passes the value from `useSelectedLocationStore`. */
  locationId?: string | null;
  onCreated: (menu: Menu) => void;
  onCancel: () => void;
}

export function CreateMenuModal({
  open,
  brandId,
  locationId,
  onCreated,
  onCancel,
}: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [menuType, setMenuType] = useState<"DELIVERY" | "DELIVERY_AND_PICKUP">(
    "DELIVERY_AND_PICKUP",
  );
  const [bannerImage, setBannerImage] = useState<string | null>(null);
  const [logoImage, setLogoImage] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () =>
      menusClient.createMenu(brandId, {
        name: name.trim(),
        description: description.trim() || undefined,
        // Phase AM extras — backend silently ignores if absent.
        menuType,
        bannerImage: bannerImage ?? undefined,
        logoImage: logoImage ?? undefined,
        // Phase AP — scope this menu to the current location so the
        // location-only Menu tab picks it up.
        locationId: locationId ?? undefined,
      }),
    onSuccess: (menu) => {
      onCreated(menu);
      // Reset local state so the next open is clean.
      setName("");
      setDescription("");
      setBannerImage(null);
      setLogoImage(null);
    },
  });

  if (!open) return null;

  const canSave = name.trim().length > 0 && !createMutation.isPending;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="my-8 bg-white rounded-xl shadow-2xl w-full max-w-3xl">
        <div className="flex items-center justify-between p-5 border-b border-zinc-100">
          <h2 className="text-base font-semibold text-zinc-900">New menu</h2>
          <button
            onClick={onCancel}
            className="text-zinc-400 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* ── Basic fields ─────────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="block md:col-span-2">
              <span className="text-xs font-semibold text-zinc-700">
                Menu name <span className="text-red-500">*</span>
              </span>
              <Input
                autoFocus
                placeholder="e.g. Lunch Menu, Dinner Menu"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 h-9 text-sm"
              />
            </label>

            <label className="block md:col-span-2">
              <span className="text-xs font-semibold text-zinc-700">
                Description
              </span>
              <textarea
                placeholder="Brief description shown to customers."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
              />
            </label>

            <label className="block md:col-span-2">
              <span className="text-xs font-semibold text-zinc-700">
                Type
              </span>
              <select
                value={menuType}
                onChange={(e) =>
                  setMenuType(
                    e.target.value as "DELIVERY" | "DELIVERY_AND_PICKUP",
                  )
                }
                className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm"
              >
                <option value="DELIVERY_AND_PICKUP">Delivery and pickup</option>
                <option value="DELIVERY">Delivery only</option>
              </select>
            </label>
          </div>

          {/* ── Images ───────────────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 pt-4 border-t border-zinc-100">
            <div>
              <h3 className="text-xs font-semibold text-zinc-700 mb-2">
                Banner image{" "}
                <span className="text-zinc-400 font-normal">
                  (1920 × 1080)
                </span>
              </h3>
              {/* Use the existing uploader; pass the banner target dimensions
                  so the client-side resize matches Deliverect's storefront
                  hero ratio. */}
              <ImageUploader
                value={bannerImage}
                onChange={setBannerImage}
                targetWidth={1920}
                targetHeight={1080}
              />
            </div>
            <div>
              <h3 className="text-xs font-semibold text-zinc-700 mb-2">
                Logo image{" "}
                <span className="text-zinc-400 font-normal">(square)</span>
              </h3>
              <ImageUploader
                value={logoImage}
                onChange={setLogoImage}
                targetWidth={512}
                targetHeight={512}
              />
            </div>
          </div>

          {createMutation.error && (
            <p className="text-xs text-red-600">
              {(createMutation.error as any)?.response?.data?.message ??
                "Could not create menu. Try again."}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-zinc-100">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Discard
          </Button>
          <Button
            size="sm"
            disabled={!canSave}
            onClick={() => createMutation.mutate()}
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            {createMutation.isPending ? "Creating…" : "Create"}
          </Button>
        </div>
      </div>
    </div>
  );
}
