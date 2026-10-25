import { EFL_CONTACT_EMAIL } from "@/lib/efl-site";
import { A, H2, P, UL } from "./legal-page";

const MAIL = `mailto:${EFL_CONTACT_EMAIL}`;

export function PrivacyContent() {
  return (
    <>
      <H2>Who we are</H2>
      <P>
        Eat For Less is run by Eat For Less Ltd, a company registered in England and Wales (company number [Company number]),
        registered office [Registered address]. For the personal data described here, we are the data controller. You can reach
        us at <A href={MAIL}>{EFL_CONTACT_EMAIL}</A>.
      </P>
      <P>
        Eat For Less is a marketplace. The takeaways and restaurants listed on it sell the food to you. When you order, the shop
        you order from also receives the details it needs to make and deliver your order, and it is responsible for how it uses
        them.
      </P>

      <H2>What we collect</H2>
      <UL>
        <li>
          <strong>Your account:</strong> your name, email address and phone number. We check your phone number with a one-time
          code.
        </li>
        <li>
          <strong>Addresses:</strong> the delivery addresses you save, and any notes you add for the driver.
        </li>
        <li>
          <strong>Orders:</strong> what you ordered, from whom, when, how much it cost, and the order&rsquo;s progress.
        </li>
        <li>
          <strong>Location:</strong> your postcode, or your device&rsquo;s location if you choose to share it, so we can show the
          shops that deliver to you. On this website, postcodes are looked up with the public postcodes.io service.
        </li>
        <li>
          <strong>Notifications:</strong> a push token for your device if you allow notifications, so we can tell you how your
          order is doing.
        </li>
        <li>
          <strong>Support:</strong> what you tell us when you contact us.
        </li>
        <li>
          <strong>Technical data:</strong> basic logs such as IP address, device and browser type, used to keep the service
          secure and working.
        </li>
      </UL>

      <H2>Payments</H2>
      <P>
        Card payments, including Apple Pay and Google Pay, are processed by Stripe on the restaurant&rsquo;s own Stripe account.
        We never see or store your full card number. Stripe&rsquo;s own privacy notice explains how it handles payment data.
      </P>

      <H2>Delivery PIN and calls</H2>
      <P>
        Some orders come with a delivery PIN. You give it to the driver at the door so the order reaches the right person. If
        you and your driver or the shop need to speak, calls go through a private connection so neither side sees the other&rsquo;s
        real phone number.
      </P>

      <H2>Why we use it</H2>
      <UL>
        <li>To run your account and take, pass on and deliver your orders (to perform our contract with you).</li>
        <li>To keep the service safe, prevent fraud and fix problems (our legitimate interests).</li>
        <li>To meet legal duties, such as keeping records for tax (legal obligation).</li>
        <li>
          To send you marketing, but only if you have said yes (consent). You can say no at any time, and it never affects your
          orders.
        </li>
      </UL>

      <H2>Who we share it with</H2>
      <UL>
        <li>The shop you order from, and the driver or courier delivering it, only as needed for that order.</li>
        <li>Service providers that help us run Eat For Less, such as hosting, payments (Stripe), messaging and calling.</li>
        <li>Authorities, where the law requires it.</li>
      </UL>
      <P>We do not sell your personal data.</P>

      <H2>How long we keep it</H2>
      <P>
        We keep your account details while your account is open. We keep order records for as long as the law requires for
        accounting and tax, usually six years, and then delete or anonymise them.
      </P>

      <H2>Your rights</H2>
      <P>Under UK data protection law (the UK GDPR and the Data Protection Act 2018) you can ask us to:</P>
      <UL>
        <li>give you a copy of your data;</li>
        <li>correct anything that is wrong;</li>
        <li>delete your data, where we don&rsquo;t need to keep it;</li>
        <li>restrict or object to how we use it;</li>
        <li>move your data to another service.</li>
      </UL>
      <P>
        Email <A href={MAIL}>{EFL_CONTACT_EMAIL}</A> to use any of these rights. If you&rsquo;re unhappy with how we handle your
        data, you can complain to the Information Commissioner&rsquo;s Office (ico.org.uk).
      </P>

      <H2 id="cookies">Cookies</H2>
      <P>
        This website only uses the storage it needs to work, such as remembering the shops you save on this device. We
        don&rsquo;t use advertising cookies. If that changes, we&rsquo;ll ask you first.
      </P>

      <H2>Changes</H2>
      <P>If we change this notice we&rsquo;ll update the date at the top, and tell you in the app if the change is significant.</P>
    </>
  );
}
