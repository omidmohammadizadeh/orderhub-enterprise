"use client";

// The step between "create" and "send" for an uploaded PDF: place the boxes.
//
// Deliberately a blocking step rather than something to remember later. A
// contract sent with no signature box is a document the client cannot sign,
// and they find that out instead of you.

import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import {
  contractsClient,
  type Contract,
  type PlacedFieldDto,
} from "@/lib/api/contracts.client";
import { FieldEditor, type PlacedField } from "./field-editor";

export function FieldEditorModal({
  contract,
  onClose,
  onSaved,
}: {
  contract: Contract;
  onClose: () => void;
  /** Fired after a successful save, with the contract for the next step. */
  onSaved: (contract: Contract) => void;
}) {
  const [fields, setFields] = useState<PlacedField[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    contractsClient
      .listFields(contract.id)
      .then((rows) =>
        setFields(
          rows.map((r) => ({
            ...r,
            label: r.label ?? null,
            value: r.value ?? null,
          })) as PlacedField[],
        ),
      )
      .catch(() => setFields([]))
      .finally(() => setLoading(false));
  }, [contract.id]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await contractsClient.setFields(
        contract.id,
        fields as unknown as PlacedFieldDto[],
      );
      onSaved(contract);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Couldn't save the layout");
    } finally {
      setSaving(false);
    }
  };

  const hasSignature = fields.some((f) => f.type === "SIGNATURE");

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-zinc-100">
      <header className="flex flex-shrink-0 items-center gap-3 border-b border-zinc-200 bg-white px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-zinc-900">
            Place fields — {contract.title}
          </h2>
          <p className="text-xs text-zinc-500">
            Drop boxes where the client should type or sign.
          </p>
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <button
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-3 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save &amp; continue
        </button>
        <button
          onClick={onClose}
          className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {!hasSignature && !loading && (
        <p className="flex-shrink-0 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          No signature box yet — without one the client has nowhere to sign on
          the document itself.
        </p>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <p className="py-10 text-center text-sm text-zinc-400">Loading…</p>
        ) : contract.fileUrl ? (
          <FieldEditor
            fileUrl={contract.fileUrl}
            fields={fields}
            onChange={setFields}
          />
        ) : (
          <p className="py-10 text-center text-sm text-zinc-500">
            This contract has no uploaded PDF, so there is nothing to place
            fields on.
          </p>
        )}
      </div>
    </div>
  );
}
