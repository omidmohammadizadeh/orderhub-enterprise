"use client";

// Till settings → Keyboard. Per DEVICE, like the card machine and printer
// pins: the till with a touch screen wants ours, the office PC next to it
// with a real keyboard doesn't.

import { Check, X } from "lucide-react";
import { KEYBOARD_LANGUAGES } from "@/lib/pos/keyboard-layouts";
import { useDeviceStore, type KeyboardMode } from "@/stores/device.store";

const MODES: Array<{ value: KeyboardMode; label: string; hint: string }> = [
  { value: "auto", label: "Automatic", hint: "On for a touch screen, off when there's a mouse" },
  { value: "on", label: "Always on", hint: "Use the Order Hub keyboard on this device" },
  { value: "off", label: "Off", hint: "Use this device's own keyboard" },
];

export function KeyboardSettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const mode = useDeviceStore((s) => s.keyboardMode);
  const languages = useDeviceStore((s) => s.keyboardLanguages);
  const setMode = useDeviceStore((s) => s.setKeyboardMode);
  const setLanguages = useDeviceStore((s) => s.setKeyboardLanguages);
  if (!open) return null;

  const toggleLanguage = (code: string) =>
    setLanguages(languages.includes(code) ? languages.filter((c) => c !== code) : [...languages, code]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="keyboard-settings-title"
        className="w-full max-w-md rounded-t-2xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="keyboard-settings-title" className="text-lg font-semibold text-zinc-900">
            Keyboard
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-10 w-10 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mb-2 text-sm font-medium text-zinc-700">On this device</p>
        <div role="radiogroup" aria-label="On-screen keyboard" className="mb-5 flex flex-col gap-2">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={mode === m.value}
              onClick={() => setMode(m.value)}
              className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 ${
                mode === m.value ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 hover:border-zinc-300"
              }`}
            >
              <span>
                <span className="block text-sm font-semibold text-zinc-900">{m.label}</span>
                <span className="block text-xs text-zinc-500">{m.hint}</span>
              </span>
              {mode === m.value && <Check className="h-5 w-5 shrink-0 text-zinc-900" />}
            </button>
          ))}
        </div>

        <p className="mb-1 text-sm font-medium text-zinc-700">Languages</p>
        <p className="mb-2 text-xs text-zinc-500">The globe key switches between the ones you tick.</p>
        <div className="grid grid-cols-2 gap-2">
          {KEYBOARD_LANGUAGES.map((l) => {
            const on = languages.includes(l.code);
            return (
              <button
                key={l.code}
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => toggleLanguage(l.code)}
                className={`flex items-center justify-between rounded-xl border px-4 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 ${
                  on ? "border-zinc-900 bg-zinc-50 text-zinc-900" : "border-zinc-200 text-zinc-600 hover:border-zinc-300"
                }`}
              >
                <span dir={l.dir}>{l.name}</span>
                {on && <Check className="h-4 w-4 text-zinc-900" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
