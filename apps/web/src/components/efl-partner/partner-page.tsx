// Public "Partner with Eat For Less" page: the static header and card shell
// render on the server; only the form inside the card is a client component.

import { PartnerApplyForm } from "./partner-apply-form";
import { PartnerHero, PartnerStyles } from "./partner-hero";

export function PartnerPage() {
  return (
    <div className="min-h-screen overflow-x-hidden bg-white font-sans text-[#0B0B0B] antialiased">
      <PartnerStyles />
      <PartnerHero />
      <main id="apply" className="scroll-mt-4 px-4 pb-16 sm:px-6">
        <section
          aria-label="Apply to join Eat For Less"
          className="efl-fu relative mx-auto -mt-7 flex max-w-[760px] flex-col rounded-3xl border border-[#E6E6E3] bg-white p-5 shadow-[0_20px_50px_rgba(0,0,0,.08)] [animation-delay:100ms] sm:p-7"
        >
          <PartnerApplyForm />
        </section>
      </main>
    </div>
  );
}
