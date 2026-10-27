import { EFL_COMPANY_NUMBER, EFL_CONTACT_EMAIL, EFL_REGISTERED_OFFICE } from "@/lib/efl-site";
import { A, H2, P, UL } from "./legal-page";

const MAIL = `mailto:${EFL_CONTACT_EMAIL}`;

export function TermsContent() {
  return (
    <>
      <H2>About these terms</H2>
      <P>
        These terms cover your use of the Eat For Less website and app. Eat For Less is run by Eat For Less Ltd, registered in
        England and Wales (company number {EFL_COMPANY_NUMBER}), registered office {EFL_REGISTERED_OFFICE}. By using Eat For Less you
        agree to these terms.
      </P>

      <H2>What Eat For Less is</H2>
      <P>
        Eat For Less is a marketplace that connects you with local takeaways and restaurants. The shop you order from is the
        seller of the food and is responsible for preparing it, for its quality, and for the allergen and ingredient information
        it gives. We take your order and pass it to the shop on its behalf.
      </P>

      <H2>Your account</H2>
      <UL>
        <li>You need to be 18 or over to order, and 18 or over to order alcohol where a shop offers it.</li>
        <li>Keep your details accurate and your account to yourself. You&rsquo;re responsible for orders placed from it.</li>
        <li>We may suspend an account that is used for fraud or abuse, or to harm shops, drivers or other customers.</li>
      </UL>

      <H2>Prices and payment</H2>
      <UL>
        <li>Each shop sets its own menu prices. Delivery fees and any service charges are shown before you pay.</li>
        <li>
          Payment is taken by card (including Apple Pay and Google Pay) and processed by Stripe on the shop&rsquo;s own account.
        </li>
        <li>Your contract for the food is with the shop. Your receipt shows which shop you bought from.</li>
      </UL>

      <H2>Delivery and collection</H2>
      <UL>
        <li>Delivery times are estimates. Things like weather and traffic can slow an order down.</li>
        <li>
          Some orders have a delivery PIN. Please give it to the driver at the door; they may not be able to hand over the order
          without it.
        </li>
        <li>For collection orders, please collect at the time shown. A shop may not hold food for long.</li>
      </UL>

      <H2>Allergies</H2>
      <P>
        If you have an allergy or intolerance, check the shop&rsquo;s information and contact the shop before ordering. Shops
        prepare food in kitchens that may handle allergens, and cannot always guarantee a dish is free from them.
      </P>

      <H2>Cancellations, refunds and problems</H2>
      <UL>
        <li>Once a shop starts preparing your food, you usually can&rsquo;t cancel the order, because it&rsquo;s made to order.</li>
        <li>
          If something is missing, wrong or not up to standard, tell us through the app or at{" "}
          <A href={MAIL}>{EFL_CONTACT_EMAIL}</A> as soon as you can and we&rsquo;ll work it out with the shop.
        </li>
        <li>Nothing in these terms affects your legal rights as a consumer.</li>
      </UL>

      <H2>Using Eat For Less fairly</H2>
      <P>
        Please don&rsquo;t misuse the service: no fraudulent orders, no abuse of shops or drivers, and no copying, scraping or
        interfering with the website or app.
      </P>

      <H2>Our responsibility</H2>
      <P>
        We work hard to keep Eat For Less running smoothly but can&rsquo;t promise it will always be available. We are not
        responsible for losses we couldn&rsquo;t reasonably foresee. We don&rsquo;t exclude responsibility where the law
        doesn&rsquo;t allow it, including for death or personal injury caused by negligence.
      </P>

      <H2>Changes and law</H2>
      <P>
        We may update these terms; the date at the top shows the latest version. These terms are governed by the law of England
        and Wales, and you can bring a claim in the courts of the part of the UK where you live.
      </P>

      <H2>Contact</H2>
      <P>
        Questions? Email <A href={MAIL}>{EFL_CONTACT_EMAIL}</A>.
      </P>
    </>
  );
}
