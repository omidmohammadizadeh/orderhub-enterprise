"use client";

// Form pieces for the public "Partner with Eat For Less" page. Every field
// renders its own label, hint and error and wires them together with
// aria-describedby, so the parent form only deals in values and messages.

import { forwardRef, useState, type DragEvent, type ReactNode } from "react";

const inputBase =
  "h-12 w-full min-w-0 rounded-xl border bg-white px-3.5 text-[15px] font-normal text-[#0B0B0B] " +
  "placeholder:text-[#8A8A8A] transition-colors duration-150 " +
  "focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0B0B0B]";

function describedBy(id: string, hint?: string, error?: string): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}

function FieldShell({
  id,
  label,
  optional,
  hint,
  error,
  className,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  hint?: string;
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className ?? ""}`}>
      <label htmlFor={id} className="text-[13px] font-semibold text-[#0B0B0B]">
        {label}
        {optional && <span className="font-medium text-[#5E5E5E]"> (optional)</span>}
      </label>
      {children}
      {hint && (
        <span id={`${id}-hint`} className="text-xs font-medium leading-snug text-[#5E5E5E]">
          {hint}
        </span>
      )}
      {error && (
        <span id={`${id}-error`} className="flex items-start gap-1 text-xs font-semibold leading-snug text-[#B42318]">
          <svg aria-hidden="true" viewBox="0 0 16 16" className="mt-px h-3.5 w-3.5 shrink-0" fill="currentColor">
            <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 3.5h1.5v5h-1.5v-5zm0 6.25h1.5v1.5h-1.5v-1.5z" />
          </svg>
          {error}
        </span>
      )}
    </div>
  );
}

type TextFieldProps = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  optional?: boolean;
  hint?: string;
  error?: string;
  placeholder?: string;
  type?: "text" | "email" | "tel" | "url";
  autoComplete?: string;
  inputMode?: "text" | "email" | "tel" | "url";
  autoCapitalize?: string;
  maxLength?: number;
  className?: string;
};

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { id, label, value, onChange, optional, hint, error, placeholder, type = "text", autoComplete, inputMode, autoCapitalize, maxLength, className },
  ref,
) {
  return (
    <FieldShell id={id} label={label} optional={optional} hint={hint} error={error} className={className}>
      <input
        ref={ref}
        id={id}
        name={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        autoCapitalize={autoCapitalize}
        maxLength={maxLength}
        required={!optional}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={`${inputBase} ${error ? "border-[#B42318]" : "border-[#DADAD6] hover:border-[#BDBDB8]"}`}
      />
    </FieldShell>
  );
});

type SelectFieldProps = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
  placeholder: string;
  optional?: boolean;
  error?: string;
  className?: string;
};

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(function SelectField(
  { id, label, value, onChange, options, placeholder, optional, error, className },
  ref,
) {
  return (
    <FieldShell id={id} label={label} optional={optional} error={error} className={className}>
      <div className="relative">
        <select
          ref={ref}
          id={id}
          name={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, undefined, error)}
          className={`${inputBase} appearance-none pr-10 ${value ? "" : "text-[#8A8A8A]"} ${
            error ? "border-[#B42318]" : "border-[#DADAD6] hover:border-[#BDBDB8]"
          }`}
        >
          <option value="">{placeholder}</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#5E5E5E]"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 8l5 5 5-5" />
        </svg>
      </div>
    </FieldShell>
  );
});

type FileDropProps = {
  id: string;
  title: string;
  hint: string;
  fileName?: string;
  busy?: boolean;
  error?: string;
  onPick: (file: File) => void;
};

/** A file input dressed as a drop zone. Tapping opens the picker; dropping works on desktop. */
export const FileDrop = forwardRef<HTMLInputElement, FileDropProps>(function FileDrop(
  { id, title, hint, fileName, busy, error, onPick },
  ref,
) {
  const [dragging, setDragging] = useState(false);
  const has = Boolean(fileName);

  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onPick(file);
  };

  const border = error
    ? "border-[#B42318]"
    : has || dragging
      ? "border-[#0B0B0B]"
      : "border-[#DADAD6] hover:border-[#0B0B0B]";
  const bg = has ? "bg-[#F4FFD6]" : dragging ? "bg-[#FAFAF8]" : "bg-white hover:bg-[#FAFAF8]";

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label
        htmlFor={id}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`relative flex min-h-[176px] cursor-pointer flex-col items-center justify-center gap-2 rounded-[18px] border-2 border-dashed p-5 text-center transition-colors duration-200 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[#0B0B0B] ${border} ${bg}`}
      >
        <input
          ref={ref}
          id={id}
          name={id}
          type="file"
          accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
          className="sr-only"
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-hint ${id}-state${error ? ` ${id}-error` : ""}`}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onPick(file);
            // Let the same file be picked again after an error.
            e.target.value = "";
          }}
        />
        {has ? (
          <svg aria-hidden="true" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#0B0B0B" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12l5 5 9-10" />
          </svg>
        ) : (
          <svg aria-hidden="true" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#0B0B0B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 16V4M7 9l5-5 5 5" />
            <path d="M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3" />
          </svg>
        )}
        <span className="text-[15px] font-extrabold">{title}</span>
        <span id={`${id}-hint`} className="text-xs leading-snug text-[#5E5E5E]">
          {hint}
        </span>
        <span id={`${id}-state`} aria-live="polite" className="max-w-full truncate text-xs font-extrabold">
          {busy ? "Preparing…" : has ? `Uploaded: ${fileName}` : "Tap to upload"}
        </span>
        {has && !busy && <span className="text-xs font-semibold text-[#5E5E5E] underline underline-offset-2">Change file</span>}
      </label>
      {error && (
        <span id={`${id}-error`} className="text-xs font-semibold leading-snug text-[#B42318]">
          {error}
        </span>
      )}
    </div>
  );
});
