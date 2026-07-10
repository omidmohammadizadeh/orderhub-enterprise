"use client";

// Deliverect-style "Add a menu" chooser. Three cards stacked vertically.
// Selecting one routes to the matching follow-up modal (which the
// parent renders) — we just emit the chosen kind here.

import { X, BookOpen, Folder, Calculator, Sparkles, Layers } from "lucide-react";

type MenuKind = "create" | "import-ai" | "import-channel" | "import-pos" | "master";

interface Props {
  open: boolean;
  onPick: (kind: MenuKind) => void;
  onCancel: () => void;
}

export function AddMenuModal({ open, onPick, onCancel }: Props) {
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
