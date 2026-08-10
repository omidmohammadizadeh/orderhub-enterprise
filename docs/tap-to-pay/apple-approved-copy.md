# Apple-approved Tap to Pay on iPhone copy (UK English)

Extracted from Apple's Marketing Toolkit —
`GBEN_Digital_Q126_Tap_to_Pay_on_iPhone_Copy.docx`, received 2026-08-10 with
the TTPOI entitlement (Case-ID 21500766).

**This copy is not ours to rewrite.** Apple supplies it as fixed blocks with
bracketed partner placeholders. Tone edits are a compliance failure, not a
style choice. Always write the full name "Tap to Pay on iPhone" — never
"Tap to Pay" alone, never "Apple Tap to Pay".

## In-app splash — what we shipped
Used in `apps/web/src/components/dashboard/tap-to-pay-splash.tsx`.

- **Headline:** Tap to Pay on iPhone
- **Subheadline:** Accept contactless payments on your iPhone.
- **Body** (Apple's "Value proposition → Short copy", placeholders filled):
  > With Tap to Pay on iPhone and OrderHub, you can accept all types of
  > in-person, contactless payments on your iPhone — from physical debit and
  > credit cards to Apple Pay and other digital wallets. No extra readers or
  > hardware needed. It's easy, secure and private.
- **CTA:** Enable now *(from Apple's approved CTA list: Learn more / Enable
  now / Try it today / Download the app to get started)*

## Push notification — Apple's copy, for when push is built
Apple's "TTPoiP Copy-Only Push Notification – Hero":

- **Headline:** Accept in-person payments with Tap to Pay on iPhone.
- **Body:** You can accept all types of contactless payments on your iPhone —
  from physical debit and credit cards to Apple Pay and other digital wallets.
  Terms apply.

## Legal — REQUIRED, verbatim

Apple: *"The following disclaimers must be used across all advertising. In
placements where space is limited, the short disclaimer can be used but must
click through to your Tap to Pay on iPhone product page where the full
disclaimer is displayed."*

We have no such product page, so **the short form is not available to us** and
the full disclaimer must appear inline.

**Short (only with a click-through to the full text):** Terms apply.

**Full:**
> Tap to Pay on iPhone Requirements: Tap to Pay on iPhone requires a supported
> payment app and the latest version of iOS. Update to the latest version by
> going to Settings > General > Software Update. Tap Download and Install.
> Some contactless cards may not be accepted by your payment app. Transaction
> limits may apply. The Contactless Symbol is a trademark owned by and used
> with permission of EMVCo, LLC. Tap to Pay on iPhone is not available in all
> markets. For Tap to Pay on iPhone countries and regions, see
> https://developer.apple.com/tap-to-pay/regions

**Additional — required whenever the copy mentions Apple Pay** (ours does):
> Apple Pay is a service provided by Apple Payments Services LLC, a subsidiary
> of Apple Inc. Neither Apple Inc. nor Apple Payments Services LLC is a bank.
> Any card used in Apple Pay is offered by the card issuer.

**Additional — required if we ever use the "Privacy and security" copy block:**
> Tap to Pay on iPhone Encryption and Storage: Encrypted card numbers are
> temporarily stored on iPhone only for transactions made in Store and Forward
> mode.

## Useful blocks we haven't used yet

**PIN accessibility** — relevant to checklist row 4.7:
> For customers needing visual or other assistance, accessibility options are
> built into Tap to Pay on iPhone to help them securely enter PIN information.
> Audible instructions guide customers to draw their PIN on the screen or tap
> the screen to indicate each digit — tapping once for 1, twice for 2 and so
> on. To submit their PIN, they simply swipe right with two fingers.

**How to use (all payments)** — merchant education:
> 1. Open the OrderHub app on your iPhone, and enter the purchase amount.
> 2. Present your iPhone to the customer.
> 3. Your customer holds their card horizontally or their device over the
>    contactless symbol at the top of your iPhone for a few seconds.
> 4. When you see the Done tick, the card read is complete and the transaction
>    is being processed.
