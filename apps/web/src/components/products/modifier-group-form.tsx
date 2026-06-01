"use client";

import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Save, Trash2, Plus, X } from "lucide-react";
import {
  modifierGroupsClient,
  modifiersClient,
  type CatalogModifierGroup,
} from "@/lib/api/catalog.client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { AttachModal } from "./attach-modal";

interface Props {
  brandId: string;
  /** Phase AP — stamp new groups with this location. */
  locationId?: string;
  groupId?: string;
  onCancel: () => void;
  // saved arg is optional so existing call sites that ignore it stay
  // type-safe. The product form uses it to grab the new group's id
  // and auto-attach it to the product without leaving the page.
  onSaved: (saved?: CatalogModifierGroup) => void;
}

const genPlu = () =>
  "MG-" + Math.random().toString(36).slice(2, 8).toUpperCase();

export function ModifierGroupForm({
  brandId,
  locationId,
  groupId,
  onCancel,
  onSaved,
}: Props) {
  const qc = useQueryClient();
  const isEdit = !!groupId;

  const { data: existing } = useQuery({
    queryKey: ["catalog", "modifier-group", groupId],
    queryFn: () =>
      modifierGroupsClient.list(brandId).then((all) => all.find((g) => g.id === groupId)),
    enabled: !!groupId,
  });

  // All groups in the brand (with options) — used by the "Attach existing"
  // picker to surface modifiers already created in OTHER groups.
  const { data: otherGroups = [] } = useQuery({
    queryKey: ["catalog", "modifier-groups", brandId],
    queryFn: () => modifierGroupsClient.list(brandId),
    enabled: !!brandId,
  });

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [plu, setPlu] = useState(genPlu());
  const [selectionType, setSelectionType] = useState<"VARIANT" | "ADDON">(
    "VARIANT",
  );
  const [minSelections, setMinSelections] = useState("0");
  const [maxSelections, setMaxSelections] = useState("1");
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [visibleToCustomers, setVisibleToCustomers] = useState(true);

  // Inline modifier creation buffer — modifiers are created against the
  // group after the group itself is saved (chicken-and-egg).
  const [pendingModifiers, setPendingModifiers] = useState<
    Array<{ name: string; priceAdjustment: number; plu: string }>
  >([]);
  const [newModName, setNewModName] = useState("");
  const [newModPrice, setNewModPrice] = useState("");

  // Attached existing modifier IDs (Phase AL many-to-many). Initialised
  // from the existing group's options on hydrate, diffed against the
  // server set on save.
  const [attachedModifierIds, setAttachedModifierIds] = useState<string[]>([]);
  const [showAddModifierModal, setShowAddModifierModal] = useState(false);
  const [showInlineCreate, setShowInlineCreate] = useState(false);

  useEffect(() => {
    if (!existing) return;
    setName(existing.name);
    setDescription(existing.description ?? "");
    setPlu(existing.plu ?? genPlu());
    setSelectionType(existing.selectionType);
    setMinSelections(String(existing.minSelections));
    setMaxSelections(String(existing.maxSelections ?? 1));
    setAllowDuplicate(existing.allowDuplicateSelections);
    setVisibleToCustomers(existing.visibleToCustomers);
    setAttachedModifierIds((existing.options ?? []).map((o) => o.id));
  }, [existing]);

  const saveMutation = useMutation({
    mutationFn: async (): Promise<CatalogModifierGroup> => {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        plu: plu.trim() || null,
        selectionType,
        minSelections: Number(minSelections) || 0,
        maxSelections: maxSelections ? Number(maxSelections) : null,
        allowDuplicateSelections: allowDuplicate,
        isRequired: Number(minSelections) > 0,
        visibleToCustomers,
      };
      const saved = isEdit && groupId
        ? await modifierGroupsClient.update(groupId, payload)
        : await modifierGroupsClient.create(brandId, {
            ...payload,
            ...(locationId && { locationId }),
          });

      // Create any pending NEW modifiers under the saved group.
      for (const m of pendingModifiers) {
        await modifiersClient.create(saved.id, {
          name: m.name,
          plu: m.plu,
          priceAdjustment: m.priceAdjustment,
        });
      }

      // Diff attached existing-modifier IDs and call the many-to-many
      // attach/detach endpoints. Mirrors the product → modifier-group
      // pattern. We skip the modifiers whose primary FK already lives
      // in this group (those are "owned" by the group; detach would
      // 400 anyway).
      const currentIds = (existing?.options ?? []).map((o) => o.id);
      const ownedIds = (existing?.options ?? [])
        .filter((o) => o.groupId === saved.id)
        .map((o) => o.id);
      const toAttach = attachedModifierIds.filter((id) => !currentIds.includes(id));
      const toDetach = currentIds
        .filter((id) => !attachedModifierIds.includes(id))
        .filter((id) => !ownedIds.includes(id));
      for (const id of toAttach) {
        await modifiersClient.attachToGroup(saved.id, id);
      }
      for (const id of toDetach) {
        await modifiersClient.detachFromGroup(saved.id, id);
      }
      return saved;
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["catalog", "modifier-groups", brandId] });
      qc.invalidateQueries({
        queryKey: ["catalog", "modifier-groups-with-options", brandId],
      });
      onSaved(saved);
    },
  });

  const addPending = () => {
    if (!newModName.trim()) return;
    setPendingModifiers([
      ...pendingModifiers,
      {
        name: newModName.trim(),
        priceAdjustment: Number(newModPrice) || 0,
        plu: "MOD-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
      },
    ]);
    setNewModName("");
    setNewModPrice("");
  };

  const removePending = (i: number) =>
    setPendingModifiers(pendingModifiers.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={onCancel}
          className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-900"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to modifier groups
        </button>
        <Button
          size="sm"
          onClick={() => saveMutation.mutate()}
          disabled={!name.trim() || saveMutation.isPending}
          className="bg-orange-500 hover:bg-orange-600 text-white"
        >
          <Save className="h-3.5 w-3.5 mr-1.5" />
          {saveMutation.isPending ? "Saving…" : isEdit ? "Save changes" : "Create group"}
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Card className="p-5 lg:col-span-2 space-y-4">
          <h3 className="text-sm font-semibold text-zinc-900">Basic details</h3>
          <label className="block">
            <span className="text-xs font-medium text-zinc-700">
              Name <span className="text-red-500">*</span>
            </span>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Toppings, Crusts, Size"
              className="mt-1 h-9 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-zinc-700">PLU</span>
            <Input
              value={plu}
              onChange={(e) => setPlu(e.target.value)}
              placeholder="MG-XXXXXX"
              className="mt-1 h-9 text-sm font-mono"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-zinc-700">Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
            />
          </label>

          <div className="pt-3 border-t border-zinc-100 space-y-3">
            <div>
              <span className="text-xs font-medium text-zinc-700">
                Select modifier group type
              </span>
              <div className="mt-2 space-y-2">
                {/* Card-style radio matching the Deliverect reference the
                    operator provided: stacked cards with title + hint and
                    a leading radio dot. */}
                {(
                  [
                    {
                      value: "VARIANT" as const,
                      title: "Variant",
                      hint: "Only one modifier can be selected with the item (Eg: Size of pizza)",
                    },
                    {
                      value: "ADDON" as const,
                      title: "Add-On",
                      hint: "More than one modifiers can be selected with the item (Eg: Pizza Toppings)",
                    },
                  ]
                ).map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setSelectionType(opt.value)}
                    className={`w-full text-left flex items-start gap-3 rounded-md border px-4 py-3 transition-colors ${
                      selectionType === opt.value
                        ? "border-orange-400 bg-orange-50/40"
                        : "border-zinc-200 hover:border-zinc-300"
                    }`}
                  >
                    <span
                      className={`mt-0.5 h-4 w-4 rounded-full border-2 flex-shrink-0 grid place-items-center ${
                        selectionType === opt.value
                          ? "border-orange-500"
                          : "border-zinc-300"
                      }`}
                    >
                      {selectionType === opt.value && (
                        <span className="h-2 w-2 rounded-full bg-orange-500" />
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-zinc-900">
                        {opt.title}
                      </span>
                      <span className="block text-xs text-zinc-500 mt-0.5">
                        {opt.hint}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs font-medium text-zinc-700">
                  Min selections
                </span>
                <Input
                  type="number"
                  min="0"
                  value={minSelections}
                  onChange={(e) => setMinSelections(e.target.value)}
                  className="mt-1 h-9 text-sm tabular-nums"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-zinc-700">
                  Max selections
                </span>
                <Input
                  type="number"
                  min="1"
                  value={maxSelections}
                  onChange={(e) => setMaxSelections(e.target.value)}
                  className="mt-1 h-9 text-sm tabular-nums"
                />
              </label>
            </div>
            {selectionType === "ADDON" && (
              <label className="flex items-center gap-2 text-xs text-zinc-700">
                <input
                  type="checkbox"
                  checked={allowDuplicate}
                  onChange={(e) => setAllowDuplicate(e.target.checked)}
                />
                Allow duplicate selections (e.g. extra cheese × 2)
              </label>
            )}
            <label className="flex items-center gap-2 text-xs text-zinc-700">
              <input
                type="checkbox"
                checked={visibleToCustomers}
                onChange={(e) => setVisibleToCustomers(e.target.checked)}
              />
              Visible to customers
            </label>
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-zinc-900">Modifiers</h3>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setShowAddModifierModal(true)}
                className="h-8 text-xs"
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add Existing
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => setShowInlineCreate((v) => !v)}
                className="h-8 text-xs bg-zinc-900 hover:bg-zinc-800 text-white"
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                Create New
              </Button>
            </div>
          </div>

          {/* Build the brand-wide modifier list once and re-use it for
              both the attached display and the AttachModal. */}
          {(() => {
            const allOptions = otherGroups.flatMap((g) =>
              (g.options ?? []).map((o) => ({
                ...o,
                groupName: g.name,
                primaryGroupId: o.groupId,
              })),
            );
            // De-dupe (a modifier attached to several groups appears once).
            const byId = new Map<string, (typeof allOptions)[number]>();
            for (const o of allOptions) if (!byId.has(o.id)) byId.set(o.id, o);
            const unique = Array.from(byId.values());

            const attached = attachedModifierIds
              .map((id) => byId.get(id))
              .filter(Boolean) as typeof unique;

            return (
              <>
                <div className="rounded-lg border border-zinc-200 bg-zinc-50/50 p-1.5 space-y-1.5">
                  {attached.length === 0 && pendingModifiers.length === 0 ? (
                    <p className="px-3 py-6 text-center text-sm text-zinc-400 italic">
                      No modifiers attached. Click &quot;Add Existing&quot; to
                      pick from the catalog or &quot;Create New&quot; to make
                      one.
                    </p>
                  ) : (
                    <>
                      {attached.map((m) => {
                        const owned = m.primaryGroupId === groupId;
                        return (
                          <div
                            key={m.id}
                            className="flex items-center justify-between rounded bg-white border border-zinc-100 px-3 py-2"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-zinc-900 truncate">
                                {m.name}{" "}
                                <span className="text-[10px] font-normal text-zinc-500 ml-1">
                                  {owned
                                    ? "(owned)"
                                    : `(shared from ${m.groupName})`}
                                </span>
                              </p>
                            </div>
                            <div className="flex items-center gap-3 flex-shrink-0">
                              <span className="text-xs text-zinc-500 tabular-nums">
                                £{Number(m.priceAdjustment).toFixed(2)}
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  setAttachedModifierIds(
                                    attachedModifierIds.filter(
                                      (id) => id !== m.id,
                                    ),
                                  )
                                }
                                disabled={owned}
                                title={
                                  owned
                                    ? "Owned by this group — delete the modifier instead."
                                    : "Remove"
                                }
                                className="text-zinc-300 hover:text-red-600 disabled:opacity-30 disabled:cursor-not-allowed"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                      {pendingModifiers.map((m, i) => (
                        <div
                          key={i}
                          className="flex items-center justify-between rounded border border-dashed border-orange-300 bg-orange-50 px-3 py-2 text-sm"
                        >
                          <span className="font-medium text-zinc-900 truncate">
                            {m.name}{" "}
                            <span className="text-[10px] text-orange-600 ml-1">
                              new
                            </span>
                          </span>
                          <span className="flex items-center gap-3">
                            <span className="text-xs text-zinc-500 tabular-nums">
                              £{m.priceAdjustment.toFixed(2)}
                            </span>
                            <button
                              type="button"
                              onClick={() => removePending(i)}
                              className="text-zinc-300 hover:text-red-600"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </span>
                        </div>
                      ))}
                    </>
                  )}
                </div>

                <AttachModal
                  open={showAddModifierModal}
                  title="Add Modifiers"
                  rows={unique.map((m) => ({
                    id: m.id,
                    name: m.name,
                    subtitle: m.plu ?? "",
                    meta: `£${Number(m.priceAdjustment).toFixed(2)} · from ${m.groupName}`,
                  }))}
                  initiallyAttachedIds={attachedModifierIds}
                  onConfirm={(ids) => {
                    setAttachedModifierIds(ids);
                    setShowAddModifierModal(false);
                  }}
                  onCancel={() => setShowAddModifierModal(false)}
                />
              </>
            );
          })()}

          {showInlineCreate && (
            <div className="mt-3 pt-3 border-t border-zinc-100 space-y-2">
              <p className="text-[10px] uppercase tracking-wider text-zinc-400">
                New modifier
              </p>
              <div className="flex gap-1.5">
                <Input
                  autoFocus
                  placeholder="Modifier name"
                  value={newModName}
                  onChange={(e) => setNewModName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addPending();
                    }
                  }}
                  className="flex-1 h-8 text-xs"
                />
                <Input
                  type="number"
                  step="0.01"
                  placeholder="£0.00"
                  value={newModPrice}
                  onChange={(e) => setNewModPrice(e.target.value)}
                  className="w-20 h-8 text-xs tabular-nums"
                />
                <Button
                  type="button"
                size="sm"
                variant="outline"
                onClick={addPending}
                className="h-8 px-2"
              >
                <Plus className="h-3 w-3" />
              </Button>
            </div>
          </div>
          )}
        </Card>
      </div>

      {isEdit && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={async () => {
              if (!groupId) return;
              if (!confirm("Delete this modifier group?")) return;
              await modifierGroupsClient.remove(groupId);
              qc.invalidateQueries({
                queryKey: ["catalog", "modifier-groups", brandId],
              });
              onCancel();
            }}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600 hover:text-red-700"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete group
          </button>
        </div>
      )}
    </div>
  );
}
