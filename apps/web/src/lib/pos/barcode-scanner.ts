"use client";

// Retail R1 — USB / Bluetooth barcode scanners at the till.
//
// Almost every scanner a shop buys is a "keyboard wedge": it types the
// barcode as keystrokes and presses Enter. The only way to tell that from a
// person is speed — a scanner sends a character every few milliseconds, a
// fast typist every 80+. So a burst of characters, each within `maxGapMs` of
// the last, ended by Enter, is a scan; anything slower is someone typing and
// is left alone.
//
// Scans are caught on window in the CAPTURE phase and the Enter is
// swallowed. Without that, the Enter a scanner sends lands on whatever button
// was tapped last — usually a product tile — and adds that product again.

import { useEffect, useRef } from "react";

export interface ScanDetectorOptions {
  /** Longest pause between two characters of one scan. */
  maxGapMs?: number;
  /** Shorter bursts are keyboard shortcuts or stray keys, not barcodes. */
  minLength?: number;
}

/** Pure state machine, fed key events; returns the code when a scan ends. */
export class ScanDetector {
  private buffer = "";
  private last = 0;
  private readonly maxGap: number;
  private readonly minLength: number;

  constructor(opts: ScanDetectorOptions = {}) {
    this.maxGap = opts.maxGapMs ?? 50;
    this.minLength = opts.minLength ?? 4;
  }

  /**
   * Feed one keydown. Returns the scanned code when this key completes a
   * scan, otherwise null.
   */
  key(key: string, at: number): string | null {
    if (key === "Enter" || key === "Tab") {
      const code = this.buffer;
      const fresh = at - this.last <= this.maxGap * 2;
      this.buffer = "";
      return code.length >= this.minLength && fresh ? code : null;
    }
    if (key.length !== 1) return null; // Shift, arrows, F-keys…
    if (at - this.last > this.maxGap) this.buffer = "";
    this.buffer += key;
    this.last = at;
    return null;
  }

  /** True while a scan is arriving, so its characters can be swallowed. */
  get inBurst(): boolean {
    return this.buffer.length >= 2;
  }
}

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/**
 * Listen for scans while `enabled`. Typing in a text box is never
 * intercepted — a box that wants scans (the search field) handles its own
 * Enter.
 */
export function useBarcodeScanner(enabled: boolean, onScan: (code: string) => void) {
  const cb = useRef(onScan);
  cb.current = onScan;

  useEffect(() => {
    if (!enabled) return;
    const detector = new ScanDetector();
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditable(e.target)) return;
      const code = detector.key(e.key, e.timeStamp || performance.now());
      if (code) {
        e.preventDefault();
        e.stopPropagation();
        cb.current(code);
      } else if (e.key === "Enter" || e.key === " ") {
        // A lone Enter/Space is someone pressing a focused button — leave it.
      } else if (detector.inBurst) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled]);
}

// ── Barcode index ───────────────────────────────────────────────────────────

/** A scanned code → the index key it was stored under (UPC-A ⇄ EAN-13). */
export function lookupKeys(code: string): string[] {
  const c = code.trim();
  const keys = [c];
  if (/^\d{12}$/.test(c)) keys.push(`0${c}`);
  if (/^0\d{12}$/.test(c)) keys.push(c.slice(1));
  return keys;
}

export function findByBarcode<T extends { barcode: string }>(
  index: Map<string, T>,
  code: string,
): T | null {
  for (const k of lookupKeys(code)) {
    const hit = index.get(k);
    if (hit) return hit;
  }
  return null;
}
