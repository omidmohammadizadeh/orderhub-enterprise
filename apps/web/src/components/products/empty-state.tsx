"use client";
import type { LucideIcon } from "lucide-react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  icon: LucideIcon;
  title: string;
  description: string;
  ctaLabel: string;
  onCta: () => void;
}

export function CatalogEmptyState({ icon: Icon, title, description, ctaLabel, onCta }: Props) {
  return (
    <div className="flex flex-col items-center justify-center py-20 border-2 border-dashed border-zinc-200 rounded-xl text-center">
      <Icon className="h-10 w-10 text-zinc-300 mb-3" />
      <p className="font-medium text-zinc-600">{title}</p>
      <p className="text-sm text-zinc-400 mt-1 mb-5 max-w-sm">{description}</p>
      <Button
        size="sm"
        onClick={onCta}
        className="bg-orange-500 hover:bg-orange-600 text-white"
      >
        <Plus className="h-4 w-4 mr-1.5" />
        {ctaLabel}
      </Button>
    </div>
  );
}
