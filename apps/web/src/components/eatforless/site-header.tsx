import Link from "next/link";
import { eflHref, type EflBase } from "@/lib/efl-site";
import { EflWordmark } from "./efl-logo";
import { FOCUS } from "./efl-styles";

/** The plain top bar: landing, legal and help pages. */
export function SiteHeader({ base, tone = "light" }: { base: EflBase; tone?: "light" | "lime" }) {
  const bg = tone === "lime" ? "bg-[#D4FF3F]" : "bg-white border-b border-[#E2E2E2]";
  return (
    <header className={`${bg} px-4 sm:px-6`}>
      <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-3 sm:h-[72px]">
        <Link href={eflHref(base, "/")} className={`-mx-1 inline-flex min-h-[44px] items-center rounded-lg px-1 ${FOCUS}`}>
          <EflWordmark size={30} onLime={tone === "lime"} />
          <span className="sr-only">Eat For Less home</span>
        </Link>
        <nav aria-label="Main" className="flex items-center gap-1.5 sm:gap-2">
          <Link
            href="/partner"
            className={`efl-press hidden min-h-[44px] items-center rounded-full px-4 text-sm font-bold text-[#0B0B0B] hover:bg-black/5 sm:inline-flex ${FOCUS}`}
          >
            Partner with us
          </Link>
          <a
            href={`${eflHref(base, "/")}#get-the-app`}
            className={`efl-press inline-flex min-h-[44px] items-center rounded-full bg-[#0B0B0B] px-4 text-sm font-bold text-white hover:bg-[#262626] ${FOCUS}`}
          >
            Get the app
          </a>
        </nav>
      </div>
    </header>
  );
}
