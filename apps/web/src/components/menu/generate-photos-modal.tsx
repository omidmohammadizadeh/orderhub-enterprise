"use client";

// Generate photos for a category — the button version of what the admin
// assistant could already do in chat.
//
// Asking a chat to photograph a category works, but it's a strange way to run
// a routine job: the operator has to describe in prose what is really three
// choices (which category, what background, overwrite or not). This is those
// three choices, and it calls the same throttled server-side job.
//
// The generation runs on the API using the key already in its environment, so
// nothing here handles a secret.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X, Camera, Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { menusClient } from "@/lib/api/menus.client";

/**
 * Two looks that actually suit a menu tile, worded the way the model responds
 * to. Free text is still allowed — an operator who knows what they want
 * shouldn't be limited to a preset.
 */
const BACKGROUNDS = [
  {
    key: "black",
    label: "Black studio",
    hint:
      "pure black seamless background, single dramatic key light from above, " +
      "soft shadow beneath the food, no props, no background clutter",
  },
  {
    key: "white",
    label: "White studio",
    hint:
      "pure white seamless background, soft even studio lighting, clean and " +
      "bright, minimal soft shadow, no props, no background clutter",
  },
] as const;

interface Props {
  open: boolean;
  menuId: string;
  category: { id: string; name: string; count: number } | null;
  onClose: () => void;
}

export function GeneratePhotosModal({ open, menuId, category, onClose }: Props) {
  const qc = useQueryClient();
  const [bg, setBg] = useState<string>(BACKGROUNDS[0].hint);
  const [extra, setExtra] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(true);
  const [job, setJob] = useState<{ done: number; total: number; failed: number } | null>(
    null,
  );
  const [lost, setLost] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  // Stop polling when the modal closes, or the interval outlives the screen
  // and keeps hitting the API from a component nobody is looking at.
  useEffect(
    () => () => {
      if (poll.current) clearInterval(poll.current);
    },
    [],
  );

  const start = useMutation({
    mutationFn: () =>
      menusClient.generateMenuImages({
        menuId,
        categoryId: category?.id,
        styleHint: [bg, extra.trim()].filter(Boolean).join(". "),
        onlyMissing,
      }),
    onSuccess: (r) => {
      if (r.error || !r.jobId) {
        toast.error(r.error ?? "Could not start");
        return;
      }
      toast.success("Generating — photos will appear as they finish");
      poll.current = setInterval(async () => {
        try {
          const s = await menusClient.getMenuImageJob(r.jobId!);
          setJob({ done: s.done, total: s.total, failed: s.failed });
          // Refresh the grid as they land, so the operator sees progress on
          // the cards rather than only in this dialog.
          qc.invalidateQueries({ queryKey: ["menu", menuId] });
          // "unknown" means the server no longer has this job: the API
          // restarted (a deploy, or Render cycling the instance) and the job
          // map lives in process memory. Reporting that as "done" claims a
          // success that didn't happen — the first run of this lost 3 of 5
          // photos to a deploy and said it had finished.
          if (s.status === "unknown") {
            if (poll.current) clearInterval(poll.current);
            setLost(true);
            toast.error("The API restarted and the job was lost — run it again");
            return;
          }
          if (s.status !== "running") {
            if (poll.current) clearInterval(poll.current);
            toast.success(
              `Done — ${s.done} photo${s.done === 1 ? "" : "s"}` +
                (s.failed ? `, ${s.failed} failed` : ""),
            );
          }
        } catch {
          /* transient poll failure — the next tick retries */
        }
      }, 3000);
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not start"),
  });

  if (!open || !category) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-zinc-200 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">
              Generate photos — {category.name}
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              Each photo is generated from the item&apos;s own description, so
              fill those in first for the best results.
            </p>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-zinc-100">
            <X className="h-4 w-4 text-zinc-500" />
          </button>
        </div>

        <div className="space-y-5 px-6 py-5">
          <div>
            <label className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Background
            </label>
            <div className="mt-2 flex gap-2">
              {BACKGROUNDS.map((b) => (
                <button
                  key={b.key}
                  onClick={() => setBg(b.hint)}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm ${
                    bg === b.hint
                      ? "border-zinc-900 bg-zinc-900 text-white"
                      : "border-zinc-200 text-zinc-700 hover:border-zinc-300"
                  }`}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Anything else (optional)
            </label>
            <input
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              placeholder="e.g. served in a takeaway box, garnish on the side"
              className="mt-2 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
            />
          </div>

          <label className="flex items-start gap-2 text-sm text-zinc-700">
            <input
              type="checkbox"
              checked={onlyMissing}
              onChange={(e) => setOnlyMissing(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Only items without a photo
              <span className="block text-xs text-zinc-500">
                Unticking regenerates everything in this category and replaces
                photos you already have.
              </span>
            </span>
          </label>

          {job && !lost && (
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700">
              {job.done} of {job.total} done
              {job.failed ? ` · ${job.failed} failed` : ""}
            </div>
          )}

          {lost && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              The API restarted while this was running, so the job was lost.
              Anything already generated has been saved — run it again with
              &ldquo;only items without a photo&rdquo; ticked to finish the rest.
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-zinc-200 bg-zinc-50 px-6 py-4">
          <span className="text-xs text-zinc-500">
            Up to {category.count} photo{category.count === 1 ? "" : "s"} · costs
            per image
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              {job ? "Close" : "Cancel"}
            </Button>
            <Button
              size="sm"
              disabled={start.isPending || (!!job && !lost)}
              onClick={() => {
                setLost(false);
                setJob(null);
                start.mutate();
              }}
              className="gap-1.5 bg-zinc-900 text-white hover:bg-zinc-800"
            >
              {start.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Camera className="h-4 w-4" />
              )}
              Generate
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
