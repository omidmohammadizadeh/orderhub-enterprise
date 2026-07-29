"use client";

// Floor plan — the room, not a list. Tiles sit on a fixed grid at the
// table's saved (posX, posY) and staff read the whole service at a glance:
// who's free, who's been sitting an hour, what's out of service.
//
// Two modes share one canvas:
//  · live  — tiles are buttons (tap a free table to seat it, an occupied one
//            to open its tab)
//  · edit  — tiles are draggable, snap to the grid, and nothing is persisted
//            until "Save layout" posts the whole plan in one call.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  Circle,
  GripVertical,
  MoreHorizontal,
  RectangleHorizontal,
  Square,
  Trash2,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  LayoutNode,
  RestaurantTable,
  TableShape,
} from "@/lib/api/tables.client";

export const CELL = 44; // px — also the minimum finger-sized touch target
const COLS = 20;
const ROWS = 14;

/** The editable half of a table: everything the layout endpoint writes. */
interface Node {
  posX: number | null;
  posY: number | null;
  shape: TableShape;
  width: number;
  height: number;
  area: string | null;
}

type Draft = Record<string, Node>;

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));

function toNode(t: RestaurantTable): Node {
  return {
    posX: t.posX ?? null,
    posY: t.posY ?? null,
    shape: t.shape ?? "SQUARE",
    width: clamp(t.width ?? 1, 1, 6),
    height: clamp(t.height ?? 1, 1, 6),
    area: t.area ?? null,
  };
}

/** Order-independent fingerprint so we can tell "dirty" from "refetched". */
function signature(map: Draft): string {
  return Object.keys(map)
    .sort()
    .map((id) => {
      const n = map[id]!;
      return `${id}:${n.posX},${n.posY},${n.shape},${n.width},${n.height},${n.area ?? ""}`;
    })
    .join("|");
}

/**
 * A brand-new table is 1×1 in the DB, which is a bare 44px square — big
 * enough to touch but not to read. Give first placements a 2×2 body; a
 * manager who has already sized the tile keeps their size.
 */
function firstPlacementSize(n: Node): { width: number; height: number } {
  return n.width === 1 && n.height === 1
    ? { width: 2, height: 2 }
    : { width: n.width, height: n.height };
}

export function elapsedLabel(from: string | null, now: number): string | null {
  if (!from) return null;
  const mins = Math.floor((now - new Date(from).getTime()) / 60_000);
  if (!Number.isFinite(mins) || mins < 0) return null;
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}`;
}

function initials(name: string | null): string | null {
  if (!name?.trim()) return null;
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

interface FloorPlanProps {
  tables: RestaurantTable[];
  /** Table service switched on for this location — gates seating. */
  serviceEnabled: boolean;
  /** Mirrors the page's "Manage tables" gate: only then is editing offered. */
  canManage: boolean;
  onOpenTable: (t: RestaurantTable) => void;
  onTableActions: (t: RestaurantTable) => void;
  onSaveLayout: (nodes: LayoutNode[], unplacedIds: string[]) => Promise<unknown>;
  savingLayout: boolean;
  /**
   * Which area the plan is showing. null = every area at once. When an
   * area is active, a table placed onto the canvas JOINS that area — that
   * is how an area someone just invented gets its first table, since areas
   * are derived from Table.area and can't exist empty.
   */
  activeArea?: string | null;
}

export function FloorPlan({
  tables,
  serviceEnabled,
  canManage,
  onOpenTable,
  onTableActions,
  onSaveLayout,
  savingLayout,
  activeArea = null,
}: FloorPlanProps) {
  const baseline = useMemo<Draft>(() => {
    const map: Draft = {};
    for (const t of tables) map[t.id] = toNode(t);
    return map;
  }, [tables]);

  // null = live mode. Entering edit mode snapshots the baseline so Cancel is
  // a plain discard and the 15s refetch can't stomp on a drag in progress.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Elapsed times have to tick even when nothing refetches.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Tables can be added or deleted (or another till can edit them) while the
  // plan is open — fold those in rather than dropping the operator's work.
  useEffect(() => {
    setDraft((d) => {
      if (!d) return d;
      const next: Draft = {};
      let changed = false;
      for (const id of Object.keys(baseline)) {
        if (d[id]) next[id] = d[id]!;
        else {
          next[id] = baseline[id]!;
          changed = true;
        }
      }
      if (Object.keys(d).length !== Object.keys(next).length) changed = true;
      return changed ? next : d;
    });
  }, [baseline]);

  const editing = draft !== null;
  const dirty = editing && signature(draft) !== signature(baseline);
  const nodeOf = (t: RestaurantTable): Node => draft?.[t.id] ?? baseline[t.id] ?? toNode(t);

  const patch = (id: string, changes: Partial<Node>) =>
    setDraft((d) => (d ? { ...d, [id]: { ...d[id]!, ...changes } } : d));

  // ── Dragging ────────────────────────────────────────────────────────
  // Pointer events (not HTML5 DnD) so the same code path serves mouse, pen
  // and — the actual deployment target — a finger on a tablet.
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    id: string;
    grabX: number;
    grabY: number;
    moved: boolean;
  } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [trayDragId, setTrayDragId] = useState<string | null>(null);

  // A tray chip that gains a position mid-drag would unmount (it becomes a
  // canvas tile) and take the pointer capture with it. Keep the chip mounted
  // until pointerup and show a ghost on the canvas instead.
  const placed = tables.filter((t) => {
    const n = nodeOf(t);
    return n.posX !== null && n.posY !== null && t.id !== trayDragId;
  });
  const unplaced = tables.filter((t) => {
    const n = nodeOf(t);
    return n.posX === null || n.posY === null || t.id === trayDragId;
  });
  const ghost = trayDragId
    ? tables.find((t) => t.id === trayDragId && nodeOf(t).posX !== null)
    : null;

  const beginDrag = (
    e: React.PointerEvent,
    t: RestaurantTable,
    fromTray: boolean,
  ) => {
    if (!editing || !canvasRef.current) return;
    let n = nodeOf(t);
    if (fromTray) {
      const size = firstPlacementSize(n);
      const joinArea = activeArea && n.area !== activeArea ? { area: activeArea } : {};
      if (size.width !== n.width || size.height !== n.height || joinArea.area) {
        n = { ...n, ...size, ...joinArea };
        patch(t.id, { ...size, ...joinArea });
      }
    }
    const rect = canvasRef.current.getBoundingClientRect();
    // Grab offset keeps the tile under the exact spot you pressed. A tray
    // chip has no position yet, so grab it by its middle.
    const grabX = fromTray
      ? (n.width * CELL) / 2
      : e.clientX - rect.left - (n.posX ?? 0) * CELL;
    const grabY = fromTray
      ? (n.height * CELL) / 2
      : e.clientY - rect.top - (n.posY ?? 0) * CELL;
    dragRef.current = { id: t.id, grabX, grabY, moved: false };
    setDragId(t.id);
    if (fromTray) setTrayDragId(t.id);
    setSelectedId(t.id);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const moveDrag = (e: React.PointerEvent, t: RestaurantTable) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== t.id || !canvasRef.current) return;
    const n = nodeOf(t);
    const rect = canvasRef.current.getBoundingClientRect();
    const x = clamp(
      Math.round((e.clientX - rect.left - drag.grabX) / CELL),
      0,
      COLS - n.width,
    );
    const y = clamp(
      Math.round((e.clientY - rect.top - drag.grabY) / CELL),
      0,
      ROWS - n.height,
    );
    if (x !== n.posX || y !== n.posY) {
      drag.moved = true;
      patch(t.id, { posX: x, posY: y });
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
    setDragId(null);
    setTrayDragId(null);
  };

  /** First cell with room for a w×h tile — used by click-to-place. */
  const firstFreeCell = (w: number, h: number) => {
    const taken = placed.map((t) => {
      const n = nodeOf(t);
      return { x: n.posX!, y: n.posY!, w: n.width, h: n.height };
    });
    for (let y = 0; y <= ROWS - h; y++) {
      for (let x = 0; x <= COLS - w; x++) {
        const hit = taken.some(
          (b) => x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y,
        );
        if (!hit) return { x, y };
      }
    }
    return { x: 0, y: 0 };
  };

  const place = (t: RestaurantTable) => {
    const size = firstPlacementSize(nodeOf(t));
    const spot = firstFreeCell(size.width, size.height);
    patch(t.id, {
      posX: spot.x,
      posY: spot.y,
      ...size,
      // Dropping a table onto an area's plan is how it joins that area.
      ...(activeArea ? { area: activeArea } : {}),
    });
    setSelectedId(t.id);
  };

  const save = async () => {
    if (!draft) return;
    const nodes: LayoutNode[] = [];
    const unplacedIds: string[] = [];
    for (const [id, n] of Object.entries(draft)) {
      if (n.posX === null || n.posY === null) {
        // Only worth a PATCH if it USED to be on the plan.
        if (baseline[id] && baseline[id]!.posX !== null) unplacedIds.push(id);
        continue;
      }
      nodes.push({
        id,
        posX: n.posX,
        posY: n.posY,
        shape: n.shape,
        width: n.width,
        height: n.height,
        area: n.area,
      });
    }
    await onSaveLayout(nodes, unplacedIds);
    setDraft(null);
    setSelectedId(null);
  };

  const selected = selectedId ? tables.find((t) => t.id === selectedId) : null;

  return (
    <div className="space-y-3">
      {/* ── Toolbar ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3 text-[11px] text-zinc-500">
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-sm border border-zinc-300 bg-white" />
            Free
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-sm bg-indigo-600" />
            Occupied
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-sm bg-zinc-300" />
            Out of service
          </span>
        </div>
        {canManage && (
          <div className="flex items-center gap-2">
            {dirty && (
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-amber-600">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                Unsaved changes
              </span>
            )}
            {editing ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setDraft(null);
                    setSelectedId(null);
                  }}
                  disabled={savingLayout}
                >
                  Cancel
                </Button>
                <Button size="sm" onClick={save} loading={savingLayout}>
                  Save layout
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDraft({ ...baseline })}
              >
                <GripVertical className="mr-1 h-3.5 w-3.5" /> Edit layout
              </Button>
            )}
          </div>
        )}
      </div>

      {editing && (
        <div className="rounded-md bg-indigo-50 px-3 py-2 text-[11px] text-indigo-800">
          Drag tiles to arrange the room. Tap a tile to change its shape or
          size. Nothing is saved until you press <b>Save layout</b>.
        </div>
      )}

      {/* ── Canvas ──────────────────────────────────────────────────── */}
      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-zinc-50 p-3">
        <div
          ref={canvasRef}
          className="relative"
          style={{
            width: COLS * CELL,
            height: ROWS * CELL,
            // Grid paper only while arranging — in service it's just noise.
            backgroundImage: editing
              ? "linear-gradient(to right, rgb(228 228 231) 1px, transparent 1px), linear-gradient(to bottom, rgb(228 228 231) 1px, transparent 1px)"
              : undefined,
            backgroundSize: `${CELL}px ${CELL}px`,
          }}
        >
          {placed.map((t) => (
            <Tile
              key={t.id}
              table={t}
              node={nodeOf(t)}
              editing={editing}
              dragging={dragId === t.id}
              selected={selectedId === t.id}
              serviceEnabled={serviceEnabled}
              now={now}
              onOpen={() => onOpenTable(t)}
              onActions={() => onTableActions(t)}
              onSelect={() => setSelectedId(t.id)}
              onPointerDown={(e) => beginDrag(e, t, false)}
              onPointerMove={(e) => moveDrag(e, t)}
              onPointerUp={endDrag}
            />
          ))}

          {ghost && (
            <div
              className={`pointer-events-none absolute grid place-items-center border-2 border-dashed border-indigo-500 bg-indigo-100/70 text-[11px] font-bold text-indigo-700 ${
                nodeOf(ghost).shape === "ROUND" ? "rounded-full" : "rounded-md"
              }`}
              style={{
                left: nodeOf(ghost).posX! * CELL + 3,
                top: nodeOf(ghost).posY! * CELL + 3,
                width: nodeOf(ghost).width * CELL - 6,
                height: nodeOf(ghost).height * CELL - 6,
                zIndex: 40,
              }}
            >
              {ghost.name}
            </div>
          )}

          {placed.length === 0 && !ghost && (
            <div className="absolute inset-0 grid place-items-center px-6 text-center">
              <p className="text-sm text-zinc-400">
                No tables placed yet.
                {canManage
                  ? " Press Edit layout, then drag tables in from the tray below."
                  : " A manager needs to arrange the floor plan."}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── Unplaced tray ───────────────────────────────────────────── */}
      {unplaced.length > 0 && (
        <div className="rounded-xl border border-dashed border-zinc-200 p-3">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
            Not on the plan ({unplaced.length})
          </h3>
          <div className="flex flex-wrap gap-2">
            {unplaced.map((t) => (
              <button
                key={t.id}
                onPointerDown={(e) => beginDrag(e, t, true)}
                onPointerMove={(e) => moveDrag(e, t)}
                onPointerUp={(e) => {
                  const moved = !!dragRef.current?.moved;
                  endDrag(e);
                  // A tap (no movement) is the accessible fallback for drag.
                  if (!moved && editing) place(t);
                }}
                onClick={() => {
                  if (!editing) onTableActions(t);
                }}
                style={editing ? { touchAction: "none" } : undefined}
                className={`flex h-11 min-w-[76px] flex-col items-center justify-center rounded-md border px-3 text-center ${
                  editing
                    ? "cursor-grab border-indigo-200 bg-indigo-50 hover:border-indigo-400"
                    : "border-zinc-200 bg-white hover:border-zinc-300"
                }`}
              >
                <span className="text-xs font-semibold text-zinc-900">
                  {t.name}
                </span>
                <span className="text-[10px] text-zinc-400">
                  {t.seats ? `${t.seats} seats` : "—"}
                </span>
              </button>
            ))}
          </div>
          {canManage && !editing && (
            <p className="mt-2 text-[11px] text-zinc-400">
              Press <b>Edit layout</b> to drag these onto the floor.
            </p>
          )}
        </div>
      )}

      {/* ── Tile inspector (edit mode) ──────────────────────────────── */}
      {editing && selected && (
        <TileInspector
          table={selected}
          node={nodeOf(selected)}
          onChange={(changes) => patch(selected.id, changes)}
          onRemove={() =>
            patch(selected.id, { posX: null, posY: null })
          }
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

// ── Tile ──────────────────────────────────────────────────────────────

interface TileProps {
  table: RestaurantTable;
  node: Node;
  editing: boolean;
  dragging: boolean;
  selected: boolean;
  serviceEnabled: boolean;
  now: number;
  onOpen: () => void;
  onActions: () => void;
  onSelect: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
}

function Tile({
  table: t,
  node,
  editing,
  dragging,
  selected,
  serviceEnabled,
  now,
  onOpen,
  onActions,
  onSelect,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: TileProps) {
  const occupied = t.status === "OCCUPIED";
  const oos = t.outOfService;
  const open = elapsedLabel(t.openedAt, now);
  const server = initials(t.serverName);
  // 1×1 is a bare 44px square — only the name fits. Anything bigger gets
  // the service detail that actually drives decisions.
  const roomForDetail = node.width >= 2 || node.height >= 2;

  const tone = oos
    ? "border-zinc-300 bg-zinc-200 text-zinc-500"
    : occupied
      ? "border-indigo-700 bg-indigo-600 text-white"
      : "border-zinc-300 bg-white text-zinc-900";

  const title = [
    t.name,
    t.seats ? `${t.seats} seats` : null,
    oos
      ? `Out of service${t.outOfServiceNote ? ` — ${t.outOfServiceNote}` : ""}`
      : occupied
        ? `Occupied${open ? ` ${open}` : ""}`
        : "Free",
    occupied && t.covers ? `${t.covers} covers` : null,
    occupied && t.serverName ? `Server: ${t.serverName}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // Long-press opens the action sheet — a corner button big enough for a
  // finger would swallow a 1×1 tile.
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const clearPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  useEffect(() => clearPress, []);

  return (
    <div
      className="absolute p-[3px]"
      style={{
        left: (node.posX ?? 0) * CELL,
        top: (node.posY ?? 0) * CELL,
        width: node.width * CELL,
        height: node.height * CELL,
        zIndex: dragging ? 30 : selected ? 20 : 10,
      }}
    >
      <button
        title={title}
        onPointerDown={(e) => {
          if (editing) {
            onPointerDown(e);
            return;
          }
          longPressed.current = false;
          pressTimer.current = setTimeout(() => {
            longPressed.current = true;
            onActions();
          }, 500);
        }}
        onPointerMove={(e) => {
          if (editing) onPointerMove(e);
          else clearPress();
        }}
        onPointerUp={(e) => {
          if (editing) onPointerUp(e);
          else clearPress();
        }}
        onPointerCancel={clearPress}
        onClick={() => {
          // A drag also ends in a click; selecting the tile you just moved
          // is what you wanted anyway, so no dedupe needed.
          if (editing) {
            onSelect();
            return;
          }
          if (longPressed.current) return;
          // Nothing to open on a table that can't be seated — go straight to
          // the sheet, which is where you'd put it back into service.
          if (oos || (!occupied && !serviceEnabled)) {
            onActions();
            return;
          }
          onOpen();
        }}
        style={{ touchAction: editing ? "none" : undefined }}
        className={`relative flex h-full w-full flex-col items-center justify-center overflow-hidden border px-1 text-center shadow-sm transition-colors ${
          !editing && !occupied && !serviceEnabled ? "opacity-60" : ""
        } ${tone} ${
          node.shape === "ROUND" ? "rounded-full" : "rounded-md"
        } ${dragging ? "cursor-grabbing ring-2 ring-indigo-400" : ""} ${
          selected && editing ? "ring-2 ring-indigo-500" : ""
        } ${editing ? "cursor-grab" : "cursor-pointer"}`}
      >
        <span
          className={`max-w-full truncate text-[11px] font-bold leading-tight ${
            oos ? "line-through" : ""
          }`}
        >
          {t.name}
        </span>

        {roomForDetail && (
          <span
            className={`max-w-full truncate text-[9px] leading-tight ${
              occupied && !oos ? "text-indigo-100" : "text-zinc-500"
            }`}
          >
            {oos ? (
              <span className="inline-flex items-center gap-0.5">
                <Ban className="h-2.5 w-2.5" /> Out of service
              </span>
            ) : occupied ? (
              [t.covers ? `${t.covers}p` : null, server, open]
                .filter(Boolean)
                .join(" · ") || "Occupied"
            ) : (
              (t.seats ? `${t.seats} seats` : "Free")
            )}
          </span>
        )}

        {/* Mouse affordance for the action sheet; touch uses long-press. */}
        {!editing && (
          <span
            role="button"
            tabIndex={-1}
            aria-label={`Actions for ${t.name}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onActions();
            }}
            className={`absolute right-0 top-0 hidden rounded-bl p-0.5 sm:block ${
              occupied && !oos
                ? "text-indigo-200 hover:text-white"
                : "text-zinc-300 hover:text-zinc-700"
            }`}
          >
            <MoreHorizontal className="h-3 w-3" />
          </span>
        )}
      </button>
    </div>
  );
}

// ── Tile inspector ────────────────────────────────────────────────────

const SHAPES: { value: TableShape; label: string; Icon: typeof Square }[] = [
  { value: "SQUARE", label: "Square", Icon: Square },
  { value: "ROUND", label: "Round", Icon: Circle },
  { value: "RECT", label: "Long", Icon: RectangleHorizontal },
];

function TileInspector({
  table,
  node,
  onChange,
  onRemove,
  onClose,
}: {
  table: RestaurantTable;
  node: Node;
  onChange: (changes: Partial<Node>) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-900">
          {table.name}
          <span className="ml-2 text-[11px] font-normal text-zinc-400">
            <Users className="mr-0.5 inline h-3 w-3" />
            {table.seats ?? "—"} seats
          </span>
        </h3>
        <button
          onClick={onClose}
          className="text-[11px] text-zinc-400 underline hover:text-zinc-700"
        >
          Done
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-[11px] font-medium text-zinc-500">
            Shape
          </label>
          <div className="flex gap-1">
            {SHAPES.map(({ value, label, Icon }) => (
              <button
                key={value}
                onClick={() => onChange({ shape: value })}
                className={`flex h-11 flex-1 flex-col items-center justify-center rounded-md border text-[10px] ${
                  node.shape === value
                    ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                    : "border-zinc-200 text-zinc-500 hover:border-zinc-300"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-1 block text-[11px] font-medium text-zinc-500">
            Size (grid cells)
          </label>
          <div className="flex gap-2">
            <Stepper
              label="W"
              value={node.width}
              onChange={(v) => onChange({ width: v })}
            />
            <Stepper
              label="H"
              value={node.height}
              onChange={(v) => onChange({ height: v })}
            />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-[11px] font-medium text-zinc-500">
            Area
          </label>
          <input
            value={node.area ?? ""}
            onChange={(e) => onChange({ area: e.target.value || null })}
            placeholder="e.g. Terrace"
            className="h-11 w-full rounded-md border border-zinc-200 px-3 text-sm"
          />
        </div>
      </div>

      <button
        onClick={onRemove}
        className="mt-3 inline-flex items-center gap-1 text-[11px] text-zinc-400 underline hover:text-red-600"
      >
        <Trash2 className="h-3 w-3" /> Take off the plan
      </button>
    </div>
  );
}

function Stepper({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-1 items-center rounded-md border border-zinc-200">
      <button
        onClick={() => onChange(clamp(value - 1, 1, 6))}
        disabled={value <= 1}
        className="h-11 w-9 text-zinc-500 disabled:opacity-30"
      >
        −
      </button>
      <span className="flex-1 text-center text-xs font-medium text-zinc-900">
        {label} {value}
      </span>
      <button
        onClick={() => onChange(clamp(value + 1, 1, 6))}
        disabled={value >= 6}
        className="h-11 w-9 text-zinc-500 disabled:opacity-30"
      >
        +
      </button>
    </div>
  );
}
