"use client";

// Gulf payouts — the brand's own Tap merchant account.
//
// Tap issued us PLATFORM accounts: every card payment for a Gulf brand goes to
// that brand's own Tap merchant, with our commission riding on the charge. The
// restaurant opens the merchant itself (KYC on Tap's pages) from a sign-up link
// generated here; Tap tells us the merchant id when it's done. An admin can
// also paste one in from Tap OS. Self-contained, like the custom-domain panel:
// it saves on its own buttons, not the drawer's Save.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { brandsClient, type Brand } from "@/lib/api/locations.client";

export function BrandTapPayoutsPanel({
  brand,
  canEdit,
}: {
  brand: Brand;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const [merchantId, setMerchantId] = useState(brand.tapMerchantId ?? "");
  const [link, setLink] = useState(brand.tapConnectUrl ?? "");
  const [status, setStatus] = useState(brand.tapOnboardingStatus ?? "not_started");
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["brands"] });
  };

  const start = useMutation({
    mutationFn: () => brandsClient.startTapOnboarding(brand.id),
    onSuccess: (r) => {
      setLink(r.connectUrl);
      setStatus(r.status);
      setErr(null);
      refresh();
    },
    onError: (e: any) =>
      setErr(e?.response?.data?.message ?? "Couldn't create the Tap sign-up link"),
  });

  const saveMerchant = useMutation({
    mutationFn: (id: string | null) => brandsClient.setTapMerchant(brand.id, id),
    onSuccess: (r) => {
      setMerchantId(r.tapMerchantId ?? "");
      setStatus(r.tapOnboardingStatus);
      setErr(null);
      refresh();
    },
    onError: (e: any) =>
      setErr(e?.response?.data?.message ?? "Couldn't save the merchant id"),
  });

  const saved = (brand.tapMerchantId ?? "") === merchantId.trim();
  const done = status === "completed" && !!merchantId.trim();

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-zinc-500">
        Gulf shops are paid through Tap, not Stripe. Card payments go straight
        to the restaurant&apos;s own Tap merchant account; our fee is taken on
        each payment and shows on their Tap statement.
      </p>

      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-zinc-600">Status</span>
        {done ? (
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
            ● Connected
          </span>
        ) : status === "link_sent" ? (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
            ● Waiting for the restaurant to finish Tap sign-up
          </span>
        ) : (
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-600">
            ● Not started
          </span>
        )}
      </div>

      {!done && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => start.mutate()}
            disabled={!canEdit || start.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            {start.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {link ? "Create a new sign-up link" : "Create Tap sign-up link"}
          </button>
          {link && (
            <div className="space-y-1">
              <span className="text-[11px] text-zinc-500">
                Send this to the restaurant. They complete Tap&apos;s checks
                (trade licence, ID, bank details) and we&apos;re told
                automatically when the account is ready.
              </span>
              <div className="flex items-center gap-1.5">
                <code className="flex-1 truncate rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-[11px] text-zinc-700">
                  {link}
                </code>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText(link);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                  className="rounded-md border border-zinc-200 bg-white p-1.5 text-zinc-500 hover:text-zinc-900"
                  aria-label="Copy sign-up link"
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-emerald-600" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </button>
                <a
                  href={link}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md border border-zinc-200 bg-white p-1.5 text-zinc-500 hover:text-zinc-900"
                  aria-label="Open sign-up link"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="space-y-1">
        <span className="text-[11px] font-medium text-zinc-600">Tap merchant id</span>
        <div className="flex items-center gap-1.5">
          <input
            value={merchantId}
            onChange={(e) => setMerchantId(e.target.value)}
            disabled={!canEdit}
            placeholder="merchant_… (filled in automatically)"
            className="input flex-1 font-mono"
          />
          <button
            type="button"
            onClick={() => saveMerchant.mutate(merchantId.trim() || null)}
            disabled={!canEdit || saved || saveMerchant.isPending}
            className="rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 disabled:opacity-40"
          >
            {saveMerchant.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
          </button>
        </div>
        {!merchantId.trim() && (
          <p className="text-[11px] text-amber-600">
            Until this is set the shop can take cash but not cards.
          </p>
        )}
      </div>

      {err && <p className="text-[11px] text-red-600">{err}</p>}
    </div>
  );
}
