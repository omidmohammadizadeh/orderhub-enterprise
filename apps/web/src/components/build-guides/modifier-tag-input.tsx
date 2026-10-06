"use client";

import { useId, useState } from "react";
import { X } from "lucide-react";

interface Props {
  label: string;
  hint: string;
  value: string[];
  onChange: (next: string[]) => void;
  /** The product's own modifier option names, offered as suggestions */
  suggestions: string[];
  tone: "amber" | "red";
}

/** Chips + a type-ahead of the product's modifier names (free text allowed). */
export function ModifierTagInput({ label, hint, value, onChange, suggestions, tone }: Props) {
  const listId = useId();
  const [text, setText] = useState("");
  const add = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    if (!value.some((v) => v.toLowerCase() === t.toLowerCase())) onChange([...value, t].slice(0, 20));
    setText("");
  };
  const chip =
    tone === "amber"
      ? "bg-amber-100 text-amber-900 ring-amber-200"
      : "bg-red-100 text-red-800 ring-red-200";

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-zinc-600">
        {label} <span className="font-normal text-zinc-400">— {hint}</span>
      </label>
      <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-zinc-200 px-2 py-1 focus-within:border-zinc-400">
        {value.map((v) => (
          <span key={v} className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ring-1 ${chip}`}>
            {v}
            <button
              type="button"
              onClick={() => onChange(value.filter((x) => x !== v))}
              aria-label={`Remove ${v}`}
              className="opacity-60 hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          list={listId}
          value={text}
          onChange={(e) => {
            const v = e.target.value;
            // Picking from the datalist fills the whole value in one go.
            if (suggestions.includes(v)) add(v);
            else setText(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add(text);
            } else if (e.key === "Backspace" && !text && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => add(text)}
          placeholder={value.length ? "" : "Pick or type a modifier"}
          className="min-w-[8rem] flex-1 bg-transparent py-0.5 text-sm outline-none"
        />
        <datalist id={listId}>
          {suggestions
            .filter((s) => !value.includes(s))
            .map((s) => (
              <option key={s} value={s} />
            ))}
        </datalist>
      </div>
    </div>
  );
}
