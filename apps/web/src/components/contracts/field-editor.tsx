"use client";

// Drag-and-drop field placement over an uploaded contract PDF.
//
// Geometry is kept as FRACTIONS of the page throughout — never pixels. The
// operator places a box on a 900px-wide desktop render and the client taps it
// on a 375px phone; storing pixels would put the signature line somewhere else
// entirely on the second screen. Everything converts to pixels only at the
// moment of drawing, and back to fractions the moment a drag ends.
//
// You fill your own fields by tapping them ON the document rather than through
// a side panel: the whole point of placing a box is that its position carries
// meaning, and typing into a form field somewhere else breaks that link.

import { useRef, useState } from "react";
import { CalendarDays, Check, PenLine, Trash2, Type } from "lucide-react";
import { PdfPages, type PageBox } from "./pdf-pages";
import { SignaturePad } from "./signature-pad";

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

/**
 * The two parties, and the colours that identify them everywhere.
 *
 * One definition drives the switch, the boxes and the legend — if the switch
 * said blue and the box drew violet, the colour would stop meaning anything.
 */
const ASSIGNEES: Array<{
  key: FieldAssignee;
  label: string;
  activeCls: string;
  boxCls: string;
  dotCls: string;
}> = [
  {
    key: "RECIPIENT",
    label: "Client",
    activeCls: "bg-blue-600",
    boxCls: "border-blue-500 bg-blue-500/15 text-blue-900",
    dotCls: "bg-blue-500",
  },
  {
    key: "SENDER",
    label: "Team member",
    activeCls: "bg-violet-600",
    boxCls: "border-violet-500 bg-violet-500/15 text-violet-900",
    dotCls: "bg-violet-500",
  },
];

const assigneeStyle = (a: FieldAssignee) =>
  ASSIGNEES.find((x) => x.key === a) ?? ASSIGNEES[0]!;

const todayIso = () => new Date().toISOString().slice(0, 10);

/** Local ids until the server assigns real ones. */
let seq = 0;
const nextId = () => `new_${++seq}`;

/** Below this much movement a pointer gesture is a tap, not a drag. */
const DRAG_THRESHOLD_PX = 4;

export function FieldEditor({
  fileUrl,
  fields,
  onChange,
}: {
  fileUrl: string;
  fields: PlacedField[];
  onChange: (fields: PlacedField[]) => void;
}) {
  const [who, setWho] = useState<FieldAssignee>("RECIPIENT");
  const [tool, setTool] = useState<FieldType | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [signing, setSigning] = useState<string | null>(null);

  const drag = useRef<{
    id: string;
    mode: "move" | "resize";
    startX: number;
    startY: number;
    moved: boolean;
    orig: PlacedField;
    box: PageBox;
  } | null>(null);

  const update = (id: string, patch: Partial<PlacedField>) =>
    onChange(fields.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  const remove = (id: string) => {
    onChange(fields.filter((f) => f.id !== id));
    setSelected((s) => (s === id ? null : s));
    setEditing((s) => (s === id ? null : s));
  };

  const placeAt = (e: React.MouseEvent, box: PageBox) => {
    if (!tool) return;
    const spec = TOOLS.find((t) => t.type === tool)!;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const field: PlacedField = {
      id: nextId(),
      page: box.page,
      // Centre on the click: the cursor marks where the field goes, not its
      // top-left corner.
      x: Math.max(0, Math.min(1 - spec.w, x - spec.w / 2)),
      y: Math.max(0, Math.min(1 - spec.h, y - spec.h / 2)),
      w: spec.w,
      h: spec.h,
      type: tool,
      assignee: who,
      label: spec.label,
      required: true,
      fontSize: 11,
      // A date we fill is almost always today, so it arrives filled rather
      // than as one more empty box to go back and complete.
      value: tool === "DATE" && who === "SENDER" ? todayIso() : null,
    };
    onChange([...fields, field]);
    setSelected(field.id);
    setTool(null);
  };

  /** Tapping your own field edits it in place; a client field is theirs. */
  const openField = (f: PlacedField) => {
    setSelected(f.id);
    if (f.assignee !== "SENDER") return;
    if (f.type === "CHECKBOX") {
      update(f.id, { value: f.value === "true" ? "" : "true" });
      return;
    }
    if (f.type === "SIGNATURE") {
      setSigning(f.id);
      return;
    }
    if (f.type === "DATE" && !f.value) update(f.id, { value: todayIso() });
    setEditing(f.id);
  };

  const onPointerDown = (
    e: React.PointerEvent,
    f: PlacedField,
    mode: "move" | "resize",
    box: PageBox,
  ) => {
    if (editing === f.id) return; // let the input take the pointer
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = {
      id: f.id,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      orig: { ...f },
      box,
    };
    setSelected(f.id);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const rawX = e.clientX - d.startX;
    const rawY = e.clientY - d.startY;
    if (
      !d.moved &&
      Math.abs(rawX) < DRAG_THRESHOLD_PX &&
      Math.abs(rawY) < DRAG_THRESHOLD_PX
    ) {
      return; // still a tap
    }
    d.moved = true;
    const dx = rawX / d.box.width;
    const dy = rawY / d.box.height;
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

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    // A gesture that never passed the threshold is a tap — open the field.
    // Resize grips are drag-only; tapping one should do nothing.
    if (!d || d.moved || d.mode === "resize") return;
    const f = fields.find((x) => x.id === d.id);
    if (f) openField(f);
  };

  const chosen = fields.find((f) => f.id === selected) ?? null;
  const signingField = fields.find((f) => f.id === signing) ?? null;

  // One switch, two jobs: with a field selected it changes THAT field; with
  // nothing selected it sets what the next box will be. A second copy in a
  // properties bar was the same control twice, in two places, disagreeing.
  const switchValue = chosen ? chosen.assignee : who;
  const setSwitch = (a: FieldAssignee) => {
    setWho(a);
    if (chosen) update(chosen.id, { assignee: a });
  };

  return (
    <div className="space-y-3">
      <div className="sticky top-0 z-10 space-y-2 rounded-lg border border-zinc-200 bg-white/95 p-2 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-zinc-500">
            {chosen ? "This box is filled by:" : "Who fills the next box:"}
          </span>
          <div className="flex overflow-hidden rounded-md border border-zinc-200">
            {ASSIGNEES.map((a) => (
              <button
                key={a.key}
                type="button"
                onClick={() => setSwitch(a.key)}
                className={`px-3 py-1.5 text-xs font-semibold transition ${
                  switchValue === a.key
                    ? `${a.activeCls} text-white`
                    : "bg-white text-zinc-600 hover:bg-zinc-50"
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>

          {chosen && (
            <>
              <input
                value={chosen.label ?? ""}
                onChange={(e) => update(chosen.id, { label: e.target.value })}
                placeholder="Label"
                className="w-32 rounded-md border border-zinc-200 px-2 py-1.5 text-xs"
              />
              <label className="flex items-center gap-1 text-xs text-zinc-600">
                <input
                  type="checkbox"
                  checked={chosen.required}
                  onChange={(e) =>
                    update(chosen.id, { required: e.target.checked })
                  }
                />
                Required
              </label>
              <button
                type="button"
                onClick={() => remove(chosen.id)}
                className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-red-600"
                title="Delete field"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
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
              : `${fields.length} placed · tap your own boxes to fill them`}
          </span>
        </div>
      </div>

      <PdfPages
        fileUrl={fileUrl}
        renderOverlay={(box) => (
          <div
            className={
              tool ? "absolute inset-0 cursor-crosshair" : "absolute inset-0"
            }
            onClick={(e) => placeAt(e, box)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {fields
              .filter((f) => f.page === box.page)
              .map((f) => {
                const isEditing = editing === f.id;
                const mine = f.assignee === "SENDER";
                return (
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
                    className={`absolute flex items-center overflow-hidden rounded border-2 px-1 text-[10px] font-medium ${
                      isEditing ? "cursor-text" : "cursor-move"
                    } ${
                      selected === f.id
                        ? "border-orange-500 bg-orange-500/25 text-orange-900 ring-2 ring-orange-300"
                        : assigneeStyle(f.assignee).boxCls
                    }`}
                  >
                    {isEditing ? (
                      <input
                        autoFocus
                        type={f.type === "DATE" ? "date" : "text"}
                        value={f.value ?? ""}
                        onChange={(e) => update(f.id, { value: e.target.value })}
                        onBlur={() => setEditing(null)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === "Escape") {
                            setEditing(null);
                          }
                        }}
                        onPointerDown={(e) => e.stopPropagation()}
                        className="h-full w-full bg-transparent text-[10px] outline-none"
                      />
                    ) : (
                      <span
                        className={`truncate ${
                          f.type === "SIGNATURE" && f.value ? "italic" : ""
                        }`}
                      >
                        {f.type === "CHECKBOX"
                          ? f.value === "true"
                            ? "✓"
                            : ""
                          : f.value ||
                            (mine
                              ? "Tap to fill"
                              : f.label || f.type.toLowerCase())}
                      </span>
                    )}
                    <span
                      onPointerDown={(e) => onPointerDown(e, f, "resize", box)}
                      className="absolute -bottom-1 -right-1 h-3 w-3 cursor-se-resize rounded-sm border border-white bg-orange-500"
                    />
                  </div>
                );
              })}
          </div>
        )}
      />

      <p className="flex flex-wrap gap-4 text-[11px] text-zinc-500">
        {ASSIGNEES.map((a) => (
          <span key={a.key} className="inline-flex items-center gap-1.5">
            <span
              className={`inline-block h-2.5 w-2.5 rounded-sm ${a.dotCls}`}
            />
            {a.label} fills this
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-orange-500" />
          Selected
        </span>
      </p>

      {signingField && (
        <SignaturePad
          initialName={signingField.value ?? ""}
          onCancel={() => setSigning(null)}
          onDone={({ name }) => {
            update(signingField.id, { value: name });
            setSigning(null);
          }}
        />
      )}
    </div>
  );
}

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n));
