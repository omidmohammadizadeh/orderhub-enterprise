"use client";

// Brand edit modal — lifted unchanged out of the Brands side drawer when that
// drawer became a full page. Kept as its own component so the brand-editing
// form has one home rather than living inside whichever view happens to
// render it.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { brandsClient, type Brand } from "@/lib/api/locations.client";
import { ImageUploader } from "@/components/products/image-uploader";

// Phase AS-6 — brand edit modal. Owns its own field state so cancel
// throws the changes away cleanly. Logo upload reuses the existing
// ImageUploader (URL-paste path stores the URL as-is; file-upload path
// stores a data: URL inline since the Supabase Storage backend isn't
// wired yet — that's fine, the bridge accepts both).
export function BrandEditModal({
  brand,
  onClose,
  onSaved,
}: {
  brand: Brand;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(brand.name);
  const [cuisine, setCuisine] = useState(brand.cuisine ?? "");
  const [logoUrl, setLogoUrl] = useState<string | null>(brand.logoUrl ?? null);
  // Phase AS-6 — brand-level public storefront fields.
  const [about, setAbout] = useState(brand.about ?? "");
  const [orderingSlug, setOrderingSlug] = useState(
    brand.onlineOrderingSlug ?? "",
  );
  const [directOrderingEnabled, setDirectOrderingEnabled] = useState<boolean>(
    !!brand.directOrderingEnabled,
  );
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // Auto-derive a URL-safe slug from the brand name on first toggle so
  // operators don't have to hand-type one. They can always overwrite.
  const generateSlug = () => {
    const seed =
      name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60) || "brand";
    // Add a 4-char suffix so the slug is unlikely to collide with another
    // brand that happens to share the same name.
    const suffix = Math.random().toString(36).slice(2, 6);
    setOrderingSlug(`${seed}-${suffix}`);
  };

  const publicUrl =
    orderingSlug && typeof window !== "undefined"
      ? `${window.location.origin}/brand/${orderingSlug}`
      : "";

  const save = useMutation({
    mutationFn: () =>
      brandsClient.update(brand.id, {
        name,
        cuisine: cuisine || null,
        logoUrl: logoUrl ?? null,
        about: about || null,
        onlineOrderingSlug: orderingSlug || null,
        directOrderingEnabled,
      }),
    onSuccess: onSaved,
    onError: (e: any) =>
      setSaveErr(e?.response?.data?.message ?? e.message ?? "Save failed"),
  });

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-zinc-900/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-md flex-col rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-900">Edit brand</h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {/* Body scrolls between the sticky header and footer. The whole
            modal is height-capped at 90vh so the Save row never falls
            below the fold — previously the logo upload + storefront
            section pushed it off-screen. */}
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Cuisine
            </label>
            <input
              value={cuisine}
              onChange={(e) => setCuisine(e.target.value)}
              placeholder="e.g. Pizza, Burgers"
              className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Logo
            </label>
            <p className="mb-2 text-[11px] text-zinc-500">
              Printed on the receipt header and shown on the storefront.
              A square logo works best — the whole image is kept, never
              cropped.
            </p>
            <ImageUploader
              value={logoUrl}
              onChange={setLogoUrl}
              targetWidth={512}
              targetHeight={512}
              fit="contain"
            />
          </div>

          {/* Phase AS-6 — Direct online ordering section. Same shape as
              the per-location storefront: toggle, slug, about. Address /
              phone always come from the brand's primary location so the
              operator doesn't enter the same info twice. */}
          <div className="rounded-md border border-zinc-200 bg-zinc-50/40 p-3">
            <div className="mb-2 flex items-center justify-between">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-zinc-700">
                Direct online ordering
              </label>
              <label className="inline-flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={directOrderingEnabled}
                  onChange={(e) => {
                    setDirectOrderingEnabled(e.target.checked);
                    if (e.target.checked && !orderingSlug) generateSlug();
                  }}
                />
                Enable
              </label>
            </div>
            <p className="mb-3 text-[11px] text-zinc-500">
              Gives this brand its own public ordering page. Address and
              phone are reused from the primary location.
            </p>

            {directOrderingEnabled && (
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    Public URL slug
                  </label>
                  <div className="flex gap-2">
                    <input
                      value={orderingSlug}
                      onChange={(e) => setOrderingSlug(e.target.value)}
                      placeholder="e.g. greek-gyros-pelton"
                      className="flex-1 rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={generateSlug}
                      className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                    >
                      Generate
                    </button>
                  </div>
                  {publicUrl && (
                    <p className="mt-1.5 truncate text-[11px] text-zinc-500">
                      Will be available at{" "}
                      <a
                        href={publicUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-violet-600 hover:underline"
                      >
                        {publicUrl}
                      </a>
                    </p>
                  )}
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    About
                  </label>
                  <textarea
                    value={about}
                    onChange={(e) => setAbout(e.target.value)}
                    placeholder="Short pitch shown above the menu (cuisine, story, hours)…"
                    rows={3}
                    className="w-full resize-none rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
                  />
                </div>
              </div>
            )}
          </div>

          {saveErr && <p className="text-[12px] text-red-600">{saveErr}</p>}
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-zinc-200 px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending || !name.trim()}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {save.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              "Save"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
