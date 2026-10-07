import type { Metadata } from "next";
import Link from "next/link";
import { CalendarDays, ExternalLink } from "lucide-react";
import { SiteNav } from "@/components/marketing/site-nav";
import { DEMO_BOOKING_EMBED_URL, DEMO_BOOKING_URL } from "@/lib/demo-booking";

export const metadata: Metadata = {
  title: "Book a demo — Order Hub",
  description:
    "Pick a 30-minute slot and we'll walk you through Order Hub on a Google Meet call — POS, online ordering and every delivery platform on one till.",
};

export default function DemoPage() {
  return (
    <div className="min-h-screen bg-white text-zinc-900 antialiased">
      <SiteNav />
      <main className="mx-auto max-w-5xl px-4 py-14 sm:py-20">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-600">
            Book a demo
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
            See Order Hub in 30 minutes
          </h1>
          <p className="mt-3 text-sm text-zinc-600 sm:text-base">
            Pick a time that suits you. We&apos;ll walk through your setup on a
            Google Meet call and answer every question — no hard sell.
          </p>
        </div>

        {/* Inline on tablet/desktop; phones get a button instead, the
            embedded scheduler is unusable at that width. */}
        <div className="mt-10 hidden overflow-hidden rounded-2xl border border-zinc-200 shadow-sm sm:block">
          <iframe
            src={DEMO_BOOKING_EMBED_URL}
            title="Book a demo with Order Hub"
            className="h-[720px] w-full border-0"
            loading="lazy"
          />
        </div>

        <div className="mt-10 rounded-2xl border border-zinc-200 p-6 text-center sm:hidden">
          <CalendarDays className="mx-auto h-8 w-8 text-emerald-600" />
          <p className="mt-3 text-sm text-zinc-600">
            Choose a slot on our booking page — it opens in Google Calendar.
          </p>
          <a
            href={DEMO_BOOKING_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
          >
            Pick a time
            <ExternalLink className="h-4 w-4" />
          </a>
        </div>

        <p className="mt-6 text-center text-xs text-zinc-500">
          Calendar not loading?{" "}
          <a
            href={DEMO_BOOKING_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-emerald-700 hover:underline"
          >
            Open the booking page
          </a>{" "}
          or{" "}
          <Link href="/contact" className="font-medium text-emerald-700 hover:underline">
            send us a message
          </Link>
          .
        </p>
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
