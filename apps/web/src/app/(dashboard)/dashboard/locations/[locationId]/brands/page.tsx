"use client";

// Full-page Brands view for one location.
//
// Replaces the side drawer this used to be. The drawer put a brand list, a
// channel grid, per-channel settings and a create form inside a 576px column,
// so wiring a marketplace meant working in a strip narrower than the forms it
// contained. Same data, same mutations, same components — laid out as
// master/detail so the brand list stays visible while a channel is configured.
//
// Deliberately still scoped to a location: a BrandPlatformConnection is
// unique on (brandId, locationId, platform), so "which store" is part of what
// a channel connection IS, not context that can be dropped.

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Pencil, Plus, Store, Trash2 } from "lucide-react";
import {
  brandConnectionsClient,
  brandsClient,
  locationsClient,
  type Brand,
} from "@/lib/api/locations.client";
import { BrandPlatformGrid } from "@/components/locations/brand-platform-grid";
import { BrandEditModal } from "@/components/brands/brand-edit-modal";
import { BrandDeleteDialog } from "@/components/brands/brand-delete-dialog";

export default function LocationBrandsPage() {
  const params = useParams();
  const router = useRouter();
  const qc = useQueryClient();
  const locationId = String(params?.locationId ?? "");

  const [selectedBrandId, setSelectedBrandId] = useState<string | null>(null);
  const [editingBrand, setEditingBrand] = useState<Brand | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Brand | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCuisine, setNewCuisine] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const locationQuery = useQuery({
    queryKey: ["location", locationId],
    queryFn: () => locationsClient.get(locationId),
    enabled: !!locationId,
  });

  const brandsQuery = useQuery({
    queryKey: ["brands", "location", locationId],
    queryFn: () => brandsClient.list(locationId),
    enabled: !!locationId,
  });

  const brands = brandsQuery.data ?? [];
  const active =
    brands.find((b) => b.id === selectedBrandId) ?? brands[0] ?? null;

  // Live channel count per brand, so the list answers "what's actually wired
  // up here" without opening each one. Same endpoint the grid uses, so it
  // shares react-query's cache rather than doubling the requests.
  const connectionQueries = useQueries({
    queries: brands.map((b) => ({
      queryKey: ["brand-connections", b.id],
      queryFn: () => brandConnectionsClient.listForBrand(b.id),
    })),
  });
  const liveCount = (index: number) =>
    (connectionQueries[index]?.data ?? []).filter(
      (c: any) => c.locationId === locationId && c.status === "connected",
    ).length;

  const create = useMutation({
    mutationFn: () =>
      brandsClient.create({
        name: newName,
        cuisine: newCuisine || undefined,
        primaryLocationId: locationId,
      }),
    onSuccess: (brand: any) => {
      setNewName("");
      setNewCuisine("");
      setAdding(false);
      // Select the brand just created — the next thing the operator wants is
      // its channels, and hunting for it in the list is friction.
      if (brand?.id) setSelectedBrandId(brand.id);
      qc.invalidateQueries({ queryKey: ["brands"] });
    },
    onError: (e: any) =>
      setErr(e?.response?.data?.message ?? e.message ?? "Failed"),
  });

  const remove = useMutation({
    mutationFn: (brandId: string) => brandsClient.remove(brandId),
    onSuccess: (_d, brandId) => {
      setConfirmDelete(null);
      setSelectedBrandId((cur) => (cur === brandId ? null : cur));
      qc.invalidateQueries({ queryKey: ["brands"] });
    },
    onError: (e: any) => {
      // The API refuses while a marketplace is still linked — surface that
      // reason verbatim, it tells the operator exactly what to do next.
      setErr(
        e?.response?.data?.message ?? e.message ?? "Couldn't remove the brand",
      );
      setConfirmDelete(null);
    },
  });

  return (
    <div className="p-6">
      <header className="mb-5">
        <button
          type="button"
          onClick={() => router.push("/dashboard/locations")}
          className="mb-2 inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-900"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Locations
        </button>
        <h1 className="text-xl font-semibold text-zinc-900">Brands</h1>
        <p className="mt-0.5 text-sm text-zinc-500">
          Brands operating from{" "}
          <span className="font-medium text-zinc-700">
            {locationQuery.data?.name ?? "this location"}
          </span>
          , and the channels each one sells through.
        </p>
      </header>

      {err && (
        <p className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {err}
        </p>
      )}

      {brandsQuery.isLoading ? (
        <p className="py-16 text-center text-sm text-zinc-400">Loading…</p>
      ) : brands.length === 0 ? (
        <EmptyState
          adding={adding}
          onStart={() => setAdding(true)}
          form={
            <AddBrandForm
              name={newName}
              cuisine={newCuisine}
              pending={create.isPending}
              onName={setNewName}
              onCuisine={setNewCuisine}
              onCancel={() => setAdding(false)}
              onSubmit={() => create.mutate()}
            />
          }
        />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
          {/* Master — the brand list stays on screen while a channel is
              configured, which is the whole point of leaving the drawer. */}
          <aside className="space-y-2">
            {brands.map((b, i) => {
              const isActive = active?.id === b.id;
              const live = liveCount(i);
              return (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => setSelectedBrandId(b.id)}
                  className={
                    "flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors " +
                    (isActive
                      ? "border-zinc-900 bg-zinc-900 text-white"
                      : "border-zinc-200 bg-white hover:border-zinc-300")
                  }
                >
                  {b.logoUrl ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={b.logoUrl}
                      alt=""
                      className="h-8 w-8 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <span
                      className={
                        "flex h-8 w-8 shrink-0 items-center justify-center rounded " +
                        (isActive ? "bg-white/10" : "bg-zinc-100")
                      }
                    >
                      <Store
                        className={
                          "h-4 w-4 " +
                          (isActive ? "text-white/70" : "text-zinc-400")
                        }
                      />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">
                      {b.name}
                    </span>
                    <span
                      className={
                        "block truncate text-[11px] " +
                        (isActive ? "text-white/60" : "text-zinc-500")
                      }
                    >
                      {live > 0
                        ? `${live} channel${live === 1 ? "" : "s"} live`
                        : "No channels yet"}
                    </span>
                  </span>
                </button>
              );
            })}

            {adding ? (
              <div className="rounded-lg border border-zinc-200 bg-white p-3">
                <AddBrandForm
                  name={newName}
                  cuisine={newCuisine}
                  pending={create.isPending}
                  onName={setNewName}
                  onCuisine={setNewCuisine}
                  onCancel={() => setAdding(false)}
                  onSubmit={() => create.mutate()}
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setErr(null);
                  setAdding(true);
                }}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-zinc-300 px-3 py-2.5 text-xs font-medium text-zinc-500 hover:border-zinc-400 hover:text-zinc-700"
              >
                <Plus className="h-3.5 w-3.5" />
                Add brand
              </button>
            )}
          </aside>

          {/* Detail — the selected brand's channels and their settings. */}
          {active && (
            <section className="min-w-0 rounded-lg border border-zinc-200 bg-white">
              <div className="flex items-center gap-2.5 border-b border-zinc-200 px-4 py-3">
                {active.logoUrl && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={active.logoUrl}
                    alt=""
                    className="h-8 w-8 rounded object-cover"
                  />
                )}
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold text-zinc-900">
                    {active.name}
                  </h2>
                  {active.cuisine && (
                    <p className="truncate text-[11px] text-zinc-500">
                      {active.cuisine}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setEditingBrand(active)}
                  title="Edit brand"
                  className="ml-auto rounded p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setErr(null);
                    setConfirmDelete(active);
                  }}
                  disabled={remove.isPending}
                  title="Remove brand"
                  className="rounded p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="p-4">
                <p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                  Channel connections
                </p>
                {/* Keyed on the brand so switching brands remounts the grid
                    and no half-typed store id carries across. */}
                <BrandPlatformGrid
                  key={active.id}
                  brand={active}
                  locationId={locationId}
                />
              </div>
            </section>
          )}
        </div>
      )}

      {editingBrand && (
        <BrandEditModal
          brand={editingBrand}
          onClose={() => setEditingBrand(null)}
          onSaved={() => {
            setEditingBrand(null);
            qc.invalidateQueries({ queryKey: ["brands"] });
          }}
        />
      )}
      {confirmDelete && (
        <BrandDeleteDialog
          brand={confirmDelete}
          pending={remove.isPending}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => remove.mutate(confirmDelete.id)}
        />
      )}
    </div>
  );
}

function AddBrandForm({
  name,
  cuisine,
  pending,
  onName,
  onCuisine,
  onCancel,
  onSubmit,
}: {
  name: string;
  cuisine: string;
  pending: boolean;
  onName: (v: string) => void;
  onCuisine: (v: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="space-y-2">
      <input
        autoFocus
        value={name}
        onChange={(e) => onName(e.target.value)}
        placeholder="Brand name"
        className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
      />
      <input
        value={cuisine}
        onChange={(e) => onCuisine(e.target.value)}
        placeholder="Cuisine"
        className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onSubmit}
          disabled={pending || !name}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {pending && <Loader2 className="h-3 w-3 animate-spin" />}
          Add
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function EmptyState({
  adding,
  onStart,
  form,
}: {
  adding: boolean;
  onStart: () => void;
  form: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-200 px-6 py-14 text-center">
      <p className="text-sm font-medium text-zinc-700">No brands yet</p>
      <p className="mx-auto mt-1 max-w-sm text-xs text-zinc-500">
        Create a brand to start selling from this location. Channel connections
        appear once a brand exists.
      </p>
      <div className="mx-auto mt-5 max-w-xs text-left">
        {adding ? (
          form
        ) : (
          <button
            type="button"
            onClick={onStart}
            className="mx-auto flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-2 text-xs font-medium text-white hover:bg-zinc-800"
          >
            <Plus className="h-3.5 w-3.5" />
            Add brand
          </button>
        )}
      </div>
    </div>
  );
}
