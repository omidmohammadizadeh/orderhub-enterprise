"use client";

// One prospect: the owner's private preview, and their commission report.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Copy, Download, ExternalLink, Trash2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import toast from "react-hot-toast";
import { extractShopFromSavedPage } from "@orderhub/shared";
import { prospectsClient, type Prospect } from "@/lib/api/prospects.client";
import { CommissionSection } from "./commission-section";
import { DropZone, errorMessage, mediaTypeOf, toUploadFile } from "./prospect-upload";

const POLL_MS = 3000;
const MENU_ACCEPT = ".html,.htm,.mhtml,.mht,.txt,.pdf,.png,.jpg,.jpeg,.webp";

function MenuSection({ prospect, onChange }: { prospect: Prospect; onChange: (p: Prospect) => void }) {
  const [busy, setBusy] = useState(false);
  const [hygieneLink, setHygieneLink] = useState("");
  const reading = busy || prospect.menuStatus === "READING";
  const previewUrl = typeof window === "undefined" ? "" : `${window.location.origin}/preview/${prospect.previewToken}`;
  const items = prospect.menu?.categories.flatMap((c) => c.items) ?? [];
  const photos = items.filter((i) => i.imageUrl).length;
  const ended = new Date(prospect.previewExpiresAt) < new Date();

  async function handleFiles(files: File[]) {
    setBusy(true);
    try {
      // A saved Just Eat or Deliveroo page is read here, in the browser: it can
      // hold 12 MB of JSON, and the menu inside is exact and comes with photos.
      if (files.length === 1 && mediaTypeOf(files[0]!) === "text/html") {
        const shop = extractShopFromSavedPage(await files[0]!.text());
        if (shop) {
          const { draft, shopName, logoUrl, bannerUrl, city, postcode } = shop;
          onChange(await prospectsClient.saveMenu(prospect.id, { draft, shopName, logoUrl, bannerUrl, city, postcode }));
          toast.success("Menu ready");
          return;
        }
      }
      onChange(await prospectsClient.readMenu(prospect.id, await Promise.all(files.map(toUploadFile))));
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't read this file."));
    } finally {
      setBusy(false);
    }
  }

  async function saveHygiene() {
    try {
      onChange(await prospectsClient.setHygiene(prospect.id, hygieneLink.trim()));
      setHygieneLink("");
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't find that rating."));
    }
  }

  function downloadMenu() {
    const blob = new Blob([JSON.stringify(prospect.menu, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${prospect.shopName.replace(/[^\w-]+/g, "-").toLowerCase()}-menu.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section aria-labelledby="menu-heading" className="rounded-xl border border-zinc-200 bg-white p-5">
      <h2 id="menu-heading" className="text-lg font-semibold text-zinc-900">Their shop</h2>

      {prospect.menuStatus !== "READY" && (
        <ol className="mt-3 list-inside list-decimal space-y-1.5 text-sm text-zinc-600">
          <li>
            {prospect.sourceUrl ? (
              <a href={prospect.sourceUrl} target="_blank" rel="noreferrer" className="font-medium text-orange-700 underline underline-offset-2">
                Open the shop&apos;s page
              </a>
            ) : (
              "Open the shop's page"
            )}
            {" "}on a computer and let the menu load.
          </li>
          <li>
            Save it with <kbd className="rounded bg-zinc-100 px-1">⌘S</kbd> or <kbd className="rounded bg-zinc-100 px-1">Ctrl+S</kbd>, as &ldquo;Webpage, HTML Only&rdquo;.
          </li>
          <li>Drop the file here.</li>
        </ol>
      )}

      {prospect.menuStatus === "FAILED" && (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{prospect.menuError}</p>
      )}

      {prospect.menuStatus === "READY" && (
        <div className="mt-4 flex flex-col gap-5 sm:flex-row">
          <div className="shrink-0 self-center rounded-xl border border-zinc-200 bg-white p-3 sm:self-start">
            <QRCodeSVG value={previewUrl} size={168} marginSize={0} title={`Preview of ${prospect.shopName}`} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-zinc-600">
              Ask them to scan this. It opens their menu on their phone: {items.length} items, {photos} with photos.
            </p>
            {ended && <p className="mt-2 text-sm font-medium text-red-700">This link has ended. Upload the menu again to renew it.</p>}
            {!ended && (
              <p className="mt-2 text-xs text-zinc-500">
                Private and can&apos;t take orders. The link ends on {new Date(prospect.previewExpiresAt).toLocaleDateString("en-GB")}.
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <a
                href={previewUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-zinc-300 px-3 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
              >
                <ExternalLink className="h-4 w-4" aria-hidden="true" /> Open
              </a>
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(previewUrl).then(() => toast.success("Link copied"))}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-zinc-300 px-3 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
              >
                <Copy className="h-4 w-4" aria-hidden="true" /> Copy link
              </button>
              <button
                type="button"
                onClick={downloadMenu}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-zinc-300 px-3 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
              >
                <Download className="h-4 w-4" aria-hidden="true" /> Download menu
              </button>
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              When they sign, create their brand, then use Add a menu → Import JSON file with this download.
            </p>

            <div className="mt-4 border-t border-zinc-100 pt-3 text-sm">
              {prospect.hygiene ? (
                <p className="text-zinc-700">
                  Food hygiene rating: <strong>{prospect.hygiene.rating}</strong>
                  {!["3", "4", "5", "Pass", "Pass and Eat Safe"].includes(prospect.hygiene.rating) && " (not shown on the preview)"}
                </p>
              ) : (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    aria-label="Food hygiene ratings link"
                    name="hygiene-link"
                    autoComplete="off"
                    value={hygieneLink}
                    onChange={(e) => setHygieneLink(e.target.value)}
                    placeholder="Rating not found. Paste its ratings.food.gov.uk link…"
                    className="min-h-10 w-full rounded-lg border border-zinc-300 px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-500"
                  />
                  <button
                    type="button"
                    disabled={!hygieneLink.trim()}
                    onClick={saveHygiene}
                    className="min-h-10 shrink-0 rounded-lg border border-zinc-300 px-3 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
                  >
                    Add rating
                  </button>
                </div>
              )}
            </div>
            {!!prospect.menu?.warnings?.length && (
              <ul className="mt-3 space-y-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                {prospect.menu.warnings.map((w) => <li key={w}>{w}</li>)}
              </ul>
            )}
          </div>
        </div>
      )}

      <div className="mt-4">
        <DropZone
          label={prospect.menuStatus === "READY" ? "Replace the menu" : "Choose the saved page"}
          hint="Just Eat and Deliveroo pages bring photos. An Uber Eats page, PDF or photo also works, read by AI, without photos."
          accept={MENU_ACCEPT}
          busy={reading}
          onFiles={handleFiles}
        />
      </div>
    </section>
  );
}

export function ProspectDetail({ id }: { id: string }) {
  const router = useRouter();
  const [prospect, setProspect] = useState<Prospect | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setProspect(await prospectsClient.get(id));
      setError(null);
    } catch (e) {
      setError(errorMessage(e, "Couldn't load this prospect."));
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Reading runs in the background on the server, so watch the row until it's done.
  const reading = prospect?.menuStatus === "READING" || prospect?.statementStatus === "READING";
  useEffect(() => {
    if (!reading) return;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [reading, load]);

  async function remove() {
    if (!window.confirm(`Delete ${prospect?.shopName}? Their preview link stops working and their statement figures are erased.`)) return;
    try {
      await prospectsClient.remove(id);
      router.push("/dashboard/admin/prospects");
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't delete this prospect."));
    }
  }

  if (error && !prospect) return <p className="text-sm text-red-600">{error}</p>;
  if (!prospect) return <p className="text-sm text-zinc-500">Loading…</p>;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <Link href="/dashboard/admin/prospects" className="inline-flex min-h-10 items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Prospects
        </Link>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-zinc-900 [text-wrap:balance]">{prospect.shopName}</h1>
            {(prospect.city || prospect.postcode) && (
              <p className="mt-0.5 text-sm text-zinc-500">{[prospect.city, prospect.postcode].filter(Boolean).join(", ")}</p>
            )}
          </div>
          <button
            type="button"
            onClick={remove}
            aria-label={`Delete ${prospect.shopName}`}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-red-50 hover:text-red-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-500"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      <MenuSection prospect={prospect} onChange={setProspect} />
      <CommissionSection prospect={prospect} onChange={setProspect} />
    </div>
  );
}
