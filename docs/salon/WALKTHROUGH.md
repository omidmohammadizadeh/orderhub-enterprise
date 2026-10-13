# Barbers, hair and nail salons — what shipped and how to test it

Built and deployed overnight 12–13 October 2026. Everything below is live on
production (API + web), behind a per-location switch: nothing changes for a
location until it is turned into a salon.

## What a salon gets

| Where | What it does |
|---|---|
| **Sidebar → Appointments** | The diary. Day view has one column per barber; week view shows one barber's week; list view is for phones. Tap an empty slot to book there. Drag a booking to move it, or onto another barber to hand it over (press and hold on a tablet). Hours, lunch and time off are shaded. Every till updates live. |
| **Appointment panel** | Arrived → Start → Checkout, or Move / No-show / Cancel (cancelling refunds a paid deposit). Shows the client's past visits and no-shows. |
| **Checkout** | Set the final price on "from" services, add products (wax, shampoo), a discount, a tip (10/15/20% or other), and scan a loyalty card. Payment goes through **the till's own screens**: cash (with change and the drawer), card machine (Stripe or Dojo), payment link, or "other". A paid sale completes on its own and the appointment turns Done. |
| **Sidebar → Walk-ins** | The queue. Each person's wait is worked out against the real bookings, so nobody is promised a chair that's spoken for. Call up → In the chair → Pay. **Quick sale** covers a cut that never touched the diary. **Screen & QR** gives the TV link and the window QR link. |
| **Services** | Price list with lengths, clean-down time, colour processing gaps (the stylist is free during them), add-ons, deposits (fixed / % / full), patch-test flag, online on/off. **Import price list** reads a CSV export from Fresha, Booksy, Treatwell, Square or a spreadsheet. |
| **Team** | Barbers with their own hours (split shifts), which services they do, their own prices (senior/junior), commission %, time off. |
| **Reports** | Takings, tips, commission due, how full each barber's book was, no-shows, new clients, online share, walk-ins, top services. |
| **Settings** | Online booking on/off and its link, "anyone available" first, lead time, how far ahead, free-cancellation window, deposit kept on no-show, reminders (email, optional SMS), "time for your next visit" emails, review request emails, walk-in queue options, trade wording, and **client list import**. |

Guest-facing pages (no login):

| Page | URL |
|---|---|
| Booking page | `/salon/<locationId>` — the link for Instagram and Google |
| Manage my booking | `/salon/booking/<token>` — emailed to the guest |
| Join the queue | `/salon/<locationId>/queue` — the window QR |
| Live place in queue | `/salon/queue/<token>` |
| TV screen by the door | `/salon/<locationId>/board` |

A salon's existing storefront link (`/order/<slug>` and its custom domain)
now opens the booking page. WhatsApp messages to a salon's number get the
booking link, the queue link and the phone number instead of the food bot.

## Morning test plan (about 30 minutes)

Use a **test location**, not a live restaurant — turning a location into a
salon changes its sidebar and its storefront link.

1. **Make a test salon.** Locations → edit (or add) a test location → Business
   type **Barber / salon** → Save. Open **Appointments**: you'll see the set-up
   card. Pick **Barbers**, type a first barber's name, keep "start me with a
   typical price list", press **Switch to salon**.
2. **Team.** Add two more barbers. Give one a split shift and a 40% commission.
   Add an hour of time off for someone today.
3. **Services.** Open Skin fade: it has two add-ons. Give one service a £1 fixed
   deposit (for step 7). Try **Import price list** with a few pasted lines —
   check the preview, then import.
4. **Settings.** Tick **Take bookings online**, save, copy the booking link.
5. **Diary.** Tap an empty slot → book someone (search a returning client,
   add an add-on, pick a free time). Drag them to another barber. Open them →
   Arrived → Checkout → add a product and a 10% tip → **Cash** → the till's cash
   screen opens → take it. The block greys out, the header's takings go up.
   Try **Card** on another (the reader screen, or "paid on a separate terminal").
6. **Booking page on your phone.** Open the link. Pick a service and add-on →
   "Anyone available" → a time → your details → Confirm. You should get the
   confirmation email (from the shop's name) with **View or change**. On that
   page: Add to calendar, Change time (only more than 24h ahead), Cancel.
   The booking appears in the diary without refreshing.
7. **Deposit (real money — use the £1 service).** Book it on the booking page.
   You're sent to Stripe on the location's own Connect account; after paying
   you land back on "You're booked in" and the diary shows the card icon.
   Cancel it from the guest page more than 24h ahead → the £1 is refunded
   automatically. If the location has no Stripe set up, the booking still
   goes through without a deposit and the diary says why.
8. **Walk-ins.** Walk-ins → Add walk-in. On your phone open the queue link
   (Screen & QR) and join. Open the TV link on a laptop. Call someone up → In
   the chair → Pay.
9. **Reports.** Today: takings, tips and commission match what you did.
10. **WhatsApp** (if the test location has a number): send "hi".

Reminders go out by themselves: an email 24h before (SMS too if switched on),
"time for your next visit" N days after (barbers default 21), and a review
request two hours after paying — only if the location has its Google review
link filled in.

## How it hangs together

- **Not a fork.** `Location.businessType = SALON` is a preset, like GROCERY and
  RETAIL. Settings live in `Location.settings.salon`.
- **Own tables** (`salon_services`, `salon_staff`, `salon_time_off`,
  `salon_appointments`, `salon_queue_entries`) — no changes to menus,
  modifiers or MenuItem.
- **Money goes through Orders.** Checkout creates an ordinary POS walk-in
  order, so receipts, loyalty stamps, refunds, payouts and analytics all see
  it. A deposit is its own small order paid by the existing Stripe payment
  link. Deposits and discounts are taken off the lines rather than put in
  `Order.discount`, because the Stripe link page ignores `Order.discount`.
- **No double-booking.** Each booking is written under a per-barber Postgres
  advisory lock with the clash check repeated inside it (tested with two
  simultaneous online bookings for the same slot — exactly one wins).
- **Times** are the shop's wall clock everywhere (Intl, DST-safe); tested
  across the October clock change and for Dubai.

Code: `packages/shared/src/lib/salon.ts` (engine), `apps/api/src/modules/salon/`,
`apps/web/src/app/(dashboard)/dashboard/salon/`, `apps/web/src/app/salon/`,
`apps/web/src/components/salon*`.

Tests: 58 unit tests in `apps/api/src/modules/salon/tests/`, plus
`docs/salon/e2e-smoke.mjs` (85 end-to-end checks against a local API and
database — never production).

## Not built yet

- **AI phone line booking for salons.** The voice line runs three engines and
  live restaurant phone ordering depends on it; it needs real test calls, so
  it was left for a session where you're around. Until then a salon's voice
  line behaves as before.
- **Reserve with Google.** Needs Google to accept OrderHub as a booking
  partner (an application, not code). The booking page link can go on the
  Google Business Profile as the "Book" link today.
- **Instagram "Book" button.** Instagram → Edit profile → Action buttons →
  Book → paste the booking page link. No code needed.
- Chairs / rooms as bookable resources (nail stations, treatment rooms),
  two staff on one appointment, packages / courses, gift cards, memberships.
- Staff logins are not limited to their own diary column yet.

## Watch out for

- **Email volume.** Salon emails (confirmations, reminders, nudges, review
  requests) use the same Resend account as order and reservation emails —
  on the free plan that's 100 a day shared with everything else, including
  Leila's salon. A busy barber could use 50+ a day. Upgrade Resend before a
  real salon goes live.
- SMS reminders and "you're up" texts are off by default; they spend the
  shop's SMS wallet when switched on.
- The dashboard's sidebar is fixed-width on phones (true for every page, not
  just salons); the diary is comfortable on tablets and laptops, and the
  List view is the phone view.
