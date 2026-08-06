/**
 * Ready-made contract templates, installable in one click from the Templates
 * tab.
 *
 * These live in code rather than a migration on purpose: they are content, not
 * data. Installing copies the HTML into a normal ContractTemplate row that the
 * operator then owns and edits — so a later change here never rewrites an
 * agreement somebody has already sent.
 *
 * Markup is limited to h1/h2/h3/p/li because that is exactly what
 * ContractPdfService lays out. Anything else survives on screen and vanishes
 * from the PDF, which is the worst of both.
 *
 * Placeholders available at send time (contracts.service.fillPlaceholders):
 *   {{recipientName}} {{recipientEmail}} {{recipientCompany}}
 *   {{location}} {{date}} {{amount}}
 * Unknown keys are left visible rather than blanked, so a typo shows up in
 * review instead of silently deleting a term.
 */

export interface StarterTemplate {
  key: string;
  name: string;
  description: string;
  bodyHtml: string;
}

const SAAS_AGREEMENT = `
<h1>Software as a Service Agreement</h1>

<p>This Agreement is made on {{date}} between:</p>

<p><strong>Order Hub Solutions Ltd</strong>, a company registered in England and Wales with company number 16608545, whose registered office is at 5 Sunningdale Drive, Washington, NE37 2LL ("we", "us", "Order Hub"); and</p>

<p><strong>{{recipientCompany}}</strong>, represented by {{recipientName}} ("you", "the Client"), in respect of the premises known as {{location}} (the "Premises").</p>

<h2>1. What this Agreement covers</h2>

<p>1.1 We licence you to use the Order Hub platform (the "Platform") to take, manage and fulfil food and drink orders at the Premises, on the terms set out below.</p>

<p>1.2 This Agreement, together with any order form, pricing schedule or written variation signed by both parties, is the entire agreement between us. It replaces anything discussed or proposed beforehand.</p>

<h2>2. What we provide</h2>

<p>2.1 <strong>Order management.</strong> A single dashboard that receives, displays and tracks orders from every channel you connect, with real-time updates to your staff.</p>

<p>2.2 <strong>Marketplace integrations.</strong> Connections to third-party ordering platforms including Uber Eats, Deliveroo, Just Eat and others we support from time to time, so their orders arrive in the same place as your own.</p>

<p>2.3 <strong>Your own ordering channels.</strong> A branded online ordering storefront, optionally on your own domain; QR-code ordering at table; WhatsApp ordering; and a kiosk mode.</p>

<p>2.4 <strong>Point of sale.</strong> Till functionality for walk-in and telephone orders, including cash and card handling, table tabs and split payments.</p>

<p>2.5 <strong>Menu management.</strong> One menu that publishes out to your connected channels, with per-channel pricing, item availability and stock controls.</p>

<p>2.6 <strong>Kitchen and printing.</strong> Kitchen display screens and receipt or ticket printing to supported hardware.</p>

<p>2.7 <strong>Payments.</strong> Card payment acceptance online and in person, including digital wallets, processed through our payment partner as described in clause 5.</p>

<p>2.8 <strong>Delivery.</strong> Dispatch tools and a driver application for orders you deliver yourself, alongside marketplace courier options where available.</p>

<p>2.9 <strong>Marketing and reporting.</strong> Customer database, promotions, SMS marketing, reviews and sales analytics.</p>

<p>2.10 We may add, change or withdraw individual features. Where a change materially reduces the functionality you rely on, we will give you at least 30 days' notice and you may terminate under clause 10.4.</p>

<h2>3. What it costs</h2>

<p>3.1 <strong>Subscription.</strong> You will pay {{amount}} per month per location, in advance, by continuous card authority. The first payment is taken when you activate your subscription and monthly thereafter on the same date.</p>

<p>3.2 <strong>Order commission.</strong> Where we have agreed a commission or service fee on orders, it is set out in your pricing schedule and is deducted automatically from card settlements. Commission on cash orders is invoiced or collected separately in arrears.</p>

<p>3.3 <strong>Messaging.</strong> SMS is prepaid. You top up a messaging balance and we deduct the published rate per message segment sent. Unused balance is not refundable on termination but remains usable until then.</p>

<p>3.4 <strong>Hardware.</strong> Printers, terminals, tablets and other equipment are charged separately and are not included in the subscription unless your pricing schedule says otherwise.</p>

<p>3.5 <strong>Price changes.</strong> We may change our fees on 30 days' written notice. If you do not accept a change you may terminate under clause 10.4 before it takes effect.</p>

<p>3.6 <strong>Late payment.</strong> If a payment fails we will retry and notify you. If an amount remains unpaid 14 days after it fell due we may suspend the Platform under clause 10.5. Overdue sums carry interest under the Late Payment of Commercial Debts (Interest) Act 1998.</p>

<p>3.7 All fees are exclusive of VAT, which is charged at the prevailing rate.</p>

<h2>4. What you commit to</h2>

<p>4.1 <strong>Accurate information.</strong> You are responsible for the accuracy of your menu, prices, allergen and dietary information, opening hours and delivery areas. We display what you publish; we do not verify it.</p>

<p>4.2 <strong>Food safety and law.</strong> You remain solely responsible for the preparation, quality, labelling and safety of everything you sell, and for holding all necessary registrations, licences and insurance. Nothing in this Agreement transfers any of that responsibility to us.</p>

<p>4.3 <strong>Accepting orders.</strong> You will monitor incoming orders during your published opening hours and accept, reject or update them promptly. Orders left unattended may be automatically rejected by a marketplace and count against your standing with them.</p>

<p>4.4 <strong>Your own equipment.</strong> You are responsible for providing and maintaining a working internet connection and compatible devices at the Premises. The Platform needs connectivity to operate; offline mode is a fallback, not a substitute.</p>

<p>4.5 <strong>Account security.</strong> You will keep login credentials confidential, give each staff member their own account at the appropriate permission level, and tell us promptly if you suspect unauthorised access.</p>

<p>4.6 <strong>Third-party terms.</strong> Where you connect a marketplace, payment provider or other third party, you remain bound by that provider's own agreement with you. We are not a party to it and cannot vary it on your behalf.</p>

<p>4.7 <strong>Acceptable use.</strong> You will not resell or sublicense the Platform, attempt to copy or reverse engineer it, use it to send unlawful or unsolicited marketing, or use it for anything other than operating your own food business.</p>

<p>4.8 <strong>Marketing consent.</strong> Where you use our marketing tools you confirm you hold valid consent for every contact you message, and you will honour opt-outs. You indemnify us against claims arising from messages sent on your instruction.</p>

<h2>5. Payments and settlement</h2>

<p>5.1 Card payments are processed by Stripe. You will hold your own connected Stripe account, enter into Stripe's terms directly, and complete their identity and onboarding checks.</p>

<p>5.2 Customer funds settle from Stripe to your nominated bank account on Stripe's payout schedule. We do not hold your money. Our commission, where agreed, is deducted at the point of settlement.</p>

<p>5.3 Chargebacks, refunds and disputes are yours. We will give you the transaction records we hold to help you respond, but we do not fund or decide them.</p>

<p>5.4 If Stripe suspends or closes your account, card payments through the Platform will stop. That is outside our control and is not a breach of this Agreement by us.</p>

<h2>6. Data protection</h2>

<p>6.1 For personal data of your customers, you are the data controller and we are your processor. We process it only on your documented instructions and as needed to provide the Platform.</p>

<p>6.2 We will keep appropriate technical and organisational security measures, restrict access to staff who need it, and tell you without undue delay if we become aware of a personal data breach affecting your data.</p>

<p>6.3 We use sub-processors — including our hosting, payment, messaging and email providers — and remain responsible for their performance. We will tell you of any intended change that materially affects them.</p>

<p>6.4 On termination we will, at your written request within 30 days, provide an export of your data in a machine-readable format. After that period we may delete it, subject to any legal retention obligation.</p>

<p>6.5 Both parties will comply with the UK GDPR and the Data Protection Act 2018.</p>

<h2>7. Intellectual property</h2>

<p>7.1 The Platform, and all software, design and documentation in it, remain ours. You receive a non-exclusive, non-transferable licence to use it for the term of this Agreement.</p>

<p>7.2 Your menu content, brand, photographs, customer data and trading records remain yours. You grant us only the licence needed to display and process them in providing the Platform.</p>

<p>7.3 You permit us to name you and use your logo as a customer reference. You may withdraw that permission by writing to us.</p>

<h2>8. Service and support</h2>

<p>8.1 We aim to keep the Platform available at all times, and to respond to support requests promptly during business hours, with a faster route for issues that stop you trading.</p>

<p>8.2 We may carry out planned maintenance, and will schedule it outside peak trading hours wherever practical.</p>

<p>8.3 We are not responsible for downtime caused by your internet connection, your hardware, a third-party marketplace or payment provider, or anything else outside our reasonable control.</p>

<h2>9. Liability</h2>

<p>9.1 Nothing in this Agreement limits liability for death or personal injury caused by negligence, for fraud, or for anything else that cannot lawfully be limited.</p>

<p>9.2 Subject to clause 9.1, neither party is liable for loss of profit, loss of goodwill, or indirect or consequential loss.</p>

<p>9.3 Subject to clause 9.1, our total liability in any twelve-month period is limited to the total subscription fees you paid us in that period.</p>

<p>9.4 The Platform is a tool for running your business. We do not guarantee any level of sales, orders or customers.</p>

<h2>10. Term and ending this Agreement</h2>

<p>10.1 This Agreement starts on the date you sign it and continues monthly until ended under this clause.</p>

<p>10.2 Either party may end it on 30 days' written notice, expiring at the end of a paid month.</p>

<p>10.3 Either party may end it immediately if the other commits a material breach that is not put right within 14 days of written notice, or becomes insolvent.</p>

<p>10.4 You may end it without notice if we change our fees or materially reduce functionality under clauses 2.10 or 3.5, provided you tell us before the change takes effect.</p>

<p>10.5 We may suspend your access while fees are overdue under clause 3.6, or immediately where we reasonably believe continued use presents a security or legal risk. Suspension does not reduce fees already due.</p>

<p>10.6 On termination your licence ends, connected channels are disconnected, and clause 6.4 applies to your data. Fees already paid for the current month are not refundable.</p>

<h2>11. General</h2>

<p>11.1 Neither party may assign this Agreement without the other's written consent, except that we may assign it to a successor of our business.</p>

<p>11.2 Any variation must be in writing and agreed by both parties.</p>

<p>11.3 If any provision is found unenforceable, the rest continues in force.</p>

<p>11.4 No third party may enforce this Agreement under the Contracts (Rights of Third Parties) Act 1999.</p>

<p>11.5 This Agreement is governed by the law of England and Wales, and both parties submit to the exclusive jurisdiction of its courts.</p>

<h2>12. Agreement</h2>

<p>By signing below, {{recipientName}} confirms they are authorised to enter into this Agreement on behalf of {{recipientCompany}}, and that {{recipientCompany}} accepts the terms set out above.</p>
`.trim();

const TRIAL_AGREEMENT = `
<h1>Free Trial Agreement</h1>

<p>This Agreement is made on {{date}} between <strong>Order Hub Solutions Ltd</strong> (company number 16608545, registered office 5 Sunningdale Drive, Washington, NE37 2LL) and <strong>{{recipientCompany}}</strong>, represented by {{recipientName}}, in respect of {{location}}.</p>

<h2>1. The trial</h2>

<p>1.1 We are giving you access to the Order Hub platform free of charge for an agreed trial period, so you can decide whether it suits your business.</p>

<p>1.2 The trial includes order management, your own online ordering storefront, menu management, point of sale and kitchen display. Marketplace integrations may be enabled where your existing agreements allow it.</p>

<p>1.3 Card processing fees, SMS charges and any hardware remain payable during the trial. Only the subscription fee is waived.</p>

<h2>2. What you commit to</h2>

<p>2.1 You remain responsible for the accuracy of your menu and prices, for food safety and licensing, and for accepting and fulfilling orders taken through the Platform, exactly as under a paid subscription.</p>

<p>2.2 You will provide a working internet connection and compatible devices at the Premises.</p>

<p>2.3 Orders taken during the trial are real orders to real customers. The trial is free; your obligations to those customers are not reduced by it.</p>

<h2>3. Ending or converting</h2>

<p>3.1 Either party may end the trial at any time, for any reason, on written notice with immediate effect.</p>

<p>3.2 At the end of the trial you may subscribe at {{amount}} per month per location. If you do not, your access ends and connected channels are disconnected.</p>

<p>3.3 We will provide an export of your data on written request within 30 days of the trial ending.</p>

<h2>4. Liability during the trial</h2>

<p>4.1 Nothing here limits liability for death or personal injury caused by negligence, or for fraud.</p>

<p>4.2 Otherwise, because the trial is provided free of charge, our total liability arising from it is limited to £100.</p>

<h2>5. General</h2>

<p>5.1 For personal data of your customers you are the controller and we are your processor, and both parties will comply with the UK GDPR and the Data Protection Act 2018.</p>

<p>5.2 This Agreement is governed by the law of England and Wales.</p>

<h2>6. Agreement</h2>

<p>By signing below, {{recipientName}} confirms they are authorised to accept these trial terms on behalf of {{recipientCompany}}.</p>
`.trim();

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    key: "saas-agreement",
    name: "SaaS Agreement — full",
    description:
      "The standard monthly subscription agreement: what the Platform provides, fees and commission, client obligations, payments, data protection, liability and termination.",
    bodyHtml: SAAS_AGREEMENT,
  },
  {
    key: "free-trial",
    name: "Free Trial Agreement",
    description:
      "Short-form terms for a no-fee trial, with the same operational obligations and a route to convert to a paid subscription.",
    bodyHtml: TRIAL_AGREEMENT,
  },
];
