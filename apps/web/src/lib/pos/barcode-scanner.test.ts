import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { ScanDetector, findByBarcode, useBarcodeScanner } from "./barcode-scanner";

/** Feed a string as keystrokes `gap` ms apart, then Enter. */
function feed(d: ScanDetector, text: string, gap: number, start = 1000) {
  let t = start;
  for (const ch of text) {
    expect(d.key(ch, t)).toBeNull();
    t += gap;
  }
  return d.key("Enter", t);
}

describe("ScanDetector", () => {
  it("recognises a scanner burst ended by Enter", () => {
    expect(feed(new ScanDetector(), "5000112637922", 8)).toBe("5000112637922");
  });

  it("ignores a person typing, however long the word", () => {
    expect(feed(new ScanDetector(), "5000112637922", 120)).toBeNull();
  });

  it("ignores short bursts — a key-repeat or a shortcut is not a barcode", () => {
    expect(feed(new ScanDetector(), "ab", 5)).toBeNull();
  });

  it("drops slow characters typed before a scan", () => {
    const d = new ScanDetector();
    d.key("x", 0); // someone brushed a key
    expect(feed(d, "12345678", 5, 5000)).toBe("12345678");
  });

  it("does not fire for an Enter long after the burst", () => {
    const d = new ScanDetector();
    for (const [i, ch] of [..."12345678"].entries()) d.key(ch, 1000 + i * 5);
    expect(d.key("Enter", 5000)).toBeNull();
  });
});

describe("useBarcodeScanner", () => {
  function press(key: string, target: EventTarget = document.body) {
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e;
  }

  it("calls back with the scan and swallows its Enter so a focused tile isn't pressed again", () => {
    const onScan = vi.fn();
    renderHook(() => useBarcodeScanner(true, onScan));
    for (const ch of "96385074") press(ch);
    const enter = press("Enter");
    expect(onScan).toHaveBeenCalledWith("96385074");
    expect(enter.defaultPrevented).toBe(true);
  });

  it("leaves text boxes alone", () => {
    const onScan = vi.fn();
    renderHook(() => useBarcodeScanner(true, onScan));
    const input = document.createElement("input");
    document.body.appendChild(input);
    for (const ch of "96385074") press(ch, input);
    press("Enter", input);
    expect(onScan).not.toHaveBeenCalled();
    input.remove();
  });

  it("does nothing while disabled (a payment modal is open)", () => {
    const onScan = vi.fn();
    renderHook(() => useBarcodeScanner(false, onScan));
    for (const ch of "96385074") press(ch);
    press("Enter");
    expect(onScan).not.toHaveBeenCalled();
  });
});

describe("findByBarcode", () => {
  const index = new Map([["0036000291452", { barcode: "0036000291452", name: "UPC item" }]]);
  it("matches a UPC-A scanned without the EAN-13 leading zero", () => {
    expect(findByBarcode(index, "036000291452")?.name).toBe("UPC item");
    expect(findByBarcode(index, "999")).toBeNull();
  });
});
