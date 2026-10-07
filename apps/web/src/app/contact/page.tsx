import type { Metadata } from "next";
import Link from "next/link";
import { CalendarDays, ArrowRight } from "lucide-react";
import { SiteNav } from "@/components/marketing/site-nav";
import { ContactForm } from "@/components/marketing/contact-form";

export const metadata: Metadata = {
  title: "Contact sales — Order Hub",
  description:
    "Tell us about your takeaway and we'll come back within a working day with pricing that fits your setup.",
};

export default function ContactPage() {
  return (
    <div className="min-h-screen bg-white text-zinc-900 antialiased">
      <SiteNav />
      <main className="mx-auto max-w-5xl px-4 py-14 sm:py-20">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-600">
            Contact sales
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
            Let's get your orders on one till
          </h1>
          <p className="mt-3 text-sm text-zinc-600 sm:text-base">
            Fill in the form and our team will be in touch within one business
            day — with pricing tailored to your setup. No hard sell.
          </p>
        </div>

        <Link
          href="/demo"
          className="mx-auto mt-8 flex max-w-2xl items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 hover:bg-emerald-100"
        >
          <CalendarDays className="h-5 w-5 shrink-0 text-emerald-600" />
          <span className="flex-1">
            <span className="font-semibold">Prefer to talk?</span> Book a
            30-minute call straight into our calendar.
          </span>
          <ArrowRight className="h-4 w-4 shrink-0" />
        </Link>

        <div className="mt-10">
          <ContactForm />
        </div>
      </main>

      <footer className="border-t border-zinc-100 py-8">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-3 px-4 text-xs text-zinc-500 sm:flex-row">
          <span>© {new Date().getFullYear()} Order Hub Solutions. All rights reserved.</span>
          <div className="flex items-center gap-4">
            <Link href="/" className="hover:text-zinc-800">Home</Link>
            <Link href="/privacy" className="hover:text-zinc-800">Privacy</Link>
            <Link href="/terms" className="hover:text-zinc-800">Terms</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
