"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlignCenter,
  AlignLeft,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Copy,
  Gift,
  Heading1,
  Image as ImageIcon,
  LayoutGrid,
  Loader2,
  Minus,
  MousePointerClick,
  MoveVertical,
  PanelTop,
  Plus,
  Search,
  Trash2,
  Type,
  X,
} from "lucide-react";
import {
  STOREFRONT_LINK,
  newEmailBlockId,
  type EmailBlock,
  type EmailBlockType,
  type EmailDesign,
  type EmailProduct,
} from "@orderhub/shared";
import { ImageUploader } from "@/components/products/image-uploader";
import { emailMarketingClient } from "@/lib/api/email-marketing.client";
import { OfferCodeField } from "./offer-code-field";
import { cn } from "@/lib/utils";

const BLOCK_META: Record<EmailBlockType, { label: string; icon: any }> = {
  header: { label: "Logo & name", icon: PanelTop },
  hero: { label: "Banner photo", icon: ImageIcon },
  heading: { label: "Headline", icon: Heading1 },
  text: { label: "Text", icon: Type },
  button: { label: "Button", icon: MousePointerClick },
  products: { label: "Dishes from your menu", icon: LayoutGrid },
  offer: { label: "Offer / discount code", icon: Gift },
  image: { label: "Photo", icon: ImageIcon },
  divider: { label: "Divider", icon: Minus },
  spacer: { label: "Space", icon: MoveVertical },
};

const ADDABLE: EmailBlockType[] = ["heading", "text", "button", "products", "offer", "hero", "image", "divider", "spacer", "header"];

function blank(type: EmailBlockType): EmailBlock {
  const id = newEmailBlockId(type);
  switch (type) {
    case "header":
      return { id, type, showName: true };
    case "hero":
      return { id, type, imageUrl: "", url: STOREFRONT_LINK };
    case "image":
      return { id, type, imageUrl: "" };
    case "heading":
      return { id, type, text: "Your headline" };
    case "text":
      return { id, type, text: "Write something your customers will love." };
    case "button":
      return { id, type, label: "Order now", url: STOREFRONT_LINK };
    case "products":
      return { id, type, title: "Customer favourites", buttonLabel: "Order", items: [] };
    case "offer":
      return { id, type, title: "20% OFF", subtitle: "Your next order", code: "", buttonLabel: "Order now", url: STOREFRONT_LINK };
    case "divider":
      return { id, type };
    case "spacer":
      return { id, type, size: "md" };
  }
}

function summary(b: EmailBlock): string {
  switch (b.type) {
    case "heading":
    case "text":
      return b.text.slice(0, 60);
    case "button":
      return b.label;
    case "offer":
      return [b.title, b.code].filter(Boolean).join(" · ");
    case "products":
      return `${b.items.length} dish${b.items.length === 1 ? "" : "es"}`;
    case "hero":
    case "image":
      return b.imageUrl ? "Photo added" : "No photo yet";
    default:
      return "";
  }
}

export function BlockEditor({
  design,
  onChange,
  brandId,
  locationId,
}: {
  design: EmailDesign;
  onChange: (d: EmailDesign) => void;
  brandId: string | null;
  locationId: string | null;
}) {
  const [open, setOpen] = useState<string | null>(design.blocks[1]?.id ?? null);
  const [adding, setAdding] = useState(false);
  const blocks = design.blocks;

  const setBlocks = (next: EmailBlock[]) => onChange({ ...design, blocks: next });
  const update = (id: string, patch: Partial<EmailBlock>) =>
    setBlocks(blocks.map((b) => (b.id === id ? ({ ...b, ...patch } as EmailBlock) : b)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setBlocks(next);
  };
  const add = (type: EmailBlockType) => {
    const b = blank(type);
    setBlocks([...blocks, b]);
    setOpen(b.id);
    setAdding(false);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-zinc-200 bg-white px-4 py-3">
        <ColorField
          label="Brand colour"
          value={design.theme.primaryColor}
          onChange={(v) => onChange({ ...design, theme: { ...design.theme, primaryColor: v } })}
        />
        <ColorField
          label="Background"
          value={design.theme.backgroundColor}
          onChange={(v) => onChange({ ...design, theme: { ...design.theme, backgroundColor: v } })}
        />
      </div>

      {blocks.map((b, i) => {
        const meta = BLOCK_META[b.type];
        const Icon = meta.icon;
        const isOpen = open === b.id;
        return (
          <div key={b.id} className={cn("rounded-xl border bg-white", isOpen ? "border-indigo-300 shadow-sm" : "border-zinc-200")}>
            <div className="flex items-center gap-2 px-3 py-2.5">
              <button onClick={() => setOpen(isOpen ? null : b.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <Icon className="h-4 w-4 shrink-0 text-indigo-600" />
                <span className="text-sm font-semibold text-zinc-900">{meta.label}</span>
                <span className="truncate text-xs text-zinc-500">{summary(b)}</span>
                <ChevronDown className={cn("ml-auto h-4 w-4 shrink-0 text-zinc-400 transition", isOpen && "rotate-180")} />
              </button>
              <div className="flex shrink-0 items-center">
                <IconBtn label="Move up" onClick={() => move(i, -1)} disabled={i === 0}>
                  <ArrowUp className="h-3.5 w-3.5" />
                </IconBtn>
                <IconBtn label="Move down" onClick={() => move(i, 1)} disabled={i === blocks.length - 1}>
                  <ArrowDown className="h-3.5 w-3.5" />
                </IconBtn>
                <IconBtn
                  label="Duplicate"
                  onClick={() => {
                    const copy = { ...b, id: newEmailBlockId(b.type) } as EmailBlock;
                    setBlocks([...blocks.slice(0, i + 1), copy, ...blocks.slice(i + 1)]);
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                </IconBtn>
                <IconBtn label="Delete" onClick={() => setBlocks(blocks.filter((x) => x.id !== b.id))}>
                  <Trash2 className="h-3.5 w-3.5" />
                </IconBtn>
              </div>
            </div>
            {isOpen && (
              <div className="space-y-3 border-t border-zinc-100 px-4 py-3">
                <BlockFields block={b} update={(p) => update(b.id, p)} brandId={brandId} locationId={locationId} />
              </div>
            )}
          </div>
        );
      })}

      {adding ? (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-indigo-900">Add a section</span>
            <button onClick={() => setAdding(false)} aria-label="Close" className="text-zinc-500">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {ADDABLE.map((t) => {
              const Icon = BLOCK_META[t].icon;
              return (
                <button
                  key={t}
                  onClick={() => add(t)}
                  className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-left text-sm text-zinc-800 hover:border-indigo-400"
                >
                  <Icon className="h-4 w-4 text-indigo-600" /> {BLOCK_META[t].label}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-zinc-300 py-3 text-sm font-medium text-zinc-600 hover:border-indigo-400 hover:text-indigo-700"
        >
          <Plus className="h-4 w-4" /> Add a section
        </button>
      )}
    </div>
  );
}

function IconBtn(props: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      aria-label={props.label}
      title={props.label}
      className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-30"
    >
      {props.children}
    </button>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs font-medium text-zinc-600">
      <input
        type="color"
        value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-9 cursor-pointer rounded border border-zinc-200 bg-white p-0.5"
      />
      {label}
    </label>
  );
}

const inputCls = "w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none";

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-zinc-600">{label}</div>
      {children}
      {hint && <div className="mt-1 text-[11px] text-zinc-400">{hint}</div>}
    </div>
  );
}

function AlignField({ value, onChange }: { value?: "left" | "center"; onChange: (v: "left" | "center") => void }) {
  return (
    <div className="flex gap-1">
      {(
        [
          ["center", AlignCenter],
          ["left", AlignLeft],
        ] as const
      ).map(([a, Icon]) => (
        <button
          key={a}
          onClick={() => onChange(a)}
          aria-label={`Align ${a}`}
          className={cn(
            "rounded-md border px-2 py-1",
            (value ?? "center") === a ? "border-indigo-400 bg-indigo-50 text-indigo-700" : "border-zinc-200 text-zinc-500",
          )}
        >
          <Icon className="h-4 w-4" />
        </button>
      ))}
    </div>
  );
}

function LinkField({ value, onChange }: { value?: string; onChange: (v: string) => void }) {
  const isStore = !value || value === STOREFRONT_LINK;
  return (
    <Field label="Link goes to">
      <select
        value={isStore ? "store" : "other"}
        onChange={(e) => onChange(e.target.value === "store" ? STOREFRONT_LINK : "https://")}
        className={inputCls}
      >
        <option value="store">Your online ordering page</option>
        <option value="other">Another web address</option>
      </select>
      {!isStore && (
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="https://" className={cn(inputCls, "mt-2")} />
      )}
    </Field>
  );
}

function ImageField({ value, onChange, wide }: { value: string; onChange: (v: string) => void; wide?: boolean }) {
  return (
    <div>
      <ImageUploader
        value={value || null}
        onChange={(url) => onChange(url ?? "")}
        targetWidth={1200}
        targetHeight={wide ? 600 : 800}
      />
      {value.startsWith("data:") && (
        <p className="mt-1 text-[11px] text-amber-700">
          This photo couldn&apos;t be uploaded to storage, and inboxes like Gmail won&apos;t show it. Try again or paste an image link.
        </p>
      )}
    </div>
  );
}

function BlockFields({
  block: b,
  update,
  brandId,
  locationId,
}: {
  block: EmailBlock;
  update: (p: any) => void;
  brandId: string | null;
  locationId: string | null;
}) {
  switch (b.type) {
    case "header":
      return (
        <label className="flex items-center gap-2 text-sm text-zinc-700">
          <input type="checkbox" checked={b.showName !== false} onChange={(e) => update({ showName: e.target.checked })} />
          Show the restaurant name under the logo
        </label>
      );
    case "hero":
    case "image":
      return (
        <>
          <ImageField value={b.imageUrl} onChange={(v) => update({ imageUrl: v })} wide={b.type === "hero"} />
          <Field label="Describe the photo (for screen readers)">
            <input value={b.alt ?? ""} onChange={(e) => update({ alt: e.target.value })} className={inputCls} />
          </Field>
          <LinkField value={b.url} onChange={(v) => update({ url: v })} />
        </>
      );
    case "heading":
      return (
        <>
          <Field label="Headline" hint="Use {{first_name}} to greet each customer by name.">
            <input value={b.text} onChange={(e) => update({ text: e.target.value })} className={inputCls} />
          </Field>
          <AlignField value={b.align} onChange={(align) => update({ align })} />
        </>
      );
    case "text":
      return (
        <>
          <Field label="Text" hint="Leave a blank line for a new paragraph. **Double stars** make text bold. {{first_name}} adds their name.">
            <textarea value={b.text} onChange={(e) => update({ text: e.target.value })} rows={5} className={inputCls} />
          </Field>
          <AlignField value={b.align} onChange={(align) => update({ align })} />
        </>
      );
    case "button":
      return (
        <>
          <Field label="Button text">
            <input value={b.label} onChange={(e) => update({ label: e.target.value })} className={inputCls} />
          </Field>
          <LinkField value={b.url} onChange={(v) => update({ url: v })} />
        </>
      );
    case "offer":
      return (
        <>
          <OfferCodeField code={b.code ?? ""} title={b.title} locationId={locationId} onPick={(p) => update(p)} />
          <Field label="Big text">
            <input value={b.title} onChange={(e) => update({ title: e.target.value })} className={inputCls} />
          </Field>
          <Field label="Line underneath">
            <input value={b.subtitle ?? ""} onChange={(e) => update({ subtitle: e.target.value })} className={inputCls} />
          </Field>
          <Field label="Small print" hint="Filled in from the code's rules when you pick or create one.">
            <input value={b.terms ?? ""} onChange={(e) => update({ terms: e.target.value })} className={inputCls} />
          </Field>
          <Field label="Button text (leave empty for no button)">
            <input value={b.buttonLabel ?? ""} onChange={(e) => update({ buttonLabel: e.target.value })} className={inputCls} />
          </Field>
          {b.buttonLabel && <LinkField value={b.url} onChange={(v) => update({ url: v })} />}
        </>
      );
    case "products":
      return (
        <>
          <Field label="Title above the dishes">
            <input value={b.title ?? ""} onChange={(e) => update({ title: e.target.value })} className={inputCls} />
          </Field>
          <ProductPicker
            brandId={brandId}
            locationId={locationId}
            value={b.items}
            onChange={(items) => update({ items })}
          />
        </>
      );
    case "spacer":
      return (
        <Field label="Size">
          <select value={b.size ?? "md"} onChange={(e) => update({ size: e.target.value })} className={inputCls}>
            <option value="sm">Small</option>
            <option value="md">Medium</option>
            <option value="lg">Large</option>
          </select>
        </Field>
      );
    default:
      return <p className="text-xs text-zinc-500">Nothing to set for this one.</p>;
  }
}

function ProductPicker({
  brandId,
  locationId,
  value,
  onChange,
}: {
  brandId: string | null;
  locationId: string | null;
  value: EmailProduct[];
  onChange: (v: EmailProduct[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { data, isLoading } = useQuery({
    queryKey: ["email-mkt", "products", brandId, locationId],
    queryFn: () => emailMarketingClient.products({ brandId, locationId }),
    enabled: open && !!brandId,
  });
  const chosen = new Set(value.map((p) => p.id));
  const list = (data ?? []).filter((p) => !search || p.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {value.map((p) => (
          <div key={p.id} className="flex items-center gap-2 rounded-lg border border-zinc-200 py-1 pl-1 pr-2 text-xs">
            {p.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={p.imageUrl} alt="" className="h-7 w-7 rounded object-cover" />
            ) : (
              <div className="h-7 w-7 rounded bg-zinc-100" />
            )}
            <span className="max-w-[120px] truncate font-medium">{p.name}</span>
            <button onClick={() => onChange(value.filter((x) => x.id !== p.id))} aria-label={`Remove ${p.name}`}>
              <X className="h-3.5 w-3.5 text-zinc-400" />
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={() => setOpen(true)}
        disabled={!brandId}
        className="mt-2 flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
      >
        <Plus className="h-4 w-4" /> {value.length ? "Change dishes" : "Pick dishes"}
      </button>
      {!brandId && <p className="mt-1 text-[11px] text-zinc-400">Choose who the email is from to pick dishes.</p>}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-3">
              <Search className="h-4 w-4 text-zinc-400" />
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search your menu"
                className="flex-1 text-sm focus:outline-none"
              />
              <span className="text-xs text-zinc-500">{value.length}/8 picked</span>
              <button onClick={() => setOpen(false)} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white">
                Done
              </button>
            </div>
            {/* The scroll box and the grid are separate elements: a grid that is
                itself the fixed-height scroller squashes every card into a
                sliver (cards are overflow-hidden, so their min-height is 0). */}
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <div className="grid auto-rows-max grid-cols-2 gap-2 sm:grid-cols-3">
              {isLoading && (
                <div className="col-span-full flex justify-center py-8 text-zinc-400">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              )}
              {!isLoading && !list.length && (
                <div className="col-span-full py-8 text-center text-sm text-zinc-500">No dishes found.</div>
              )}
              {list.map((p) => {
                const on = chosen.has(p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() =>
                      onChange(on ? value.filter((x) => x.id !== p.id) : value.length >= 8 ? value : [...value, p])
                    }
                    className={cn(
                      "overflow-hidden rounded-xl border text-left transition",
                      on ? "border-indigo-500 ring-2 ring-indigo-500" : "border-zinc-200 hover:border-zinc-300",
                    )}
                  >
                    {p.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.imageUrl} alt="" className="h-24 w-full object-cover" />
                    ) : (
                      <div className="flex h-24 items-center justify-center bg-zinc-50 text-[11px] text-zinc-400">No photo</div>
                    )}
                    <div className="px-2.5 py-2">
                      <div className="truncate text-xs font-semibold text-zinc-900">{p.name}</div>
                      <div className="text-xs text-zinc-500">{p.price}</div>
                    </div>
                  </button>
                );
              })}
            </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
