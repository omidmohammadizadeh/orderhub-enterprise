"use client";

// Which barcode layout this shop's label scale prints. Scales disagree on
// where the price (or weight) sits inside a "2…" barcode, so the till needs
// telling once; it's stored on Location.settings.scaleLabels.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Scale } from "lucide-react";
import { normaliseScaleFormat, SCALE_FORMATS, type ScaleFormatId } from "@orderhub/shared";
import { locationsClient } from "@/lib/api/locations.client";
import { queryKeys } from "@/lib/api/query-keys";

export function ScaleLabelSetting({ locationId, settings }: { locationId: string; settings: unknown }) {
  const qc = useQueryClient();
  const current = normaliseScaleFormat((settings as any)?.scaleLabels?.format);
  const [format, setFormat] = useState<ScaleFormatId>(current);
  const save = useMutation({
    mutationFn: (f: ScaleFormatId) =>
      locationsClient.update(locationId, { settings: { scaleLabels: { format: f } } } as any),
    onSuccess: () => {
      toast.success("Scale label format saved");
      void qc.invalidateQueries({ queryKey: queryKeys.locationDetail(locationId) });
    },
    onError: (e: any) => {
      setFormat(current);
      toast.error(e?.response?.data?.message ?? "Couldn't save");
    },
  });
  const example = SCALE_FORMATS.find((f) => f.id === format)?.example;

  return (
    <details className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm">
      <summary className="flex cursor-pointer items-center gap-2 font-medium text-zinc-800">
        <Scale className="h-4 w-4 text-zinc-500" aria-hidden /> Label scale
      </summary>
      <div className="mt-2 space-y-2 pb-1">
        <p className="text-xs text-zinc-500">
          Loose products (sold per kg or per 100 g) can be weighed on a label scale. Give each one a scale code in
          the product editor, then pick how your scale lays out its barcodes — check a printed label or the scale&apos;s
          manual. Without a scale, staff type the weight at the till.
        </p>
        <label className="block">
          <span className="sr-only">Barcode layout</span>
          <select
            value={format}
            disabled={save.isPending}
            onChange={(e) => {
              const f = e.target.value as ScaleFormatId;
              setFormat(f);
              save.mutate(f);
            }}
            className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm sm:w-auto"
          >
            {SCALE_FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        {example && (
          <p className="font-mono text-[11px] text-zinc-500">
            {example} <span className="font-sans">— C = scale code, P = pence, W = grams, K = check digit</span>
          </p>
        )}
      </div>
    </details>
  );
}
