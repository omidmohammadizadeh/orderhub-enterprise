"use client";

// Caller ID — is the box working?
//
// The Comet path crosses four boundaries (USB serial → native shell → this web
// app → the API) and used to be silent at every one. A dead box, an app build
// without USB support, a denied permission, a wrong baud rate and an
// unselected location all looked identical from the counter: nothing happens.
//
// This page is the answer to "is it working?" without a USB cable and adb.
// It shows what the reader is doing right now, including the raw serial lines,
// so an unfamiliar Comet firmware can be diagnosed from a photo of this screen
// rather than a debugging session.

import { useEffect, useState } from "react";
import { Phone, Trash2, RefreshCw, AlertTriangle } from "lucide-react";
import {
  attachHubLogBridge,
  clearHubLog,
  subscribeHubLog,
  hubRecord,
  type HubLogEntry,
} from "@/lib/callerid/hub-log";
import { useSelectedLocationStore } from "@/stores/selected-location.store";

const LEVEL_STYLES: Record<HubLogEntry["level"], string> = {
  info: "bg-zinc-100 text-zinc-600",
  error: "bg-red-100 text-red-700",
  ring: "bg-violet-100 text-violet-700",
  sent: "bg-emerald-100 text-emerald-700",
  dropped: "bg-amber-100 text-amber-800",
};

export default function CallerIdPage() {
  const [entries, setEntries] = useState<HubLogEntry[]>([]);
  const selectedLocationId = useSelectedLocationStore((s) => s.selectedLocationId);

  useEffect(() => {
    attachHubLogBridge();
    return subscribeHubLog(setEntries);
  }, []);

  // Derived state, read off the log rather than tracked separately — one
  // source of truth means the summary can never disagree with the lines
  // underneath it.
  // Only NATIVE lines prove the reader is alive. Counting every entry meant
  // tapping Mark turned this green while the reader had said nothing at all —
  // a false all-clear on the one check that has to be trustworthy.
  const nativeEntries = entries.filter((e) => e.source === "native");
  const sawDevice = nativeEntries.some((e) =>
    /usb caller-ID device|opening /i.test(e.message),
  );
  const sawRaw = nativeEntries.some((e) => e.raw || /RAW @/.test(e.message));
  const baudLine = nativeEntries.find((e) => /RAW @(\d+)/.test(e.message));
  const baud = baudLine?.message.match(/RAW @(\d+)/)?.[1] ?? null;
  const lastSent = entries.find((e) => e.level === "sent");
  // Only the LATEST permission-related line counts. Scanning all of history
  // meant a denial at 21:39:00 kept the card red long after the operator had
  // granted it at 21:39:15 — the page contradicting its own log.
  const latestPermission = nativeEntries.find((e) =>
    /permission denied|opening .* baud|open failed/i.test(e.message),
  );
  const permissionDenied = /permission denied/i.test(
    latestPermission?.message ?? "",
  );
  // The driver probe failing is a different failure from permission, and the
  // one that actually blocks this hardware: Android enumerates the box, but
  // the serial library has no driver for its chipset, so the port can never
  // open at any baud.
  const noDriver = nativeEntries.some((e) => /no driver for device/i.test(e.message));
  const noUsbModule = nativeEntries.some((e) =>
    /usb serial module not present/i.test(e.message),
  );

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-zinc-900">Caller ID</h1>
          <p className="mt-0.5 text-xs text-zinc-500">
            Live status of the Comet box on this tablet. Open this page on the
            hub tablet — the one with the USB box plugged in.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => hubRecord("info", "— marker —")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Mark
          </button>
          <button
            type="button"
            onClick={clearHubLog}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700"
          >
            <Trash2 className="h-3.5 w-3.5" /> Clear
          </button>
        </div>
      </header>

      {/* The checks, in the order they have to pass. */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Check
          label="Native app"
          ok={nativeEntries.length > 0}
          detail={
            nativeEntries.length > 0
              ? "Reader is reporting"
              : "No reader logs — either this is a browser tab, or the app build predates reader logging"
          }
        />
        <Check
          label="USB device"
          ok={sawDevice && !noUsbModule && !permissionDenied && !noDriver}
          detail={
            noUsbModule
              ? "This app build has no USB support — needs a newer build"
              : noDriver
                ? "Device found, but no serial driver matches its chipset — send me its vendor/product ID"
                : permissionDenied
                  ? "USB permission was denied — replug the box and allow it"
                  : sawDevice
                    ? "Comet claimed"
                    : "No device seen yet"
          }
        />
        <Check
          label="Serial data"
          ok={sawRaw}
          detail={
            sawRaw
              ? baud
                ? `Reading at ${baud} baud`
                : "Lines arriving"
              : "Nothing received yet — ring the line to test"
          }
        />
        <Check
          label="Location"
          ok={!!selectedLocationId}
          detail={
            selectedLocationId
              ? "A single location is selected"
              : "Pick ONE location in the switcher — rings are dropped otherwise"
          }
        />
      </div>

      {lastSent && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          Last ring forwarded {new Date(lastSent.at).toLocaleTimeString()} —{" "}
          {lastSent.message}
        </p>
      )}

      {sawRaw && !lastSent && (
        <p className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          The box is sending data but no phone number has been recognised in it.
          Copy a RAW line below and send it over — the parser needs to learn
          this firmware&apos;s format.
        </p>
      )}

      <section className="rounded-lg border border-zinc-200 bg-white">
        <header className="flex items-center gap-2 border-b border-zinc-100 px-3 py-2">
          <Phone className="h-3.5 w-3.5 text-zinc-400" />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Reader log
          </h2>
        </header>
        {entries.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-zinc-400">
            Nothing yet. On the hub tablet, unplug and replug the Comet, then
            ring the shop&apos;s line.
          </p>
        ) : (
          <ul className="max-h-[60vh] divide-y divide-zinc-100 overflow-y-auto">
            {entries.map((e, i) => (
              <li key={`${e.at}-${i}`} className="flex gap-2 px-3 py-2">
                <span className="shrink-0 font-mono text-[10px] text-zinc-400">
                  {new Date(e.at).toLocaleTimeString()}
                </span>
                <span
                  className={`h-fit shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${LEVEL_STYLES[e.level]}`}
                >
                  {e.level}
                </span>
                <span className="min-w-0 break-words font-mono text-[11px] text-zinc-700">
                  {e.message}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Check({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean;
  detail: string;
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        ok ? "border-emerald-200 bg-emerald-50" : "border-zinc-200 bg-white"
      }`}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        {label}
      </p>
      <p
        className={`mt-1 text-xs ${ok ? "text-emerald-800" : "text-zinc-600"}`}
      >
        {detail}
      </p>
    </div>
  );
}
