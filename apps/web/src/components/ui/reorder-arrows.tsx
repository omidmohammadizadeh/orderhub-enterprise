"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Up / down buttons for putting a list in order. Replaces drag-and-drop in
 * the menu editor: a tap works on a touch screen, where HTML5 drag never
 * fires, and it can't drop a row in the wrong place.
 */
export function ReorderArrows({
  label,
  isFirst,
  isLast,
  onMove,
  disabled = false,
  className,
}: {
  /** What is being moved, for the buttons' accessible names. */
  label: string;
  isFirst: boolean;
  isLast: boolean;
  onMove: (delta: -1 | 1) => void;
  disabled?: boolean;
  className?: string;
}) {
  const button =
    "grid h-6 w-7 place-items-center rounded text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 disabled:pointer-events-none disabled:opacity-25";
  return (
    <span className={cn("flex shrink-0 flex-col", className)}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onMove(-1);
        }}
        disabled={disabled || isFirst}
        className={button}
        aria-label={`Move ${label} up`}
        title="Move up"
      >
        <ChevronUp className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onMove(1);
        }}
        disabled={disabled || isLast}
        className={button}
        aria-label={`Move ${label} down`}
        title="Move down"
      >
        <ChevronDown className="h-4 w-4" />
      </button>
    </span>
  );
}
