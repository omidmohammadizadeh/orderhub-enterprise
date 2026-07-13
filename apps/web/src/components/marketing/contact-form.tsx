"use client";

// Phase AP marketing — contact form that POSTs straight to a Google
// Sheet via an Apps Script Web App webhook.
//
// Why Apps Script instead of a backend route:
//   • Zero cost — Google hosts the endpoint
//   • The sheet is the only "database"; no extra plumbing
//   • Operator owns the data inside their own Workspace account
//
// The webhook URL is held in NEXT_PUBLIC_CONTACT_WEBHOOK_URL.
// Without it, the form falls back to a mailto: link so we never break
// the page during local dev.

import { useState } from "react";
import { CheckCircle2, Loader2, Send } from "lucide-react";
import { InView } from "./in-view";
import { apiClient } from "@/lib/api/client";

interface Props {
  /** @deprecated legacy Google-Sheet webhook — the form now posts straight to
   *  our own Leads API so submissions land in the dashboard Leads section.
   *  Kept optional so existing callers don't break. */
  webhookUrl?: string;
}

export function ContactForm({ webhookUrl: _webhookUrl = "" }: Props) {
  const [name, setName] = useState("");
  const [restaurant, setRestaurant] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [locations, setLocations] = useState("1");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<
    "idle" | "sending" | "sent" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setStatus("sending");
    // Split the single "name" field into first/last — the Leads API needs
    // both. One-word names fall back to a placeholder last name.
    const parts = name.trim().split(/\s+/);
    const firstName = parts[0] || name.trim();
    const lastName = parts.length > 1 ? parts.slice(1).join(" ") : "—";
    try {
      // Public endpoint — lands directly in the dashboard's Leads section.
      await apiClient.post("/v1/leads", {
        firstName,
        lastName,
        email: email.trim(),
        phone: phone.trim() || undefined,
        companyName: restaurant.trim() || undefined,
        numberOfLocations: locations,
        message: message.trim() || undefined,
        source: "MARKETING_SITE",
      });
      setStatus("sent");
      setName("");
      setRestaurant("");
      setPhone("");
      setEmail("");
      setLocations("1");
      setMessage("");
    } catch (err: any) {
      setStatus("error");
      setError(
        err?.response?.data?.message ??
          err?.message ??
          "Couldn't send just now. Please try again in a moment.",
      );
    }
  };

  if (status === "sent") {
    return (
      <InView className="rounded-2xl border border-emerald-200 bg-emerald-50 p-10 text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-500 text-white">
          <CheckCircle2 className="h-7 w-7" />
        </div>
        <h3 className="mt-4 text-xl font-bold text-zinc-900">
          Thanks for contacting us
        </h3>
        <p className="mt-2 text-sm text-zinc-600">
          We&apos;ll be in touch soon. In the meantime, feel free to drop us
          a WhatsApp using the chat bubble at the bottom-right of your screen.
        </p>
        <button
          onClick={() => setStatus("idle")}
          className="mt-4 text-xs text-emerald-700 underline hover:text-emerald-900"
        >
          Send another message
        </button>
      </InView>
    );
  }

  return (
    <InView className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
      <div className="grid lg:grid-cols-[1fr,1.3fr]">
        <div className="bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-800 p-8 text-white sm:p-10">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-400">
            Talk to us
          </p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
            Tell us about your takeaway
          </h2>
          <p className="mt-3 text-sm text-zinc-300 leading-relaxed">
            Drop your details and we&apos;ll come back within a working day
            with pricing that makes sense for your setup. No hard sell.
          </p>
          <ul className="mt-6 space-y-2 text-sm text-zinc-300">
            {[
              "Reply within 1 business day",
              "Bespoke pricing for early customers",
              "Help setting up your first menu free",
            ].map((p) => (
              <li key={p} className="flex items-start gap-2">
                <span className="mt-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
                {p}
              </li>
            ))}
          </ul>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3 p-8 sm:p-10">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Your name" required>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                placeholder="Omid"
                className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
              />
            </Field>
            <Field label="Restaurant name" required>
              <input
                value={restaurant}
                onChange={(e) => setRestaurant(e.target.value)}
                required
                placeholder="Pizza Uno Pelton"
                className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
              />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Phone">
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+44 …"
                type="tel"
                className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
              />
            </Field>
            <Field label="Email" required>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                type="email"
                placeholder="you@yourshop.com"
                className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
              />
            </Field>
          </div>
          <Field label="How many locations?">
            <select
              value={locations}
              onChange={(e) => setLocations(e.target.value)}
              className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
            >
              <option value="1">1</option>
              <option value="2-5">2-5</option>
              <option value="6-20">6-20</option>
              <option value="20+">20+</option>
            </select>
          </Field>
          <Field label="What do you need help with?">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              placeholder="Tell us a bit about your current setup…"
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
            />
          </Field>

          {error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={status === "sending"}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
          >
            {status === "sending" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            Send message
          </button>
          <p className="text-center text-[11px] text-zinc-400">
            By submitting you agree to be contacted about your enquiry.
          </p>
        </form>
      </div>
    </InView>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
        {label} {required && <span className="text-red-500">*</span>}
      </span>
      {children}
    </label>
  );
}
