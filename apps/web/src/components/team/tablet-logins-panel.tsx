"use client";

// Team → Tablet logins.
//
// One shared sign-in per shop for the counter tablet, the way Uber Eats Order
// Manager does it: a generated username and a password an owner sets and can
// reset. Signed in with it, the tablet reaches the shop-floor tabs for that
// shop only. Nothing here changes how people sign in as themselves.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Eye, EyeOff, Loader2, Tablet, X } from "lucide-react";
import {
  tabletLoginsClient,
  type TabletLoginRow,
} from "@/lib/api/team.client";

const QUERY_KEY = ["team", "tablet-logins"];

function errorMessage(err: any, fallback: string): string {
  const msg = err?.response?.data?.message ?? err?.message;
  return Array.isArray(msg) ? msg.join(", ") : msg || fallback;
}

/** Same rule the server applies: 8+ characters, a number and a non-digit. */
function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return "At least 8 characters";
  if (!/[0-9]/.test(pw) || !/[^0-9]/.test(pw)) {
    return "Include a number and a non-digit character";
  }
  return null;
}

export function TabletLoginsPanel({ search }: { search: string }) {
  const qc = useQueryClient();
  const [passwordFor, setPasswordFor] = useState<TabletLoginRow | null>(null);
  const [removeFor, setRemoveFor] = useState<TabletLoginRow | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: tabletLoginsClient.list,
  });

  const update = useMutation({
    mutationFn: (v: { locationId: string; analytics?: boolean; isActive?: boolean }) =>
      tabletLoginsClient.update(v.locationId, {
        analytics: v.analytics,
        isActive: v.isActive,
      }),
    onSuccess: () => {
      setRowError(null);
      qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (err) => setRowError(errorMessage(err, "Couldn't save that change.")),
  });

  const q = search.trim().toLowerCase();
  const rows = (query.data ?? []).filter(
    (r) =>
      !q ||
      r.locationName.toLowerCase().includes(q) ||
      (r.brandName ?? "").toLowerCase().includes(q) ||
      (r.login?.username ?? "").includes(q),
  );

  return (
    <div className="space-y-3">
      <p className="max-w-3xl text-sm text-zinc-600">
        Each shop can have its own login for the counter tablet. Staff sign in
        with the shop's username and password and see only that shop's Orders,
        POS, Inventory, Store status, Printers, Loyalty scan and Caller ID —
        plus Analytics if you allow it. Staff can still sign in with their own
        accounts as before.
      </p>

      {rowError && (
        <p className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">{rowError}</p>
      )}

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
        <table className="min-w-full divide-y divide-zinc-200 text-sm">
          <thead className="bg-zinc-50">
            <tr>
              <Th>Shop</Th>
              <Th>Username</Th>
              <Th>Status</Th>
              <Th>Analytics</Th>
              <Th>Last sign-in</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {query.isLoading && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-zinc-400">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                </td>
              </tr>
            )}
            {query.isError && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-red-600">
                  {errorMessage(query.error, "Couldn't load tablet logins.")}
                </td>
              </tr>
            )}
            {!query.isLoading && !query.isError && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-zinc-500">
                  {q ? "No shops match your search." : "No shops to set up yet."}
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.locationId} className="align-middle">
                <td className="px-4 py-3">
                  <div className="font-medium text-zinc-900">{row.locationName}</div>
                  {row.brandName && (
                    <div className="text-xs text-zinc-500">{row.brandName}</div>
                  )}
                </td>
                <td className="px-4 py-3">
                  {row.login ? (
                    <CopyableUsername username={row.login.username} />
                  ) : (
                    <span className="text-zinc-400">—</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {!row.login ? (
                    <span className="text-xs text-zinc-400">Not set up</span>
                  ) : row.login.isActive ? (
                    <span className="rounded bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                      On
                    </span>
                  ) : (
                    <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-600">
                      Off
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {row.login && (
                    <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-zinc-600">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-violet-600"
                        checked={row.login.analytics}
                        disabled={update.isPending}
                        onChange={(e) =>
                          update.mutate({
                            locationId: row.locationId,
                            analytics: e.target.checked,
                          })
                        }
                      />
                      Show takings
                    </label>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-zinc-500">
                  {row.login?.lastLoginAt
                    ? new Date(row.login.lastLoginAt).toLocaleString()
                    : row.login
                      ? "Never"
                      : ""}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right">
                  {!row.login ? (
                    <button
                      onClick={() => setPasswordFor(row)}
                      className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700"
                    >
                      <Tablet className="h-3.5 w-3.5" />
                      Create login
                    </button>
                  ) : (
                    <div className="inline-flex items-center gap-3 text-xs font-semibold">
                      <button
                        onClick={() => setPasswordFor(row)}
                        className="text-violet-700 underline-offset-2 hover:underline"
                      >
                        Reset password
                      </button>
                      <button
                        disabled={update.isPending}
                        onClick={() =>
                          update.mutate({
                            locationId: row.locationId,
                            isActive: !row.login!.isActive,
                          })
                        }
                        className="text-zinc-600 underline-offset-2 hover:underline disabled:opacity-50"
                      >
                        {row.login.isActive ? "Turn off" : "Turn on"}
                      </button>
                      <button
                        onClick={() => setRemoveFor(row)}
                        className="text-red-600 underline-offset-2 hover:underline"
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {passwordFor && (
        <PasswordModal
          row={passwordFor}
          onClose={() => setPasswordFor(null)}
          onSaved={() => {
            setPasswordFor(null);
            qc.invalidateQueries({ queryKey: QUERY_KEY });
          }}
        />
      )}
      {removeFor && (
        <RemoveModal
          row={removeFor}
          onClose={() => setRemoveFor(null)}
          onRemoved={() => {
            setRemoveFor(null);
            qc.invalidateQueries({ queryKey: QUERY_KEY });
          }}
        />
      )}
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500">
      {children}
    </th>
  );
}

function CopyableUsername({ username }: { username: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(username);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked — the username is still on screen */
        }
      }}
      className="inline-flex items-center gap-1.5 rounded bg-zinc-100 px-2 py-1 font-mono text-xs text-zinc-800 hover:bg-zinc-200"
      title="Copy username"
    >
      {username}
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-600" />
      ) : (
        <Copy className="h-3.5 w-3.5 text-zinc-400" />
      )}
    </button>
  );
}

function PasswordModal({
  row,
  onClose,
  onSaved,
}: {
  row: TabletLoginRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isReset = !!row.login;
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      isReset
        ? tabletLoginsClient.resetPassword(row.locationId, password)
        : tabletLoginsClient.create(row.locationId, password),
    onSuccess: onSaved,
    onError: (err) => setError(errorMessage(err, "Couldn't save the password.")),
  });

  const problem = passwordProblem(password);
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSave = !problem && confirm === password && !save.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4">
          <h2 className="text-base font-semibold text-zinc-900">
            {isReset ? "Reset password" : "Create tablet login"}
          </h2>
          <button onClick={onClose} aria-label="Close" className="text-zinc-400 hover:text-zinc-700">
            <X className="h-5 w-5" />
          </button>
        </div>
        <form
          className="space-y-4 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) save.mutate();
          }}
        >
          <p className="text-sm text-zinc-600">
            {isReset ? (
              <>
                New password for <strong>{row.login!.username}</strong>. Tablets
                signed in with the old password will be signed out.
              </>
            ) : (
              <>
                We'll generate a username for <strong>{row.locationName}</strong>.
                The password must be at least 8 characters and include a number
                and a non-digit character.
              </>
            )}
          </p>
          <PasswordField
            label="New password"
            value={password}
            onChange={setPassword}
            show={show}
            onToggle={() => setShow((s) => !s)}
            autoFocus
          />
          {password && problem && <p className="text-xs text-amber-700">{problem}</p>}
          <PasswordField
            label="Confirm new password"
            value={confirm}
            onChange={setConfirm}
            show={show}
            onToggle={() => setShow((s) => !s)}
          />
          {mismatch && <p className="text-xs text-amber-700">Passwords don't match</p>}
          {error && (
            <p className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
          )}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50"
            >
              Back
            </button>
            <button
              type="submit"
              disabled={!canSave}
              className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {isReset ? "Reset" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  show,
  onToggle,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  onToggle: () => void;
  autoFocus?: boolean;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-zinc-800">{label}</span>
      <div className="relative">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="new-password"
          autoFocus={autoFocus}
          className="w-full rounded-md border border-zinc-300 py-2 pl-3 pr-10 text-sm outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
        />
        <button
          type="button"
          onClick={onToggle}
          aria-label={show ? "Hide password" : "Show password"}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-800"
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </label>
  );
}

function RemoveModal({
  row,
  onClose,
  onRemoved,
}: {
  row: TabletLoginRow;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: () => tabletLoginsClient.remove(row.locationId),
    onSuccess: onRemoved,
    onError: (err) => setError(errorMessage(err, "Couldn't remove the login.")),
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4">
      <div className="w-full max-w-md space-y-4 rounded-lg bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-zinc-900">Remove tablet login</h2>
        <p className="text-sm text-zinc-600">
          <strong>{row.login?.username}</strong> will stop working and any tablet
          signed in with it will be signed out. You can create a new one later.
        </p>
        {error && (
          <p className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
        )}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
          >
            {remove.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Yes, remove
          </button>
        </div>
      </div>
    </div>
  );
}
