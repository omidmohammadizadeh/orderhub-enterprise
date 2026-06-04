"use client";

// Phase AP — System Secrets admin page.
//
// Flow:
//   1. Page mounts → check status endpoint. If the vault is disabled
//      (no SECRETS_MASTER_KEY on the API), show a hint screen explaining
//      how to enable it.
//   2. Password prompt — re-enter the admin's own password. The API
//      validates it and returns a 10-min unlock JWT that stays in
//      MEMORY (never localStorage) and is sent as X-Secrets-Unlock on
//      every reveal/write request.
//   3. List view, grouped by category. Each row shows masked
//      sk_live_••••4u9X. Buttons: Reveal (temporary clipboard),
//      Edit, Delete.
//   4. Add new — key, label, category, value, description.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useAuthStore } from "@/stores/auth.store";
import { secretsClient, type SecretMetadata } from "@/lib/api/secrets.client";

const UNLOCK_TTL_MS = 10 * 60 * 1000;

export default function SecretsPage() {
  const user = useAuthStore((s) => s.user);
  // Only PLATFORM_ADMIN can see this page. Server enforces too; this is
  // just a friendly UI guard.
  if (user && user.role !== "PLATFORM_ADMIN") {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Lock className="h-10 w-10 text-zinc-300 mb-3" />
        <p className="font-medium text-zinc-500">Admin only</p>
        <p className="text-sm text-zinc-400 mt-1">
          Only the platform admin can access the secrets vault.
        </p>
      </div>
    );
  }

  return <SecretsInner />;
}

function SecretsInner() {
  const qc = useQueryClient();

  // ── Vault status ─────────────────────────────────────────────────────────
  const statusQuery = useQuery({
    queryKey: ["secrets", "status"],
    queryFn: () => secretsClient.status(),
  });

  // ── Unlock state ─────────────────────────────────────────────────────────
  // Token in memory only. We track expiry so the UI can re-prompt
  // automatically if it lapses.
  const [unlockToken, setUnlockToken] = useState<string | null>(null);
  const [unlockExpiresAt, setUnlockExpiresAt] = useState<number | null>(null);

  // Auto-clear after TTL.
  useEffect(() => {
    if (!unlockExpiresAt) return;
    const t = window.setTimeout(
      () => {
        setUnlockToken(null);
        setUnlockExpiresAt(null);
      },
      Math.max(0, unlockExpiresAt - Date.now()),
    );
    return () => window.clearTimeout(t);
  }, [unlockExpiresAt]);

  const enabled = !!statusQuery.data?.enabled;
  const isLocked = !unlockToken;

  if (statusQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 text-zinc-500 py-12">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading vault status…
      </div>
    );
  }

  if (!enabled) {
    return <DisabledVaultScreen />;
  }

  if (isLocked) {
    return (
      <UnlockScreen
        onUnlocked={(token, expiresInSec) => {
          setUnlockToken(token);
          setUnlockExpiresAt(Date.now() + Math.min(expiresInSec * 1000, UNLOCK_TTL_MS));
        }}
      />
    );
  }

  return (
    <SecretsList
      unlockToken={unlockToken!}
      unlockExpiresAt={unlockExpiresAt!}
      onLock={() => {
        setUnlockToken(null);
        setUnlockExpiresAt(null);
      }}
      onChanged={() => qc.invalidateQueries({ queryKey: ["secrets", "list"] })}
    />
  );
}

// ── Disabled vault ──────────────────────────────────────────────────────────

function DisabledVaultScreen() {
  return (
    <div className="max-w-2xl mx-auto py-16">
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-6">
        <div className="flex items-start gap-3">
          <KeyRound className="h-6 w-6 text-amber-600 mt-0.5" />
          <div>
            <h2 className="text-lg font-bold text-zinc-900">
              Secrets vault is not configured yet
            </h2>
            <p className="mt-2 text-sm text-zinc-700 leading-relaxed">
              To turn the vault on, set the{" "}
              <code className="rounded bg-white px-1.5 py-0.5 font-mono text-xs text-zinc-800 border border-zinc-200">
                SECRETS_MASTER_KEY
              </code>{" "}
              environment variable on the <strong>API</strong> service to a 32-byte
              base64 string. Generate one in a terminal with:
            </p>
            <pre className="mt-3 rounded-lg bg-zinc-900 px-4 py-3 text-xs text-emerald-300 overflow-x-auto">
              openssl rand -base64 32
            </pre>
            <p className="mt-3 text-xs text-zinc-600 leading-relaxed">
              Paste the output into Render → orderhub-api → Environment →{" "}
              <code className="rounded bg-white px-1 py-0.5 font-mono">SECRETS_MASTER_KEY</code>{" "}
              → Save. Render redeploys in ~3 minutes. Then reload this page.
            </p>
            <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">
              ⚠ Keep this key safe. If you lose it, every stored secret becomes
              unreadable — there is no recovery path.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Unlock screen ──────────────────────────────────────────────────────────

function UnlockScreen({
  onUnlocked,
}: {
  onUnlocked: (token: string, expiresInSec: number) => void;
}) {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);

  const unlock = useMutation({
    mutationFn: () => secretsClient.unlock(password),
    onSuccess: (res) => {
      setPassword("");
      onUnlocked(res.token, res.expiresIn);
    },
  });

  return (
    <div className="max-w-md mx-auto py-16">
      <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="grid h-12 w-12 place-items-center rounded-full bg-zinc-100 mb-4">
          <ShieldCheck className="h-6 w-6 text-zinc-700" />
        </div>
        <h2 className="text-lg font-bold text-zinc-900 mb-1">
          Re-enter your password
        </h2>
        <p className="text-sm text-zinc-500 mb-5">
          The vault stays locked even after sign-in. Confirm your password to
          view secrets. The unlock lasts 10 minutes.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!password) return;
            unlock.mutate();
          }}
          className="space-y-3"
        >
          <div className="relative">
            <input
              autoFocus
              type={show ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Your password"
              className="w-full rounded-md border border-zinc-200 px-3 py-2 pr-10 text-sm focus:border-zinc-900 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setShow(!show)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 hover:bg-zinc-100"
            >
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {unlock.error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
              {(unlock.error as any)?.response?.data?.message ??
                "Incorrect password"}
            </p>
          )}
          <button
            type="submit"
            disabled={!password || unlock.isPending}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {unlock.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Unlock vault
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Secrets list ───────────────────────────────────────────────────────────

function SecretsList({
  unlockToken,
  unlockExpiresAt,
  onLock,
  onChanged,
}: {
  unlockToken: string;
  unlockExpiresAt: number;
  onLock: () => void;
  onChanged: () => void;
}) {
  const listQuery = useQuery({
    queryKey: ["secrets", "list"],
    queryFn: () => secretsClient.list(),
  });

  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<SecretMetadata | "new" | null>(null);

  const grouped = useMemo(() => {
    const rows = (listQuery.data ?? []).filter((r) => {
      if (!filter.trim()) return true;
      const q = filter.toLowerCase();
      return (
        r.key.toLowerCase().includes(q) ||
        (r.label ?? "").toLowerCase().includes(q) ||
        (r.category ?? "").toLowerCase().includes(q)
      );
    });
    const map = new Map<string, SecretMetadata[]>();
    for (const r of rows) {
      const cat = r.category ?? "uncategorised";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(r);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [listQuery.data, filter]);

  // Tick once a second so the "expires in" badge updates without
  // having to manage a stateful timer per row.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const remainingSec = Math.max(0, Math.floor((unlockExpiresAt - now) / 1000));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Secrets</h1>
          <p className="text-sm text-zinc-500">
            API keys and credentials the backend uses. Encrypted at rest.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-zinc-500">
            Unlocked · auto-locks in {Math.floor(remainingSec / 60)}:
            {String(remainingSec % 60).padStart(2, "0")}
          </span>
          <button
            type="button"
            onClick={onLock}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            <Lock className="h-3.5 w-3.5" /> Lock now
          </button>
          <button
            type="button"
            onClick={() => setEditing("new")}
            className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800"
          >
            <Plus className="h-3.5 w-3.5" /> Add secret
          </button>
        </div>
      </div>

      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Search by key, label, or category…"
        className="w-full max-w-md rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
      />

      {listQuery.isLoading ? (
        <p className="text-sm text-zinc-400 py-6">Loading…</p>
      ) : grouped.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 py-16 text-center">
          <KeyRound className="mx-auto mb-2 h-8 w-8 text-zinc-300" />
          <p className="font-medium text-zinc-500">No secrets yet</p>
          <p className="text-sm text-zinc-400 mt-1">
            Click <strong>Add secret</strong> to store your first one.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map(([cat, rows]) => (
            <section key={cat}>
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                {cat}
              </h2>
              <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white divide-y divide-zinc-100">
                {rows.map((row) => (
                  <SecretRow
                    key={row.id}
                    row={row}
                    unlockToken={unlockToken}
                    onEdit={() => setEditing(row)}
                    onChanged={onChanged}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {editing && (
        <EditSecretModal
          existing={editing === "new" ? null : editing}
          unlockToken={unlockToken}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function SecretRow({
  row,
  unlockToken,
  onEdit,
  onChanged,
}: {
  row: SecretMetadata;
  unlockToken: string;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);

  const remove = useMutation({
    mutationFn: () => secretsClient.remove(row.key, unlockToken),
    onSuccess: onChanged,
  });

  const handleReveal = async () => {
    if (revealed) {
      setRevealed(null);
      return;
    }
    setRevealing(true);
    try {
      const res = await secretsClient.reveal(row.key, unlockToken);
      setRevealed(res.value);
      // Auto-hide after 20s so it doesn't sit on screen for shoulder-surfers.
      window.setTimeout(() => setRevealed(null), 20_000);
    } finally {
      setRevealing(false);
    }
  };

  const masked = row.lastFourChars
    ? `••••••••••••${row.lastFourChars}`
    : "••••••••";

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <code className="font-mono text-sm font-semibold text-zinc-900">
            {row.key}
          </code>
          {row.label && (
            <span className="text-xs text-zinc-500">· {row.label}</span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs">
          <code className="rounded bg-zinc-50 px-2 py-0.5 font-mono text-zinc-700 border border-zinc-200">
            {revealed ?? masked}
          </code>
          {revealed && (
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(revealed).catch(() => undefined);
              }}
              className="text-[11px] text-zinc-500 underline hover:text-zinc-700"
            >
              Copy
            </button>
          )}
        </div>
        {row.description && (
          <p className="mt-1 text-[11px] text-zinc-500">{row.description}</p>
        )}
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={handleReveal}
          disabled={revealing}
          className="rounded-md border border-zinc-200 bg-white p-1.5 text-zinc-600 hover:bg-zinc-50 disabled:opacity-50"
          title={revealed ? "Hide value" : "Reveal value"}
        >
          {revealing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : revealed ? (
            <EyeOff className="h-3.5 w-3.5" />
          ) : (
            <Eye className="h-3.5 w-3.5" />
          )}
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="rounded-md border border-zinc-200 bg-white p-1.5 text-zinc-600 hover:bg-zinc-50"
          title="Edit"
        >
          <KeyRound className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => {
            if (confirm(`Delete ${row.key}? This cannot be undone.`)) {
              remove.mutate();
            }
          }}
          className="rounded-md border border-zinc-200 bg-white p-1.5 text-red-500 hover:bg-red-50"
          title="Delete"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ── Edit/create modal ──────────────────────────────────────────────────────

const CATEGORIES = [
  "stripe",
  "google",
  "supabase",
  "address",
  "delivery",
  "marketplace",
  "infra",
  "other",
];

function EditSecretModal({
  existing,
  unlockToken,
  onClose,
  onSaved,
}: {
  existing: SecretMetadata | null;
  unlockToken: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!existing;
  const [key, setKey] = useState(existing?.key ?? "");
  const [label, setLabel] = useState(existing?.label ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [category, setCategory] = useState(existing?.category ?? "other");
  const [value, setValue] = useState("");

  const save = useMutation({
    mutationFn: () =>
      secretsClient.upsert(key, unlockToken, {
        value,
        label: label || undefined,
        description: description || undefined,
        category: category || undefined,
      }),
    onSuccess: onSaved,
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-lg bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-900">
            {isEdit ? `Edit ${existing!.key}` : "Add new secret"}
          </h2>
          <button onClick={onClose} className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="space-y-3 p-4 text-sm">
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Key
            </span>
            <input
              value={key}
              onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
              placeholder="STRIPE_SECRET_KEY"
              disabled={isEdit}
              className="w-full rounded-md border border-zinc-200 px-2 py-1.5 font-mono text-sm focus:border-zinc-900 focus:outline-none disabled:bg-zinc-50"
            />
            <p className="mt-1 text-[10px] text-zinc-500">
              UPPER_SNAKE_CASE — same shape as an env var.
            </p>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                Label
              </span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Stripe live secret key"
                className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                Category
              </span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Value
            </span>
            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={isEdit ? "Enter new value to replace" : "Paste the secret"}
              rows={3}
              className="w-full rounded-md border border-zinc-200 px-2 py-1.5 font-mono text-xs focus:border-zinc-900 focus:outline-none"
            />
            {isEdit && (
              <p className="mt-1 text-[10px] text-amber-700">
                Saving replaces the stored value.
              </p>
            )}
          </label>

          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Description (optional)
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Notes for yourself — what it's for, when to rotate, etc."
              rows={2}
              className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
            />
          </label>

          {save.error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
              {(save.error as any)?.response?.data?.message ?? "Failed to save"}
            </p>
          )}
        </div>
        <footer className="flex justify-end gap-2 border-t border-zinc-200 px-4 py-3">
          <button
            onClick={onClose}
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            onClick={() => save.mutate()}
            disabled={!key || !value || save.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {save.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}
