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
 *   {{location}} {{date}} {{amount}} {{commission}} {{serviceCharge}}
 *   {{recipientCompanyNumber}} {{recipientAddress}} {{recipientPhone}}
 *   {{locationCount}} {{locationWord}}  ("3 locations" / "1 location")
 *
 * Optional clauses use {{#key}}…{{/key}}: the block survives only when that
 * value was filled in. Commission and the customer service charge are both
 * optional, so leaving either blank removes the clause entirely rather than
 * printing "0%" — a term negotiated to nothing and a term never offered read
 * very differently to whoever is signing.
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

<p><strong>{{recipientCompany}}</strong>{{#recipientCompanyNumber}}, company number {{recipientCompanyNumber}}{{/recipientCompanyNumber}}{{#recipientAddress}}, of {{recipientAddress}}{{/recipientAddress}} ("you", "the Client"), represented by {{recipientName}} ({{recipientEmail}}{{#recipientPhone}}, {{recipientPhone}}{{/recipientPhone}}).</p>

{{#locationWord}}
<p>This Agreement covers {{locationWord}}.</p>
{{/locationWord}}

<h2>1. What this Agreement covers</h2>

<p>1.1 We licence you to use the Order Hub platform (the "Platform") to take, manage and fulfil food and drink orders at your premises, on the terms set out below.</p>

<p>1.2 This Agreement begins on the date above and continues monthly until either party ends it under clause 10.</p>

<p>1.3 Nothing here makes either of us the other's partner, agent or employer. You run your business; we provide software to it.</p>

<h2>2. What we provide</h2>

<p>2.1 <strong>Order management.</strong> A single dashboard that receives, displays and tracks orders from every channel you connect, with real-time updates to your staff.</p>

<p>2.2 <strong>Marketplace integrations.</strong> Connections to third-party ordering platforms including Uber Eats, Deliveroo, Just Eat and others we support from time to time, so their orders arrive in the same place as your own.</p>

<p>2.3 <strong>Your own ordering channels.</strong> A branded online ordering storefront, optionally on your own domain; QR-code ordering at table; WhatsApp ordering; and a kiosk mode.</p>

<p>2.4 <strong>Point of sale.</strong> Till functionality for walk-in and telephone orders, including cash and card handling, table tabs and split payments.</p>

<p>2.5 <strong>Menu management.</strong> One menu that publishes out to your connected channels, with per-channel pricing, item availability and stock controls.</p>

<p>2.6 <strong>Kitchen and printing.</strong> Kitchen display screens and receipt or ticket printing to supported hardware.</p>

<p>2.7 <strong>Payments.</strong> Card payment acceptance online and in person, including digital wallets, processed through our payment partner as described in clause 5.</p>

<p>2.8 <strong>Delivery.</strong> Dispatch tools and a driver application for orders you deliver yourself, alongside marketplace courier options where available.</p>

<p>2.9 <strong>Marketing and reporting.</strong> Customer database, promotions, SMS marketing, reviews, caller ID and sales analytics.</p>

<p>2.10 <strong>Support and onboarding.</strong> Menu setup, channel connection and staff training at the outset, then ongoing support under clause 8.</p>

<p>2.11 We may add, change or withdraw individual features. Where a change materially reduces functionality you rely on, we will give you at least 30 days' notice and you may terminate under clause 10.4.</p>

<h2>3. What it costs</h2>

<p>3.1 <strong>Subscription.</strong> You will pay {{amount}} per month{{#locationWord}} for {{locationWord}}{{/locationWord}}, in advance, by continuous card authority. The first payment is taken when you activate your subscription and monthly thereafter on the same date.</p>

{{#commission}}
<p>3.2 <strong>Order commission.</strong> In addition to the subscription, we charge commission of {{commission}} of the value of each order processed through the Platform. Commission on card orders is deducted automatically from settlement before payout. Commission on cash orders accrues in the same way and is collected in arrears. Commission is calculated on the order value excluding delivery charges, tips and VAT.</p>
{{/commission}}

{{#serviceCharge}}
<p>3.3 <strong>Customer service charge.</strong> A service charge of {{serviceCharge}} per order is added to the customer's total at checkout and shown to them before they pay. This charge is collected on your behalf and is retained by us as part of the fees for the Platform. It is not part of your revenue and is not commission on your sales.</p>
{{/serviceCharge}}

<p>3.4 <strong>Messaging.</strong> SMS is prepaid. You top up a messaging balance and we deduct the published rate per message segment sent. Unused balance is not refundable on termination but remains usable until then.</p>

<p>3.5 <strong>Hardware.</strong> Printers, terminals, tablets and other equipment are charged separately and are not included in the subscription unless agreed in writing.</p>

<p>3.6 <strong>Payment processing.</strong> Card processing fees are charged by our payment partner at their published rates and are separate from our fees.</p>

<p>3.7 <strong>Price changes.</strong> We may change our fees on 30 days' written notice. If you do not accept a change you may terminate under clause 10.4 before it takes effect.</p>

<p>3.8 <strong>Late payment.</strong> If a payment fails we will retry and notify you. If an amount remains unpaid 14 days after it fell due we may suspend the Platform under clause 10.5. Overdue sums carry interest under the Late Payment of Commercial Debts (Interest) Act 1998.</p>

<p>3.9 All fees are exclusive of VAT, which is charged at the prevailing rate.</p>

<h2>4. Terms of use</h2>

<p>4.1 <strong>Accurate information.</strong> You are responsible for the accuracy of your menu, prices, allergen and dietary information, opening hours and delivery areas. We display what you publish; we do not verify it.</p>

<p>4.2 <strong>Food safety and law.</strong> You remain solely responsible for the preparation, quality, labelling and safety of everything you sell, and for holding all necessary registrations, licences and insurance. Nothing in this Agreement transfers any of that responsibility to us.</p>

<p>4.3 <strong>Accepting orders.</strong> You will monitor incoming orders during your published opening hours and accept, reject or update them promptly. Orders left unattended may be automatically rejected by a marketplace and count against your standing with them.</p>

<p>4.4 <strong>Your own equipment.</strong> You are responsible for providing and maintaining a working internet connection and compatible devices at your premises. The Platform needs connectivity to operate; offline mode is a fallback, not a substitute.</p>

<p>4.5 <strong>Account security.</strong> You will keep login credentials confidential, give each staff member their own account at the appropriate permission level, and tell us promptly if you suspect unauthorised access.</p>

<p>4.6 <strong>Third-party terms.</strong> Where you connect a marketplace, payment provider or other third party, you remain bound by that provider's own agreement with you. We are not a party to it and cannot vary it on your behalf.</p>

<p>4.7 <strong>Acceptable use.</strong> You will not resell or sublicense the Platform, attempt to copy or reverse engineer it, use it to send unlawful or unsolicited marketing, or use it for anything other than operating your own food business.</p>

<p>4.8 <strong>Marketing consent.</strong> Where you use our marketing tools you confirm you hold valid consent for every contact you message, and you will honour opt-outs. You indemnify us against claims arising from messages sent on your instruction.</p>

<p>4.9 <strong>Fair use.</strong> The Platform is provided for normal restaurant trading volumes. If your usage materially exceeds that, we will discuss a suitable plan with you rather than restrict the service without warning.</p>

<h2>5. Payments and settlement</h2>

<p>5.1 Card payments are processed by our payment partner. Funds from card orders settle to your own connected account, less our fees and their processing charges.</p>

<p>5.2 You are responsible for completing the payment partner's onboarding and identity checks. Until that is done, card payments cannot be accepted.</p>

<p>5.3 Chargebacks, refunds and disputes on orders you have taken are your responsibility. We will give you the records we hold to help you respond.</p>

<p>5.4 Cash orders are settled directly between you and your customer. Any fees due to us on cash orders are collected under clause 3.</p>

<h2>6. Data protection</h2>

<p>6.1 For customer personal data processed through the Platform, you are the controller and we are the processor. We process it only on your documented instructions and as needed to provide the Platform.</p>

<p>6.2 We apply appropriate technical and organisational measures to protect that data, and we will tell you without undue delay if we become aware of a personal data breach affecting it.</p>

<p>6.3 We use sub-processors — including hosting, payment, messaging and mapping providers — to deliver the Platform, and remain responsible for their performance.</p>

<p>6.4 On termination we will return or delete your data as set out in clause 10.7, subject to any retention we are legally required to apply.</p>

<p>6.5 Each of us will comply with the UK GDPR and the Data Protection Act 2018.</p>

<h2>7. Intellectual property</h2>

<p>7.1 The Platform, and all intellectual property in it, remains ours. You receive a non-exclusive, non-transferable licence to use it for the term of this Agreement.</p>

<p>7.2 Your menu content, branding, images and customer data remain yours. You grant us a licence to use them only so far as is needed to operate the Platform for you.</p>

<h2>8. Service and support</h2>

<p>8.1 We aim to keep the Platform available at all times but do not guarantee uninterrupted service. Planned maintenance is carried out outside typical trading hours wherever practical.</p>

<p>8.2 Support is available by phone, email and WhatsApp. We aim to respond to issues that stop you trading within one hour during your opening hours, and to other issues within one working day.</p>

<p>8.3 We are not responsible for downtime caused by your internet connection, your hardware, or a third-party marketplace or payment provider.</p>

<h2>9. Liability</h2>

<p>9.1 Neither of us excludes liability for death or personal injury caused by negligence, for fraud, or for anything else that cannot lawfully be excluded.</p>

<p>9.2 We are not liable for loss of profit, loss of business, loss of goodwill or any indirect or consequential loss.</p>

<p>9.3 Our total liability in any twelve-month period is limited to the fees you paid us in that period.</p>

<p>9.4 You indemnify us against claims arising from the food you sell, the information you publish, or your breach of clause 4.</p>

<h2>10. Term and ending this Agreement</h2>

<p>10.1 <strong>Notice period.</strong> Either party may end this Agreement by giving <strong>one month's written notice</strong>, expiring at the end of a billing month. Notice by email to the address each party has given in this Agreement is valid written notice.</p>

<p>10.2 The subscription remains payable in full for the notice period, and the Platform remains available to you throughout it.</p>

<p>10.3 We do not refund subscription paid for the current month if you cancel part-way through it.</p>

<p>10.4 Where we have changed the fees or materially reduced functionality, you may terminate on written notice before the change takes effect, without serving the month under clause 10.1.</p>

<p>10.5 <strong>Suspension.</strong> We may suspend the Platform where an amount is more than 14 days overdue, where you are in material breach of clause 4, or where we are required to by law or by a payment or marketplace partner. We will tell you why and what is needed to restore it.</p>

<p>10.6 Either party may terminate immediately if the other is in material breach and has not put it right within 14 days of being asked to, or becomes insolvent.</p>

<p>10.7 <strong>On termination.</strong> Your access ends and your ordering channels stop taking orders. We will make your order history and customer data available for export for 30 days, after which we may delete it. You should disconnect marketplace integrations from your own accounts.</p>

<h2>11. General</h2>

<p>11.1 <strong>Confidentiality.</strong> Neither party will disclose the other's confidential information, except where required by law.</p>

<p>11.2 <strong>Assignment.</strong> Neither party may assign this Agreement without the other's written consent, except to a purchaser of substantially all of its business.</p>

<p>11.3 <strong>Entire agreement.</strong> This Agreement is the whole agreement between us and replaces anything said or written beforehand.</p>

<p>11.4 <strong>Variation.</strong> Changes must be agreed in writing, except fee and feature changes made under clauses 3.7 and 2.11.</p>

<p>11.5 <strong>Third parties.</strong> No one other than you and us has any right to enforce this Agreement.</p>

<p>11.6 <strong>Governing law.</strong> This Agreement is governed by the law of England and Wales, and the courts of England and Wales have exclusive jurisdiction.</p>

<h2>12. Agreement</h2>

<p>By signing below, {{recipientName}} confirms they have read and understood this Agreement, that they are authorised to accept it on behalf of {{recipientCompany}}, and that {{recipientCompany}} agrees to be bound by it.</p>
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
