import type { Metadata } from "next";
import Link from "next/link";
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
