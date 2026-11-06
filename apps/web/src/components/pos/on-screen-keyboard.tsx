"use client";

// The till's own keyboard, in place of the tablet's or Windows' one.
//
// The system keyboard covers half the screen, shoves the basket around, and
// shows letters for a phone number unless every field remembers to ask for
// digits. This one is the same on every till: a numpad for phone and money
// fields, capitals for a postcode, the number row always on top, and the
// languages this shop's staff type in behind the globe key.
//
// Mounted once on the POS page, it serves every field on it, modals
// included, without each field opting in: when a typed field gains focus it
// gets inputmode="none" (which tells Android, iPad and Windows touch not to
// open theirs) and this one appears. A physical keyboard or barcode scanner
// keeps working, because nothing about the field itself changes. A field
// that has its own keypad opts out with data-osk="off".
//
// Keys act on pointerdown and swallow the press, so the field never loses
// focus and a modal's "tap outside to close" never sees a tap on a key.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowBigUp, ChevronDown, CornerDownLeft, Delete, Globe } from "lucide-react";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useDeviceStore } from "@/stores/device.store";
import {
  NUMBER_ROW,
  SYMBOL_ROWS,
  applyKey,
  hasShift,
  isTypedField,
  keyboardLanguage,
  keypadFor,
  shiftedRows,
  wantsCapitals,
  type FieldDescription,
  type KeyAction,
  type KeypadKind,
} from "@/lib/pos/keyboard-layouts";

type Field = HTMLInputElement | HTMLTextAreaElement;
type Shift = "off" | "once" | "lock";

/** Where a field's own inputmode is kept while ours is "none". */
const SAVED_MODE = "data-osk-mode";

function asField(el: EventTarget | null): Field | null {
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return null;
  const tag = el instanceof HTMLTextAreaElement ? "textarea" : "input";
  if (!isTypedField(tag, el instanceof HTMLInputElement ? el.type : "")) return null;
  if (el.readOnly || el.disabled || el.closest('[data-osk="off"]')) return null;
  return el;
}

function describe(el: Field): FieldDescription {
  return {
    tag: el instanceof HTMLTextAreaElement ? "textarea" : "input",
    type: el instanceof HTMLInputElement ? el.type : "",
    inputMode: el.getAttribute(SAVED_MODE) ?? el.getAttribute("inputmode") ?? "",
    hints: ["aria-label", "placeholder", "name", "autocomplete"]
      .map((a) => el.getAttribute(a) ?? "")
      .join(" "),
  };
}

/** Stop the system keyboard opening for this field. */
function claim(el: Field) {
  if (el.hasAttribute(SAVED_MODE)) return;
  el.setAttribute(SAVED_MODE, el.getAttribute("inputmode") ?? "");
  el.setAttribute("inputmode", "none");
}

function releaseAll() {
  document.querySelectorAll<Field>(`[${SAVED_MODE}]`).forEach((el) => {
    const mode = el.getAttribute(SAVED_MODE);
    if (mode) el.setAttribute("inputmode", mode);
    else el.removeAttribute("inputmode");
    el.removeAttribute(SAVED_MODE);
  });
}

/**
 * Write a value the way typing does, so React's onChange sees it. Setting
 * .value directly is swallowed by React's own value tracker.
 */
function typeInto(el: Field, action: KeyAction) {
  // email and number inputs have no selection API; they're edited at the end.
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const next = applyKey({ value: el.value, start, end }, action, el.maxLength);
  if (next.value === el.value) return;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, next.value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  try {
    el.setSelectionRange(next.start, next.end);
  } catch {
    // Not supported on this input type — the caret stays at the end.
  }
}

/** Enter: what a hardware Enter would do, then put the keyboard away. */
function pressEnter(el: Field) {
  if (el instanceof HTMLTextAreaElement) {
    typeInto(el, { kind: "insert", text: "\n" });
    return;
  }
  const init = { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true };
  const proceed = el.dispatchEvent(new KeyboardEvent("keydown", init));
  el.dispatchEvent(new KeyboardEvent("keyup", init));
  if (!proceed) return;
  el.form?.requestSubmit();
  el.blur();
}

export function OnScreenKeyboard() {
  const mode = useDeviceStore((s) => s.keyboardMode);
  const languages = useDeviceStore((s) => s.keyboardLanguages);
  const languageCode = useDeviceStore((s) => s.keyboardLanguage);
  const setLanguage = useDeviceStore((s) => s.setKeyboardLanguage);
  const touchScreen = useMediaQuery("(pointer: coarse)");
  const enabled = mode === "on" || (mode === "auto" && touchScreen);

  const [field, setField] = useState<Field | null>(null);
  const [shift, setShift] = useState<Shift>("off");
  const [symbols, setSymbols] = useState(false);
  const [atTop, setAtTop] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Follow focus around the page.
  useEffect(() => {
    if (!enabled) {
      releaseAll();
      setField(null);
      return;
    }
    // pointerdown comes before focus, so a tapped field is claimed before
    // the system decides to open its keyboard. focusin covers autoFocus and
    // fields reached with Tab.
    const onPointerDown = (e: PointerEvent) => {
      const el = asField(e.target);
      if (el) claim(el);
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = asField(e.target);
      if (!el) return;
      claim(el);
      setField(el);
    };
    const onFocusOut = () => {
      // Wait for focus to land: moving from one field to the next is not a
      // reason to hide and reshow.
      setTimeout(() => {
        if (!asField(document.activeElement)) setField(null);
      }, 0);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    const current = asField(document.activeElement);
    if (current) {
      claim(current);
      setField(current);
    }
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      releaseAll();
    };
  }, [enabled]);

  // A modal closing removes its field without a focusout.
  useEffect(() => {
    if (!field) return;
    const observer = new MutationObserver(() => {
      if (!field.isConnected) setField(null);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [field]);

  const description = field ? describe(field) : null;
  const kind: KeypadKind = description ? keypadFor(description) : "text";

  // Each new field starts on letters, capitalised as a name or postcode is.
  useEffect(() => {
    if (!field || !description) return;
    setSymbols(false);
    if (wantsCapitals(description)) setShift("lock");
    else if (kind === "text" && field.value === "") setShift("once");
    else setShift("off");
    // Only when the field changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field]);

  // Sit at the bottom, unless that would cover the field.
  useLayoutEffect(() => {
    if (!field || !panelRef.current) return;
    const height = panelRef.current.offsetHeight;
    const rect = field.getBoundingClientRect();
    const coveredAtBottom = rect.bottom > window.innerHeight - height - 8;
    const roomAtTop = rect.top > height + 8;
    setAtTop(coveredAtBottom && roomAtTop);
    if (coveredAtBottom && !roomAtTop) field.scrollIntoView({ block: "start" });
  }, [field, kind]);

  // Cancel the press's default so focus stays in the field. Natively, and
  // non-passive, because React's touchstart listener is passive. Propagation
  // is stopped in React (below) instead: stopping it here, under the portal's
  // root, would hide the press from the keys' own handlers.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const keepFocus = (e: Event) => e.preventDefault();
    const events = ["pointerdown", "mousedown", "touchstart"] as const;
    events.forEach((t) => panel.addEventListener(t, keepFocus, { passive: false }));
    return () => events.forEach((t) => panel.removeEventListener(t, keepFocus));
  }, [field]);

  const press = useCallback(
    (action: KeyAction) => {
      if (!field) return;
      typeInto(field, action);
      if (action.kind === "insert" && shift === "once") setShift("off");
    },
    [field, shift],
  );

  if (!enabled || !field) return null;

  const lang = keyboardLanguage(languageCode);
  const nextLanguage = () => {
    const i = languages.indexOf(lang.code);
    setLanguage(languages[(i + 1) % languages.length] ?? languages[0] ?? "en");
  };
  const actions = {
    press,
    backspace: () => press({ kind: "backspace" }),
    enter: () => pressEnter(field),
    hide: () => field.blur(),
  };

  return createPortal(
    <div
      ref={panelRef}
      role="group"
      aria-label="On-screen keyboard"
      // Above every POS modal (z-50) and the till's own popups.
      className={`fixed inset-x-0 z-[200] select-none border-zinc-300 bg-zinc-200 text-zinc-900 px-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] pt-1.5 shadow-[0_-4px_16px_rgba(0,0,0,0.12)] ${
        atTop ? "top-0 border-b" : "bottom-0 border-t"
      }`}
      style={{ pointerEvents: "auto", touchAction: "manipulation" }}
      // Nothing underneath (a modal backdrop, an outside-click handler) may
      // hear a press on a key.
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {kind === "text" || kind === "email" ? (
        <LetterPad
          lang={lang}
          email={kind === "email"}
          shift={shift}
          symbols={symbols}
          showGlobe={languages.length > 1}
          onShift={() => setShift(shift === "off" ? "once" : shift === "once" ? "lock" : "off")}
          onSymbols={() => setSymbols(!symbols)}
          onGlobe={nextLanguage}
          {...actions}
        />
      ) : (
        <NumberPad kind={kind} {...actions} />
      )}
    </div>,
    document.body,
  );
}

type PadActions = {
  press: (action: KeyAction) => void;
  backspace: () => void;
  enter: () => void;
  hide: () => void;
};

function LetterPad({
  lang,
  email,
  shift,
  symbols,
  showGlobe,
  onShift,
  onSymbols,
  onGlobe,
  press,
  backspace,
  enter,
  hide,
}: PadActions & {
  lang: ReturnType<typeof keyboardLanguage>;
  email: boolean;
  shift: Shift;
  symbols: boolean;
  showGlobe: boolean;
  onShift: () => void;
  onSymbols: () => void;
  onGlobe: () => void;
}) {
  const rows = symbols ? SYMBOL_ROWS : shift === "off" ? lang.rows : shiftedRows(lang);
  const dir = symbols ? "ltr" : lang.dir;
  // Every key the same width: shorter rows are centred with spacers, the
  // way a phone keyboard indents its middle row.
  const columns = Math.max(NUMBER_ROW.length, ...rows.map((r, i) => r.length + (i === 2 ? 3 : 0)));
  const insert = (text: string) => press({ kind: "insert", text });

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-1.5">
      <Row columns={columns} used={NUMBER_ROW.length}>
        {NUMBER_ROW.map((k) => (
          <Key key={k} onPress={() => insert(k)} className="bg-zinc-50">
            {k}
          </Key>
        ))}
      </Row>
      {rows.map((row, i) => {
        const last = i === rows.length - 1;
        const letters = (
          <div dir={dir} className="flex min-w-0 gap-1.5" style={{ flex: row.length }}>
            {row.map((k) => (
              <Key key={k} onPress={() => insert(k)}>
                {k}
              </Key>
            ))}
          </div>
        );
        if (!last) {
          return (
            <Row key={i} columns={columns} used={row.length}>
              {letters}
            </Row>
          );
        }
        return (
          <Row key={i} columns={columns} used={row.length + 3}>
            {!symbols && hasShift(lang) ? (
              <Key
                grow={1.5}
                onPress={onShift}
                label={shift === "lock" ? "Caps lock on" : "Shift"}
                pressed={shift !== "off"}
                className={shift === "lock" ? "bg-zinc-900 text-white" : shift === "once" ? "bg-white" : "bg-zinc-300"}
              >
                <ArrowBigUp className={`h-6 w-6 ${shift !== "off" ? "fill-current" : ""}`} />
              </Key>
            ) : (
              <div style={{ flex: 1.5 }} />
            )}
            {letters}
            <Key grow={1.5} onPress={backspace} repeat label="Backspace" className="bg-zinc-300">
              <Delete className="h-6 w-6" />
            </Key>
          </Row>
        );
      })}
      <div className="flex gap-1.5">
        <Key grow={1.5} onPress={onSymbols} className="bg-zinc-300 text-base font-semibold">
          {symbols ? "ABC" : "?123"}
        </Key>
        {showGlobe && (
          <Key onPress={onGlobe} label="Next language" className="bg-zinc-300">
            <Globe className="h-5 w-5" />
          </Key>
        )}
        <Key onPress={() => insert(email ? "@" : ",")}>{email ? "@" : ","}</Key>
        <Key grow={5} onPress={() => insert(" ")} label="Space" className="text-sm text-zinc-500">
          {lang.name}
        </Key>
        <Key onPress={() => insert(".")}>.</Key>
        {email && (
          <Key grow={1.5} onPress={() => insert(".com")} className="text-base">
            .com
          </Key>
        )}
        <Key onPress={hide} label="Hide keyboard" className="bg-zinc-300">
          <ChevronDown className="h-6 w-6" />
        </Key>
        <Key grow={1.5} onPress={enter} label="Enter" className="bg-zinc-900 text-white">
          <CornerDownLeft className="h-6 w-6" />
        </Key>
      </div>
    </div>
  );
}

function NumberPad({ kind, press, backspace, enter, hide }: PadActions & { kind: KeypadKind }) {
  const insert = (text: string) => press({ kind: "insert", text });
  const extra = kind === "decimal" ? "." : kind === "tel" ? "+" : null;
  const digit = (d: string) => (
    <Key key={d} onPress={() => insert(d)} className="text-2xl">
      {d}
    </Key>
  );
  return (
    <div className="mx-auto grid max-w-md grid-cols-4 gap-1.5 [&>*]:h-14">
      {["1", "2", "3"].map(digit)}
      <Key onPress={backspace} repeat label="Backspace" className="bg-zinc-300">
        <Delete className="h-6 w-6" />
      </Key>
      {["4", "5", "6"].map(digit)}
      <Key onPress={hide} label="Hide keyboard" className="bg-zinc-300">
        <ChevronDown className="h-6 w-6" />
      </Key>
      {["7", "8", "9"].map(digit)}
      <Key onPress={enter} label="Enter" className="row-span-2 !h-auto bg-zinc-900 text-white">
        <CornerDownLeft className="h-6 w-6" />
      </Key>
      {extra ? (
        <Key onPress={() => insert(extra)} className="text-2xl">
          {extra}
        </Key>
      ) : (
        <div />
      )}
      {digit("0")}
      {kind === "tel" ? (
        <Key onPress={() => insert(" ")} label="Space" className="text-sm text-zinc-500">
          space
        </Key>
      ) : (
        <div />
      )}
    </div>
  );
}

/** A row of keys, centred with spacers so every key is the same width. */
function Row({ columns, used, children }: { columns: number; used: number; children: React.ReactNode }) {
  const pad = Math.max(0, (columns - used) / 2);
  return (
    <div className="flex gap-1.5">
      {pad > 0 && <div style={{ flex: pad }} />}
      {children}
      {pad > 0 && <div style={{ flex: pad }} />}
    </div>
  );
}

const REPEAT_DELAY_MS = 400;
const REPEAT_EVERY_MS = 60;

function Key({
  onPress,
  children,
  label,
  grow = 1,
  repeat = false,
  pressed,
  className = "bg-white",
}: {
  onPress: () => void;
  children: React.ReactNode;
  label?: string;
  grow?: number;
  /** Keep firing while held, like backspace on a phone. */
  repeat?: boolean;
  pressed?: boolean;
  className?: string;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);

  return (
    <button
      type="button"
      // Never focusable: focus belongs to the field being typed into.
      tabIndex={-1}
      aria-label={label}
      aria-pressed={pressed}
      onPointerDown={() => {
        onPress();
        if (!repeat) return;
        const again = () => {
          onPress();
          timer.current = setTimeout(again, REPEAT_EVERY_MS);
        };
        timer.current = setTimeout(again, REPEAT_DELAY_MS);
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      style={{ flex: grow }}
      className={`grid h-12 min-w-0 place-items-center rounded-lg text-xl shadow-[0_1px_0_rgba(0,0,0,0.25)] active:translate-y-px active:bg-zinc-400 ${className}`}
    >
      {children}
    </button>
  );
}
