"use client";

// Drag-and-drop field placement over an uploaded contract PDF.
//
// Geometry is kept as FRACTIONS of the page throughout — never pixels. The
// operator places a box on a 900px-wide desktop render and the client taps it
// on a 375px phone; storing pixels would put the signature line somewhere else
// entirely on the second screen. Everything converts to pixels only at the
// moment of drawing, and back to fractions the moment a drag ends.

import { useRef, useState } from "react";
import { CalendarDays, Check, PenLine, Trash2, Type } from "lucide-react";
import { PdfPages, type PageBox } from "./pdf-pages";

export type FieldType = "TEXT" | "DATE" | "SIGNATURE" | "CHECKBOX";
export type FieldAssignee = "SENDER" | "RECIPIENT";

export interface PlacedField {
  id: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  type: FieldType;
  assignee: FieldAssignee;
  label?: string | null;
  required: boolean;
  fontSize: number;
  value?: string | null;
}

const TOOLS: Array<{
  type: FieldType;
  label: string;
  Icon: any;
  w: number;
  h: number;
}> = [
  { type: "TEXT", label: "Text", Icon: Type, w: 0.26, h: 0.028 },
  { type: "DATE", label: "Date", Icon: CalendarDays, w: 0.16, h: 0.028 },
  { type: "SIGNATURE", label: "Signature", Icon: PenLine, w: 0.3, h: 0.05 },
  { type: "CHECKBOX", label: "Tick box", Icon: Check, w: 0.03, h: 0.02 },
];

/** Local ids until the server assigns real ones. */
let seq = 0;
const nextId = () => `new_${++seq}`;

export function FieldEditor({
  fileUrl,
  fields,
  onChange,
}: {
  fileUrl: string;
  fields: PlacedField[];
  onChange: (fields: PlacedField[]) => void;
}) {
  const [tool, setTool] = useState<FieldType | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const drag = useRef<{
    id: string;
    mode: "move" | "resize";
    startX: number;
    startY: number;
    orig: PlacedField;
    box: PageBox;
  } | null>(null);

  const update = (id: string, patch: Partial<PlacedField>) =>
    onChange(fields.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  const remove = (id: string) => {
    onChange(fields.filter((f) => f.id !== id));
    setSelected((s) => (s === id ? null : s));
  };

  /** Click on empty page space with a tool armed → drop a new box there. */
  const placeAt = (e: React.MouseEvent, box: PageBox) => {
    if (!tool) return;
    const spec = TOOLS.find((t) => t.type === tool)!;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const field: PlacedField = {
      id: nextId(),
      page: box.page,
      // Centre the box on the click rather than starting at it — the cursor
      // is where you want the field, not its top-left corner.
      x: Math.max(0, Math.min(1 - spec.w, x - spec.w / 2)),
      y: Math.max(0, Math.min(1 - spec.h, y - spec.h / 2)),
      w: spec.w,
      h: spec.h,
      type: tool,
      assignee: "RECIPIENT",
      label: spec.label,
      required: true,
      fontSize: 11,
    };
    onChange([...fields, field]);
    setSelected(field.id);
    setTool(null);
  };

  const onPointerDown = (
    e: React.PointerEvent,
    f: PlacedField,
    mode: "move" | "resize",
    box: PageBox,
  ) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = {
      id: f.id,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      orig: { ...f },
      box,
    };
    setSelected(f.id);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / d.box.width;
    const dy = (e.clientY - d.startY) / d.box.height;
    if (d.mode === "move") {
      update(d.id, {
        x: clamp(d.orig.x + dx, 0, 1 - d.orig.w),
        y: clamp(d.orig.y + dy, 0, 1 - d.orig.h),
      });
    } else {
      update(d.id, {
        w: clamp(d.orig.w + dx, 0.02, 1 - d.orig.x),
        h: clamp(d.orig.h + dy, 0.012, 1 - d.orig.y),
      });
    }
  };

  const endDrag = () => {
    drag.current = null;
  };

  const chosen = fields.find((f) => f.id === selected) ?? null;

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 bg-white/95 p-2 backdrop-blur">
        <span className="text-xs font-semibold text-zinc-500">Add:</span>
        {TOOLS.map((t) => (
          <button
            key={t.type}
            type="button"
            onClick={() => setTool((cur) => (cur === t.type ? null : t.type))}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-semibold transition ${
              tool === t.type
                ? "border-orange-500 bg-orange-500 text-white"
                : "border-zinc-200 text-zinc-700 hover:border-zinc-300"
            }`}
          >
            <t.Icon className="h-3.5 w-3.5" />
            {t.label}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-zinc-500">
          {tool
            ? "Now click where it goes"
            : `${fields.length} field${fields.length === 1 ? "" : "s"} placed`}
        </span>
      </div>

      {/* Properties for the selected box */}
      {chosen && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-2">
          <input
            value={chosen.label ?? ""}
            onChange={(e) => update(chosen.id, { label: e.target.value })}
            placeholder="Label"
            className="w-40 rounded-md border border-zinc-200 px-2 py-1.5 text-xs"
          />
          <select
            value={chosen.assignee}
            onChange={(e) =>
              update(chosen.id, { assignee: e.target.value as FieldAssignee })
            }
            className="rounded-md border border-zinc-200 px-2 py-1.5 text-xs"
          >
            <option value="RECIPIENT">Client fills this</option>
            <option value="SENDER">I fill this</option>
          </select>
          {chosen.assignee === "SENDER" && chosen.type !== "SIGNATURE" && (
            <input
              value={chosen.value ?? ""}
              onChange={(e) => update(chosen.id, { value: e.target.value })}
              placeholder="Value"
              className="w-40 rounded-md border border-zinc-200 px-2 py-1.5 text-xs"
            />
          )}
          <label className="flex items-center gap-1 text-xs text-zinc-600">
            <input
              type="checkbox"
              checked={chosen.required}
              onChange={(e) => update(chosen.id, { required: e.target.checked })}
            />
            Required
          </label>
          <button
            type="button"
            onClick={() => remove(chosen.id)}
            className="ml-auto rounded p-1 text-zinc-400 hover:bg-white hover:text-red-600"
            title="Delete field"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      )}

      <PdfPages
        fileUrl={fileUrl}
        renderOverlay={(box) => (
          <div
            className={tool ? "absolute inset-0 cursor-crosshair" : "absolute inset-0"}
            onClick={(e) => placeAt(e, box)}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            {fields
              .filter((f) => f.page === box.page)
              .map((f) => (
                <div
                  key={f.id}
                  onPointerDown={(e) => onPointerDown(e, f, "move", box)}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    left: `${f.x * 100}%`,
                    top: `${f.y * 100}%`,
                    width: `${f.w * 100}%`,
                    height: `${f.h * 100}%`,
                  }}
                  className={`absolute flex cursor-move items-center rounded border-2 px-1 text-[10px] font-medium ${
                    selected === f.id
                      ? "border-orange-500 bg-orange-500/20"
                      : f.assignee === "SENDER"
                        ? "border-violet-400 bg-violet-400/15 text-violet-900"
                        : "border-blue-400 bg-blue-400/15 text-blue-900"
                  }`}
                >
                  <span className="truncate">
                    {f.value || f.label || f.type.toLowerCase()}
                  </span>
                  {/* Resize grip */}
                  <span
                    onPointerDown={(e) => onPointerDown(e, f, "resize", box)}
                    className="absolute -bottom-1 -right-1 h-3 w-3 cursor-se-resize rounded-sm border border-white bg-orange-500"
                  />
                </div>
              ))}
          </div>
        )}
      />

      <p className="text-[11px] text-zinc-500">
        <span className="mr-3">
          <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-blue-400" />
          Client fills
        </span>
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-violet-400" />
          You fill
        </span>
      </p>
    </div>
  );
}

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n));
