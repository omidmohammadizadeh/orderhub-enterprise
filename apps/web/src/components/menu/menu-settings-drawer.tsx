"use client";

// Phase AP — Menu Settings drawer.
//
// Opened from the Settings button in the menu editor top bar. Edits the
// presentational + structural fields the operator used to be unable to
// change after creation:
//
//   • Menu name
//   • Description
//   • Menu type (DELIVERY / DELIVERY_AND_PICKUP)
//   • Banner image (1920×1080 — used by the storefront hero)
//   • Logo image (1:1 — used by the storefront header)
//   • Hero image (alternate slot if the operator wants a non-banner)
//
// Categories, products, modifier groups and modifiers keep their own
// dedicated panels in the editor — this drawer only handles the menu
// row itself.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Sparkles, X } from "lucide-react";
import { menusClient, type Menu } from "@/lib/api/menus.client";
import { ImageUploader } from "@/components/products/image-uploader";

interface Props {
  menu: Menu;
  /** Banner generation is admin-only while it's being trialled. */
  canGenerate?: boolean;
  onClose: () => void;
}

type MenuType = "DELIVERY" | "DELIVERY_AND_PICKUP";

export function MenuSettingsDrawer({ menu, canGenerate, onClose }: Props) {
  const qc = useQueryClient();

  const [name, setName] = useState(menu.name);
  const [description, setDescription] = useState(menu.description ?? "");
  const [menuType, setMenuType] = useState<MenuType>(
    (menu.menuType as MenuType) ?? "DELIVERY_AND_PICKUP",
  );
  const [bannerImage, setBannerImage] = useState<string | null>(
    menu.bannerImage ?? null,
  );
  const [logoImage, setLogoImage] = useState<string | null>(
    menu.logoImage ?? null,
  );
  const [heroImage, setHeroImage] = useState<string | null>(
    menu.heroImage ?? null,
  );
  const [feedback, setFeedback] = useState<string | null>(null);

  // ── AI banner ────────────────────────────────────────────────────────────
  // Generates into the Banner field but does NOT save. The operator looks at
  // it and presses Save, or closes the drawer and nothing changed.
  const [brief, setBrief] = useState("");
  const [generating, setGenerating] = useState(false);
  const [basedOn, setBasedOn] = useState<string[] | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  // An interval that outlives the drawer keeps polling from a component
  // nobody is looking at.
  useEffect(
    () => () => {
      if (poll.current) clearInterval(poll.current);
    },
    [],
  );

  const generate = async () => {
    setGenerating(true);
    setBasedOn(null);
    setFeedback("Generating — about a minute.");
    try {
      const started = await menusClient.generateMenuBanner({
        menuId: menu.id,
        brief: brief.trim() || undefined,
      });
      if (!started.jobId) {
        setFeedback(started.error ?? "Could not start");
        setGenerating(false);
        return;
      }
      poll.current = setInterval(async () => {
        try {
          const s = await menusClient.getMenuBannerJob(started.jobId!);
          if (s.status === "running") return;
          if (poll.current) clearInterval(poll.current);
          setGenerating(false);
          if (s.status === "done" && s.url) {
            setBannerImage(s.url);
            setBasedOn(s.basedOn ?? null);
            setFeedback("Generated — press Save to keep it.");
          } else if (s.status === "unknown") {
            // The job map lives in process memory, so a deploy loses it.
            // Saying "done" here would be a lie about a paid render.
            setFeedback("The API restarted and the job was lost — try again.");
          } else {
            setFeedback(s.error ?? "Generation failed");
          }
        } catch {
          /* transient poll failure — the next tick retries */
        }
      }, 3000);
    } catch (e: any) {
      setGenerating(false);
      setFeedback(e?.response?.data?.message ?? e.message ?? "Could not start");
    }
  };

  // Resync if the parent re-opens with a different menu (rare, but
  // keeps the form honest under StrictMode double-mounts).
  useEffect(() => {
    setName(menu.name);
    setDescription(menu.description ?? "");
    setMenuType((menu.menuType as MenuType) ?? "DELIVERY_AND_PICKUP");
    setBannerImage(menu.bannerImage ?? null);
    setLogoImage(menu.logoImage ?? null);
    setHeroImage(menu.heroImage ?? null);
  }, [menu.id]);

  const save = useMutation({
    mutationFn: () =>
      menusClient.updateMenu(menu.id, {
        name: name.trim(),
        description: description.trim(),
        menuType,
        bannerImage: bannerImage ?? null,
        logoImage: logoImage ?? null,
        heroImage: heroImage ?? null,
      }),
    onSuccess: () => {
      setFeedback("Saved");
      qc.invalidateQueries({ queryKey: ["menus"] });
      qc.invalidateQueries({ queryKey: ["menu", menu.id] });
      window.setTimeout(() => setFeedback(null), 2000);
    },
    onError: (err: any) =>
      setFeedback(err?.response?.data?.message ?? err.message ?? "Failed"),
  });

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full max-w-lg flex-col overflow-hidden bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900">Menu settings</h2>
            <p className="text-xs text-zinc-500">
              Name, description, banner + logo for the storefront.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <Field label="Menu name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Dinner Menu"
              className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
            />
          </Field>

          <Field
            label="Description"
            help="Short blurb shown to customers on the storefront."
          >
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
            />
          </Field>

          <Field label="Menu type">
            <select
              value={menuType}
              onChange={(e) => setMenuType(e.target.value as MenuType)}
              className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
            >
              <option value="DELIVERY_AND_PICKUP">Delivery &amp; Pickup</option>
              <option value="DELIVERY">Delivery only</option>
            </select>
          </Field>

          <Field
            label="Banner image"
            help="1920×1080 hero displayed on the storefront. Optional."
          >
            <ImageUploader
              value={bannerImage}
              onChange={(v) => setBannerImage(v ?? null)}
              targetWidth={1920}
              targetHeight={1080}
            />
            {canGenerate && (
              <div className="mt-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                <div className="flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-zinc-500" />
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    Generate with AI
                  </span>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                  Built from this menu&apos;s own categories and dishes, at
                  1920×1080, with the left third kept clear for a headline.
                </p>
                <div className="mt-2 flex gap-2">
                  <input
                    value={brief}
                    onChange={(e) => setBrief(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !generating) {
                        e.preventDefault();
                        void generate();
                      }
                    }}
                    placeholder="Optional steer — e.g. brighter, feature the breakfast"
                    disabled={generating}
                    className="flex-1 rounded-md border border-zinc-200 px-2 py-1.5 text-sm placeholder:text-zinc-400 focus:border-zinc-900 focus:outline-none disabled:bg-zinc-100"
                  />
                  <button
                    onClick={() => void generate()}
                    disabled={generating}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {generating ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    Generate
                  </button>
                </div>
                {basedOn && basedOn.length > 0 && (
                  // Show what it read. If the banner looks like the wrong
                  // shop, this says whether the prompt or the menu is wrong.
                  <p className="mt-2 text-[11px] text-zinc-500">
                    Based on: {basedOn.join(", ")}
                  </p>
                )}
              </div>
            )}
          </Field>

          <Field
            label="Logo image"
            help="1:1 brand badge. Optional."
          >
            <ImageUploader
              value={logoImage}
              onChange={(v) => setLogoImage(v ?? null)}
              targetWidth={512}
              targetHeight={512}
            />
          </Field>

          <Field
            label="Hero image (alternate)"
            help="Use when you want a different image from the banner. Optional."
          >
            <ImageUploader
              value={heroImage}
              onChange={(v) => setHeroImage(v ?? null)}
              targetWidth={1920}
              targetHeight={1080}
            />
          </Field>
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-zinc-200 px-4 py-3">
          <span className="text-[11px] text-zinc-500">
            {feedback ?? "Changes apply on save."}
          </span>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending || !name.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  help,
}: {
  label: string;
  children: React.ReactNode;
  help?: string;
}) {
  return (
    <div>
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        {label}
      </span>
      {children}
      {help && <p className="mt-1 text-[11px] text-zinc-500">{help}</p>}
    </div>
  );
}
