"use client";

// Deliverect-style "Add a menu" chooser. Three cards stacked vertically.
// Selecting one routes to the matching follow-up modal (which the
// parent renders) — we just emit the chosen kind here.

import { X, BookOpen, Folder, Calculator, Sparkles, Layers, Copy, FileJson } from "lucide-react";
import { useAuthStore } from "@/stores/auth.store";

type MenuKind =
  | "create"
  | "import-ai"
  | "import-channel"
  | "import-pos"
  | "master"
  | "clone-location"
  | "import-json";

interface Props {
  open: boolean;
  onPick: (kind: MenuKind) => void;
  onCancel: () => void;
}

export function AddMenuModal({ open, onPick, onCancel }: Props) {
  // Hooks before the early return — React requires a stable hook order, and
  // this component returns null while closed.
  const role = useAuthStore((s) => s.user?.role);
  const isAdmin = role === "PLATFORM_ADMIN";
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl">
        <div className="flex items-center justify-between p-5 border-b border-zinc-100">
          <h2 className="text-base font-semibold text-zinc-900">Add a menu</h2>
          <button
            onClick={onCancel}
            className="text-zinc-400 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5 space-y-3">
          <Card
            icon={<BookOpen className="h-5 w-5" />}
            title="Create menu"
            description="Start a new menu from scratch"
            onClick={() => onPick("create")}
          />
          <Card
            icon={<Sparkles className="h-5 w-5" />}
            title="Import from photo or PDF"
            description="Upload your menu — AI builds the categories, items, prices and options for you"
            badge="AI"
            onClick={() => onPick("import-ai")}
          />
          <Card
            icon={<Folder className="h-5 w-5" />}
            title="Import from channel"
            description="Import your menu from a connected channel (Uber Eats, Deliveroo, etc.)"
            onClick={() => onPick("import-channel")}
          />
          <Card
            icon={<Calculator className="h-5 w-5" />}
            title="Import from POS"
            description="Import from your point of sale"
            onClick={() => onPick("import-pos")}
          />
          <Card
            icon={<Layers className="h-5 w-5" />}
            title="Master menu"
            description="Combine several of this location's menus (one per brand) into one — for a single HubRise catalog serving every brand"
            onClick={() => onPick("master")}
          />
          {/* Admin-only for now: the JSON is hand-built per shop, so this is
              a tool for us rather than something to hand an operator yet. The
              gate is on VISIBILITY only — the commit endpoint behind it is the
              same one the AI import uses and still accepts managers. */}
          {isAdmin && (
            <Card
              icon={<FileJson className="h-5 w-5" />}
              title="Import JSON file"
              description="Build a whole menu from a prepared JSON file — categories, items, sizes and options in one go"
              badge="Admin"
              onClick={() => onPick("import-json")}
            />
          )}
          <Card
            icon={<Copy className="h-5 w-5" />}
            title="Clone from another location"
            description="Copy a menu from one of your other locations into this location as a new, independent menu"
            onClick={() => onPick("clone-location")}
          />
        </div>
      </div>
    </div>
  );
}

function Card({
  icon,
  title,
  description,
  onClick,
  badge,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-4 rounded-xl border border-zinc-200 p-4 text-left transition-colors hover:border-zinc-300 hover:bg-zinc-50"
    >
      <span className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-lg bg-zinc-100 text-zinc-700">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
          {title}
          {badge && (
            <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-violet-700">
              {badge}
            </span>
          )}
        </p>
        <p className="text-xs text-zinc-500">{description}</p>
      </span>
    </button>
  );
}
