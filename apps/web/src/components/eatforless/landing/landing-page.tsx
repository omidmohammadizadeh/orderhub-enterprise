import Link from "next/link";
import { ArrowRight, Bike, MapPin, ShieldCheck, Store, UtensilsCrossed } from "lucide-react";
import { EFL_LAUNCH_TOWNS, eflHref, type EflBase } from "@/lib/efl-site";
import { EflMark } from "../efl-logo";
import { FOCUS } from "../efl-styles";
import { FoodIcon, FoodTile, type FoodKind } from "../food-art";
import { SiteHeader } from "../site-header";
import { PostcodeSearch } from "./postcode-search";

/** The district each launch town's link searches from. */
const TOWN_DISTRICT: Record<(typeof EFL_LAUNCH_TOWNS)[number], string> = {
  Newcastle: "NE1",
  Gateshead: "NE8",
  Sunderland: "SR1",
  "South Shields": "NE33",
  "North Shields": "NE29",
  Jarrow: "NE32",
};

const TOWN_ART: Record<(typeof EFL_LAUNCH_TOWNS)[number], FoodKind> = {
  Newcastle: "pizza",
  Gateshead: "burger",
  Sunderland: "curry",
  "South Shields": "fries",
  "North Shields": "chinese",
  Jarrow: "kebab",
};

const STEPS = [
  {
    icon: MapPin,
    title: "Find your local",
    body: "Pop in your postcode and see the takeaways that deliver to you, or that you can collect from.",
  },
  {
    icon: UtensilsCrossed,
    title: "Same menu, lower prices",
    body: "Order the dishes you already love. Shops pay us less, so they can charge you less here.",
  },
  {
    icon: ShieldCheck,
    title: "Track it to your door",
    body: "Follow your order live. Bigger orders come with a delivery PIN, so it reaches the right hands.",
  },
] as const;

const fadeUp = (i: number) => ({ animationDelay: `${i * 70}ms` });

export function LandingPage({ base }: { base: EflBase }) {
  return (
    <>
      <div className="bg-[#D4FF3F]">
        <SiteHeader base={base} tone="lime" />
        <section aria-labelledby="hero-title" className="relative overflow-hidden px-4 pb-16 pt-8 sm:px-6 sm:pb-24 sm:pt-14">
          <div className="mx-auto grid max-w-[1200px] items-center gap-10 lg:grid-cols-[1.15fr_1fr]">
            <div className="efl-fu flex flex-col gap-6">
              <p className="m-0 inline-flex w-fit items-center gap-2 rounded-full bg-[#0B0B0B] px-3.5 py-1.5 text-[13px] font-bold text-[#D4FF3F]">
                Launching in Newcastle and Tyne and Wear
              </p>
              <h1
                id="hero-title"
                className="m-0 font-extrabold leading-[0.95] tracking-[-0.04em] [text-wrap:balance]"
                style={{ fontSize: "clamp(44px, 7.5vw, 84px)" }}
              >
                Your local favourites. For less.
              </h1>
              <p className="m-0 max-w-[520px] text-lg leading-snug text-[#1F1F1F] sm:text-xl">
                The takeaways you already order from, at lower prices. Enter your postcode to see who&rsquo;s near you.
              </p>
              <PostcodeSearch />
            </div>
            <HeroArt />
          </div>
        </section>
      </div>

      <section id="how-it-works" aria-labelledby="how-title" className="scroll-mt-4 px-4 py-16 sm:px-6 sm:py-24">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-10">
          <h2 id="how-title" className="m-0 text-[32px] font-extrabold leading-tight tracking-[-0.02em] sm:text-[44px]">
            How it works
          </h2>
          <ol className="m-0 grid list-none gap-4 p-0 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="efl-fu flex flex-col gap-4 rounded-[20px] bg-[#F3F3F3] p-6 sm:p-7" style={fadeUp(i)}>
                <div className="flex items-center justify-between">
                  <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#0B0B0B] text-[#D4FF3F]">
                    <s.icon aria-hidden="true" className="h-6 w-6" />
                  </span>
                  <span aria-hidden="true" className="text-[44px] font-extrabold leading-none tracking-[-0.04em] text-[#D0D0D0]">
                    {i + 1}
                  </span>
                </div>
                <h3 className="m-0 text-[22px] font-extrabold tracking-[-0.02em]">{s.title}</h3>
                <p className="m-0 text-base leading-relaxed text-[#5E5E5E]">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section aria-labelledby="less-title" className="px-4 sm:px-6">
        <div className="mx-auto grid max-w-[1200px] items-center gap-10 overflow-hidden rounded-[28px] bg-[#0B0B0B] p-7 text-white sm:p-12 lg:grid-cols-2 lg:p-16">
          <div className="flex flex-col gap-5">
            <h2 id="less-title" className="m-0 text-[36px] font-extrabold leading-[1] tracking-[-0.03em] sm:text-[52px]">
              Same menu. <span className="text-[#D4FF3F]">Lower prices.</span>
            </h2>
            <p className="m-0 max-w-[480px] text-[17px] leading-relaxed text-[#C9C9C9]">
              Delivery apps take a share of every order a takeaway sells. Eat For Less takes a smaller one. That saving is
              what lets your local shop price its food lower here than it can elsewhere.
            </p>
            <p className="m-0 max-w-[480px] text-[17px] leading-relaxed text-[#C9C9C9]">
              Same kitchen, same food, same people making it. You just pay less for it.
            </p>
          </div>
          <PriceIllustration />
        </div>
      </section>

      <section aria-labelledby="work-title" className="px-4 py-16 sm:px-6 sm:py-24">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-8">
          <h2 id="work-title" className="sr-only">
            Work with Eat For Less
          </h2>
          <div className="grid gap-5 md:grid-cols-2">
            <PromoCard
              art="pizza"
              icon={<Store aria-hidden="true" className="h-5 w-5" />}
              title="Partner with Eat For Less"
              body="Own a takeaway? Reach new customers and keep more of every order. Weekly payouts, your drivers or ours."
              cta={{ label: "Apply in 5 minutes", href: "/partner" }}
            />
            <PromoCard
              art="chicken"
              icon={<Bike aria-hidden="true" className="h-5 w-5" />}
              title="Deliver with Eat For Less"
              body="Ride for local takeaways in Newcastle and Tyne and Wear, on your own hours."
              comingSoon
            />
          </div>
        </div>
      </section>

      <section id="get-the-app" aria-labelledby="app-title" className="scroll-mt-4 bg-[#F3F3F3] px-4 py-16 sm:px-6 sm:py-24">
        <div className="mx-auto grid max-w-[1200px] items-center gap-12 lg:grid-cols-[1.1fr_1fr]">
          <div className="flex flex-col gap-6">
            <h2 id="app-title" className="m-0 text-[36px] font-extrabold leading-[1] tracking-[-0.03em] sm:text-[52px]">
              Get the Eat For Less app
            </h2>
            <p className="m-0 max-w-[480px] text-[17px] leading-relaxed text-[#5E5E5E]">
              Ordering, live tracking and your saved addresses all live in the app. It&rsquo;s on its way to the App Store and
              Google Play.
            </p>
            <ul className="m-0 flex list-none flex-wrap gap-3 p-0" aria-label="App stores">
              <StoreButton platform="ios" />
              <StoreButton platform="android" />
            </ul>
          </div>
          <PhoneMock />
        </div>
      </section>

      <section aria-labelledby="towns-title" className="px-4 py-16 sm:px-6 sm:py-24">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-8">
          <div className="flex flex-col gap-2">
            <h2 id="towns-title" className="m-0 text-[32px] font-extrabold leading-tight tracking-[-0.02em] sm:text-[44px]">
              Tyne and Wear first
            </h2>
            <p className="m-0 text-[17px] text-[#5E5E5E]">We&rsquo;re starting close to home. More towns soon.</p>
          </div>
          <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 lg:grid-cols-6">
            {EFL_LAUNCH_TOWNS.map((town, i) => (
              <li key={town} className="efl-fu" style={fadeUp(i)}>
                <Link
                  href={eflHref(base, `/near?postcode=${TOWN_DISTRICT[town]}`)}
                  className={`efl-press efl-lift group flex h-full flex-col overflow-hidden rounded-[18px] border border-[#E2E2E2] bg-white hover:border-[#0B0B0B] ${FOCUS}`}
                >
                  <span className="block aspect-[16/10] overflow-hidden">
                    <span className="efl-zoom block h-full">
                      <FoodTile kind={TOWN_ART[town]} />
                    </span>
                  </span>
                  <span className="flex items-center justify-between gap-2 px-3.5 py-3">
                    <span className="text-[15px] font-bold">{town}</span>
                    <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}

function HeroArt() {
  return (
    <div aria-hidden="true" className="relative mx-auto hidden h-[420px] w-full max-w-[460px] lg:block">
      <div className="efl-fu absolute left-0 top-6 h-[230px] w-[230px] overflow-hidden rounded-full border-[6px] border-[#0B0B0B]" style={fadeUp(1)}>
        <FoodTile kind="pizza" />
      </div>
      <div className="efl-fu absolute right-0 top-0 h-[170px] w-[170px] overflow-hidden rounded-full border-[6px] border-[#0B0B0B]" style={fadeUp(2)}>
        <FoodTile kind="burger" />
      </div>
      <div className="efl-fu absolute bottom-0 right-6 h-[200px] w-[200px] overflow-hidden rounded-full border-[6px] border-[#0B0B0B]" style={fadeUp(3)}>
        <FoodTile kind="curry" />
      </div>
      <div className="efl-fu absolute bottom-12 left-10 flex items-center gap-3 rounded-2xl bg-[#0B0B0B] px-4 py-3 text-white shadow-xl" style={fadeUp(4)}>
        <EflMark size={36} />
        <span className="flex flex-col leading-tight">
          <span className="text-sm font-extrabold">Same menu</span>
          <span className="text-sm text-[#D4FF3F]">lower prices</span>
        </span>
      </div>
    </div>
  );
}

function PriceIllustration() {
  return (
    <figure className="m-0 flex flex-col gap-3">
      <div className="flex items-center gap-4 rounded-[20px] bg-[#1A1A1A] p-4 sm:p-5">
        <span className="h-16 w-16 shrink-0 overflow-hidden rounded-2xl">
          <FoodTile kind="pizza" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[17px] font-bold">Large Margherita</span>
          <span className="text-sm text-[#9A9A9A]">Your local pizzeria</span>
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1 rounded-[20px] border border-[#2A2A2A] p-4 sm:p-5">
          <span className="text-sm text-[#9A9A9A]">Elsewhere</span>
          <span className="text-[28px] font-extrabold tracking-[-0.02em] text-[#9A9A9A] line-through decoration-2">£14.49</span>
        </div>
        <div className="flex flex-col gap-1 rounded-[20px] bg-[#D4FF3F] p-4 text-[#0B0B0B] sm:p-5">
          <span className="text-sm font-semibold">Eat For Less</span>
          <span className="text-[28px] font-extrabold tracking-[-0.02em]">£12.99</span>
        </div>
      </div>
      <figcaption className="text-[13px] text-[#8C8C8C]">Illustration only. Each shop sets its own prices.</figcaption>
    </figure>
  );
}

function PromoCard({
  art,
  icon,
  title,
  body,
  cta,
  comingSoon,
}: {
  art: FoodKind;
  icon: React.ReactNode;
  title: string;
  body: string;
  cta?: { label: string; href: string };
  comingSoon?: boolean;
}) {
  return (
    <article className="flex flex-col overflow-hidden rounded-[24px] border border-[#E2E2E2] bg-white">
      <div className="relative aspect-[16/7] overflow-hidden">
        <FoodTile kind={art} />
        {comingSoon ? (
          <span className="absolute left-4 top-4 rounded-full bg-[#0B0B0B] px-3 py-1 text-[13px] font-bold text-[#D4FF3F]">
            Coming soon
          </span>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col gap-3 p-6 sm:p-7">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#D4FF3F] text-[#0B0B0B]">{icon}</span>
        <h3 className="m-0 text-[26px] font-extrabold leading-tight tracking-[-0.02em]">{title}</h3>
        <p className="m-0 flex-1 text-base leading-relaxed text-[#5E5E5E]">{body}</p>
        {cta ? (
          <Link
            href={cta.href}
            className={`efl-press mt-2 inline-flex min-h-[48px] w-fit items-center gap-2 rounded-full bg-[#0B0B0B] px-6 text-[15px] font-bold text-white hover:bg-[#262626] ${FOCUS}`}
          >
            {cta.label}
            <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Link>
        ) : (
          <p className="m-0 mt-2 text-[15px] font-bold">Sign-ups open soon.</p>
        )}
      </div>
    </article>
  );
}

function StoreButton({ platform }: { platform: "ios" | "android" }) {
  const label = platform === "ios" ? "App Store" : "Google Play";
  return (
    <li
      className="flex min-h-[56px] items-center gap-3 rounded-2xl bg-[#0B0B0B] py-2.5 pl-4 pr-5 text-white"
    >
      {platform === "ios" ? <PhoneGlyph /> : <PlayGlyph />}
      <span className="flex flex-col leading-tight">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#D4FF3F]">Coming soon</span>
        <span className="text-[17px] font-bold">{label}</span>
      </span>
    </li>
  );
}

/** A generic phone outline — not any company's logo. */
function PhoneGlyph() {
  return (
    <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="6" y="2.5" width="12" height="19" rx="3" />
      <path d="M10.5 18.5h3" />
    </svg>
  );
}

/** A generic play triangle — not any company's logo. */
function PlayGlyph() {
  return (
    <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
      <path d="M7 4.5v15l12-7.5z" />
    </svg>
  );
}

function PhoneMock() {
  const rows: Array<{ kind: FoodKind; name: string; meta: string }> = [
    { kind: "pizza", name: "Your local pizzeria", meta: "20–30 min" },
    { kind: "curry", name: "Your local curry house", meta: "25–35 min" },
  ];
  return (
    <div aria-hidden="true" className="mx-auto w-[260px] rounded-[40px] bg-[#0B0B0B] p-3 shadow-2xl sm:w-[290px]">
      <div className="flex flex-col gap-3 overflow-hidden rounded-[30px] bg-white p-4">
        <div className="flex items-center justify-between">
          <EflMark size={26} />
          <span className="rounded-full bg-[#F3F3F3] px-3 py-1 text-[11px] font-bold">NE1</span>
        </div>
        <div className="flex gap-2">
          {(["pizza", "burger", "kebab", "curry"] as const).map((k) => (
            <span key={k} className="flex h-11 w-11 items-center justify-center rounded-full bg-[#F3F3F3]">
              <FoodIcon kind={k} size={30} />
            </span>
          ))}
        </div>
        {rows.map((r) => (
          <div key={r.name} className="flex flex-col gap-1.5">
            <span className="block aspect-[16/9] overflow-hidden rounded-2xl">
              <FoodTile kind={r.kind} />
            </span>
            <span className="text-[13px] font-bold leading-tight">{r.name}</span>
            <span className="text-[11px] text-[#5E5E5E]">{r.meta}</span>
          </div>
        ))}
        <span className="flex h-10 items-center justify-center rounded-xl bg-[#D4FF3F] text-[13px] font-extrabold">Order for less</span>
      </div>
    </div>
  );
}
