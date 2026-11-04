import { ChevronDown } from "lucide-react";
import { EFL_CONTACT_EMAIL } from "@/lib/efl-site";
import { FOCUS } from "../efl-styles";
import { A, H2 } from "./legal-page";

const MAIL = `mailto:${EFL_CONTACT_EMAIL}`;

const GROUPS: Array<{ title: string; items: Array<{ q: string; a: React.ReactNode }> }> = [
  {
    title: "Ordering",
    items: [
      {
        q: "How do I order?",
        a: "Ordering happens in the Eat For Less app, which is coming soon to the App Store and Google Play. On this website you can already see the shops near you and their menus.",
      },
      {
        q: "Why are prices lower on Eat For Less?",
        a: "Shops pay us a smaller commission than they pay most delivery apps. That lets them price the same food lower here. Each shop still sets its own prices.",
      },
      {
        q: "Where is Eat For Less available?",
        a: "We're launching in Newcastle and Tyne and Wear first: Newcastle, Gateshead, Sunderland, South Shields, North Shields and Jarrow. More towns will follow.",
      },
      {
        q: "Who makes my food?",
        a: "The shop you order from. It is the seller of the food and is responsible for preparing it and for its allergen information.",
      },
    ],
  },
  {
    title: "Delivery",
    items: [
      {
        q: "What is the delivery PIN?",
        a: "Some orders come with a short PIN shown in the app. Give it to your driver at the door so your food reaches the right person.",
      },
      {
        q: "Can I call my driver?",
        a: "Yes. Calls go through a private line, so neither of you sees the other's real phone number.",
      },
      {
        q: "Something is missing or wrong with my order",
        a: (
          <>
            Sorry about that. Tell us in the app or email <A href={MAIL}>{EFL_CONTACT_EMAIL}</A> with your order number and
            we&rsquo;ll sort it out with the shop.
          </>
        ),
      },
    ],
  },
  {
    title: "Allergies",
    items: [
      {
        q: "I have a food allergy",
        a: "Check the shop's allergen information and contact the shop before you order. Kitchens may handle allergens and can't always guarantee a dish is free from them.",
      },
    ],
  },
  {
    title: "Your account and data",
    items: [
      {
        q: "How do I delete my account?",
        a: (
          <>
            Email <A href={MAIL}>{EFL_CONTACT_EMAIL}</A> from the address on your account and we&rsquo;ll delete it. Some order
            records are kept for tax reasons, as our privacy notice explains.
          </>
        ),
      },
      {
        q: "Do you send marketing?",
        a: "Only if you say yes, and you can switch it off at any time.",
      },
    ],
  },
];

export function HelpContent() {
  return (
    <>
      {GROUPS.map((g) => (
        <section key={g.title} className="flex flex-col gap-3">
          <H2>{g.title}</H2>
          <div className="flex flex-col gap-2">
            {g.items.map((item) => (
              <details key={item.q} className="group rounded-2xl bg-[#F3F3F3] open:bg-white open:ring-2 open:ring-[#0B0B0B]">
                <summary
                  className={`flex min-h-[56px] cursor-pointer list-none items-center justify-between gap-4 rounded-2xl px-5 py-3 text-[17px] font-bold [&::-webkit-details-marker]:hidden ${FOCUS}`}
                >
                  {item.q}
                  <ChevronDown aria-hidden="true" className="h-5 w-5 shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
                </summary>
                <div className="px-5 pb-5 text-base leading-relaxed text-[#3A3A3A]">{item.a}</div>
              </details>
            ))}
          </div>
        </section>
      ))}
      <section className="mt-6 flex flex-col gap-3 rounded-[20px] bg-[#0B0B0B] p-6 text-white sm:p-8">
        <h2 className="m-0 text-[24px] font-extrabold tracking-[-0.02em]">Still need help?</h2>
        <p className="m-0 text-[#C9C9C9]">Email us and a real person will get back to you.</p>
        <a
          href={MAIL}
          className="efl-press inline-flex min-h-[48px] w-fit items-center rounded-full bg-[#D4FF3F] px-6 text-[15px] font-bold text-[#0B0B0B] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#D4FF3F]"
        >
          {EFL_CONTACT_EMAIL}
        </a>
      </section>
    </>
  );
}
