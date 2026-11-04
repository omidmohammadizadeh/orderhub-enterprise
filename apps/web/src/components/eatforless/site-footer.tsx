import Link from "next/link";
import {
  EFL_COMPANY_NAME,
  EFL_COMPANY_NUMBER,
  EFL_CONTACT_EMAIL,
  EFL_LAUNCH_TOWNS,
  EFL_REGISTERED_OFFICE,
  eflHref,
  type EflBase,
} from "@/lib/efl-site";
import { EflWordmark } from "./efl-logo";
import { FOCUS_ON_DARK } from "./efl-styles";

const LINK = `inline-flex min-h-[40px] items-center rounded text-[15px] text-[#C9C9C9] hover:text-white ${FOCUS_ON_DARK}`;

export function SiteFooter({ base }: { base: EflBase }) {
  const columns = [
    {
      title: "Eat For Less",
      links: [
        { label: "About", href: `${eflHref(base, "/")}#how-it-works` },
        { label: "Partner with us", href: "/partner" },
        { label: "Help", href: eflHref(base, "/help") },
      ],
    },
    {
      title: "Legal",
      links: [
        { label: "Privacy", href: eflHref(base, "/privacy") },
        { label: "Terms", href: eflHref(base, "/terms") },
        { label: "Cookies", href: `${eflHref(base, "/privacy")}#cookies` },
      ],
    },
  ];

  return (
    <footer className="bg-[#0B0B0B] px-4 pb-10 pt-14 text-white sm:px-6">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-12">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1.2fr]">
          <div className="flex flex-col gap-4">
            <Link href={eflHref(base, "/")} className={`-mx-1 inline-flex w-fit rounded-lg px-1 ${FOCUS_ON_DARK}`}>
              <EflWordmark tone="light" size={32} />
              <span className="sr-only">Eat For Less home</span>
            </Link>
            <p className="m-0 max-w-[300px] text-[15px] leading-relaxed text-[#BDBDBD]">
              Your local takeaways, for less. Launching in Newcastle and Tyne and Wear.
            </p>
            <a href={`mailto:${EFL_CONTACT_EMAIL}`} className={`${LINK} w-fit font-semibold text-white`}>
              {EFL_CONTACT_EMAIL}
            </a>
          </div>
          {columns.map((col) => (
            <nav key={col.title} aria-label={col.title} className="flex flex-col gap-2">
              <h2 className="m-0 mb-1 text-sm font-bold uppercase tracking-[0.08em] text-[#8C8C8C]">{col.title}</h2>
              <ul className="m-0 flex list-none flex-col p-0">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <Link href={l.href} className={LINK}>
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
          <div className="flex flex-col gap-2">
            <h2 className="m-0 mb-1 text-sm font-bold uppercase tracking-[0.08em] text-[#8C8C8C]">Launching in</h2>
            <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[15px] text-[#C9C9C9]">
              {EFL_LAUNCH_TOWNS.map((t) => (
                <li key={t} className="min-h-[32px] leading-8">
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="flex flex-col gap-2 border-t border-[#262626] pt-6 text-sm text-[#8C8C8C] sm:flex-row sm:items-center sm:justify-between">
          <p className="m-0">© 2026 Eat For Less</p>
          <p className="m-0">Restaurants are the sellers of the food you order.</p>
        </div>
        <p className="m-0 -mt-8 text-xs leading-relaxed text-[#8C8C8C]">
          {EFL_COMPANY_NAME}, registered in England and Wales, company number {EFL_COMPANY_NUMBER}. Registered office:{" "}
          {EFL_REGISTERED_OFFICE}.
        </p>
      </div>
    </footer>
  );
}
