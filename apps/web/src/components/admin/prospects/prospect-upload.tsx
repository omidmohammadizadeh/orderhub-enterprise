"use client";

// File handling shared by the menu and statement sections of a prospect.

import { useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import type { UploadFile } from "@/lib/api/prospects.client";

export const errorMessage = (e: any, fallback: string): string =>
  e?.response?.data?.message ?? fallback;

/** Chrome labels a saved page as multipart/related or nothing, so go by name. */
export function mediaTypeOf(file: File): string {
  const name = file.name.toLowerCase();
  if (/\.(html?|mhtml?)$/.test(name)) return "text/html";
  if (name.endsWith(".csv")) return "text/csv";
  if (name.endsWith(".txt")) return "text/plain";
  if (name.endsWith(".pdf")) return "application/pdf";
  return file.type;
}

export function toUploadFile(file: File): Promise<UploadFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ mediaType: mediaTypeOf(file), data: String(reader.result) });
    reader.onerror = () => reject(new Error(`Couldn't read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export function DropZone({
  label,
  hint,
  accept,
  busy,
  onFiles,
}: {
  label: string;
  hint: string;
  accept: string;
  busy: boolean;
  onFiles: (files: File[]) => void;
}) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!busy && e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]);
      }}
      className={`rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors ${
        over ? "border-orange-500 bg-orange-50" : "border-zinc-300"
      }`}
    >
      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-zinc-900 px-4 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Upload className="h-4 w-4" aria-hidden="true" />}
        {busy ? "Reading…" : label}
      </button>
      <p className="mt-2 text-xs text-zinc-500">{hint}</p>
      <input
        ref={input}
        type="file"
        multiple
        accept={accept}
        className="sr-only"
        tabIndex={-1}
        aria-label={label}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
    </div>
  );
}
