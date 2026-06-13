"use client";

// Phase AR — shown to an authenticated user whose account isn't
// linked to any locations yet. They can't reach the dashboard until
// somebody on the Order Hub team (or one of the tenant's owners)
// gives them access via Team Roles. Visually echoes the Deliverect
// "no account" / "request a demo" pattern.
//
// The form posts to POST /v1/leads — a public endpoint, but we ride
// the user's existing JWT cookie so the lead is tagged with the
// account that submitted it. Internal team views this at
// /dashboard/leads (PLATFORM_ADMIN + ONBOARDING_AGENT only).

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  ArrowRight,
  Loader2,
  CheckCircle2,
  X,
  MessageSquare,
  LogOut,
} from "lucide-react";
import { leadsClient } from "@/lib/api/leads.client";
import { useAuthStore } from "@/stores/auth.store";

export function NoAccessScreen() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [modal, setModal] = useState<null | "demo" | "support">(null);

  return (
    <div className="relative min-h-screen w-full overflow-hidden">
      {/* Restaurant-kitchen background — soft amber tone, dark overlay
          so the card stays readable without us shipping a hero image. */}
      <div className="absolute inset-0 bg-gradient-to-br from-zinc-900 via-zinc-800 to-zinc-900" />
      <div
        className="absolute inset-0 opacity-10"
        style={{
          backgroundImage:
            "radial-gradient(circle at 20% 30%, #f97316 0px, transparent 40%), radial-gradient(circle at 80% 70%, #7c3aed 0px, transparent 40%)",
        }}
      />

      <div className="relative z-10 flex min-h-screen flex-col items-center justify-center p-4">
        <div className="w-full max-w-md rounded-xl bg-white shadow-2xl">
          {/* Logo bar */}
          <div className="flex items-center justify-center border-b border-zinc-100 px-6 py-5">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-orange-400 to-orange-600">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  className="h-4 w-4 text-white"
                  aria-hidden
                >
                  <path
                    d="M3 7h18M3 12h18M3 17h10"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  />
                  <circle cx="19" cy="17" r="3" fill="currentColor" opacity="0.9" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-bold text-zinc-900 leading-tight">
                  Order Hub
                </p>
                <p className="text-[10px] text-zinc-500 leading-tight">
                  Solutions
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-6 p-6">
            <div>
              <h1 className="text-xl font-bold text-orange-600">
                We couldn&apos;t find your account.
              </h1>
              <p className="mt-1 text-sm text-zinc-500">
                You&apos;re signed in as <strong>{user?.email}</strong>, but no
                locations have been linked to your account yet.
              </p>
            </div>

            {/* Demo request */}
            <Section
              question="Are you interested in getting started with Order Hub?"
              cta="Request a demo"
              onClick={() => setModal("demo")}
            />

            {/* Support */}
            <Section
              question="Do you already have an account but can't log in?"
              cta="Contact support"
              onClick={() => setModal("support")}
            />

            <div className="border-t border-zinc-100 pt-4">
              <p className="text-xs text-zinc-500">
                You are trying to login with {user?.email}
              </p>
              <button
                onClick={logout}
                className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-zinc-700 hover:text-zinc-900"
              >
                Try with another account
                <ArrowRight className="h-3 w-3" />
              </button>
              <button
                onClick={logout}
                className="mt-3 inline-flex items-center gap-1.5 text-[11px] text-zinc-400 hover:text-zinc-600"
              >
                <LogOut className="h-3 w-3" />
                Sign out
              </button>
            </div>
          </div>
        </div>
      </div>

      {modal === "demo" && (
        <DemoFormModal onClose={() => setModal(null)} />
      )}
      {modal === "support" && (
        <SupportInfoModal onClose={() => setModal(null)} />
      )}
    </div>
  );
}

function Section({
  question,
  cta,
  onClick,
}: {
  question: string;
  cta: string;
  onClick: () => void;
}) {
  return (
    <div>
      <p className="text-sm text-zinc-500">{question}</p>
      <button
        onClick={onClick}
        className="mt-1 inline-flex items-center gap-1.5 text-sm font-bold text-orange-600 hover:text-orange-700"
      >
        {cta}
        <ArrowRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Demo request modal
// ────────────────────────────────────────────────────────────────────

const NUM_LOC_OPTIONS = ["1-2", "3-5", "6-49", "50-500", "500+"];

function DemoFormModal({ onClose }: { onClose: () => void }) {
  const user = useAuthStore((s) => s.user);
  const [firstName, setFirstName] = useState(user?.firstName ?? "");
  const [lastName, setLastName] = useState(user?.lastName ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [phone, setPhone] = useState("");
  const [country, setCountry] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [numberOfLocations, setNumberOfLocations] = useState("");
  const [hearAboutUs, setHearAboutUs] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = useMutation({
    mutationFn: async () => {
      setError(null);
      if (!firstName || !lastName || !email) {
        throw new Error("First name, last name and email are required.");
      }
      await leadsClient.submit({
        firstName,
        lastName,
        email,
        phone: phone || undefined,
        country: country || undefined,
        companyName: companyName || undefined,
        numberOfLocations: numberOfLocations || undefined,
        hearAboutUs: hearAboutUs || undefined,
        message: message || undefined,
        source: "NO_ACCESS_SCREEN",
      });
    },
    onSuccess: () => setDone(true),
    onError: (err: any) =>
      setError(
        err?.response?.data?.message ?? err?.message ?? "Submission failed.",
      ),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-lg bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-900">
            Request a demo
          </h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {done ? (
          <div className="p-8 text-center">
            <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-emerald-50">
              <CheckCircle2 className="h-6 w-6 text-emerald-600" />
            </div>
            <h3 className="text-base font-semibold text-zinc-900">
              Thanks — we&apos;ll be in touch.
            </h3>
            <p className="mt-2 text-sm text-zinc-500">
              Our team will reach out within one business day.
            </p>
            <button
              onClick={onClose}
              className="mt-5 rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-semibold text-zinc-700 hover:bg-zinc-50"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            <div className="space-y-3 p-5 max-h-[65vh] overflow-y-auto">
              <div className="grid grid-cols-2 gap-2">
                <Field
                  label="First name *"
                  value={firstName}
                  onChange={setFirstName}
                />
                <Field
                  label="Last name *"
                  value={lastName}
                  onChange={setLastName}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field
                  label="Email *"
                  type="email"
                  value={email}
                  onChange={setEmail}
                />
                <Field
                  label="Phone number"
                  value={phone}
                  onChange={setPhone}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field
                  label="Country"
                  value={country}
                  onChange={setCountry}
                />
                <Field
                  label="Company name"
                  value={companyName}
                  onChange={setCompanyName}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-600 mb-1">
                  Number of locations
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {NUM_LOC_OPTIONS.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setNumberOfLocations(opt)}
                      className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                        numberOfLocations === opt
                          ? "border-orange-500 bg-orange-50 text-orange-700"
                          : "border-zinc-300 text-zinc-600 hover:border-zinc-400"
                      }`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </div>
              <Field
                label="How did you hear about us?"
                value={hearAboutUs}
                onChange={setHearAboutUs}
              />
              <div>
                <label className="block text-xs font-semibold text-zinc-600 mb-1">
                  Anything else?
                </label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={3}
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
                />
              </div>
              {error && (
                <p className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">
                  {error}
                </p>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-5 py-3">
              <button
                onClick={onClose}
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50"
              >
                Cancel
              </button>
              <button
                onClick={() => submit.mutate()}
                disabled={submit.isPending}
                className="inline-flex items-center gap-1.5 rounded-md bg-orange-600 px-3 py-2 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
              >
                {submit.isPending && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                )}
                Get started
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SupportInfoModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-lg bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-900">
            Contact support
          </h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-3 p-5">
          <div className="grid h-10 w-10 place-items-center rounded-full bg-orange-50">
            <MessageSquare className="h-5 w-5 text-orange-600" />
          </div>
          <p className="text-sm text-zinc-700">
            If you already have an Order Hub account but can&apos;t access it,
            email us and we&apos;ll get it sorted.
          </p>
          <a
            href="mailto:hello@orderhubsolutions.com?subject=Support%20request"
            className="block rounded-md bg-orange-600 px-3 py-2 text-center text-sm font-semibold text-white hover:bg-orange-700"
          >
            hello@orderhubsolutions.com
          </a>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-zinc-600 mb-1">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
      />
    </div>
  );
}
