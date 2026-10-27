"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, MapPin, Menu, Search, ShoppingBag, X } from "lucide-react";
import { useEflHref } from "../efl-base-context";
import { EflWordmark } from "../efl-logo";
import { FOCUS } from "../efl-styles";
import { normalisePostcode } from "../postcode";
import type { FeedMode } from "./shop-card";

const ICON_BTN = `efl-press flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-[#F3F3F3] ${FOCUS}`;

/** Close a popover on outside click or Escape. */
function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close, ref]);
}

export function ModeToggle({ mode, onChange, className = "" }: { mode: FeedMode; onChange: (m: FeedMode) => void; className?: string }) {
  const options: Array<{ value: FeedMode; label: string }> = [
    { value: "DELIVERY", label: "Delivery" },
    { value: "PICKUP", label: "Pick up" },
  ];
  return (
    <div role="group" aria-label="How you get your food" className={`flex shrink-0 rounded-full bg-[#F3F3F3] p-1 ${className}`}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={mode === o.value}
          onClick={() => onChange(o.value)}
          className={`efl-press min-h-[36px] rounded-full px-4 text-sm font-bold ${FOCUS} ${
            mode === o.value ? "bg-[#0B0B0B] text-white" : "text-[#0B0B0B] hover:bg-[#E2E2E2]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function AddressChip({ label }: { label: string }) {
  const router = useRouter();
  const href = useEflHref();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, wrap);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const pc = normalisePostcode(value);
    if (!pc) {
      setError("Enter a UK postcode, like NE1 4ST.");
      return;
    }
    setOpen(false);
    setValue("");
    setError(null);
    router.push(href(`/near?postcode=${encodeURIComponent(pc)}`));
  }

  return (
    <div ref={wrap} className="relative min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        className={`efl-press flex min-h-[44px] min-w-0 max-w-[220px] items-center gap-1.5 rounded-full bg-[#F3F3F3] px-3.5 text-sm font-bold hover:bg-[#E2E2E2] ${FOCUS}`}
      >
        <MapPin aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span className="truncate">{label}</span>
        <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span className="sr-only">, change location</span>
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Change your location"
          className="efl-pop absolute left-0 top-[calc(100%+8px)] z-50 w-[min(340px,calc(100vw-32px))] rounded-2xl border border-[#E2E2E2] bg-white p-4 shadow-[0_12px_40px_rgba(0,0,0,.14)]"
        >
          <form onSubmit={submit} noValidate className="flex flex-col gap-2.5">
            <label htmlFor={inputId} className="text-sm font-bold">
              Deliver to a different postcode
            </label>
            <div className="flex gap-2">
              <input
                id={inputId}
                autoFocus
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setError(null);
                }}
                placeholder="e.g. NE1 4ST"
                autoComplete="postal-code"
                autoCapitalize="characters"
                spellCheck={false}
                aria-invalid={error ? true : undefined}
                className="h-11 min-w-0 flex-1 rounded-xl border-2 border-[#E2E2E2] px-3 text-base focus:border-[#0B0B0B] focus:outline-none"
              />
              <button type="submit" className={`efl-press h-11 rounded-xl bg-[#0B0B0B] px-4 text-sm font-bold text-white ${FOCUS}`}>
                Go
              </button>
            </div>
            <p aria-live="polite" className="m-0 text-sm font-semibold">
              {error ?? ""}
            </p>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function BasketButton() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, wrap);
  return (
    <div ref={wrap} className="relative">
      <button type="button" aria-expanded={open} aria-label="Basket" onClick={() => setOpen((o) => !o)} className={ICON_BTN}>
        <ShoppingBag aria-hidden="true" className="h-[22px] w-[22px]" />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Basket"
          className="efl-pop absolute right-0 top-[calc(100%+8px)] z-50 w-[min(300px,calc(100vw-32px))] rounded-2xl border border-[#E2E2E2] bg-white p-5 shadow-[0_12px_40px_rgba(0,0,0,.14)]"
        >
          <p className="m-0 text-base font-extrabold">Your basket is empty</p>
          <p className="m-0 mt-1.5 text-sm leading-relaxed text-[#5E5E5E]">
            Ordering opens in the Eat For Less app soon. For now, browse the shops and menus near you.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function SiteMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const href = useEflHref();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const links = [
    { label: "Home", href: href("/") },
    { label: "Partner with us", href: "/partner" },
    { label: "Help", href: href("/help") },
    { label: "Privacy", href: href("/privacy") },
    { label: "Terms", href: href("/terms") },
  ];

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-label="Menu"
      className="m-0 h-full max-h-none w-[min(320px,86vw)] max-w-none bg-white p-0 backdrop:bg-black/40"
    >
      <div className="flex h-full flex-col gap-6 p-5">
        <div className="flex items-center justify-between">
          <EflWordmark size={28} />
          <button type="button" onClick={onClose} aria-label="Close menu" className={ICON_BTN}>
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>
        <nav aria-label="Site">
          <ul className="m-0 flex list-none flex-col p-0">
            {links.map((l) => (
              <li key={l.label}>
                <Link
                  href={l.href}
                  onClick={onClose}
                  className={`flex min-h-[52px] items-center rounded-xl px-3 text-lg font-bold hover:bg-[#F3F3F3] ${FOCUS}`}
                >
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="mt-auto rounded-2xl bg-[#0B0B0B] p-5 text-white">
          <p className="m-0 text-lg font-extrabold">Own a takeaway?</p>
          <p className="m-0 mt-1 text-sm text-[#C9C9C9]">Keep more of every order.</p>
          <Link
            href="/partner"
            onClick={onClose}
            className="efl-press mt-4 inline-flex min-h-[44px] items-center rounded-full bg-[#D4FF3F] px-5 text-sm font-bold text-[#0B0B0B] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#D4FF3F]"
          >
            Partner with us
          </Link>
        </div>
      </div>
    </dialog>
  );
}

export function FeedTopBar({
  mode,
  onModeChange,
  locationLabel,
  search,
  onSearch,
}: {
  mode: FeedMode;
  onModeChange: (m: FeedMode) => void;
  locationLabel: string;
  search: string;
  onSearch: (s: string) => void;
}) {
  const href = useEflHref();
  const [menuOpen, setMenuOpen] = useState(false);
  const searchId = useId();
  const searchMobileId = useId();

  const searchBox = (id: string, extra: string) => (
    <div className={`relative ${extra}`}>
      <label htmlFor={id} className="sr-only">
        Search shops and cuisines
      </label>
      <Search aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2" />
      <input
        id={id}
        type="search"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        placeholder="Search Eat For Less"
        autoComplete="off"
        enterKeyHint="search"
        className="h-12 w-full rounded-full border-2 border-transparent bg-[#F3F3F3] pl-12 pr-4 text-base font-medium placeholder:text-[#5E5E5E] focus:border-[#0B0B0B] focus:bg-white focus:outline-none"
      />
    </div>
  );

  return (
    <header className="sticky top-0 z-40 border-b border-[#E2E2E2] bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/85">
      <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-2 px-3 sm:gap-3 sm:px-5 lg:h-[72px]">
        <button type="button" onClick={() => setMenuOpen(true)} aria-label="Open menu" aria-haspopup="dialog" className={ICON_BTN}>
          <Menu aria-hidden="true" className="h-6 w-6" />
        </button>
        <Link href={href("/")} className={`mr-1 hidden shrink-0 rounded-lg sm:inline-flex ${FOCUS}`}>
          <EflWordmark size={30} />
          <span className="sr-only">Eat For Less home</span>
        </Link>
        <Link href={href("/")} aria-label="Eat For Less home" className={`shrink-0 rounded-lg sm:hidden ${FOCUS}`}>
          <EflWordmarkCompact />
        </Link>
        <ModeToggle mode={mode} onChange={onModeChange} className="hidden md:flex" />
        <AddressChip label={locationLabel} />
        {searchBox(searchId, "hidden flex-1 md:block")}
        <div className="ml-auto md:ml-0">
          <BasketButton />
        </div>
      </div>
      <div className="flex flex-col gap-2 px-3 pb-3 sm:px-5 md:hidden">
        {searchBox(searchMobileId, "")}
        <ModeToggle mode={mode} onChange={onModeChange} className="w-fit" />
      </div>
      <SiteMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
    </header>
  );
}

function EflWordmarkCompact() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-9 w-9 items-center justify-center bg-[#D4FF3F] text-xl font-extrabold text-[#0B0B0B]"
      style={{ borderRadius: "10px 50% 50% 50%" }}
    >
      £
    </span>
  );
}
