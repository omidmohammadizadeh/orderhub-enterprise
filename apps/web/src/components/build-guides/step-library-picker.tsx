"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Loader2, Search, Trash2, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { buildGuidesClient, type BuildStepTemplate } from "@/lib/api/build-guides.client";

export const STEP_LIBRARY_QUERY = ["build-step-library"] as const;

interface Props {
  open: boolean;
  onClose: () => void;
  /** Inserts a COPY into the guide — later library edits never change it. */
  onPick: (step: BuildStepTemplate) => void;
}

export function StepLibraryPicker({ open, onClose, onPick }: Props) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const q = useQuery({
    queryKey: [...STEP_LIBRARY_QUERY, debounced],
    queryFn: () => buildGuidesClient.library(debounced || undefined),
    enabled: open,
  });
  const remove = useMutation({
    mutationFn: (id: string) => buildGuidesClient.removeFromLibrary(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: STEP_LIBRARY_QUERY }),
  });

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
            <BookOpen className="h-4 w-4 text-orange-500" /> Step library
          </h3>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="border-b border-zinc-100 p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <Input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search saved steps — foil, toast, sauce…"
              className="pl-8"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {q.isLoading ? (
            <div className="flex items-center justify-center py-10 text-sm text-zinc-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : (q.data ?? []).length === 0 ? (
            <p className="py-10 text-center text-sm text-zinc-500">
              {debounced
                ? "No saved step matches."
                : "No saved steps yet. Use the bookmark on any step to save it here for reuse."}
            </p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {q.data!.map((t) => (
                <li key={t.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => onPick(t)}
                    className="flex w-full items-start gap-3 rounded-lg border border-zinc-200 p-2 text-left hover:border-orange-300 hover:bg-orange-50"
                  >
                    {t.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={t.imageUrl} alt="" className="h-14 w-[4.5rem] shrink-0 rounded object-cover" />
                    ) : (
                      <div className="h-14 w-[4.5rem] shrink-0 rounded bg-zinc-100" />
                    )}
                    <div className="min-w-0 pr-6">
                      <p className="truncate text-sm font-semibold text-zinc-900">{t.title}</p>
                      <p className="line-clamp-2 text-xs text-zinc-500">{t.text}</p>
                      {t.amount && (
                        <span className="mt-1 inline-block rounded bg-amber-100 px-1.5 text-[10px] font-bold text-amber-900">
                          {t.amount}
                        </span>
                      )}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => confirm(`Remove "${t.title}" from the library? Guides that use it keep their copy.`) && remove.mutate(t.id)}
                    className="absolute right-1.5 top-1.5 rounded p-1 text-zinc-300 hover:bg-red-50 hover:text-red-600"
                    title="Remove from library"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
