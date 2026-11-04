"use client";

// Admin Dashboard → Prospects. Every shop we're preparing to pitch, and the box
// that starts a new one from its marketplace link.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Handshake, Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import { prospectsClient, type Prospect } from "@/lib/api/prospects.client";

const menuItemCount = (p: Prospect) =>
  p.menu?.categories.reduce((n, c) => n + c.items.length, 0) ?? 0;

export function ProspectsPanel() {
  const router = useRouter();
  const [rows, setRows] = useState<Prospect[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await prospectsClient.list());
      setError(null);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Couldn't load prospects.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    const value = link.trim();
    if (!value) return;
    setCreating(true);
    try {
      const isLink = /^https?:\/\//i.test(value);
      const prospect = await prospectsClient.create(isLink ? { sourceUrl: value } : { shopName: value });
      router.push(`/dashboard/admin/prospects/${prospect.id}`);
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Couldn't start this prospect.");
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold text-zinc-900">Prospects</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Walk into the meeting with their shop already built and their commission already added up.
      </p>

      <form onSubmit={create} className="mt-6 rounded-xl border border-zinc-200 bg-white p-4">
        <label htmlFor="prospect-link" className="text-sm font-medium text-zinc-800">
          Marketplace link or shop name
        </label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            id="prospect-link"
            name="prospect-link"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="https://www.just-eat.co.uk/restaurants-…"
            className="min-h-11 w-full rounded-lg border border-zinc-300 px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-500"
          />
          <button
            type="submit"
            disabled={creating || !link.trim()}
            className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-orange-600 px-4 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500"
          >
            {creating && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            Start
          </button>
        </div>
      </form>

      <div className="mt-6" aria-live="polite">
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!rows && !error && <p className="text-sm text-zinc-500">Loading…</p>}
        {rows?.length === 0 && (
          <div className="flex flex-col items-center py-14 text-center">
            <Handshake className="mb-3 h-9 w-9 text-zinc-300" aria-hidden="true" />
            <p className="text-sm text-zinc-500">No prospects yet. Paste a shop&apos;s link above to start.</p>
          </div>
        )}
        {!!rows?.length && (
          <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 bg-white">
            {rows.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/dashboard/admin/prospects/${p.id}`}
                  className="flex min-h-16 items-center justify-between gap-3 px-4 py-3 hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-orange-500"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-zinc-900">{p.shopName}</span>
                    <span className="block text-sm text-zinc-500">
                      {p.menuStatus === "READY" ? `${menuItemCount(p)} menu items` : "No menu yet"}
                      {" · "}
                      {p.statements.length === 1 ? "1 statement" : `${p.statements.length} statements`}
                    </span>
                  </span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
