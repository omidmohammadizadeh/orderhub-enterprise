"use client";

import { useMemo, useState } from "react";
import { Monitor, Smartphone } from "lucide-react";
import { personalise, renderEmail, type EmailDesign } from "@orderhub/shared";
import { cn } from "@/lib/utils";

/**
 * The live preview. Uses the SAME renderer the API sends with, so what the
 * restaurant sees here is what lands in the inbox — including the footer and
 * unsubscribe link they can't remove.
 */
export function EmailPreview({
  design,
  brandName,
  logoUrl,
  subject,
  preheader,
  footerAddress,
  firstName = "Sam",
}: {
  design: EmailDesign;
  brandName: string;
  logoUrl?: string | null;
  subject: string;
  preheader?: string | null;
  footerAddress?: string | null;
  firstName?: string;
}) {
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const html = useMemo(
    () =>
      renderEmail(design, {
        brandName,
        logoUrl,
        storefrontUrl: "#",
        unsubscribeUrl: "#",
        footerAddress: footerAddress ?? "Your shop address appears here",
        firstName,
        preheader,
      }).html,
    [design, brandName, logoUrl, preheader, footerAddress, firstName],
  );
  const vars = { firstName, brandName };

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-2.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Preview</span>
        <div className="flex rounded-lg bg-zinc-100 p-0.5">
          {(
            [
              ["desktop", Monitor],
              ["mobile", Smartphone],
            ] as const
          ).map(([d, Icon]) => (
            <button
              key={d}
              onClick={() => setDevice(d)}
              aria-label={d}
              className={cn(
                "rounded-md px-2 py-1 text-zinc-500",
                device === d && "bg-white text-zinc-900 shadow-sm",
              )}
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
        </div>
      </div>
      {/* How it looks in the inbox list — subject + preview text decide the open. */}
      <div className="flex items-start gap-3 border-b border-zinc-100 bg-zinc-50 px-4 py-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-sm font-bold text-white">
          {(brandName || "?").trim().charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 text-sm">
          <div className="truncate font-semibold text-zinc-900">{brandName}</div>
          <div className="truncate text-zinc-800">{personalise(subject, vars) || "Your subject line"}</div>
          <div className="truncate text-xs text-zinc-500">{personalise(preheader ?? "", vars)}</div>
        </div>
      </div>
      <div className="flex justify-center bg-zinc-100 p-3">
        <iframe
          title="Email preview"
          srcDoc={html}
          sandbox=""
          className="rounded-lg border-0 bg-white transition-all"
          style={{ width: device === "desktop" ? "100%" : 375, maxWidth: 640, height: 720 }}
        />
      </div>
    </div>
  );
}
