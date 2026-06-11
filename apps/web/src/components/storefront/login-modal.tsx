"use client";

// Phase AP-AUTH — storefront login + signup modal.
//
// Opens when the customer clicks "Place order" without being signed in
// (Friendly flavour — they can browse the menu freely; auth only gates
// the checkout submit).
//
// Three states:
//   "signin"  — email + password form
//   "signup"  — first name, last name, email, password (+ optional phone)
//   "sent"    — "check your email" confirmation after signup submits
//
// Google OAuth button is wired in increment 2b; for now it shows a
// "coming soon" toast so layout doesn't shift later.

import { useState } from "react";
import { Loader2, Mail, X } from "lucide-react";
import { useCustomerAuth } from "../../hooks/use-customer-auth";

type Mode = "signin" | "signup" | "sent";

interface Props {
  open: boolean;
  storeSlug: string;
  onClose: () => void;
  /** Called once the customer is signed in (login resolves successfully). */
  onAuthenticated: () => void;
}

export function LoginModal({ open, storeSlug, onClose, onAuthenticated }: Props) {
  const { login, signup } = useCustomerAuth();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const reset = () => {
    setError(null);
    setSubmitting(false);
  };

  const handleSignin = async (e: React.FormEvent) => {
    e.preventDefault();
    reset();
    setSubmitting(true);
    try {
      await login(email.trim(), password);
      onAuthenticated();
      onClose();
    } catch (err: any) {
      setError(
        err?.response?.data?.message ??
          "Couldn't sign in. Check your email and password.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    reset();
    setSubmitting(true);
    try {
      await signup({
        email: email.trim(),
        password,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phone: phone.trim() || undefined,
        marketingOptIn,
        storeSlug,
      });
      setMode("sent");
    } catch (err: any) {
      setError(
        err?.response?.data?.message ?? "Couldn't create your account.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <h2 className="text-base font-bold text-zinc-900">
            {mode === "sent"
              ? "Check your email"
              : mode === "signup"
                ? "Create your account"
                : "Sign in to order"}
          </h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5">
          {mode === "sent" ? (
            <SentState email={email} onBack={() => setMode("signin")} />
          ) : (
            <>
              <GoogleButton storeSlug={storeSlug} />
              <Divider />
              {mode === "signin" ? (
                <form onSubmit={handleSignin} className="space-y-3">
                  <Field label="Email" required>
                    <Input
                      type="email"
                      value={email}
                      onChange={setEmail}
                      placeholder="you@example.com"
                      autoFocus
                    />
                  </Field>
                  <Field label="Password" required>
                    <Input
                      type="password"
                      value={password}
                      onChange={setPassword}
                      placeholder="••••••••"
                    />
                  </Field>
                  {error && <ErrorRow message={error} />}
                  <SubmitButton submitting={submitting}>Sign in</SubmitButton>
                  <p className="pt-1 text-center text-xs text-zinc-500">
                    No account yet?{" "}
                    <button
                      type="button"
                      onClick={() => {
                        setMode("signup");
                        reset();
                      }}
                      className="font-semibold text-emerald-700 hover:underline"
                    >
                      Create one
                    </button>
                  </p>
                </form>
              ) : (
                <form onSubmit={handleSignup} className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="First name" required>
                      <Input
                        value={firstName}
                        onChange={setFirstName}
                        placeholder="Omid"
                        autoFocus
                      />
                    </Field>
                    <Field label="Last name" required>
                      <Input
                        value={lastName}
                        onChange={setLastName}
                        placeholder="Mohammadi"
                      />
                    </Field>
                  </div>
                  <Field label="Email" required>
                    <Input
                      type="email"
                      value={email}
                      onChange={setEmail}
                      placeholder="you@example.com"
                    />
                  </Field>
                  <Field label="Phone (optional)">
                    <Input
                      type="tel"
                      value={phone}
                      onChange={setPhone}
                      placeholder="+44 …"
                    />
                  </Field>
                  <Field
                    label="Password"
                    required
                    hint="8+ chars, with an uppercase letter and a number"
                  >
                    <Input
                      type="password"
                      value={password}
                      onChange={setPassword}
                      placeholder="••••••••"
                    />
                  </Field>
                  <label className="flex items-start gap-2 pt-1 text-xs text-zinc-600">
                    <input
                      type="checkbox"
                      checked={marketingOptIn}
                      onChange={(e) => setMarketingOptIn(e.target.checked)}
                      className="mt-0.5"
                    />
                    Send me offers and updates from this restaurant
                  </label>
                  {error && <ErrorRow message={error} />}
                  <SubmitButton submitting={submitting}>
                    Create account
                  </SubmitButton>
                  <p className="pt-1 text-center text-xs text-zinc-500">
                    Already have an account?{" "}
                    <button
                      type="button"
                      onClick={() => {
                        setMode("signin");
                        reset();
                      }}
                      className="font-semibold text-emerald-700 hover:underline"
                    >
                      Sign in
                    </button>
                  </p>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SentState({ email, onBack }: { email: string; onBack: () => void }) {
  return (
    <div className="py-2 text-center">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-emerald-50">
        <Mail className="h-6 w-6 text-emerald-600" />
      </div>
      <p className="mt-4 text-sm font-semibold text-zinc-900">
        We sent a confirmation link to
      </p>
      <p className="mt-1 break-all text-sm text-zinc-700">{email}</p>
      <p className="mt-3 text-xs leading-relaxed text-zinc-500">
        Tap the link in the email to activate your account, then come back
        here to finish placing your order. The email should arrive in under
        a minute — check your spam folder if it doesn&apos;t.
      </p>
      <button
        onClick={onBack}
        className="mt-5 text-xs font-semibold text-emerald-700 hover:underline"
      >
        Back to sign in
      </button>
    </div>
  );
}

function GoogleButton({ storeSlug }: { storeSlug: string }) {
  // Bounce the whole window to the API. Backend's customer-google
  // strategy redirects to Google, Google redirects to our callback,
  // callback redirects back to the storefront with the token. The
  // `state` query param threads storeSlug through Google's OAuth
  // flow so we know where to return the customer.
  const API_BASE =
    process.env.NEXT_PUBLIC_API_URL ?? "https://orderhub-api-0re6.onrender.com";
  const href = `${API_BASE}/v1/customer-auth/google?state=${encodeURIComponent(storeSlug)}`;
  return (
    <a
      href={href}
      className="flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-700 hover:bg-zinc-50"
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09Z" />
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.25 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
        <path fill="#FBBC05" d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.12-1.43.34-2.1V7.07H2.18a11 11 0 0 0 0 9.86l3.66-2.83Z" />
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.07l3.66 2.83C6.71 7.31 9.14 5.38 12 5.38Z" />
      </svg>
      Continue with Google
    </a>
  );
}

function Divider() {
  return (
    <div className="my-4 flex items-center gap-3 text-[10px] uppercase tracking-wider text-zinc-400">
      <div className="h-px flex-1 bg-zinc-200" />
      or
      <div className="h-px flex-1 bg-zinc-200" />
    </div>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
        {label} {required && <span className="text-red-500">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[10px] text-zinc-400">{hint}</span>}
    </label>
  );
}

function Input({
  value,
  onChange,
  type = "text",
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      type={type}
      placeholder={placeholder}
      autoFocus={autoFocus}
      className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
    />
  );
}

function ErrorRow({ message }: { message: string }) {
  return (
    <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
      {message}
    </p>
  );
}

function SubmitButton({
  submitting,
  children,
}: {
  submitting: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={submitting}
      className="mt-1 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
    >
      {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}
